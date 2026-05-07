import { config } from './config.js';
import { scoutYandexMaps } from './services/yandexMaps.js';
import { plannedGoogleSearches, scoutGooglePlaces } from './services/googlePlaces.js';
import { diagnoseLead, evaluatePitch } from './services/openaiAgent.js';
import { createA1LeadTask, crmAddEvent, customerBotLink, outboundQueueMessage, parsedToolData, syncA1CrmLead } from './services/a1Client.js';
import { prepareLovableMockup } from './services/lovableMcp.js';
import { renderLeadVideo } from './services/filmer.js';
import { enrichContacts } from './services/contactEnrichment.js';
import { approvalKeyboard, sendTelegram } from './services/telegram.js';
import { enrichLeadScore, topLovableCandidates } from './services/scoring.js';
import { deployLeadExportedProject, deployLeadPublicUrlProject } from './services/projectPublisher.js';

const LOVABLE_HANDOFF_STALE_MS = 30 * 60 * 1000;

const nextLane = {
  Разведка: { agent: 'Diagnoser', lane: 'Диагноз' },
  Диагноз: { agent: 'Builder', lane: 'Lovable' },
  Lovable: { agent: 'Builder', lane: 'Lovable' },
  Видео: { agent: 'Checker', lane: 'Проверка' },
  Проверка: { agent: 'Pitcher', lane: 'Отправка' },
  Отправка: { agent: 'Mobile', lane: 'Ответы' },
};

export class Orchestrator {
  constructor(store) {
    this.store = store;
  }

  async scout() {
    const result = await this.scoutSources();
    if (!result.ok) return result;
    const saved = [];
    for (const lead of result.leads ?? []) {
      let savedLead = await this.store.upsertLead(lead);
      const contacts = await enrichContacts(savedLead);
      savedLead = await this.store.updateLead(savedLead.id, enrichLeadScore({ ...savedLead, contacts }));
      savedLead = await this.syncLeadWithA1(savedLead, 'scout');
      saved.push(savedLead);
      await this.store.addEvent(savedLead.id, 'contacts.enriched', `Contact enrichment finished: ${contacts.emails?.length || 0} email(s)`);
      await this.addA1Event(savedLead, 'contacts.enriched', `Contact enrichment finished: ${contacts.emails?.length || 0} email(s)`, { contacts });
      await this.store.addEvent(savedLead.id, 'a1.crm.synced', `A1 CRM sync after Scout: ${savedLead.a1Crm?.ok ? 'ok' : savedLead.a1Crm?.reason || savedLead.a1Crm?.error || 'failed'}`);
    }
    this.store.state.metrics.scannedToday += saved.length;
    await this.store.save();
    return { ok: true, saved, sources: result.sources ?? [] };
  }

  async scoutSources() {
    const sources = [];
    const leads = [];
    const provider = config.LEAD_SOURCE_PROVIDER;

    if (provider === 'yandex' || provider === 'both') {
      try {
        const yandex = await scoutYandexMaps();
        sources.push({ name: 'yandex_maps', ok: yandex.ok, skipped: yandex.skipped, reason: yandex.reason });
        if (yandex.ok) leads.push(...yandex.leads);
        if (provider === 'yandex' && yandex.ok) return { ok: true, leads, sources };
      } catch (error) {
        sources.push({ name: 'yandex_maps', ok: false, error: error.message });
        if (provider === 'both') console.error('Yandex scout failed, continuing with Google fallback', error);
      }
    }

    if (provider === 'google' || provider === 'both' || (provider === 'yandex' && leads.length === 0)) {
      if (!config.GOOGLE_MAPS_API_KEY) {
        sources.push({ name: 'google_places', ok: false, skipped: true, reason: 'GOOGLE_MAPS_API_KEY is not configured' });
        const ok = sources.some((source) => source.ok);
        return { ok, skipped: !ok, leads, sources, reason: ok ? undefined : 'No lead source returned data' };
      }
      const usage = await this.store.reserveGoogleSearches(config.GOOGLE_DAILY_SEARCH_LIMIT, plannedGoogleSearches());
      const google = await scoutGooglePlaces(usage.reserved);
      sources.push({
        name: 'google_places',
        ok: google.ok,
        skipped: google.skipped,
        reason: google.reason,
        searchesReserved: usage.reserved,
        searchesUsed: google.searchesUsed,
        searchesRemaining: usage.remaining,
        limited: google.limited,
      });
      if (google.ok) leads.push(...google.leads);
    }

    const ok = sources.some((source) => source.ok);
    return { ok, skipped: !ok, leads, sources, reason: ok ? undefined : 'No lead source returned data' };
  }

  async tick() {
    const scout = await this.scout();
    const stalledLovable = await this.inspectStalledLovableHandoffs();
    const topActions = this.topActions(config.AUTONOMY_TOP_ACTIONS_LIMIT);
    const advanced = [];
    const skipped = [];
    let actionCount = 0;
    let lovableBuildCount = 0;
    for (const action of topActions.filter((item) => item.autoRunnable)) {
      if (actionCount >= config.AUTONOMY_MAX_ACTIONS_PER_TICK) {
        skipped.push(skipAction(action, 'max_actions_per_tick'));
        continue;
      }
      if (action.action === 'build_lovable' && lovableBuildCount >= config.AUTONOMY_MAX_LOVABLE_BUILDS_PER_TICK) {
        skipped.push(skipAction(action, 'max_lovable_builds_per_tick'));
        continue;
      }
      console.log('Autonomy action started', {
        action: action.action,
        leadId: action.lead.id,
        name: action.lead.name,
        lane: action.lead.lane,
        owner: action.lead.owner,
      });
      const startedAt = Date.now();
      const result = await this.advanceLead(action.lead.id);
      console.log('Autonomy action finished', {
        action: action.action,
        leadId: action.lead.id,
        ok: Boolean(result?.ok),
        held: Boolean(result?.held),
        reason: result?.reason || result?.error || '',
        durationMs: Date.now() - startedAt,
      });
      actionCount += 1;
      if (action.action === 'build_lovable') lovableBuildCount += 1;
      if (result?.ok) advanced.push(result.lead);
    }
    return { ok: true, scout, stalledLovable, advanced, skipped, topActions };
  }

  topActions(limit = 10) {
    const leads = this.store.listLeads();
    const topLovableIds = new Set(this.lovableCandidates().map((lead) => lead.id));
    return leads
      .map((lead) => {
        const scored = enrichLeadScore({ ...lead });
        const action = actionForLead(scored, topLovableIds);
        if (lead.mockup?.buildUrl) scored.mockup = { ...(scored.mockup ?? {}), buildUrl: lead.mockup.buildUrl };
        return { lead: scored, ...action };
      })
      .filter((item) => item.action !== 'none')
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
  }

  lovableCandidates() {
    const remaining = Math.max(0, config.DAILY_MOCKUP_LIMIT - Number(this.store.state.metrics.mockupsToday ?? 0));
    return topLovableCandidates(this.store.listLeads(), remaining);
  }

  async inspectStalledLovableHandoffs() {
    const stalled = this.store
      .listLeads()
      .filter((lead) => lead.lane === 'Lovable' && lead.mockup?.status === 'waiting_lovable_project')
      .filter((lead) => lovableHandoffAgeMs(lead) >= LOVABLE_HANDOFF_STALE_MS);

    const alerted = [];
    for (const lead of stalled) {
      if (lead.mockup?.handoffAlertedAt) continue;
      const handoff = lovableHandoffRequest(lead);
      await this.store.updateLead(lead.id, {
        status: 'handoff_required',
        mockup: {
          ...(lead.mockup ?? {}),
          handoffStatus: 'stalled',
          handoffPrompt: handoff.prompt,
          handoffAlertedAt: new Date().toISOString(),
        },
      });
      await this.store.addEvent(lead.id, 'lovable.handoff_stalled', 'Lovable project is waiting for attach_lovable_repo, attach_lovable_url or deploy_static_project');
      await sendTelegram(
        [
          '<b>Lovable handoff застрял</b>',
          `${lead.name} · ${lead.city} · ${lead.niche}`,
          `Lead ID: <code>${lead.id}</code>`,
          'Сайт, вероятно, создан в Lovable, но Web Studio не получила URL или файлы.',
          'В Lovable нужно вызвать MCP tool attach_lovable_repo, attach_lovable_url или deploy_static_project.',
        ].join('\n'),
      );
      alerted.push({ leadId: lead.id, name: lead.name });
    }
    return { ok: true, stalled: stalled.length, alerted };
  }

  async advanceLane(lane, limit = 50) {
    const candidates = this.store
      .listLeads()
      .filter((lead) => lead.lane === lane && !['done', 'paused', 'waiting_approval', 'needs_review'].includes(lead.status))
      .map((lead) => enrichLeadScore({ ...lead }))
      .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 50)));

    const advanced = [];
    const held = [];
    const waitingApproval = [];
    const failed = [];
    for (const lead of candidates) {
      const result = await this.advanceLead(lead.id);
      if (result?.ok) advanced.push(result.lead);
      else if (result?.held) held.push({ leadId: lead.id, reason: result.reason });
      else if (result?.waitingApproval) waitingApproval.push(result.approval);
      else failed.push({ leadId: lead.id, error: result?.error || 'unknown error' });
    }
    return { ok: true, lane, requested: candidates.length, advanced, held, waitingApproval, failed };
  }

  async advanceLead(leadId) {
    const lead = this.store.getLead(leadId);
    if (!lead) return { ok: false, error: 'Lead not found' };

    const gate = await this.checkGates(lead);
    if (!gate.ok) return gate;

    const currentAgent = lead.owner || 'Scout';
    const locked = await this.store.lockLead(lead.id, currentAgent);
    if (!locked) return { ok: false, error: 'Lead is locked by another agent' };

    try {
      if (lead.owner === 'Coder' && (lead.status === 'public_url_attached' || lead.mockup?.status === 'public_url_attached')) {
        return await deployLeadPublicUrlProject(this.store, lead.id);
      }

      if (lead.owner === 'Coder' && (lead.status === 'export_ready' || lead.mockup?.status === 'export_ready')) {
        return await deployLeadExportedProject(this.store, lead.id, {
          files: lead.mockup?.files ?? [],
          lovable: lovableExportMeta(lead.mockup),
          projectName: lead.mockup?.projectName || lead.name,
        });
      }

      if (lead.lane === 'Разведка') {
        Object.assign(lead, await diagnoseLead(lead));
        enrichLeadScore(lead);
        await this.store.addEvent(lead.id, 'diagnosis.created', 'Diagnoser подготовил диагноз, сообщение и fitScore');
        await this.addA1Event(lead, 'diagnosis.created', 'Diagnoser created diagnosis, cold message and fitScore', {
          diagnosis: lead.diagnosis,
          angle: lead.angle,
          message: lead.message,
          fitScore: lead.fitScore,
        });
      }

      if (lead.lane === 'Диагноз') {
        enrichLeadScore(lead);
        const allowed = new Set(this.lovableCandidates().map((candidate) => candidate.id));
        if (!allowed.has(lead.id)) {
          await this.store.save();
          return { ok: false, held: true, reason: 'Not in daily top Lovable candidates or daily mockup limit reached', lead };
        }
      }

      if (lead.lane === 'Lovable') {
        lead.mockup = await prepareLovableMockup(lead);
        await this.store.addEvent(lead.id, 'mockup.waiting_lovable', 'Builder ждет проект из Lovable MCP');
        await this.store.save();
        return { ok: true, lead };
      }

      if (lead.lane === 'Видео') {
        const artifactGate = await this.requireDeployedSite(lead);
        if (!artifactGate.ok) return artifactGate;
        lead.video = await renderLeadVideo(lead);
        if (!lead.video.ok) {
          lead.status = 'needs_review';
          await this.store.addEvent(lead.id, 'video.failed', `Filmer не смог собрать видео: ${lead.video.reason}`);
          await sendTelegram(
            [
              '<b>Filmer требует решения</b>',
              `${lead.name} · ${lead.city} · ${lead.niche}`,
              `Ошибка: ${lead.video.reason}`,
              `Lovable URL: ${lead.mockup?.url || 'нет'}`,
              'Лид оставлен в Видео со статусом needs_review.',
            ].join('\n'),
          );
          await this.store.save();
          return { ok: false, held: true, reason: 'Video render failed', lead };
        }
        await this.store.addEvent(lead.id, 'video.created', `Filmer собрал видео: ${lead.video.videoUrl}`);
        await this.addA1Event(lead, 'video.created', `Filmer rendered video: ${lead.video.videoUrl}`, { video: lead.video });
      }

      if (lead.lane === 'Проверка') {
        const artifactGate = await this.requireDeployedSite(lead);
        if (!artifactGate.ok) return artifactGate;
        lead.checker = await evaluatePitch(lead);
        if (!lead.checker.passed) {
          lead.status = 'needs_review';
          lead.message = lead.checker.revisedMessage || lead.message;
          await this.store.addEvent(lead.id, 'checker.failed', `Checker остановил сообщение: ${lead.checker.issues.join('; ')}`);
          await this.store.save();
          return { ok: false, held: true, reason: 'Checker failed', lead };
        }
        lead.message = lead.checker.revisedMessage || lead.message;
        await this.store.addEvent(lead.id, 'checker.passed', `Checker passed: ${lead.checker.score}`);
        await this.addA1Event(lead, 'checker.passed', `Checker passed: ${lead.checker.score}`, { checker: lead.checker, message: lead.message });
      }

      if (lead.lane === 'Отправка') {
        lead.contacts = await enrichContacts(lead);
        if (!lead.contacts.channels.some((channel) => channel.type === 'email')) {
          lead.status = 'needs_review';
          await this.store.addEvent(lead.id, 'contacts.needs_review', 'Email не найден. Нужен ручной выбор: звонок для уточнения контакта или поиск контактов.');
          await sendTelegram(
            [
              '<b>Нужен выбор канала отправки</b>',
              `${lead.name} · ${lead.city} · ${lead.niche}`,
              `Телефон: ${lead.phone || 'нет'}`,
              'Email не найден. Автоматическая рекламная отправка на телефон без предварительного согласия рискованна.',
              'Рекомендация: ручной звонок для уточнения ЛПР/email или дополнительный поиск контактов.',
            ].join('\n'),
          );
          await this.store.save();
          return { ok: false, held: true, reason: 'No compliant outbound channel found', lead };
        }
        const reserved = await this.store.reserveSends(config.DAILY_SEND_LIMIT, 1);
        if (reserved.reserved < 1) return { ok: false, held: true, reason: 'Daily send limit reached', lead };
        const emailChannel = lead.contacts.channels.find((channel) => channel.type === 'email');
        const botLink = customerBotLink(lead);
        const siteUrl = absolutePublicUrl(lead.mockup?.publishedUrl || lead.mockup?.deployedUrl || lead.mockup?.publicUrl || '');
        const videoUrl = absolutePublicUrl(lead.video?.videoUrl || '');
        const message = outboundEmailBody(lead, { botLink, siteUrl, videoUrl });
        const outbound = await outboundQueueMessage({
          a1LeadId: lead.a1LeadId || lead.a1?.leadId || '',
          externalId: lead.id,
          dedupeKey: `webstudio:${lead.id}`,
          to: emailChannel?.value || lead.contacts.emails?.[0] || '',
          subject: `Сайт для ${lead.name}`,
          body: message,
          attachments: [
            siteUrl ? { type: 'link', url: siteUrl, title: 'Превью сайта' } : null,
            videoUrl ? { type: 'link', url: videoUrl, title: 'Видео-превью' } : null,
          ].filter(Boolean),
          idempotencyKey: `webstudio:${lead.id}:outbound:${lead.updatedAt || Date.now()}`,
        });
        const item = await this.store.addOutreachQueueItem({
          leadId: lead.id,
          channel: 'Email',
          message,
          fitScore: lead.fitScore ?? 0,
          a1Outbound: outbound,
        });
        lead.pitch = { ok: outbound.ok, queued: true, queueId: item.id, channel: item.channel, updatedAt: new Date().toISOString(), a1Outbound: outbound };
        await this.store.addEvent(lead.id, 'pitch.queued', `Pitcher поставил сообщение в очередь: ${item.channel}`);
        await this.addA1Event(lead, 'outbound.queued', 'Pitcher queued outbound email in A1', { queueItem: item, outbound });
      }

      lead.a1Task = await createA1LeadTask(
        lead,
        currentAgent,
        `Обработай лида строго в роли ${currentAgent}. Не выполняй write-действия вне A1 task. Верни результат для оркестратора.`,
      );

      const next = nextLane[lead.lane];
      if (next) {
        const patch = { lane: next.lane, owner: next.agent, status: 'in_progress' };
        if (lead.lane === 'Диагноз') {
          patch.mockup = await prepareLovableMockup(lead);
          if (patch.mockup?.status === 'export_ready') {
            await this.store.updateLead(lead.id, { ...patch, owner: 'Coder', status: 'export_ready' });
            await this.store.addEvent(lead.id, 'mockup.export_ready', `Lovable returned ${patch.mockup.files?.length || 0} source file(s); Coder deploy started`);
            this.store.state.metrics.mockupsToday = Number(this.store.state.metrics.mockupsToday ?? 0) + 1;
            return await deployLeadExportedProject(this.store, lead.id, {
              files: patch.mockup.files ?? [],
              lovable: lovableExportMeta(patch.mockup),
              projectName: patch.mockup.projectName || lead.name,
            });
          }
          if (patch.mockup?.status === 'public_url_attached') {
            patch.owner = 'Coder';
            patch.status = 'public_url_attached';
          }
          if (patch.mockup?.status === 'failed') {
            patch.status = 'needs_review';
          }
          this.store.state.metrics.mockupsToday = Number(this.store.state.metrics.mockupsToday ?? 0) + 1;
        }
        await this.store.updateLead(lead.id, patch);
        await this.store.addEvent(lead.id, 'lead.advanced', `Лид передан агенту ${next.agent}`);
        await this.addA1Event(this.store.getLead(lead.id), 'lead.advanced', `Lead advanced to ${next.agent}`, { next });
      }
      const currentLead = this.store.getLead(lead.id);
      const syncedLead = await this.syncLeadWithA1(currentLead, `lane:${currentLead?.lane || lead.lane}`);
      const a1Crm = syncedLead.a1Crm;
      await this.store.addEvent(lead.id, 'a1.crm.synced', `A1 CRM sync after advance: ${a1Crm?.ok ? 'ok' : a1Crm?.reason || a1Crm?.error || 'failed'}`);
      return { ok: true, lead: this.store.getLead(lead.id) };
    } finally {
      await this.store.unlockLead(lead.id, currentAgent);
    }
  }

  async syncLeadWithA1(lead, reason) {
    if (!lead) return lead;
    const a1Crm = await syncA1CrmLead(lead, reason);
    const data = parsedToolData(a1Crm.upsert) || parsedToolData(a1Crm) || {};
    const patch = {
      a1Crm,
      a1LeadId: a1Crm.a1LeadId || data.a1LeadId || data.leadId || data.id || lead.a1LeadId || '',
      a1: {
        ...(lead.a1 ?? {}),
        leadId: a1Crm.a1LeadId || data.a1LeadId || data.leadId || data.id || lead.a1?.leadId || '',
        dedupeKey: a1Crm.dedupeKey || lead.a1?.dedupeKey || `webstudio:${lead.id}`,
        lastSyncAt: new Date().toISOString(),
      },
    };
    return this.store.updateLead(lead.id, patch);
  }

  async addA1Event(lead, eventType, text, payload = {}) {
    if (!lead) return { ok: false, skipped: true };
    return crmAddEvent({
      entityType: lead.a1DealId ? 'deal' : 'lead',
      entityId: lead.a1DealId || lead.a1LeadId || lead.id,
      eventType,
      text,
      payload: {
        webstudioLeadId: lead.id,
        a1LeadId: lead.a1LeadId,
        a1DealId: lead.a1DealId,
        ...payload,
      },
      idempotencyKey: `webstudio:${lead.id}:${eventType}:${lead.updatedAt || Date.now()}`,
    });
  }

  async checkGates(lead) {
    if ((lead.deal ?? 0) > config.DEAL_APPROVAL_RUB) {
      return this.requestApproval(
        lead,
        'deal_limit',
        `Сделка ${formatRub(lead.deal)} выше лимита ${formatRub(config.DEAL_APPROVAL_RUB)}`,
      );
    }
    if ((lead.replyRate ?? config.MIN_REPLY_RATE) < config.MIN_REPLY_RATE) {
      return this.requestApproval(lead, 'reply_rate', `Reply rate ${lead.replyRate}% ниже ${config.MIN_REPLY_RATE}%`);
    }
    return { ok: true };
  }

  async requestApproval(lead, reason, message) {
    const existing = this.store
      .listApprovals()
      .find((approval) => approval.leadId === lead.id && approval.reason === reason && approval.status === 'pending');
    if (existing) return { ok: false, waitingApproval: true, approval: existing };

    const approval = await this.store.addApproval({ leadId: lead.id, reason, message });
    await this.store.updateLead(lead.id, { status: 'waiting_approval' });
    await sendTelegram(
      [
        '<b>Нужен выбор владельца</b>',
        `${lead.name} · ${lead.city} · ${lead.niche}`,
        message,
        `Текущий этап: ${lead.lane}, агент: ${lead.owner}`,
      ].join('\n'),
      approvalKeyboard(approval.id),
    );
    return { ok: false, waitingApproval: true, approval };
  }

  async requireDeployedSite(lead) {
    const hasSite = Boolean((lead.mockup?.publicUrl || lead.mockup?.deployedUrl || lead.mockup?.publishedUrl) && lead.mockup?.status === 'deployed');
    if (hasSite) return { ok: true };
    const updated = await this.store.updateLead(lead.id, {
      lane: 'Диагноз',
      owner: 'Diagnoser',
      status: 'in_progress',
      mockup: lead.mockup
        ? {
            ...lead.mockup,
            status: 'not_built',
            handoffStatus: 'returned_to_diagnosis',
            returnedAt: new Date().toISOString(),
          }
        : undefined,
    });
    await this.store.addEvent(lead.id, 'mockup.missing_returned', 'Lead returned to Diagnosis because no deployed Web Studio site exists');
    return { ok: false, held: true, reason: 'No deployed Web Studio site exists; returned to Diagnosis', lead: updated };
  }
}

function actionForLead(lead, topLovableIds) {
  if (lead.status === 'waiting_approval') return { action: 'approve_or_reject', label: 'Ждет approval', score: 100, autoRunnable: false };
  if (lead.mockup?.status === 'export_ready' || lead.status === 'export_ready') {
    return { action: 'deploy_lovable_export', label: 'Деплой Lovable export', score: lead.fitScore ?? 0, autoRunnable: true };
  }
  if (lead.mockup?.status === 'public_url_attached' || lead.status === 'public_url_attached') {
    return { action: 'deploy_public_url', label: 'Деплой публичного URL', score: lead.fitScore ?? 0, autoRunnable: true };
  }
  if (lead.mockup?.status === 'github_repo_attached' || lead.status === 'repo_attached') {
    return { action: 'deploy_github_repo', label: 'Деплой GitHub repo', score: lead.fitScore ?? 0, autoRunnable: false };
  }
  if (lead.lane === 'Lovable' && (lead.mockup?.handoffStatus === 'stalled' || lovableHandoffAgeMs(lead) >= LOVABLE_HANDOFF_STALE_MS)) {
    return { action: 'lovable_handoff_stalled', label: 'Lovable: сайт не сделан', score: 100, autoRunnable: false };
  }
  if (lead.status === 'needs_review') return { action: 'review_message', label: 'Нужна ручная правка сообщения', score: 90, autoRunnable: false };
  if (lead.lane === 'Диагноз' && topLovableIds.has(lead.id)) return { action: 'build_lovable', label: 'Сделать сайт в Lovable', score: lead.fitScore ?? 0, autoRunnable: true };
  if (lead.lane === 'Диагноз') return { action: 'hold_lovable', label: 'Ждет quota Lovable', score: lead.fitScore ?? 0, autoRunnable: false };
  if (lead.lane === 'Lovable') return { action: 'wait_lovable_export', label: 'Ждет export из Lovable MCP', score: lead.fitScore ?? 0, autoRunnable: false };
  if (lead.lane === 'Видео') return { action: 'make_video', label: 'Подготовить видео/пропустить', score: lead.fitScore ?? 0, autoRunnable: true };
  if (lead.lane === 'Проверка') return { action: 'check_pitch', label: 'Проверить сообщение', score: lead.fitScore ?? 0, autoRunnable: true };
  if (lead.lane === 'Отправка') return { action: 'queue_pitch', label: 'Поставить в очередь отправки', score: lead.fitScore ?? 0, autoRunnable: true };
  return { action: 'none', label: 'Нет действия', score: 0, autoRunnable: false };
}

function skipAction(action, reason) {
  return {
    reason,
    action: action.action,
    leadId: action.lead?.id,
    name: action.lead?.name,
    lane: action.lead?.lane,
    owner: action.lead?.owner,
  };
}

function formatRub(value) {
  return `${Number(value ?? 0).toLocaleString('ru-RU')} ₽`;
}

function outboundEmailBody(lead, { botLink = '', siteUrl = '', videoUrl = '' } = {}) {
  return [
    `Здравствуйте. Мы посмотрели, как ${lead.name} сейчас выглядит в поиске и на картах, и подготовили один вариант превью сайта под ${lead.niche || 'ваш бизнес'}.`,
    'Это не шаблон к обязательному запуску, а быстрый пример направления: структуру, тексты и визуал можно поменять под ваши идеи.',
    siteUrl ? `\nПревью сайта: ${siteUrl}` : '',
    videoUrl ? `Видео-превью: ${videoUrl}` : '',
    botLink ? `Если интересно обсудить или дать правки, напишите сюда: ${botLink}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function absolutePublicUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  const base = String(config.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}${url.startsWith('/') ? '' : '/'}${url}` : url;
}

function lovableHandoffAgeMs(lead) {
  const updatedAt = Date.parse(lead.mockup?.updatedAt || lead.updatedAt || lead.createdAt || '');
  return Number.isFinite(updatedAt) ? Date.now() - updatedAt : 0;
}

function lovableHandoffRequest(lead) {
  return {
    prompt: [
      `The landing page for Web Studio lead "${lead.name}" has already been created in this Lovable project.`,
      'Do not rebuild from scratch and do not resend the original generation prompt.',
      'Please hand the result back to Web Studio now.',
      '',
      'Preferred: call Web Studio Orchestrator MCP tool attach_lovable_url with a public preview or published URL.',
      `Call attach_lovable_url with leadId "${lead.id}", url or publishedUrl, projectName, and short notes.`,
      '',
      'If a real public GitHub repository is available, call attach_lovable_repo. Do not pass lovable.code.storage internal remotes.',
      `Call attach_lovable_repo with leadId "${lead.id}", githubUrl, repoName if available, branch, projectName, and short notes.`,
      '',
      'If this project can export files, call deploy_static_project instead with leadId, projectName, and all static files.',
      'Web Studio will deploy it under /projects/<slug>, then make screenshots/video and continue the pipeline.',
    ].join('\n'),
  };
}

function lovableExportMeta(mockup = {}) {
  return {
    projectId: mockup.projectId || '',
    editorUrl: mockup.editorUrl || '',
    previewUrl: mockup.previewUrl || '',
    publishedUrl: mockup.publishedUrl || mockup.url || '',
    latestRef: mockup.latestRef || '',
    createMessageId: mockup.raw?.createMessageId || '',
  };
}

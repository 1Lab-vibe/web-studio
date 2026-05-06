import { config } from './config.js';
import { scoutYandexMaps } from './services/yandexMaps.js';
import { plannedGoogleSearches, scoutGooglePlaces } from './services/googlePlaces.js';
import { diagnoseLead, evaluatePitch } from './services/openaiAgent.js';
import { createA1LeadTask } from './services/a1Client.js';
import { prepareLovableMockup } from './services/lovableMcp.js';
import { approvalKeyboard, sendTelegram } from './services/telegram.js';
import { enrichLeadScore, topLovableCandidates } from './services/scoring.js';

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
    for (const lead of result.leads ?? []) saved.push(await this.store.upsertLead(lead));
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
    const topActions = this.topActions(12);
    const advanced = [];
    for (const action of topActions.filter((item) => item.autoRunnable)) {
      const result = await this.advanceLead(action.lead.id);
      if (result?.ok) advanced.push(result.lead);
    }
    return { ok: true, scout, advanced, topActions };
  }

  topActions(limit = 10) {
    const leads = this.store.listLeads();
    const topLovableIds = new Set(this.lovableCandidates().map((lead) => lead.id));
    return leads
      .map((lead) => {
        const scored = enrichLeadScore({ ...lead });
        const action = actionForLead(scored, topLovableIds);
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
      if (lead.lane === 'Разведка') {
        Object.assign(lead, await diagnoseLead(lead));
        enrichLeadScore(lead);
        await this.store.addEvent(lead.id, 'diagnosis.created', 'Diagnoser подготовил диагноз, сообщение и fitScore');
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
        lead.video = {
          ok: false,
          skipped: true,
          reason: 'Video renderer is not configured yet',
          updatedAt: new Date().toISOString(),
        };
        await this.store.addEvent(lead.id, 'video.skipped', 'Видео пока пропущено: renderer не подключен');
      }

      if (lead.lane === 'Проверка') {
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
      }

      if (lead.lane === 'Отправка') {
        const reserved = await this.store.reserveSends(config.DAILY_SEND_LIMIT, 1);
        if (reserved.reserved < 1) return { ok: false, held: true, reason: 'Daily send limit reached', lead };
        const item = await this.store.addOutreachQueueItem({
          leadId: lead.id,
          channel: lead.channel || 'Email',
          message: lead.message || '',
          fitScore: lead.fitScore ?? 0,
        });
        lead.pitch = { ok: true, queued: true, queueId: item.id, channel: item.channel, updatedAt: new Date().toISOString() };
        await this.store.addEvent(lead.id, 'pitch.queued', `Pitcher поставил сообщение в очередь: ${item.channel}`);
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
          this.store.state.metrics.mockupsToday = Number(this.store.state.metrics.mockupsToday ?? 0) + 1;
        }
        await this.store.updateLead(lead.id, patch);
        await this.store.addEvent(lead.id, 'lead.advanced', `Лид передан агенту ${next.agent}`);
      }
      return { ok: true, lead: this.store.getLead(lead.id) };
    } finally {
      await this.store.unlockLead(lead.id, currentAgent);
    }
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
}

function actionForLead(lead, topLovableIds) {
  if (lead.status === 'waiting_approval') return { action: 'approve_or_reject', label: 'Ждет approval', score: 100, autoRunnable: false };
  if (lead.status === 'needs_review') return { action: 'review_message', label: 'Нужна ручная правка сообщения', score: 90, autoRunnable: false };
  if (lead.lane === 'Диагноз' && topLovableIds.has(lead.id)) return { action: 'build_lovable', label: 'Сделать сайт в Lovable', score: lead.fitScore ?? 0, autoRunnable: true };
  if (lead.lane === 'Диагноз') return { action: 'hold_lovable', label: 'Ждет quota Lovable', score: lead.fitScore ?? 0, autoRunnable: false };
  if (lead.lane === 'Lovable') return { action: 'wait_lovable_url', label: 'Ждет URL из Lovable MCP', score: lead.fitScore ?? 0, autoRunnable: false };
  if (lead.lane === 'Видео') return { action: 'make_video', label: 'Подготовить видео/пропустить', score: lead.fitScore ?? 0, autoRunnable: true };
  if (lead.lane === 'Проверка') return { action: 'check_pitch', label: 'Проверить сообщение', score: lead.fitScore ?? 0, autoRunnable: true };
  if (lead.lane === 'Отправка') return { action: 'queue_pitch', label: 'Поставить в очередь отправки', score: lead.fitScore ?? 0, autoRunnable: true };
  return { action: 'none', label: 'Нет действия', score: 0, autoRunnable: false };
}

function formatRub(value) {
  return `${Number(value ?? 0).toLocaleString('ru-RU')} ₽`;
}

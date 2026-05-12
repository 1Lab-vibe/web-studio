import { config } from './config.js';
import { scoutYandexMaps } from './services/yandexMaps.js';
import { scoutGooglePlaces } from './services/googlePlaces.js';
import { diagnoseLead, evaluatePitch } from './services/openaiAgent.js';
import { crmAddEvent, crmCreateManagerTask, crmMoveLeadStage, customerBotLink, outboundQueueMessage, parsedToolData, syncA1CrmLead } from './services/a1Client.js';
import { prepareLovableMockup } from './services/lovableMcp.js';
import { renderLeadVideo } from './services/filmer.js';
import { enrichContacts } from './services/contactEnrichment.js';
import { approvalKeyboard, sendTelegram, sendTelegramTo } from './services/telegram.js';
import { customerBriefSafetyIssues } from './services/customerTelegram.js';
import { classifyCustomerRevision, isRevisionPaymentOk, revisionPaymentRequiredText } from './services/revisions.js';
import { enrichLeadScore, hasEmailContact, hasValidatedEmailContact, isLovableEligible, topLovableCandidates } from './services/scoring.js';
import { applySimpleRevisionToSourceProject, deployLeadExportedProject, deployLeadGeneratedPreview, deployLeadPublicUrlProject, repairLeadSourceProject } from './services/projectPublisher.js';
import { ensureQualityGate, runPreviewQualityGate } from './services/qualityGate.js';
import { listSubjectVariants, pickSubjectVariant, recordSubjectSend, variantId } from './services/subjectAB.js';
import { discoverLeadSite } from './services/siteFinder.js';
import { trackingUrl } from './services/clickTracker.js';
import { buildTelegramFollowupArtifact, telegramFollowupEventPayload } from './services/telegramFollowup.js';

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
    const filtered = this.filterNewScoutLeads(result.leads ?? []);
    for (const lead of filtered.newLeads) {
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
    return { ok: true, saved, duplicatesSkipped: filtered.duplicatesSkipped, sources: result.sources ?? [] };
  }

  async scoutSources() {
    const sources = [];
    const leads = [];
    const provider = config.LEAD_SOURCE_PROVIDER;

    if (provider === 'yandex' || provider === 'both') {
      try {
        const yandex = await scoutYandexMaps(this.scoutQueryOptions());
        sources.push({ name: 'yandex_maps', ok: yandex.ok, skipped: yandex.skipped, reason: yandex.reason, skippedQueries: yandex.skippedQueries?.length || 0 });
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
      const budget = await this.store.googleSearchBudget(config.GOOGLE_DAILY_SEARCH_LIMIT);
      const google = await scoutGooglePlaces(budget.remaining, this.scoutQueryOptions());
      const usage = await this.store.recordGoogleSearches(google.searchesUsed || 0, config.GOOGLE_DAILY_SEARCH_LIMIT);
      sources.push({
        name: 'google_places',
        ok: google.ok,
        skipped: google.skipped,
        reason: google.reason,
        searchesReserved: budget.remaining,
        searchesUsed: google.searchesUsed,
        searchesRemaining: usage.remaining,
        skippedQueries: google.skippedQueries?.length || 0,
        limited: google.limited,
      });
      if (google.ok) leads.push(...google.leads);
    }

    const ok = sources.some((source) => source.ok);
    return { ok, skipped: !ok, leads, sources, reason: ok ? undefined : 'No lead source returned data' };
  }

  scoutQueryOptions() {
    return {
      shouldRunQuery: (input) => this.store.shouldRunScoutQuery(input),
      recordQuery: (input, result) => this.store.recordScoutQuery(input, result),
    };
  }

  filterNewScoutLeads(leads = []) {
    const seen = new Set();
    const existing = this.store.listLeads();
    const knownSourceKeys = new Set(existing.map((lead) => lead.sourceKey).filter(Boolean));
    const knownNameCity = new Set(existing.map((lead) => `${normalizeDedupeText(lead.name)}|${normalizeDedupeText(lead.city)}`).filter((key) => key !== '|'));
    const knownPhones = new Set(existing.map((lead) => normalizePhone(lead.phone || lead.contacts?.phone)).filter(Boolean));
    const knownAddresses = new Set(existing.map((lead) => `${normalizeDedupeText(lead.address)}|${normalizeDedupeText(lead.city)}`).filter((key) => key !== '|'));
    const newLeads = [];
    let duplicatesSkipped = 0;
    for (const lead of leads) {
      const signature = [
        lead.sourceKey ? `source:${lead.sourceKey}` : '',
        `name:${normalizeDedupeText(lead.name)}|${normalizeDedupeText(lead.city)}`,
        normalizePhone(lead.phone) ? `phone:${normalizePhone(lead.phone)}` : '',
        lead.address ? `addr:${normalizeDedupeText(lead.address)}|${normalizeDedupeText(lead.city)}` : '',
      ].filter(Boolean);
      const duplicate =
        signature.some((item) => seen.has(item)) ||
        (lead.sourceKey && knownSourceKeys.has(lead.sourceKey)) ||
        knownNameCity.has(`${normalizeDedupeText(lead.name)}|${normalizeDedupeText(lead.city)}`) ||
        (normalizePhone(lead.phone) && knownPhones.has(normalizePhone(lead.phone))) ||
        (lead.address && knownAddresses.has(`${normalizeDedupeText(lead.address)}|${normalizeDedupeText(lead.city)}`));
      if (duplicate) {
        duplicatesSkipped += 1;
        continue;
      }
      signature.forEach((item) => seen.add(item));
      newLeads.push(lead);
    }
    return { newLeads, duplicatesSkipped };
  }

  async tick() {
    const startedAt = Date.now();
    const recovered = await this.store.recoverExpiredJobs({ deadAfterAttempts: config.AUTONOMY_DEAD_AFTER_ATTEMPTS });
    for (const job of recovered.filter((item) => item.status === 'dead')) {
      await this.alertJobFailure(job, new Error(job.lastError || 'Job lock expired'), { source: 'lock_recovery' });
    }
    const stalledLovable = await this.inspectStalledLovableHandoffs();
    const planned = await this.planJobs();
    const claimed = await this.store.claimNextJobs({
      limit: config.AUTONOMY_MAX_JOBS_PER_TICK || config.AUTONOMY_MAX_ACTIONS_PER_TICK,
      lockMinutes: config.AUTONOMY_JOB_LOCK_MINUTES,
      maxLovable: config.AUTONOMY_MAX_LOVABLE_JOBS_PER_TICK || config.AUTONOMY_MAX_LOVABLE_BUILDS_PER_TICK,
      maxFilmer: config.AUTONOMY_MAX_FILMER_JOBS_PER_TICK,
      maxDiagnose: config.AUTONOMY_MAX_DIAGNOSE_JOBS_PER_TICK,
    });
    const started = [];
    const succeeded = [];
    const failed = [];
    for (const job of claimed) {
      started.push({ id: job.id, type: job.type, leadId: job.leadId });
      if (isLongRunningJob(job)) {
        void this.runClaimedJob(job);
        continue;
      }
      const result = await this.runClaimedJob(job);
      if (result.ok) succeeded.push({ id: job.id, type: job.type, leadId: job.leadId, durationMs: result.durationMs });
      else failed.push({ id: job.id, type: job.type, leadId: job.leadId, error: result.error });
    }
    const summary = {
      ok: true,
      planned,
      recovered: recovered.map((job) => ({ id: job.id, type: job.type, leadId: job.leadId, status: job.status })),
      stalledLovable,
      started,
      succeeded,
      failed,
      skipped: [],
      durationMs: Date.now() - startedAt,
      topActions: this.topActions(config.AUTONOMY_TOP_ACTIONS_LIMIT).map(slimTopAction),
    };
    await this.store.addOrchestratorRun(summary);
    return summary;
  }

  async runClaimedJob(job) {
    console.log('Autonomy job started', { id: job.id, type: job.type, leadId: job.leadId, attempts: job.attempts });
    const jobStartedAt = Date.now();
    try {
      const result = await this.runJob(job);
      await this.store.finishJob(job.id, result);
      const durationMs = Date.now() - jobStartedAt;
      console.log('Autonomy job succeeded', { id: job.id, type: job.type, leadId: job.leadId, durationMs });
      return { ok: true, durationMs, result };
    } catch (error) {
      const failedJob = await this.store.failJob(job.id, error, { retryDelayMs: retryDelayForJob(job) });
      await this.alertJobFailure(failedJob || job, error, { source: 'job_failure' });
      const durationMs = Date.now() - jobStartedAt;
      console.error('Autonomy job failed', { id: job.id, type: job.type, leadId: job.leadId, durationMs, error });
      return { ok: false, durationMs, error: error.message };
    }
  }

  async alertJobFailure(job, error, { source = 'job_failure' } = {}) {
    if (!job) return;
    const message = job.lastError || error?.message || String(error || 'Job failed');
    const critical = isCriticalJobError(message);
    const dead = job.status === 'dead';
    if (!critical && !dead) return;
    const lead = job.leadId ? this.store.getLead(job.leadId) : null;
    const key = critical
      ? `critical-job:${critical}:${job.type}`
      : `dead-job:${job.type}:${job.leadId || 'global'}:${message.slice(0, 120)}`;
    const reserved = await this.store.reserveAdminAlert(key, {
      cooldownMs: critical ? 2 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000,
    });
    if (!reserved?.reserved) return;
    const alert = await sendTelegram(
      [
        critical === 'openai_quota' ? '<b>OpenAI quota exhausted</b>' : '<b>Autonomy job failed</b>',
        `Job: <code>${escapeHtml(job.type)}</code>`,
        lead ? `Лид: <b>${escapeHtml(lead.name || lead.id)}</b>` : '',
        job.leadId ? `Lead ID: <code>${escapeHtml(job.leadId)}</code>` : '',
        `Status: <code>${escapeHtml(job.status || 'failed')}</code>`,
        `Attempts: <code>${escapeHtml(`${job.attempts ?? 0}/${job.maxAttempts ?? config.AUTONOMY_DEAD_AFTER_ATTEMPTS}`)}</code>`,
        `Source: <code>${escapeHtml(source)}</code>`,
        `Ошибка: <code>${escapeHtml(message.slice(0, 800))}</code>`,
        critical === 'openai_quota' ? 'Автономия не сможет выполнять LLM-этапы, пока не пополнить/проверить billing OpenAI или не сменить ключ/модель.' : '',
      ].filter(Boolean).join('\n'),
    );
    if (!alert?.ok) console.error('Telegram job failure alert failed', alert);
  }

  async planJobs() {
    const planned = [];
    const now = new Date();
    const planningLimit = Math.max(50, Number(config.AUTONOMY_TOP_ACTIONS_LIMIT) || 12);
    const scoutKey = `scout:${now.toISOString().slice(0, 13)}`;
    planned.push(await this.enqueueJob('scout_sources', '', { idempotencyKey: scoutKey, priority: 10 }));
    for (const lead of scoutEnrichmentCandidates(this.store.listLeads(), planningLimit)) {
      planned.push(
        await this.enqueueJob('enrich_lead', lead.id, {
          idempotencyKey: `enrich:${lead.id}:contact-gate:v1`,
          priority: pipelineJobPriority(lead, 350),
        }),
      );
    }
    for (const action of this.topActions(planningLimit).filter((item) => item.autoRunnable)) {
      const lead = action.lead;
      const jobType = jobTypeForAction(action.action);
      if (!jobType) continue;
      const idempotencyKey = jobIdempotencyKey(lead, action.action, jobType);
      planned.push(
        await this.enqueueJob(jobType, lead.id, {
          idempotencyKey,
          priority: jobPriorityForAction(action, lead),
          payload: { action: action.action, rebuild: action.action === 'rebuild_lovable' },
        }),
      );
    }
    return planned.filter(Boolean).map((item) => ({
      id: item.job?.id,
      type: item.job?.type,
      leadId: item.job?.leadId,
      deduped: item.deduped,
    }));
  }

  async enqueueJob(type, leadId, options = {}) {
    const supersedeSameLeadType = ['lovable_build', 'customer_preview_build', 'customer_revision_triage', 'customer_revision_apply', 'coder_deploy', 'filmer_render', 'checker_eval', 'outbound_queue'].includes(type);
    return this.store.enqueueJob({
      type,
      leadId,
      priority: options.priority,
      payload: options.payload,
      idempotencyKey: options.idempotencyKey,
      nextRunAt: options.nextRunAt,
      maxAttempts: options.maxAttempts || config.AUTONOMY_DEAD_AFTER_ATTEMPTS,
      supersedeSameLeadType,
    });
  }

  async runJob(job) {
    switch (job.type) {
      case 'scout_sources':
        return this.runScoutJob();
      case 'enrich_lead':
        return this.runEnrichLeadJob(job.leadId);
      case 'diagnose_lead':
        return this.runDiagnoseJob(job.leadId);
      case 'lovable_build':
        return this.runLovableBuildJob(job.leadId, { rebuild: Boolean(job.payload?.rebuild) });
      case 'customer_preview_build':
        return this.runLovableBuildJob(job.leadId, { skipQuota: true, customerChatId: job.payload?.chatId, rebuild: Boolean(job.payload?.rebuild) });
      case 'customer_revision_triage':
        return this.runCustomerRevisionTriageJob(job.leadId, job.payload || {});
      case 'customer_revision_apply':
        return this.runCustomerRevisionApplyJob(job.leadId, job.payload || {});
      case 'coder_deploy':
        return this.runCoderDeployJob(job.leadId);
      case 'filmer_render':
        return this.runFilmerJob(job.leadId);
      case 'checker_eval':
        return this.runCheckerJob(job.leadId);
      case 'outbound_queue':
        return this.runOutboundJob(job.leadId);
      case 'outbound_followup_1':
        return this.runFollowupJob(job.leadId, 1);
      case 'outbound_followup_2':
        return this.runFollowupJob(job.leadId, 2);
      case 'a1_sync':
        return this.runA1SyncJob(job.leadId, job.payload?.reason || 'job');
      default:
        throw new Error(`Unknown job type: ${job.type}`);
    }
  }

  async runScoutJob() {
    const scout = await this.scout();
    return { ok: Boolean(scout.ok), scout };
  }

  async runDiagnoseJob(leadId) {
    let lead = this.store.getLead(leadId);
    if (!lead) throw new Error('Lead not found');
    const gate = await this.checkGates(lead);
    if (!gate.ok) throw new Error(gate.reason || gate.error || 'Gate failed');
    const contactGate = await this.prepareScoutLeadForDiagnosis(lead);
    if (!contactGate.ok) return contactGate;
    lead = contactGate.lead;
    if (!lead.url || !/^https?:\/\//i.test(lead.url)) {
      const discovery = await discoverLeadSite(lead).catch((error) => ({ ok: false, reason: error.message }));
      if (discovery?.ok && discovery.url) {
        lead = await this.store.updateLead(lead.id, {
          url: discovery.url,
          site: 'сайт есть',
          siteDiscovery: discovery,
        });
        await this.store.addEvent(lead.id, 'site.discovered', `Site discovered via ${discovery.source}: ${discovery.url}`);
      } else if (discovery && !discovery.skipped) {
        await this.store.updateLead(lead.id, { siteDiscovery: discovery });
      }
    }
    Object.assign(lead, await diagnoseLead(lead));
    enrichLeadScore(lead);
    lead = await this.store.updateLead(lead.id, lead);
    lead = await this.store.transitionLead(lead.id, {
      pipelineStage: 'diagnosed',
      stageStatus: 'in_progress',
      reason: 'diagnosis_created',
      patch: lead,
    });
    await this.store.addEvent(lead.id, 'diagnosis.created', 'Diagnoser prepared diagnosis, message and fitScore');
    await this.addA1Event(lead, 'diagnosis.created', 'Diagnoser created diagnosis, cold message and fitScore', {
      diagnosis: lead.diagnosis,
      angle: lead.angle,
      message: lead.message,
      fitScore: lead.fitScore,
    });
    await this.enqueueJob('a1_sync', lead.id, { idempotencyKey: `a1_sync:${lead.id}:diagnosis:${lead.updatedAt}`, priority: 20, payload: { reason: 'diagnosis' } });
    return { ok: true, lead };
  }

  async runLovableBuildJob(leadId, { skipQuota = false, customerChatId = '', rebuild = false } = {}) {
    let lead = this.store.getLead(leadId);
    if (!lead) throw new Error('Lead not found');
    if (['telegram_inbound', 'web_inbound'].includes(lead.source) || customerChatId) {
      const issues = customerBriefSafetyIssues(lead);
      if (issues.length) {
        await this.store.cancelLeadJobs(lead.id, ['customer_preview_build', 'lovable_build', 'coder_deploy', 'filmer_render', 'checker_eval', 'outbound_queue'], 'Customer brief safety gate failed');
        await this.store.transitionLead(lead.id, {
          pipelineStage: 'needs_review',
          stageStatus: 'content_review_required',
          artifactStatus: 'blocked',
          lane: 'Диагноз',
          owner: 'Mobile',
          reason: 'customer_brief_safety_gate_failed',
        });
        await this.store.addEvent(lead.id, 'customer.brief_safety_blocked', issues.join('; '));
        if (customerChatId) {
          await sendTelegramTo(customerChatId, 'Пока не запускаю сборку: в ТЗ есть рискованная тематика или некорректные поля. Можно собрать ТЗ заново через /reset.');
        }
        await sendTelegram(`<b>Customer preview blocked by safety gate</b>\nЛид: ${lead.name}\nID: <code>${lead.id}</code>\nПричины: <code>${issues.join('; ').slice(0, 700)}</code>`);
        return { ok: true, skipped: true, reason: 'customer_brief_safety_gate_failed', issues };
      }
    }
    enrichLeadScore(lead);
    if (rebuild) {
      const attempts = Number(lead.mockup?.rebuildAttempts ?? 0) + 1;
      lead = await this.store.updateLead(lead.id, {
        mockup: {
          previousStatus: lead.mockup?.status || '',
          previousMode: lead.mockup?.mode || '',
          previousPublicUrl: lead.mockup?.publicUrl || lead.mockup?.deployedUrl || lead.mockup?.publishedUrl || '',
          rebuildAttempts: attempts,
          status: 'rebuild_queued',
        },
        qualityGate: null,
        checker: null,
        outboundPackage: null,
        outboundStatus: '',
      });
    }
    const quotaFreeBuild = skipQuota || ['telegram_inbound', 'web_inbound', 'manual_smoke'].includes(lead.source);
    if (!quotaFreeBuild && !isLovableEligible(lead)) {
      await this.store.transitionLead(lead.id, {
        pipelineStage: 'diagnosed',
        stageStatus: 'needs_email_enrichment',
        lane: 'Диагноз',
        owner: 'Scout',
        reason: 'lovable_requires_email_contact',
      });
      const patch = {
        outboundStatus: 'needs_channel_decision',
      };
      if (lead.mockup) {
        patch.mockup = {
          ...lead.mockup,
          status: 'blocked_no_email',
          blockedAt: new Date().toISOString(),
        };
      }
      await this.store.updateLead(lead.id, patch);
      return { ok: true, skipped: true, reason: 'lovable_requires_email_contact' };
    }
    if (!quotaFreeBuild && !this.lovableCandidates().some((candidate) => candidate.id === lead.id)) {
      await this.store.transitionLead(lead.id, { pipelineStage: 'diagnosed', stageStatus: 'quota_wait', reason: 'lovable_daily_quota_wait' });
      return { ok: true, skipped: true, reason: 'quota_wait' };
    }
    if (!quotaFreeBuild) {
      const slot = await this.store.reserveLovableBuildSlot({ intervalHours: config.LOVABLE_BUILD_INTERVAL_HOURS });
      if (!slot.ok) {
        await this.enqueueJob('lovable_build', lead.id, {
          idempotencyKey: `lovable_build:${lead.id}:scheduled:${slot.nextRunAt}`,
          priority: lovableJobPriority(lead),
          nextRunAt: slot.nextRunAt,
        });
        await this.store.transitionLead(lead.id, {
          pipelineStage: 'lovable_queued',
          stageStatus: 'scheduled',
          reason: `lovable_throttled_until_${slot.nextRunAt}`,
        });
        return { ok: true, skipped: true, reason: 'lovable_throttled', nextRunAt: slot.nextRunAt };
      }
    }
    lead = await this.store.transitionLead(lead.id, { pipelineStage: 'lovable_building', stageStatus: 'running', artifactStatus: 'building', reason: 'lovable_job_started' });
    let mockup;
    try {
      mockup = await prepareLovableMockup(lead);
    } catch (error) {
      mockup = {
        ok: false,
        mode: 'lovable_exception',
        status: 'failed',
        reason: error.message || String(error),
        updatedAt: new Date().toISOString(),
      };
    }
    if (quotaFreeBuild) {
      this.store.state.metrics.customerMockupsToday = Number(this.store.state.metrics.customerMockupsToday ?? 0) + 1;
    } else {
      this.store.state.metrics.mockupsToday = Number(this.store.state.metrics.mockupsToday ?? 0) + 1;
    }
    lead = await this.store.updateLead(lead.id, { mockup, status: mockup?.status || 'in_progress' });
    if (mockup?.status === 'export_ready') {
      lead = await this.store.transitionLead(lead.id, {
        pipelineStage: 'lovable_export_ready',
        stageStatus: 'ready',
        artifactStatus: 'export_ready',
        reason: 'lovable_export_ready',
      });
      await this.store.addEvent(lead.id, 'mockup.export_ready', `Lovable returned ${mockup.files?.length || 0} source file(s)`);
      await this.enqueueJob('coder_deploy', lead.id, { idempotencyKey: `coder_deploy:${lead.id}:${mockup.latestRef || mockup.updatedAt || lead.updatedAt}`, priority: pipelineJobPriority(lead, 900) });
      if (customerChatId) await this.store.updateLead(lead.id, { customerTelegram: { ...(lead.customerTelegram ?? {}), pendingPreviewChatId: customerChatId } });
      await this.addA1Event(lead, 'mockup.export_ready', 'Lovable returned source files', { mockup });
      return { ok: true, lead };
    }
    if (mockup?.status === 'public_url_attached') {
      lead = await this.store.transitionLead(lead.id, {
        pipelineStage: 'lovable_export_ready',
        stageStatus: 'ready',
        artifactStatus: 'public_url_attached',
        reason: 'lovable_public_url_attached',
      });
      await this.enqueueJob('coder_deploy', lead.id, { idempotencyKey: `coder_deploy:${lead.id}:${mockup.publishedUrl || mockup.url || lead.updatedAt}`, priority: pipelineJobPriority(lead, 900) });
      if (customerChatId) await this.store.updateLead(lead.id, { customerTelegram: { ...(lead.customerTelegram ?? {}), pendingPreviewChatId: customerChatId } });
      return { ok: true, lead };
    }
    if (mockup?.status === 'failed') {
      const reason = mockup.reason || 'Lovable build failed';
      await this.store.addEvent(lead.id, 'lovable.failed_template_fallback', reason);
      const generated = await deployLeadGeneratedPreview(this.store, lead.id, {
        reason,
        projectName: lead.name,
        renderVideo: false,
      });
      lead = generated.lead || this.store.getLead(lead.id) || lead;
      const quality = await runPreviewQualityGate(lead);
      lead = await this.store.updateLead(lead.id, { qualityGate: quality });
      if (!generated.ok || !quality.ok) {
        await this.store.transitionLead(lead.id, { pipelineStage: 'needs_review', stageStatus: 'template_preview_failed', artifactStatus: 'quality_failed', lane: 'Lovable', owner: 'Builder', reason: quality.issues?.join('; ') || generated.error || reason });
        await sendTelegram(`<b>Lovable failed and Coder template fallback failed</b>\n${lead.name}\nLovable: ${reason}\nTemplate: ${quality.issues?.join('; ') || generated.error || 'unknown'}`);
        throw new Error(`Template fallback failed: ${quality.issues?.join('; ') || generated.error || reason}`);
      }
      lead = await this.store.transitionLead(lead.id, { pipelineStage: 'deployed', stageStatus: 'template_quality_passed', artifactStatus: 'deployed', reason: 'coder_template_fallback_after_lovable_failed' });
      await this.enqueueJob('filmer_render', lead.id, { idempotencyKey: `filmer:${lead.id}:${lead.mockup?.publicUrl || lead.updatedAt}`, priority: pipelineJobPriority(lead, 800) });
      await this.addA1Event(lead, 'project.template_preview_deployed', 'Coder template fallback deployed after Lovable failed', { reason, qualityGate: quality, publicUrl: lead.mockup?.publicUrl || '' });
      await sendTelegram(`<b>Lovable недоступен, Coder собрал шаблонное превью</b>\n${lead.name}\n${lead.mockup?.publicUrl || ''}\nПричина Lovable: <code>${escapeHtml(reason).slice(0, 500)}</code>`);
      return { ok: true, lead, fallback: 'coder_template_preview', reason };
    }
    await this.store.transitionLead(lead.id, { pipelineStage: 'lovable_building', stageStatus: 'handoff_required', artifactStatus: mockup?.status || 'waiting', reason: 'waiting_lovable_handoff' });
    return { ok: true, lead: this.store.getLead(lead.id), waiting: true };
  }

  async runCustomerRevisionTriageJob(leadId, payload = {}) {
    let lead = this.store.getLead(leadId);
    if (!lead) throw new Error('Lead not found');
    const text = payload.text || lead.revision?.text || '';
    if (!text) throw new Error('Revision text is empty');
    if (!isRevisionPaymentOk(lead)) {
      lead = await this.store.updateLead(lead.id, {
        status: 'revision_payment_required',
        revision: { ...(lead.revision ?? {}), text, paymentRequired: true, status: 'payment_required' },
        payment: { ...(lead.payment ?? {}), status: lead.payment?.status || 'revision_payment_required' },
      });
      await this.store.addEvent(lead.id, 'customer.revision_payment_required', `Revision blocked until payment: ${text}`);
      if (payload.chatId) await sendTelegramTo(payload.chatId, revisionPaymentRequiredText(lead));
      return { ok: true, skipped: true, reason: 'revision_payment_required', lead };
    }
    const route = payload.route ? { route: payload.route, reason: 'payload_route' } : classifyCustomerRevision(text);
    lead = await this.store.updateLead(lead.id, {
      revision: {
        ...(lead.revision ?? {}),
        text,
        route: route.route,
        routeReason: route.reason,
        triagedAt: new Date().toISOString(),
        status: 'triaged',
      },
    });
    await this.store.addEvent(lead.id, 'customer.revision_triaged', `Revision route: ${route.route}`);
    if (route.route === 'lovable') {
      const notes = [lead.customerBrief?.notes, `Правка клиента: ${text}`].filter(Boolean).join('\n');
      lead = await this.store.updateLead(lead.id, {
        customerBrief: { ...(lead.customerBrief ?? {}), notes },
        revision: { ...(lead.revision ?? {}), status: 'lovable_queued' },
      });
      const queued = await this.enqueueJob('customer_preview_build', lead.id, {
        idempotencyKey: `customer_revision_lovable:${lead.id}:${payload.requestedAt || lead.revision?.requestedAt || lead.updatedAt}`,
        priority: lovableJobPriority(lead),
        payload: { chatId: payload.chatId, rebuild: true, revisionText: text },
      });
      if (payload.chatId) await sendTelegramTo(payload.chatId, 'Правка требует глубокой переработки. Передал задачу в Lovable, после деплоя и проверки пришлю новую ссылку.');
      return { ok: true, lead, route, queued };
    }
    const queued = await this.enqueueJob('customer_revision_apply', lead.id, {
      idempotencyKey: `customer_revision_apply:${lead.id}:${payload.requestedAt || lead.revision?.requestedAt || lead.updatedAt}`,
      priority: pipelineJobPriority(lead, 850),
      payload: { chatId: payload.chatId, text, requestedAt: payload.requestedAt },
    });
    if (payload.chatId) await sendTelegramTo(payload.chatId, 'Правка понятна. Coder внесет изменение в текущий сайт, затем пройдет сборка и проверка.');
    return { ok: true, lead, route, queued };
  }

  async runCustomerRevisionApplyJob(leadId, payload = {}) {
    let lead = this.store.getLead(leadId);
    if (!lead) throw new Error('Lead not found');
    const text = payload.text || lead.revision?.text || '';
    if (!isRevisionPaymentOk(lead)) {
      await this.store.updateLead(lead.id, {
        status: 'revision_payment_required',
        revision: { ...(lead.revision ?? {}), text, paymentRequired: true, status: 'payment_required' },
      });
      if (payload.chatId) await sendTelegramTo(payload.chatId, revisionPaymentRequiredText(lead));
      return { ok: true, skipped: true, reason: 'revision_payment_required', lead };
    }
    const result = await applySimpleRevisionToSourceProject(this.store, lead.id, { text, renderVideo: false });
    lead = result.lead || this.store.getLead(lead.id) || lead;
    if (!result.ok) throw new Error(result.error || 'Customer revision apply failed');
    const quality = await runPreviewQualityGate(lead);
    lead = await this.store.updateLead(lead.id, { qualityGate: quality });
    if (!quality.ok) {
      await this.store.transitionLead(lead.id, {
        pipelineStage: 'needs_review',
        stageStatus: 'revision_quality_failed',
        artifactStatus: 'quality_failed',
        lane: 'Lovable',
        owner: 'Orchestrator',
        reason: quality.issues?.join('; ') || 'revision_quality_failed',
      });
      throw new Error(`Revision quality failed: ${quality.issues?.join('; ') || 'unknown'}`);
    }
    if (payload.chatId) {
      await sendTelegramTo(payload.chatId, `Готово, внес правку и обновил сайт:\n${result.publicUrl}\n\nЕсли нужно еще что-то поправить, отправьте /revision.`);
    }
    return { ok: true, lead, result, quality };
  }

  async runCoderDeployJob(leadId) {
    let lead = this.store.getLead(leadId);
    if (!lead) throw new Error('Lead not found');
    let deployed;
    if (lead.mockup?.status === 'deployed' && (lead.mockup?.publicUrl || lead.mockup?.publishedUrl || lead.mockup?.deployedUrl)) {
      deployed = { ok: true, skipped: true, reason: 'already_deployed' };
    } else if (lead.mockup?.status === 'build_failed' && lead.mockup?.sourceRoot && lead.mockup?.projectSlug) {
      deployed = await repairLeadSourceProject(this.store, lead.id, { renderVideo: false });
    } else if (lead.mockup?.status === 'public_url_attached' || lead.status === 'public_url_attached') {
      deployed = await deployLeadPublicUrlProject(this.store, lead.id, { renderVideo: false });
    } else if (lead.mockup?.status === 'export_ready' || lead.status === 'export_ready') {
      deployed = await deployLeadExportedProject(this.store, lead.id, {
        files: lead.mockup?.files ?? [],
        lovable: lovableExportMeta(lead.mockup),
        projectName: lead.mockup?.projectName || lead.name,
        renderVideo: false,
      });
    } else {
      throw new Error('No deployable Lovable artifact');
    }
    if (!deployed.ok) {
      const reason = deployed.error || 'Coder deploy failed';
      await this.store.transitionLead(lead.id, {
        pipelineStage: 'needs_review',
        stageStatus: 'deploy_failed',
        artifactStatus: 'build_failed',
        lane: 'Lovable',
        owner: 'Builder',
        reason,
      });
      await sendTelegram(`<b>Coder deploy failed</b>\n${lead.name}\n${reason}`);
      throw new Error(reason);
    }
    lead = this.store.getLead(lead.id);
    const quality = await runPreviewQualityGate(lead);
    lead = await this.store.updateLead(lead.id, { qualityGate: quality });
    if (!quality.ok) {
      await this.store.transitionLead(lead.id, { pipelineStage: 'needs_review', stageStatus: 'quality_failed', artifactStatus: 'quality_failed', lane: 'Lovable', owner: 'Builder', reason: quality.issues.join('; ') });
      await sendTelegram(`<b>Preview quality gate failed</b>\n${lead.name}\n${quality.issues.join('; ')}`);
      throw new Error(`Preview quality failed: ${quality.issues.join('; ')}`);
    }
    lead = this.store.getLead(lead.id);
    lead = await this.store.transitionLead(lead.id, { pipelineStage: 'deployed', stageStatus: 'quality_passed', artifactStatus: 'deployed', reason: 'coder_deploy_quality_passed' });
    if (lead.customerTelegram?.pendingPreviewChatId) {
      const previewUrl = absolutePublicUrl(lead.mockup?.publishedUrl || lead.mockup?.deployedUrl || lead.mockup?.publicUrl || '');
      await sendTelegramTo(
        lead.customerTelegram.pendingPreviewChatId,
        `Первое превью готово и прошло проверку:\n${previewUrl}\n\nЕсли направление подходит — нажмите «Превью подходит» или отправьте /approve еще раз. Если нужны правки — напишите обычным сообщением.`,
      );
      await this.store.updateLead(lead.id, {
        customerTelegram: {
          ...(lead.customerTelegram ?? {}),
          state: 'preview_ready',
          pendingPreviewChatId: '',
        },
      });
    }
    await this.enqueueJob('filmer_render', lead.id, { idempotencyKey: `filmer:${lead.id}:${lead.mockup?.publicUrl || lead.updatedAt}`, priority: pipelineJobPriority(lead, 800) });
    await this.addA1Event(lead, 'project.quality_passed', 'Coder deploy passed quality gate', { qualityGate: quality });
    return { ok: true, lead, quality };
  }

  async runFilmerJob(leadId) {
    let lead = this.store.getLead(leadId);
    if (!lead) throw new Error('Lead not found');
    const artifactGate = await this.requireDeployedSite(lead);
    if (!artifactGate.ok) throw new Error(artifactGate.reason || 'No deployed site');
    const quality = await ensureQualityGate(lead);
    if (quality !== lead.qualityGate) lead = await this.store.updateLead(lead.id, { qualityGate: quality });
    if (!quality.ok) {
      await this.store.updateLead(lead.id, {
        video: { ok: false, reason: 'preview_quality_not_passed_before_filmer', invalidatedAt: new Date().toISOString() },
        outboundStatus: 'blocked_quality_failed',
      });
      await this.store.transitionLead(lead.id, {
        pipelineStage: 'needs_review',
        stageStatus: 'preview_quality_failed',
        artifactStatus: 'quality_failed',
        lane: 'Lovable',
        owner: 'Builder',
        reason: quality.issues?.join('; ') || 'preview_quality_failed',
      });
      await sendTelegram(`<b>Filmer blocked by quality gate</b>\n${lead.name}\n${quality.issues?.join('; ') || 'preview_quality_failed'}`);
      throw new Error(`Preview quality failed before filming: ${quality.issues?.join('; ') || 'unknown'}`);
    }
    if (lead.video?.ok && lead.video?.videoUrl) {
      if (!lead.checker?.passed && lead.lane !== 'Отправка') {
        await this.enqueueJob('checker_eval', lead.id, { idempotencyKey: `checker:${lead.id}:${lead.video.videoUrl}`, priority: pipelineJobPriority(lead, 700) });
      }
      return { ok: true, skipped: true, reason: 'video_already_ready', lead, video: lead.video };
    }
    const video = await renderLeadVideo(lead);
    lead = await this.store.updateLead(lead.id, { video });
    if (!video.ok) {
      await this.store.transitionLead(lead.id, { pipelineStage: 'needs_review', stageStatus: 'video_failed', artifactStatus: 'video_failed', reason: video.reason || 'video_failed' });
      await sendTelegram(`<b>Filmer failed</b>\n${lead.name}\n${video.reason || 'unknown error'}`);
      throw new Error(video.reason || 'Video render failed');
    }
    lead = await this.store.transitionLead(lead.id, { pipelineStage: 'media_ready', stageStatus: 'in_progress', artifactStatus: 'media_ready', reason: 'video_created' });
    await this.store.addEvent(lead.id, 'video.created', `Filmer rendered video: ${video.videoUrl}`);
    await this.addA1Event(lead, 'video.created', `Filmer rendered video: ${video.videoUrl}`, { video });
    if (lead.source === 'telegram_inbound') {
      lead = await this.store.transitionLead(lead.id, {
        pipelineStage: 'qualified',
        stageStatus: 'preview_ready',
        artifactStatus: 'media_ready',
        lane: 'Ответы',
        owner: 'Mobile',
        reason: 'customer_preview_media_ready',
      });
      await this.store.updateLead(lead.id, {
        outboundStatus: 'not_applicable_customer_inbound',
        customerTelegram: {
          ...(lead.customerTelegram ?? {}),
          state: 'preview_ready',
        },
      });
      return { ok: true, lead: this.store.getLead(lead.id), video, skippedChecker: true };
    }
    await this.enqueueJob('checker_eval', lead.id, { idempotencyKey: `checker:${lead.id}:${video.videoUrl || lead.updatedAt}`, priority: pipelineJobPriority(lead, 700) });
    return { ok: true, lead, video };
  }

  async runCheckerJob(leadId) {
    let lead = this.store.getLead(leadId);
    if (!lead) throw new Error('Lead not found');
    const artifactGate = await this.requireDeployedSite(lead);
    if (!artifactGate.ok) throw new Error(artifactGate.reason || 'No deployed site');
    if (!lead.qualityGate?.ok) {
      const quality = await ensureQualityGate(lead);
      if (quality !== lead.qualityGate) lead = await this.store.updateLead(lead.id, { qualityGate: quality });
      if (!quality.ok) {
        const reason = `preview_quality_not_passed: ${quality.issues?.join('; ') || 'unknown'}`;
        await this.store.updateLead(lead.id, {
          outboundStatus: 'blocked',
          outboundPackage: { ok: false, issues: ['preview_quality_not_passed'], channel: 'email' },
        });
        await this.store.transitionLead(lead.id, {
          pipelineStage: 'needs_review',
          stageStatus: 'preview_quality_failed',
          artifactStatus: 'quality_failed',
          lane: 'Lovable',
          owner: 'Builder',
          reason,
        });
        throw new Error(reason);
      }
    }
    const packageGate = outboundPackageGate(lead);
    lead.checker = await evaluatePitch({
      ...lead,
      channel: 'email',
      checkerMode: 'scout_email',
      message: packageGate.body || lead.message,
      outboundPackage: packageGate,
    });
    if (!packageGate.ok || !lead.checker.passed) {
      lead.message = lead.checker.revisedMessage || lead.message;
      lead = await this.store.updateLead(lead.id, { checker: lead.checker, message: lead.message, outboundPackage: packageGate, status: 'needs_review' });
      await this.store.transitionLead(lead.id, { pipelineStage: 'needs_review', stageStatus: 'checker_failed', artifactStatus: lead.artifactStatus, lane: packageGate.issues.includes('preview_quality_not_passed') ? 'Lovable' : 'Проверка', reason: [...packageGate.issues, ...(lead.checker.issues || [])].join('; ') });
      throw new Error(`Checker failed: ${[...packageGate.issues, ...(lead.checker.issues || [])].join('; ')}`);
    }
    lead.message = lead.checker.revisedMessage || lead.message;
    lead = await this.store.updateLead(lead.id, { checker: lead.checker, message: lead.message, outboundPackage: packageGate });
    lead = await this.store.transitionLead(lead.id, { pipelineStage: 'outbound_ready', stageStatus: 'ready', reason: 'checker_passed' });
    await this.store.addEvent(lead.id, 'checker.passed', `Checker passed: ${lead.checker.score}`);
    await this.addA1Event(lead, 'checker.passed', `Checker passed: ${lead.checker.score}`, { checker: lead.checker, outboundPackage: packageGate });
    await this.enqueueJob('outbound_queue', lead.id, { idempotencyKey: stableOutboundKey(lead), priority: pipelineJobPriority(lead, 600) });
    return { ok: true, lead };
  }

  async runOutboundJob(leadId) {
    let lead = this.store.getLead(leadId);
    if (!lead) throw new Error('Lead not found');
    if (lead.pitch?.queued || ['queued', 'sent', 'succeeded'].includes(String(lead.outboundStatus || ''))) {
      return { ok: true, skipped: true, reason: 'outbound_already_queued_or_sent' };
    }
    if (String(lead.outboundStatus || '').startsWith('blocked')) {
      return { ok: true, skipped: true, reason: lead.outboundStatus };
    }
    const workingWindow = outboundWorkingWindow();
    if (!workingWindow.open) {
      await this.store.updateLead(lead.id, {
        outboundStatus: 'scheduled_working_hours',
        outboundScheduledAt: workingWindow.nextRunAt,
      });
      await this.enqueueJob('outbound_queue', lead.id, {
        idempotencyKey: `${stableOutboundKey(lead)}:${workingWindow.nextRunAt.slice(0, 10)}`,
        priority: pipelineJobPriority(lead, 600),
        nextRunAt: workingWindow.nextRunAt,
      });
      return { ok: true, skipped: true, reason: 'outside_working_hours', nextRunAt: workingWindow.nextRunAt };
    }
    lead.contacts = await enrichContacts(lead);
    const emailChannel = lead.contacts.channels?.find((channel) => channel.type === 'email') || null;
    if (!emailChannel?.value) {
      await this.store.updateLead(lead.id, { contacts: lead.contacts, outboundStatus: 'needs_channel_decision' });
      await this.store.transitionLead(lead.id, { pipelineStage: 'needs_review', stageStatus: 'needs_channel_decision', lane: 'Отправка', owner: 'Pitcher', reason: 'no_verified_email' });
      await sendTelegram(`<b>Нужен канал отправки</b>\n${lead.name}\nEmail не найден. Автоотправка остановлена.`);
      throw new Error('No verified email');
    }
    const packageGate = outboundPackageGate(lead);
    if (!packageGate.ok) {
      await this.store.updateLead(lead.id, { outboundPackage: packageGate, outboundStatus: 'blocked' });
      await this.store.transitionLead(lead.id, {
        pipelineStage: 'needs_review',
        stageStatus: 'outbound_blocked',
        lane: 'Отправка',
        owner: 'Pitcher',
        reason: packageGate.issues.join('; '),
      });
      throw new Error(`Outbound package blocked: ${packageGate.issues.join('; ')}`);
    }
    const freshQuality = await ensureQualityGate(lead);
    if (freshQuality !== lead.qualityGate) lead = await this.store.updateLead(lead.id, { qualityGate: freshQuality });
    if (!freshQuality.ok) {
      await this.store.updateLead(lead.id, { outboundStatus: 'blocked_quality_failed' });
      await this.store.transitionLead(lead.id, {
        pipelineStage: 'needs_review',
        stageStatus: 'preview_quality_failed',
        artifactStatus: 'quality_failed',
        lane: 'Lovable',
        owner: 'Builder',
        reason: freshQuality.issues?.join('; ') || 'preview_quality_failed',
      });
      throw new Error(`Preview quality gate is not passed: ${freshQuality.issues?.join('; ') || 'unknown'}`);
    }
    if (!lead.checker?.passed) throw new Error('Checker is not passed');
    const botLink = customerBotLink(lead);
    const rawSiteUrl = absolutePublicUrl(lead.mockup?.publishedUrl || lead.mockup?.deployedUrl || lead.mockup?.publicUrl || '');
    const rawVideoUrl = absolutePublicUrl(lead.video?.videoUrl || '');
    const variant = pickSubjectVariant(lead, this.store);
    const subject = (variant?.text || '').trim() || outboundEmailSubject(lead);
    const subjectVariantId = variant?.id || variantId(subject);
    const siteUrl = rawSiteUrl ? trackingUrl({ leadId: lead.id, kind: 'preview', target: rawSiteUrl, variantId: subjectVariantId, stage: 0 }) : '';
    const videoUrl = rawVideoUrl ? trackingUrl({ leadId: lead.id, kind: 'video', target: rawVideoUrl, variantId: subjectVariantId, stage: 0 }) : '';
    const trackedBotLink = botLink ? trackingUrl({ leadId: lead.id, kind: 'bot', target: botLink, variantId: subjectVariantId, stage: 0 }) : '';
    const message = outboundEmailBody(lead, { botLink: trackedBotLink, siteUrl, videoUrl });
    const telegramFollowup = buildTelegramFollowupArtifact(lead, { email: emailChannel.value });
    const outbound = await outboundQueueMessage({
      a1LeadId: lead.a1LeadId || lead.a1?.leadId || '',
      externalId: lead.id,
      dedupeKey: `webstudio:${lead.id}`,
      to: emailChannel.value,
      senderProfile: '1lab',
      fromAddress: '1lab@1true.ru',
      purpose: 'sales_outbound',
      subject,
      body: message,
      attachments: [
        siteUrl ? { type: 'link', url: siteUrl, title: 'Превью сайта' } : null,
        videoUrl ? { type: 'link', url: videoUrl, title: 'Видео-превью' } : null,
        trackedBotLink ? { type: 'link', url: trackedBotLink, title: 'Бот для правок и ТЗ' } : null,
      ].filter(Boolean),
      deliveryPolicy: {
        workingHoursOnly: true,
        timezone: config.OUTBOUND_TIMEZONE,
        startHour: config.OUTBOUND_WORKING_HOURS_START,
        endHour: config.OUTBOUND_WORKING_HOURS_END,
      },
      idempotencyKey: stableOutboundKey(lead),
    });
    const sentNow = outboundWasSent(outbound);
    const item = await this.store.addOutreachQueueItem({
      leadId: lead.id,
      status: sentNow ? 'sent' : 'queued',
      channel: 'Email',
      to: emailChannel.value,
      subject,
      message,
      fitScore: lead.fitScore ?? 0,
      a1Outbound: outbound,
      subjectVariantId,
      subjectVariantAngle: variant?.angle || '',
      trackedLinks: { preview: siteUrl, video: videoUrl, bot: trackedBotLink },
      telegramFollowup,
    });
    lead = await this.store.updateLead(lead.id, {
      contacts: lead.contacts,
      pitch: { ok: outbound.ok, queued: !sentNow, sent: sentNow, queueId: item.id, channel: item.channel, updatedAt: new Date().toISOString(), a1Outbound: outbound, subjectVariantId, subjectVariantAngle: variant?.angle || '' },
      outboundStatus: outbound.ok ? (sentNow ? 'sent' : 'queued') : 'failed',
      outboundScheduledAt: '',
      subjectVariantId,
      telegramFollowup: {
        ...(lead.telegramFollowup ?? {}),
        ...telegramFollowup,
        status: outbound.ok ? 'prepared' : 'not_prepared',
        updatedAt: new Date().toISOString(),
      },
    });
    if (!outbound.ok) throw new Error(outbound.error || outbound.reason || 'A1 outbound queue failed');
    if (sentNow) await recordSubjectSend(this.store, subjectVariantId);
    lead = await this.store.transitionLead(lead.id, { pipelineStage: 'outbound_sent', stageStatus: sentNow ? 'sent' : 'queued', reason: sentNow ? 'outbound_sent_by_a1' : 'outbound_queued_in_a1' });
    await this.store.addEvent(lead.id, sentNow ? 'pitch.sent' : 'pitch.queued', sentNow ? `Pitcher sent message via A1: ${item.channel} (subj=${variant?.angle || 'primary'})` : `Pitcher queued message: ${item.channel} (subj=${variant?.angle || 'primary'})`);
    await this.addA1Event(lead, sentNow ? 'outbound.sent' : 'outbound.queued', sentNow ? 'Pitcher sent outbound email via A1' : 'Pitcher queued outbound email in A1', { queueItem: item, outbound, subjectVariantId, subjectVariantAngle: variant?.angle || '' });
    await this.store.addEvent(lead.id, 'outbound.telegram_followup_prepared', 'Pitcher prepared Telegram follow-up after email');
    await this.addA1Event(lead, 'outbound.telegram_followup_prepared', 'Telegram follow-up message prepared after outbound email', {
      telegramFollowup: telegramFollowupEventPayload(telegramFollowup),
      queueItem: item,
      subjectVariantId,
    });
    if (sentNow) {
      await this.scheduleFollowups(lead);
    }
    return { ok: true, lead, outbound, subjectVariantId };
  }

  async runA1SyncJob(leadId, reason = 'job') {
    const lead = this.store.getLead(leadId);
    if (!lead) throw new Error('Lead not found');
    const syncedLead = await this.syncLeadWithA1(lead, reason);
    await this.store.addEvent(lead.id, 'a1.crm.synced', `A1 CRM sync: ${syncedLead.a1Crm?.ok ? 'ok' : syncedLead.a1Crm?.reason || syncedLead.a1Crm?.error || 'failed'}`);
    return { ok: true, lead: syncedLead };
  }

  async runEnrichLeadJob(leadId) {
    const lead = this.store.getLead(leadId);
    if (!lead) throw new Error('Lead not found');
    if (!isScoutLane(lead)) return { ok: true, skipped: true, reason: 'not_scout_lane', lead };
    if (lead.status === 'contact_hold' || ['invalid_email_hold', 'no_verified_email_hold', 'awaiting_a1_email', 'a1_email_task_created', 'no_contacts'].includes(String(lead.stageStatus || ''))) {
      return { ok: true, skipped: true, reason: 'contact_gate_already_done', lead };
    }
    const result = await this.prepareScoutLeadForDiagnosis(lead);
    if (result.ok && result.lead) {
      await this.enqueueJob('diagnose_lead', result.lead.id, {
        idempotencyKey: `diagnose:${result.lead.id}:v1`,
        priority: pipelineJobPriority(result.lead, 420),
      });
    }
    return result;
  }

  async prepareScoutLeadForDiagnosis(lead) {
    if (!isScoutLane(lead)) return { ok: true, lead };
    const contacts = await enrichContacts(lead);
    const hasValidEmail = hasValidatedEmailContact({ ...lead, contacts });
    if (hasValidEmail) {
      const updated = await this.store.updateLead(lead.id, enrichLeadScore({
        ...lead,
        contacts,
        status: 'ready_for_diagnosis',
        stageStatus: 'email_verified',
        lastContactGateAt: new Date().toISOString(),
      }));
      await this.store.addEvent(updated.id, 'contacts.verified_for_diagnosis', `Verified email before diagnosis: ${contacts.emailValidation?.best?.value || contacts.emails?.[0] || 'email'}`);
      await this.addA1Event(updated, 'contacts.verified_for_diagnosis', 'Scout lead has verified email; diagnosis can run', { contacts });
      return { ok: true, lead: updated };
    }

    const hasAnyEmail = hasEmailContact({ ...lead, contacts });
    const hasPhone = Boolean(lead.phone || contacts.phone);
    const now = new Date().toISOString();
    const contactReview = {
      ...(lead.contactReview ?? {}),
      checkedAt: now,
      status: hasAnyEmail ? 'invalid_email' : 'no_email_found',
      hasAnyEmail,
      hasPhone,
      sources: contacts.sources,
      bestEmail: contacts.emailValidation?.best || null,
      candidates: contacts.emailValidation?.candidates || [],
    };

    if (!hasPhone && !hasAnyEmail) {
      const failed = await this.store.updateLead(lead.id, enrichLeadScore({
        ...lead,
        contacts,
        contactReview: { ...contactReview, status: 'no_contacts' },
        priority: Math.max(0, Number(lead.priority ?? 50) - 30),
        fitScore: 0,
        pipelineStage: 'failed',
        stageStatus: 'no_contacts',
        status: 'failed',
        lastTransitionReason: 'no_phone_no_verified_email_after_enrichment',
      }));
      await this.store.addEvent(failed.id, 'contacts.no_contacts_failed', 'No phone and no verified email after Scout enrichment; lead failed as no_contacts');
      await this.addA1Event(failed, 'contacts.no_contacts_failed', 'Lead failed: no phone and no verified email after enrichment', { contacts });
      return { ok: false, skipped: true, reason: 'no_contacts', lead: failed };
    }

    if (hasPhone) {
      return this.handoffPhoneOnlyLeadToA1(lead, contacts, contactReview, hasAnyEmail);
    }

    const held = await this.store.updateLead(lead.id, enrichLeadScore({
      ...lead,
      contacts,
      contactReview,
      priority: Math.max(0, Number(lead.priority ?? 50) - 15),
      pipelineStage: 'scouted',
      stageStatus: hasAnyEmail ? 'invalid_email_hold' : 'no_verified_email_hold',
      status: 'contact_hold',
      lastTransitionReason: hasAnyEmail ? 'email_not_valid_for_diagnosis' : 'no_verified_email_after_enrichment',
    }));
    await this.store.addEvent(held.id, hasAnyEmail ? 'contacts.invalid_email_hold' : 'contacts.no_email_hold', hasAnyEmail ? 'Email candidates failed validation; lead left in Scout with lower score' : 'No verified email found; lead left in Scout with lower score');
    await this.addA1Event(held, hasAnyEmail ? 'contacts.invalid_email_hold' : 'contacts.no_email_hold', hasAnyEmail ? 'Scout lead held: email candidates failed validation' : 'Scout lead held: no verified email found', { contacts });
    return { ok: false, skipped: true, reason: hasAnyEmail ? 'invalid_email' : 'no_verified_email', lead: held };
  }

  async handoffPhoneOnlyLeadToA1(lead, contacts, contactReview, hasAnyEmail = false) {
    const now = new Date().toISOString();
    let handedOff = await this.store.updateLead(lead.id, enrichLeadScore({
      ...lead,
      contacts,
      contactReview: {
        ...contactReview,
        status: hasAnyEmail ? 'invalid_email_phone_handoff' : 'phone_only_a1_handoff',
        handedOffToA1At: now,
      },
      priority: Math.max(0, Number(lead.priority ?? 50) - 8),
      pipelineStage: 'scouted',
      stageStatus: 'awaiting_a1_email',
      status: 'a1_email_lookup',
      lastTransitionReason: hasAnyEmail ? 'invalid_email_manager_lookup' : 'phone_only_manager_lookup',
      a1EmailLookup: {
        status: 'pending',
        requestedAt: now,
        reason: hasAnyEmail ? 'invalid_email_with_phone' : 'phone_only_no_email',
      },
    }));

    handedOff = await this.syncLeadWithA1(handedOff, 'phone_only_email_lookup');
    const a1LeadId = handedOff.a1LeadId || handedOff.a1?.leadId || handedOff.id;
    const stageMove = await crmMoveLeadStage({
      a1LeadId,
      externalId: handedOff.id,
      dedupeKey: `webstudio:${handedOff.id}`,
      stage: 'qualification',
      status: 'open',
      reason: 'phone_only_email_lookup',
      actor: 'web-studio-orchestrator',
      idempotencyKey: `webstudio:${handedOff.id}:stage:qualification:phone-email-lookup:v1`,
      payload: {
        webstudioStageStatus: 'awaiting_a1_email',
        phone: handedOff.phone || contacts.phone,
      },
    });
    const title = `Уточнить email: ${handedOff.name}`;
    const description = [
      `Лид из Web Studio: ${handedOff.name}`,
      `Город: ${handedOff.city || 'не указан'}`,
      `Ниша: ${handedOff.niche || 'не указана'}`,
      `Телефон: ${handedOff.phone || contacts.phone || 'не указан'}`,
      `Адрес: ${handedOff.address || 'не указан'}`,
      '',
      'Задача: связаться с клиентом только для уточнения рабочей почты и согласия на дальнейшую коммуникацию по email.',
      'Если email получен, отправьте webhook lead.contact_updated / lead.email_found с externalId и email.',
      'Если клиент отказался, переведите лид в отказ/провал в A1, чтобы Web Studio получила webhook и закрыла его локально.',
    ].join('\n');
    const task = await crmCreateManagerTask({
      a1LeadId,
      externalId: handedOff.id,
      dedupeKey: `webstudio:${handedOff.id}`,
      title,
      description,
      reason: 'phone_only_email_lookup',
      priority: Number(handedOff.fitScore || handedOff.priority || 0) >= 70 ? 'high' : 'normal',
      idempotencyKey: `webstudio:${handedOff.id}:manager-email-task:v1`,
      payload: {
        webstudioLead: {
          id: handedOff.id,
          name: handedOff.name,
          city: handedOff.city,
          niche: handedOff.niche,
          phone: handedOff.phone || contacts.phone,
          address: handedOff.address,
          score: handedOff.fitScore ?? handedOff.priority ?? 0,
        },
        contacts,
        contactReview,
      },
    });
    await this.addA1Event(handedOff, 'manager.email_required', 'Phone-only Scout lead handed to A1 manager to obtain email', {
      contacts,
      contactReview,
      managerTask: task,
    });
    const updated = await this.store.updateLead(handedOff.id, {
      a1EmailLookup: {
        ...(handedOff.a1EmailLookup || {}),
        status: task.ok ? 'task_created' : 'event_created',
        task,
        stageMove,
        taskCreatedAt: task.ok ? new Date().toISOString() : '',
        lastError: task.ok ? '' : task.error || task.reason || '',
      },
      stageStatus: task.ok ? 'a1_email_task_created' : 'awaiting_a1_email',
    });
    await this.store.addEvent(updated.id, task.ok ? 'a1.manager.email_task_created' : 'a1.manager.email_task_event_only', task.ok ? 'A1 manager task created to obtain email' : 'A1 manager task tool unavailable; timeline event emitted for email lookup');
    return { ok: false, skipped: true, reason: 'awaiting_a1_email', lead: updated, a1Task: task };
  }

  async scheduleFollowups(lead) {
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    const stages = [
      { stage: 1, jobType: 'outbound_followup_1', runAt: new Date(now.getTime() + 3 * day).toISOString(), priority: 550 },
      { stage: 2, jobType: 'outbound_followup_2', runAt: new Date(now.getTime() + 7 * day).toISOString(), priority: 540 },
    ];
    const followupsState = { ...(lead.followups || {}) };
    for (const stage of stages) {
      const key = `stage_${stage.stage}`;
      if (followupsState[key]?.sentAt) continue;
      const queued = await this.enqueueJob(stage.jobType, lead.id, {
        idempotencyKey: `webstudio:${lead.id}:followup:${stage.stage}:v1`,
        priority: stage.priority,
        nextRunAt: stage.runAt,
        payload: { stage: stage.stage },
      });
      followupsState[key] = {
        ...(followupsState[key] || {}),
        scheduledAt: stage.runAt,
        jobId: queued?.job?.id || followupsState[key]?.jobId || '',
        status: 'scheduled',
      };
    }
    await this.store.updateLead(lead.id, { followups: followupsState });
    return followupsState;
  }

  async cancelFollowups(leadId, reason = 'lead_replied') {
    const cancelled = await this.store.cancelLeadJobs(leadId, ['outbound_followup_1', 'outbound_followup_2'], reason);
    if (cancelled.length) {
      const lead = this.store.getLead(leadId);
      if (lead?.followups) {
        const next = { ...lead.followups };
        for (const job of cancelled) {
          const stage = job.payload?.stage || (job.type === 'outbound_followup_1' ? 1 : 2);
          const key = `stage_${stage}`;
          if (next[key] && !next[key].sentAt) {
            next[key] = { ...next[key], status: 'cancelled', cancelledReason: reason };
          }
        }
        await this.store.updateLead(leadId, { followups: next });
      }
    }
    return cancelled;
  }

  async runFollowupJob(leadId, stage) {
    let lead = this.store.getLead(leadId);
    if (!lead) throw new Error('Lead not found');
    const key = `stage_${stage}`;
    const followupsState = { ...(lead.followups || {}) };
    if (followupsState[key]?.sentAt) return { ok: true, skipped: true, reason: 'already_sent' };
    if (lead.reply?.text || ['replied', 'positive_reply', 'converted', 'paid'].includes(String(lead.status || ''))) {
      followupsState[key] = { ...(followupsState[key] || {}), status: 'cancelled', cancelledReason: 'lead_replied' };
      await this.store.updateLead(leadId, { followups: followupsState });
      return { ok: true, skipped: true, reason: 'lead_replied' };
    }
    const emailChannel = (lead.contacts?.channels || []).find((channel) => channel.type === 'email' && channel.value);
    if (!emailChannel?.value) return { ok: true, skipped: true, reason: 'no_email_channel' };
    const workingWindow = outboundWorkingWindow();
    if (!workingWindow.open) {
      await this.enqueueJob(`outbound_followup_${stage}`, lead.id, {
        idempotencyKey: `webstudio:${lead.id}:followup:${stage}:v1`,
        priority: 540,
        nextRunAt: workingWindow.nextRunAt,
        payload: { stage },
      });
      return { ok: true, skipped: true, reason: 'outside_working_hours', nextRunAt: workingWindow.nextRunAt };
    }
    const subjectVariantIdForFollowup = lead.subjectVariantId || lead.pitch?.subjectVariantId || '';
    const rawBotLink = customerBotLink(lead);
    const rawSiteUrl = absolutePublicUrl(lead.mockup?.publishedUrl || lead.mockup?.deployedUrl || lead.mockup?.publicUrl || '');
    const rawVideoUrl = absolutePublicUrl(lead.video?.videoUrl || '');
    const siteUrl = rawSiteUrl ? trackingUrl({ leadId: lead.id, kind: 'preview', target: rawSiteUrl, variantId: subjectVariantIdForFollowup, stage }) : '';
    const videoUrl = rawVideoUrl ? trackingUrl({ leadId: lead.id, kind: 'video', target: rawVideoUrl, variantId: subjectVariantIdForFollowup, stage }) : '';
    const botLink = rawBotLink ? trackingUrl({ leadId: lead.id, kind: 'bot', target: rawBotLink, variantId: subjectVariantIdForFollowup, stage }) : '';
    const subject = followupSubject(lead, stage);
    const body = followupEmailBody(lead, stage, { botLink, siteUrl, videoUrl });
    const outbound = await outboundQueueMessage({
      a1LeadId: lead.a1LeadId || lead.a1?.leadId || '',
      externalId: `${lead.id}:followup:${stage}`,
      dedupeKey: `webstudio:${lead.id}:followup:${stage}`,
      to: emailChannel.value,
      senderProfile: '1lab',
      fromAddress: '1lab@1true.ru',
      purpose: 'sales_followup',
      subject,
      body,
      attachments: [
        siteUrl ? { type: 'link', url: siteUrl, title: 'Превью сайта' } : null,
        botLink ? { type: 'link', url: botLink, title: 'Бот для правок и ТЗ' } : null,
      ].filter(Boolean),
      deliveryPolicy: {
        workingHoursOnly: true,
        timezone: config.OUTBOUND_TIMEZONE,
        startHour: config.OUTBOUND_WORKING_HOURS_START,
        endHour: config.OUTBOUND_WORKING_HOURS_END,
      },
      idempotencyKey: `webstudio:${lead.id}:followup:${stage}:v1`,
    });
    if (!outbound.ok) throw new Error(outbound.error || outbound.reason || `Followup ${stage} A1 outbound failed`);
    const sentNow = outboundWasSent(outbound);
    const item = await this.store.addOutreachQueueItem({
      leadId: lead.id,
      status: sentNow ? 'sent' : 'queued',
      channel: 'Email',
      to: emailChannel.value,
      subject,
      message: body,
      fitScore: lead.fitScore ?? 0,
      a1Outbound: outbound,
      followupStage: stage,
      subjectVariantId: subjectVariantIdForFollowup,
      trackedLinks: { preview: siteUrl, video: videoUrl, bot: botLink },
    });
    followupsState[key] = {
      ...(followupsState[key] || {}),
      sentAt: sentNow ? new Date().toISOString() : '',
      queuedAt: !sentNow ? new Date().toISOString() : '',
      queueId: item.id,
      subject,
      status: sentNow ? 'sent' : 'queued',
    };
    lead = await this.store.updateLead(lead.id, { followups: followupsState });
    await this.store.addEvent(lead.id, sentNow ? `pitch.followup_${stage}.sent` : `pitch.followup_${stage}.queued`, sentNow ? `Followup ${stage} sent via A1` : `Followup ${stage} queued in A1`);
    await this.addA1Event(lead, sentNow ? `outbound.followup_${stage}.sent` : `outbound.followup_${stage}.queued`, `Followup ${stage} ${sentNow ? 'sent' : 'queued'}`, { queueItem: item, outbound, stage });
    return { ok: true, lead, outbound, stage };
  }

  topActions(limit = 10) {
    const leads = this.store.listLeads();
    const topLovableIds = new Set(this.lovableCandidates().map((lead) => lead.id));
    return leads
      .map((lead) => {
        const scored = enrichLeadScore({ ...lead });
        const action = actionForLead(scored, topLovableIds);
        scored.mockup = publicMockup(scored.mockup);
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
        const contactGate = await this.prepareScoutLeadForDiagnosis(lead);
        if (!contactGate.ok) return contactGate;
        Object.assign(lead, contactGate.lead);
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
        if (lead.pitch?.queued || ['queued', 'sent', 'succeeded'].includes(String(lead.outboundStatus || ''))) {
          return { ok: true, held: true, reason: 'Outbound already queued or sent', lead };
        }
        const workingWindow = outboundWorkingWindow();
        if (!workingWindow.open) {
          await this.store.updateLead(lead.id, {
            outboundStatus: 'scheduled_working_hours',
            outboundScheduledAt: workingWindow.nextRunAt,
          });
          await this.enqueueJob('outbound_queue', lead.id, {
            idempotencyKey: `${stableOutboundKey(lead)}:${workingWindow.nextRunAt.slice(0, 10)}`,
            priority: pipelineJobPriority(lead, 600),
            nextRunAt: workingWindow.nextRunAt,
          });
          return { ok: true, held: true, reason: 'Outside working hours; outbound scheduled', lead };
        }
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
        const emailChannel = lead.contacts.channels.find((channel) => channel.type === 'email');
        const botLink = customerBotLink(lead);
        const siteUrl = absolutePublicUrl(lead.mockup?.publishedUrl || lead.mockup?.deployedUrl || lead.mockup?.publicUrl || '');
        const videoUrl = absolutePublicUrl(lead.video?.videoUrl || '');
        const message = outboundEmailBody(lead, { botLink, siteUrl, videoUrl });
        const subject = outboundEmailSubject(lead);
        const telegramFollowup = buildTelegramFollowupArtifact(lead, { email: emailChannel?.value || lead.contacts.emails?.[0] || '' });
        const outbound = await outboundQueueMessage({
          a1LeadId: lead.a1LeadId || lead.a1?.leadId || '',
          externalId: lead.id,
          dedupeKey: `webstudio:${lead.id}`,
          to: emailChannel?.value || lead.contacts.emails?.[0] || '',
          senderProfile: '1lab',
          fromAddress: '1lab@1true.ru',
          purpose: 'sales_outbound',
          subject,
          body: message,
          attachments: [
            siteUrl ? { type: 'link', url: siteUrl, title: 'Превью сайта' } : null,
            videoUrl ? { type: 'link', url: videoUrl, title: 'Видео-превью' } : null,
          ].filter(Boolean),
          deliveryPolicy: {
            workingHoursOnly: true,
            timezone: config.OUTBOUND_TIMEZONE,
            startHour: config.OUTBOUND_WORKING_HOURS_START,
            endHour: config.OUTBOUND_WORKING_HOURS_END,
          },
          idempotencyKey: stableOutboundKey(lead),
        });
        const sentNow = outboundWasSent(outbound);
        const item = await this.store.addOutreachQueueItem({
          leadId: lead.id,
          status: sentNow ? 'sent' : 'queued',
          channel: 'Email',
          subject,
          message,
          fitScore: lead.fitScore ?? 0,
          a1Outbound: outbound,
          telegramFollowup,
        });
        lead.pitch = { ok: outbound.ok, queued: !sentNow, sent: sentNow, queueId: item.id, channel: item.channel, updatedAt: new Date().toISOString(), a1Outbound: outbound };
        lead.telegramFollowup = {
          ...(lead.telegramFollowup ?? {}),
          ...telegramFollowup,
          status: outbound.ok ? 'prepared' : 'not_prepared',
          updatedAt: new Date().toISOString(),
        };
        await this.store.addEvent(lead.id, sentNow ? 'pitch.sent' : 'pitch.queued', sentNow ? `Pitcher sent message via A1: ${item.channel}` : `Pitcher поставил сообщение в очередь: ${item.channel}`);
        await this.addA1Event(lead, sentNow ? 'outbound.sent' : 'outbound.queued', sentNow ? 'Pitcher sent outbound email via A1' : 'Pitcher queued outbound email in A1', { queueItem: item, outbound });
        await this.store.addEvent(lead.id, 'outbound.telegram_followup_prepared', 'Pitcher prepared Telegram follow-up after email');
        await this.addA1Event(lead, 'outbound.telegram_followup_prepared', 'Telegram follow-up message prepared after outbound email', {
          telegramFollowup: telegramFollowupEventPayload(telegramFollowup),
          queueItem: item,
        });
      }

      const next = nextLane[lead.lane];
      if (next) {
        const patch = { lane: next.lane, owner: next.agent, status: 'in_progress' };
        if (lead.lane === 'Диагноз') {
          const customerIssues = lead.source === 'telegram_inbound' ? customerBriefSafetyIssues(lead) : [];
          if (customerIssues.length) {
            await this.store.cancelLeadJobs(lead.id, ['customer_preview_build', 'lovable_build', 'coder_deploy', 'filmer_render', 'checker_eval', 'outbound_queue'], 'Customer brief safety gate failed');
            const blocked = await this.store.transitionLead(lead.id, {
              pipelineStage: 'needs_review',
              stageStatus: 'content_review_required',
              artifactStatus: 'blocked',
              lane: 'Диагноз',
              owner: 'Mobile',
              reason: 'customer_brief_safety_gate_failed',
            });
            await this.store.addEvent(lead.id, 'customer.brief_safety_blocked', customerIssues.join('; '));
            return { ok: true, held: true, reason: 'customer_brief_safety_gate_failed', issues: customerIssues, lead: blocked };
          }
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
    if (isFailedBuildPreview(lead)) {
      const updated = await this.store.transitionLead(lead.id, {
        pipelineStage: 'needs_review',
        stageStatus: 'deploy_failed',
        artifactStatus: 'build_failed',
        lane: 'Lovable',
        owner: 'Builder',
        reason: lead.mockup?.deploymentWarning || 'build_failed_preview',
      });
      await this.store.updateLead(lead.id, { outboundStatus: 'blocked_build_failed' });
      return { ok: false, held: true, reason: 'Preview build failed; client pipeline blocked', lead: updated };
    }
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
  if (shouldReviewCustomerBriefBeforeAction(lead)) {
    const issues = customerBriefSafetyIssues(lead);
    if (issues.length) return { action: 'review_customer_brief', label: 'Проверить клиентское ТЗ', score: 100, autoRunnable: false };
  }
  if (isBuildFailedWithSource(lead)) {
    const attempts = Number(lead.mockup?.repairAttempts ?? 0);
    if (attempts < 2) return { action: 'repair_deploy', label: 'Починить деплой кодером', score: 98 - attempts, autoRunnable: true };
    return { action: 'rebuild_lovable', label: 'Пересобрать превью в Lovable', score: 96 - Number(lead.mockup?.rebuildAttempts ?? 0), autoRunnable: true };
  }
  if (isPreviewBlocked(lead)) {
    const attempts = Number(lead.mockup?.rebuildAttempts ?? 0);
    if (attempts < 2) return { action: 'rebuild_lovable', label: 'Пересобрать превью в Lovable', score: 96 - attempts, autoRunnable: true };
    return { action: 'review_preview', label: 'Проверить превью', score: 95, autoRunnable: false };
  }
  if (lead.outboundStatus === 'scheduled_working_hours' && !isOutboundScheduleDue(lead)) {
    return { action: 'wait_working_hours', label: 'Ждет рабочее время для письма', score: lead.fitScore ?? 0, autoRunnable: false };
  }
  if (lead.mockup?.status === 'deployed' && (lead.mockup?.publicUrl || lead.mockup?.publishedUrl || lead.mockup?.deployedUrl) && lead.qualityGate?.ok && !lead.video?.ok) {
    return { action: 'make_video', label: 'Подготовить видео', score: lead.fitScore ?? 0, autoRunnable: true };
  }
  if (lead.source !== 'telegram_inbound' && lead.mockup?.status === 'deployed' && lead.video?.ok && !lead.checker?.passed && lead.stageStatus !== 'checker_failed' && lead.status !== 'checker_failed') {
    return { action: 'check_pitch', label: 'Проверить сообщение', score: lead.fitScore ?? 0, autoRunnable: true };
  }
  if (lead.stageStatus === 'checker_failed' || lead.status === 'checker_failed') {
    return { action: 'review_message', label: 'Нужна правка письма', score: 90, autoRunnable: false };
  }
  if (lead.outboundStatus === 'needs_channel_decision' || lead.stageStatus === 'needs_channel_decision') {
    return { action: 'choose_channel', label: 'Нужен канал отправки', score: lead.fitScore ?? 0, autoRunnable: false };
  }
  if (String(lead.outboundStatus || '').startsWith('blocked')) {
    return { action: 'review_outbound', label: 'Проверить отправку вручную', score: lead.fitScore ?? 0, autoRunnable: false };
  }
  if (lead.pitch?.queued || ['queued', 'sent', 'succeeded'].includes(String(lead.outboundStatus || ''))) {
    return { action: 'wait_outbound_status', label: 'Письмо уже в очереди A1', score: lead.fitScore ?? 0, autoRunnable: false };
  }
  if (lead.status === 'waiting_approval') return { action: 'approve_or_reject', label: 'Ждет approval', score: 100, autoRunnable: false };
  if (lead.status === 'failed' || lead.pipelineStage === 'failed') return { action: 'none', label: 'Failed', score: 0, autoRunnable: false };
  if (isScoutLane(lead) && (lead.status === 'contact_hold' || ['invalid_email_hold', 'no_verified_email_hold', 'awaiting_a1_email', 'a1_email_task_created', 'no_contacts'].includes(String(lead.stageStatus || '')))) {
    return { action: 'none', label: 'Scout contact hold', score: 0, autoRunnable: false };
  }
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
  if (lead.lane === 'Разведка') return { action: 'diagnose_lead', label: 'Диагноз дальше', score: lead.fitScore ?? lead.priority ?? 50, autoRunnable: true };
  if (lead.lane === 'Диагноз' && topLovableIds.has(lead.id)) return { action: 'build_lovable', label: 'Сделать сайт в Lovable', score: lead.fitScore ?? 0, autoRunnable: true };
  if (lead.lane === 'Диагноз') return { action: 'hold_lovable', label: 'Ждет quota Lovable', score: lead.fitScore ?? 0, autoRunnable: false };
  if (lead.lane === 'Lovable') return { action: 'wait_lovable_export', label: 'Ждет export из Lovable MCP', score: lead.fitScore ?? 0, autoRunnable: false };
  if (lead.lane === 'Видео') return { action: 'make_video', label: 'Подготовить видео/пропустить', score: lead.fitScore ?? 0, autoRunnable: true };
  if (lead.lane === 'Проверка') return { action: 'check_pitch', label: 'Проверить сообщение', score: lead.fitScore ?? 0, autoRunnable: true };
  if (lead.lane === 'Отправка') return { action: 'queue_pitch', label: 'Поставить в очередь отправки', score: lead.fitScore ?? 0, autoRunnable: true };
  return { action: 'none', label: 'Нет действия', score: 0, autoRunnable: false };
}

function scoutEnrichmentCandidates(leads = [], limit = 50) {
  return leads
    .filter((lead) => isScoutLane(lead))
    .filter((lead) => !['failed', 'paused', 'contact_hold', 'ready_for_diagnosis'].includes(String(lead.status || '')))
    .filter((lead) => !['email_verified', 'invalid_email_hold', 'no_verified_email_hold', 'awaiting_a1_email', 'a1_email_task_created', 'no_contacts'].includes(String(lead.stageStatus || '')))
    .filter((lead) => !lead.contactReview?.checkedAt)
    .map((lead) => enrichLeadScore({ ...lead }))
    .sort((a, b) => (b.fitScore ?? b.priority ?? 0) - (a.fitScore ?? a.priority ?? 0))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 50)));
}

function isScoutLane(lead = {}) {
  const lane = String(lead.lane || '');
  return lead.pipelineStage === 'scouted' || lead.pipelineStage === 'enriched' || lane === 'Разведка' || lane === 'Р Р°Р·РІРµРґРєР°';
}

function shouldReviewCustomerBriefBeforeAction(lead = {}) {
  if (lead.source !== 'telegram_inbound') return false;
  if (lead.customerBrief?.approvedAt) return true;
  if (lead.customerTelegram?.mode === 'brief_review') return true;
  if (['Lovable', 'Видео', 'Проверка', 'Отправка'].includes(lead.lane)) return true;
  return /lovable|deployed|media_ready|checked|outbound/i.test(String(lead.pipelineStage || ''));
}

function isBuildFailedWithSource(lead = {}) {
  const mockup = lead.mockup || {};
  return (
    (mockup.status === 'build_failed' || mockup.deploymentStrategy === 'build_failed') &&
    Boolean(mockup.sourceRoot && mockup.projectSlug)
  );
}

function isPreviewBlocked(lead = {}) {
  const status = String(lead.stageStatus || lead.status || '');
  const reason = String(lead.lastTransitionReason || '');
  return (
    lead.qualityGate?.ok === false ||
    lead.artifactStatus === 'quality_failed' ||
    status.includes('quality_failed') ||
    status.includes('preview_quality_failed') ||
    reason.includes('preview_quality_not_passed') ||
    reason.includes('empty_or_too_short_body') ||
    isCoderFallbackPreview(lead)
  );
}

function publicMockup(mockup = {}) {
  if (!mockup || typeof mockup !== 'object') return mockup;
  const {
    files,
    raw,
    create,
    project,
    content,
    html,
    source,
    ...rest
  } = mockup;
  return {
    ...rest,
    filesCount: Array.isArray(files) ? files.length : Number(mockup.filesCount ?? 0) || 0,
  };
}

function slimTopAction(action = {}) {
  return {
    action: action.action,
    label: action.label,
    reason: action.reason,
    score: action.score,
    autoRunnable: action.autoRunnable,
    lead: action.lead
      ? {
          id: action.lead.id,
          name: action.lead.name,
          city: action.lead.city,
          niche: action.lead.niche,
          fitScore: action.lead.fitScore,
          pipelineStage: action.lead.pipelineStage,
          lane: action.lead.lane,
          status: action.lead.status,
        }
      : undefined,
  };
}

function jobTypeForAction(action) {
  return {
    diagnose_lead: 'diagnose_lead',
    repair_deploy: 'coder_deploy',
    build_lovable: 'lovable_build',
    deploy_lovable_export: 'coder_deploy',
    deploy_public_url: 'coder_deploy',
    rebuild_lovable: 'lovable_build',
    make_video: 'filmer_render',
    check_pitch: 'checker_eval',
    queue_pitch: 'outbound_queue',
  }[action];
}

function lovableJobPriority(lead = {}) {
  return 1000 + Number(lead.fitScore ?? lead.priority ?? 70);
}

function pipelineJobPriority(lead = {}, offset = 500) {
  return Number(offset) + Number(lead.fitScore ?? lead.priority ?? 50);
}

function jobPriorityForAction(action = {}, lead = {}) {
  const base = Number(action.score ?? lead.fitScore ?? 50);
  if (['build_lovable', 'rebuild_lovable'].includes(action.action)) return 1000 + base;
  if (['deploy_lovable_export', 'deploy_public_url', 'repair_deploy'].includes(action.action)) return 900 + base;
  return base;
}

function jobIdempotencyKey(lead, action, jobType) {
  if (action === 'queue_pitch') return stableOutboundKey(lead);
  if (action === 'repair_deploy') return `coder_repair:${lead.id}:${Number(lead.mockup?.repairAttempts ?? 0) + 1}`;
  if (action === 'rebuild_lovable') return `lovable_rebuild:${lead.id}:${Number(lead.mockup?.rebuildAttempts ?? 0) + 1}`;
  if (action === 'check_pitch') return `checker_eval:${lead.id}:${lead.video?.videoUrl || lead.mockup?.publicUrl || lead.mockup?.deployedUrl || 'preview'}`;
  return `${jobType}:${lead.id}:${jobRevisionForAction(lead, action)}`;
}

function jobRevisionForAction(lead, action) {
  if (action === 'build_lovable') return lead.mockup?.projectId || lead.pipelineStage || 'diagnosed';
  if (action === 'repair_deploy') return Number(lead.mockup?.repairAttempts ?? 0) + 1;
  if (action === 'rebuild_lovable') return Number(lead.mockup?.rebuildAttempts ?? 0) + 1;
  if (action === 'deploy_lovable_export') return lead.mockup?.latestRef || lead.mockup?.updatedAt || lead.updatedAt || 'export';
  if (action === 'deploy_public_url') return lead.mockup?.publishedUrl || lead.mockup?.url || lead.updatedAt || 'url';
  if (action === 'make_video') return lead.mockup?.publicUrl || lead.mockup?.deployedUrl || lead.updatedAt || 'video';
  if (action === 'check_pitch') return lead.video?.videoUrl || lead.updatedAt || 'checker';
  if (action === 'queue_pitch') return lead.checker?.checkedAt || lead.updatedAt || 'outbound';
  return lead.updatedAt || lead.createdAt || 'v1';
}

function stableOutboundKey(lead = {}) {
  return `webstudio:${lead.id}:outbound:sales-email-v1`;
}

function outboundWasSent(outbound) {
  const data = parsedToolData(outbound) || {};
  const status = String(
    data.message?.status ||
      data.sendResult?.response?.status ||
      data.sendResult?.response?.action_result?.status ||
      data.status ||
      '',
  ).toLowerCase();
  return ['sent', 'delivered', 'succeeded'].includes(status);
}

function normalizeDedupeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function isOutboundScheduleDue(lead = {}) {
  const scheduledAt = Date.parse(lead.outboundScheduledAt || '');
  return Number.isFinite(scheduledAt) && scheduledAt <= Date.now();
}

function outboundWorkingWindow(now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: config.OUTBOUND_TIMEZONE || 'Europe/Moscow',
      hour: 'numeric',
      hour12: false,
    }).format(now),
  );
  const start = Number(config.OUTBOUND_WORKING_HOURS_START ?? 9);
  const end = Number(config.OUTBOUND_WORKING_HOURS_END ?? 18);
  if (hour >= start && hour < end) return { open: true, hour };
  const next = new Date(now);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: config.OUTBOUND_TIMEZONE || 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const moscowStartUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), start - 3, 0, 0);
  const nextRunAt = hour < start ? new Date(moscowStartUtc) : new Date(moscowStartUtc + 24 * 60 * 60 * 1000);
  if (nextRunAt <= now) nextRunAt.setUTCDate(nextRunAt.getUTCDate() + 1);
  return { open: false, hour, nextRunAt: nextRunAt.toISOString() };
}

function isCriticalJobError(message = '') {
  const text = String(message || '').toLowerCase();
  if (text.includes('insufficient_quota') || text.includes('exceeded your current quota')) return 'openai_quota';
  if (text.includes('rate limit') || /\b429\b/.test(text)) return 'rate_limit';
  if (text.includes('invalid_grant') || text.includes('oauth')) return 'oauth';
  return '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function retryDelayForJob(job) {
  const delays = {
    scout_sources: 5 * 60_000,
    enrich_lead: 90_000,
    diagnose_lead: 90_000,
    lovable_build: 20 * 60_000,
    customer_preview_build: 20 * 60_000,
    customer_revision_triage: 60_000,
    customer_revision_apply: 10 * 60_000,
    coder_deploy: 10 * 60_000,
    filmer_render: 8 * 60_000,
    checker_eval: 90_000,
    outbound_queue: 60_000,
    outbound_followup_1: 30 * 60_000,
    outbound_followup_2: 30 * 60_000,
    a1_sync: 60_000,
  };
  return delays[job.type] || 60_000;
}

function followupSubject(lead, stage) {
  const business = lead.name || 'вашего бизнеса';
  if (stage === 1) return `Re: ${String(lead.subject || `сделали превью сайта для ${business}`).slice(0, 110)}`;
  return `Закрыть тред по сайту для ${business}?`.slice(0, 110);
}

function followupEmailBody(lead, stage, { botLink = '', siteUrl = '', videoUrl = '' } = {}) {
  const owner = lead.ownerName || lead.contactName || '';
  const greeting = owner ? `${owner}, добрый день.` : 'Добрый день.';
  const business = lead.name || 'вашей компании';
  const niche = (lead.niche || 'ваш бизнес').toLowerCase();
  const ctaText = String(lead.ctaText || 'Посмотреть превью').trim();
  const proofIdea = String(lead.angle || `быстрый путь к заявке для ${niche}`).toLowerCase();

  if (stage === 1) {
    return [
      greeting,
      '',
      `Поднимаю свое прошлое письмо про сайт для ${business}. Возможно, оно прошло мимо во входящих.`,
      '',
      `Если коротко — мы собрали один рабочий вариант сайта под ${niche}: ${proofIdea}. Не шаблон «на потом», а превью под ваши тексты, фото и контакты.`,
      '',
      siteUrl ? `${ctaText}: ${siteUrl}` : '',
      videoUrl ? `Короткое видео-превью: ${videoUrl}` : '',
      '',
      followupDiscountText(lead),
      '',
      'Если стоит передвинуть встречу или пообсуждать позже - скажите, когда удобно. Если не актуально, просто ответьте «не интересно», и я больше не пишу.',
      '',
      emailSignature(),
    ].filter(Boolean).join('\n').trim();
  }
  return [
    greeting,
    '',
    `Это последнее письмо в ветке про сайт для ${business}. Не хочу занимать ваш ящик, поэтому сворачиваю тему, если ответа не будет.`,
    '',
    siteUrl ? `Если соберетесь посмотреть превью — оно по-прежнему здесь: ${siteUrl}` : '',
    botLink ? `И есть бот для правок и ТЗ за пару минут: ${botLink}` : '',
    '',
    'Если сейчас не до этого - это нормально, просто отвечать необязательно. Спасибо, что прочитали.',
    '',
    emailSignature(),
  ].filter(Boolean).join('\n').trim();
}

function isLongRunningJob(job) {
  return ['lovable_build', 'customer_preview_build', 'customer_revision_apply', 'coder_deploy', 'filmer_render'].includes(job.type);
}

function outboundPackageGate(lead) {
  const botLink = customerBotLink(lead);
  const siteUrl = absolutePublicUrl(lead.mockup?.publishedUrl || lead.mockup?.deployedUrl || lead.mockup?.publicUrl || '');
  const videoUrl = absolutePublicUrl(lead.video?.videoUrl || '');
  const body = outboundEmailBody(lead, { botLink, siteUrl, videoUrl });
  const issues = [];
  if (isCoderFallbackPreview(lead)) issues.push('coder_fallback_preview_not_client_sendable');
  if (isFailedBuildPreview(lead)) issues.push('build_failed_preview_not_client_sendable');
  if (!siteUrl) issues.push('missing_preview_link');
  if (!botLink) issues.push('missing_telegram_bot_link');
  if (!lead.name) issues.push('missing_company_name');
  if (body.length < 120) issues.push('body_too_short');
  if (body.length > 1800) issues.push('body_too_long');
  if (/ai generated|нейросеть написала|уникальное предложение|революцион/i.test(body)) issues.push('ai_markers_or_buzzwords');
  if (!lead.qualityGate?.ok) issues.push('preview_quality_not_passed');
  return {
    ok: issues.length === 0,
    issues,
    subject: outboundEmailSubject(lead),
    body,
    previewUrl: siteUrl,
    videoUrl,
    botLink,
    channel: 'email',
  };
}

function isFailedBuildPreview(lead) {
  const mockup = lead.mockup || {};
  return (
    mockup.status === 'build_failed' ||
    mockup.deploymentStrategy === 'build_failed' ||
    mockup.deploymentStrategy === 'no_package_json' ||
    lead.artifactStatus === 'build_failed'
  );
}

function isCoderFallbackPreview(lead) {
  const mockup = lead.mockup || {};
  return (
    mockup.mode === 'coder_generated_preview' ||
    mockup.deploymentStrategy === 'coder_generated_preview' ||
    mockup.status === 'internal_fallback_preview' ||
    mockup.clientSendAllowed === false
  );
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

const SIMPLE_SITE_PRICE_RUB = 30000;
const FIRST_ORDER_DISCOUNT = 0.5;

function firstOrderPrice(value) {
  return Math.round(Number(value || 0) * FIRST_ORDER_DISCOUNT);
}

function salesOfferText(lead = {}) {
  const fullPrice = Math.max(SIMPLE_SITE_PRICE_RUB, Number(lead.deal || 0));
  const simplePrice = formatRub(SIMPLE_SITE_PRICE_RUB);
  const fullPriceText = formatRub(fullPrice);
  return `По стоимости: разработка начинается от ${simplePrice} за простой сайт-визитку. Вариант с полным функционалом и дополнительными модулями под вашу задачу агент предварительно оценил в ${fullPriceText}. Финальную стоимость фиксируем после согласованного превью и ТЗ.`;
}

function followupDiscountText(lead = {}) {
  const fullPrice = Math.max(SIMPLE_SITE_PRICE_RUB, Number(lead.deal || 0));
  const simpleDiscountPrice = formatRub(firstOrderPrice(SIMPLE_SITE_PRICE_RUB));
  const fullDiscountText = formatRub(firstOrderPrice(fullPrice));
  return `Для первого заказа можем дать скидку 50%: простой сайт-визитка получится от ${simpleDiscountPrice}, а вариант с полным функционалом под вашу задачу - ориентировочно ${fullDiscountText}.`;
}

function emailSignature() {
  return [
    'С уважением,',
    'студия 1Lab, Иван',
    'Telegram: @Van_true777',
    'Телефон: 8-905-777-76-72',
  ].join('\n');
}

function outboundEmailSubject(lead) {
  const subject = String(lead.subject || '').trim();
  if (subject) return subject.slice(0, 120);
  const business = lead.name || 'вашего бизнеса';
  const owner = lead.ownerName || lead.contactName || '';
  return owner ? `${owner}, сделали превью сайта для ${business}` : `Сделали превью сайта для ${business}`;
}

function outboundEmailBody(lead, { botLink = '', siteUrl = '', videoUrl = '' } = {}) {
  const owner = lead.ownerName || lead.contactName || '';
  const greeting = owner ? `${owner}, здравствуйте.` : 'Здравствуйте.';
  const ctaText = String(lead.ctaText || '').trim() || 'Посмотреть превью';
  const postscript = String(lead.postscript || 'Если сейчас не актуально, просто ответьте «не интересно».').trim();

  const paragraphs = Array.isArray(lead.bodyParagraphs)
    ? lead.bodyParagraphs.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  if (paragraphs.length) {
    return [
      greeting,
      '',
      ...interleave(paragraphs, ''),
      '',
      siteUrl ? `${ctaText}: ${siteUrl}` : '',
      videoUrl ? `Короткое видео-превью: ${videoUrl}` : '',
      botLink ? `Бот для правок и ТЗ: ${botLink}` : '',
      '',
      salesOfferText(lead),
      '',
      `P.S. ${postscript}`,
      '',
      emailSignature(),
    ].filter((line) => line !== undefined && line !== null).join('\n').trim();
  }

  const business = lead.name || 'ваша компания';
  const niche = lead.niche || 'ваш бизнес';
  const angle = lead.angle || `первый экран, который быстро показывает пользу ${business} и ведет клиента к заявке`;
  const currentSituation = lead.site
    ? 'У вас уже есть сайт, но первый экран можно сделать сильнее под заявки.'
    : 'В открытых источниках не нашли рабочий сайт, хотя карточка в картах уже дает доверие и может приводить больше заявок.';
  const proof = [lead.rating ? `рейтинг ${lead.rating}` : '', lead.reviews ? `${lead.reviews} ${reviewWord(lead.reviews)}` : '', lead.city || ''].filter(Boolean).join(', ');
  return [
    greeting,
    '',
    `Мы из 1Lab собрали для ${business} рабочее превью сайта под направление «${niche}». ${currentSituation}${proof ? ` В основу взяли то, что уже видит клиент: ${proof}.` : ''}`,
    '',
    `Идея: ${angle}. Не шаблон "на потом", а быстрый вариант, который можно довести до запуска под ваши тексты, фото, цены и контакты.`,
    '',
    siteUrl ? `${ctaText}: ${siteUrl}` : '',
    videoUrl ? `Короткое видео-превью: ${videoUrl}` : '',
    '',
    `Если идея близка, ответьте на это письмо или откройте бота - там за пару минут можно оставить правки и собрать точное ТЗ. ${salesOfferText(lead)}`,
    botLink ? `Бот для правок и ТЗ: ${botLink}` : '',
    '',
    `P.S. ${postscript}`,
    '',
    emailSignature(),
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function interleave(items, separator) {
  const out = [];
  items.forEach((item, index) => {
    out.push(item);
    if (index < items.length - 1) out.push(separator);
  });
  return out;
}

function reviewWord(value) {
  const number = Math.abs(Number(value) || 0);
  const mod10 = number % 10;
  const mod100 = number % 100;
  if (mod10 === 1 && mod100 !== 11) return 'отзыв';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'отзыва';
  return 'отзывов';
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

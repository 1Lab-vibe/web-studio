import { config } from './config.js';
import { scoutYandexMaps } from './services/yandexMaps.js';
import { plannedGoogleSearches, scoutGooglePlaces } from './services/googlePlaces.js';
import { diagnoseLead, evaluatePitch } from './services/openaiAgent.js';
import { crmAddEvent, customerBotLink, outboundQueueMessage, parsedToolData, syncA1CrmLead } from './services/a1Client.js';
import { prepareLovableMockup } from './services/lovableMcp.js';
import { renderLeadVideo } from './services/filmer.js';
import { enrichContacts } from './services/contactEnrichment.js';
import { approvalKeyboard, sendTelegram, sendTelegramTo } from './services/telegram.js';
import { enrichLeadScore, topLovableCandidates } from './services/scoring.js';
import { deployLeadExportedProject, deployLeadPublicUrlProject, repairLeadSourceProject } from './services/projectPublisher.js';
import { runPreviewQualityGate } from './services/qualityGate.js';

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
    const startedAt = Date.now();
    const recovered = await this.store.recoverExpiredJobs({ deadAfterAttempts: config.AUTONOMY_DEAD_AFTER_ATTEMPTS });
    const stalledLovable = await this.inspectStalledLovableHandoffs();
    const planned = await this.planJobs();
    const claimed = await this.store.claimNextJobs({
      limit: config.AUTONOMY_MAX_JOBS_PER_TICK || config.AUTONOMY_MAX_ACTIONS_PER_TICK,
      lockMinutes: config.AUTONOMY_JOB_LOCK_MINUTES,
      maxLovable: config.AUTONOMY_MAX_LOVABLE_JOBS_PER_TICK || config.AUTONOMY_MAX_LOVABLE_BUILDS_PER_TICK,
      maxFilmer: config.AUTONOMY_MAX_FILMER_JOBS_PER_TICK,
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
      await this.store.failJob(job.id, error, { retryDelayMs: retryDelayForJob(job) });
      const durationMs = Date.now() - jobStartedAt;
      console.error('Autonomy job failed', { id: job.id, type: job.type, leadId: job.leadId, durationMs, error });
      return { ok: false, durationMs, error: error.message };
    }
  }

  async planJobs() {
    const planned = [];
    const now = new Date();
    const scoutKey = `scout:${now.toISOString().slice(0, 13)}`;
    planned.push(await this.enqueueJob('scout_sources', '', { idempotencyKey: scoutKey, priority: 10 }));
    for (const action of this.topActions(config.AUTONOMY_TOP_ACTIONS_LIMIT).filter((item) => item.autoRunnable)) {
      const lead = action.lead;
      const jobType = jobTypeForAction(action.action);
      if (!jobType) continue;
      const idempotencyKey = jobIdempotencyKey(lead, action.action, jobType);
      planned.push(
        await this.enqueueJob(jobType, lead.id, {
          idempotencyKey,
          priority: action.score ?? lead.fitScore ?? 50,
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
    const supersedeSameLeadType = ['lovable_build', 'coder_deploy', 'filmer_render', 'checker_eval', 'outbound_queue'].includes(type);
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
      case 'diagnose_lead':
        return this.runDiagnoseJob(job.leadId);
      case 'lovable_build':
        return this.runLovableBuildJob(job.leadId, { rebuild: Boolean(job.payload?.rebuild) });
      case 'customer_preview_build':
        return this.runLovableBuildJob(job.leadId, { skipQuota: true, customerChatId: job.payload?.chatId });
      case 'coder_deploy':
        return this.runCoderDeployJob(job.leadId);
      case 'filmer_render':
        return this.runFilmerJob(job.leadId);
      case 'checker_eval':
        return this.runCheckerJob(job.leadId);
      case 'outbound_queue':
        return this.runOutboundJob(job.leadId);
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
    const quotaFreeBuild = skipQuota || ['telegram_inbound', 'manual_smoke'].includes(lead.source);
    if (!quotaFreeBuild && !this.lovableCandidates().some((candidate) => candidate.id === lead.id)) {
      await this.store.transitionLead(lead.id, { pipelineStage: 'diagnosed', stageStatus: 'quota_wait', reason: 'lovable_daily_quota_wait' });
      return { ok: true, skipped: true, reason: 'quota_wait' };
    }
    if (!quotaFreeBuild) {
      const slot = await this.store.reserveLovableBuildSlot({ intervalHours: config.LOVABLE_BUILD_INTERVAL_HOURS });
      if (!slot.ok) {
        await this.enqueueJob('lovable_build', lead.id, {
          idempotencyKey: `lovable_build:${lead.id}:scheduled:${slot.nextRunAt}`,
          priority: lead.fitScore ?? 70,
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
    const mockup = await prepareLovableMockup(lead);
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
      await this.enqueueJob('coder_deploy', lead.id, { idempotencyKey: `coder_deploy:${lead.id}:${mockup.latestRef || mockup.updatedAt || lead.updatedAt}`, priority: lead.fitScore ?? 70 });
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
      await this.enqueueJob('coder_deploy', lead.id, { idempotencyKey: `coder_deploy:${lead.id}:${mockup.publishedUrl || mockup.url || lead.updatedAt}`, priority: lead.fitScore ?? 70 });
      if (customerChatId) await this.store.updateLead(lead.id, { customerTelegram: { ...(lead.customerTelegram ?? {}), pendingPreviewChatId: customerChatId } });
      return { ok: true, lead };
    }
    if (mockup?.status === 'failed') {
      await this.store.transitionLead(lead.id, { pipelineStage: 'needs_review', stageStatus: 'lovable_failed', artifactStatus: 'failed', lane: 'Lovable', owner: 'Builder', reason: mockup.reason || 'lovable_failed' });
      await sendTelegram(`<b>Lovable build failed</b>\n${lead.name}\n${mockup.reason || 'unknown error'}`);
      throw new Error(mockup.reason || 'Lovable build failed');
    }
    await this.store.transitionLead(lead.id, { pipelineStage: 'lovable_building', stageStatus: 'handoff_required', artifactStatus: mockup?.status || 'waiting', reason: 'waiting_lovable_handoff' });
    return { ok: true, lead: this.store.getLead(lead.id), waiting: true };
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
    await this.enqueueJob('filmer_render', lead.id, { idempotencyKey: `filmer:${lead.id}:${lead.mockup?.publicUrl || lead.updatedAt}`, priority: lead.fitScore ?? 60 });
    await this.addA1Event(lead, 'project.quality_passed', 'Coder deploy passed quality gate', { qualityGate: quality });
    return { ok: true, lead, quality };
  }

  async runFilmerJob(leadId) {
    let lead = this.store.getLead(leadId);
    if (!lead) throw new Error('Lead not found');
    const artifactGate = await this.requireDeployedSite(lead);
    if (!artifactGate.ok) throw new Error(artifactGate.reason || 'No deployed site');
    const quality = await runPreviewQualityGate(lead);
    lead = await this.store.updateLead(lead.id, { qualityGate: quality });
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
        await this.enqueueJob('checker_eval', lead.id, { idempotencyKey: `checker:${lead.id}:${lead.video.videoUrl}`, priority: lead.fitScore ?? 55 });
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
    await this.enqueueJob('checker_eval', lead.id, { idempotencyKey: `checker:${lead.id}:${video.videoUrl || lead.updatedAt}`, priority: lead.fitScore ?? 55 });
    return { ok: true, lead, video };
  }

  async runCheckerJob(leadId) {
    let lead = this.store.getLead(leadId);
    if (!lead) throw new Error('Lead not found');
    const artifactGate = await this.requireDeployedSite(lead);
    if (!artifactGate.ok) throw new Error(artifactGate.reason || 'No deployed site');
    if (!lead.qualityGate?.ok) {
      const quality = await runPreviewQualityGate(lead);
      lead = await this.store.updateLead(lead.id, { qualityGate: quality });
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
    await this.enqueueJob('outbound_queue', lead.id, { idempotencyKey: stableOutboundKey(lead), priority: lead.fitScore ?? 50 });
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
        priority: lead.fitScore ?? 50,
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
    const freshQuality = await runPreviewQualityGate(lead);
    lead = await this.store.updateLead(lead.id, { qualityGate: freshQuality });
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
    const reserved = await this.store.reserveSends(config.DAILY_SEND_LIMIT, 1);
    if (reserved.reserved < 1) throw new Error('Daily send limit reached');
    const botLink = customerBotLink(lead);
    const siteUrl = absolutePublicUrl(lead.mockup?.publishedUrl || lead.mockup?.deployedUrl || lead.mockup?.publicUrl || '');
    const videoUrl = absolutePublicUrl(lead.video?.videoUrl || '');
    const message = outboundEmailBody(lead, { botLink, siteUrl, videoUrl });
    const subject = outboundEmailSubject(lead);
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
        botLink ? { type: 'link', url: botLink, title: 'Бот для правок и ТЗ' } : null,
      ].filter(Boolean),
      deliveryPolicy: {
        workingHoursOnly: true,
        timezone: config.OUTBOUND_TIMEZONE,
        startHour: config.OUTBOUND_WORKING_HOURS_START,
        endHour: config.OUTBOUND_WORKING_HOURS_END,
      },
      idempotencyKey: stableOutboundKey(lead),
    });
    const item = await this.store.addOutreachQueueItem({
      leadId: lead.id,
      channel: 'Email',
      to: emailChannel.value,
      subject,
      message,
      fitScore: lead.fitScore ?? 0,
      a1Outbound: outbound,
    });
    lead = await this.store.updateLead(lead.id, {
      contacts: lead.contacts,
      pitch: { ok: outbound.ok, queued: true, queueId: item.id, channel: item.channel, updatedAt: new Date().toISOString(), a1Outbound: outbound },
      outboundStatus: outbound.ok ? 'queued' : 'failed',
      outboundScheduledAt: '',
    });
    if (!outbound.ok) throw new Error(outbound.error || outbound.reason || 'A1 outbound queue failed');
    lead = await this.store.transitionLead(lead.id, { pipelineStage: 'outbound_sent', stageStatus: 'queued', reason: 'outbound_queued_in_a1' });
    await this.store.addEvent(lead.id, 'pitch.queued', `Pitcher queued message: ${item.channel}`);
    await this.addA1Event(lead, 'outbound.queued', 'Pitcher queued outbound email in A1', { queueItem: item, outbound });
    return { ok: true, lead, outbound };
  }

  async runA1SyncJob(leadId, reason = 'job') {
    const lead = this.store.getLead(leadId);
    if (!lead) throw new Error('Lead not found');
    const syncedLead = await this.syncLeadWithA1(lead, reason);
    await this.store.addEvent(lead.id, 'a1.crm.synced', `A1 CRM sync: ${syncedLead.a1Crm?.ok ? 'ok' : syncedLead.a1Crm?.reason || syncedLead.a1Crm?.error || 'failed'}`);
    return { ok: true, lead: syncedLead };
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
            priority: lead.fitScore ?? 50,
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
        const reserved = await this.store.reserveSends(config.DAILY_SEND_LIMIT, 1);
        if (reserved.reserved < 1) return { ok: false, held: true, reason: 'Daily send limit reached', lead };
        const emailChannel = lead.contacts.channels.find((channel) => channel.type === 'email');
        const botLink = customerBotLink(lead);
        const siteUrl = absolutePublicUrl(lead.mockup?.publishedUrl || lead.mockup?.deployedUrl || lead.mockup?.publicUrl || '');
        const videoUrl = absolutePublicUrl(lead.video?.videoUrl || '');
        const message = outboundEmailBody(lead, { botLink, siteUrl, videoUrl });
        const subject = outboundEmailSubject(lead);
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
        const item = await this.store.addOutreachQueueItem({
          leadId: lead.id,
          channel: 'Email',
          subject,
          message,
          fitScore: lead.fitScore ?? 0,
          a1Outbound: outbound,
        });
        lead.pitch = { ok: outbound.ok, queued: true, queueId: item.id, channel: item.channel, updatedAt: new Date().toISOString(), a1Outbound: outbound };
        await this.store.addEvent(lead.id, 'pitch.queued', `Pitcher поставил сообщение в очередь: ${item.channel}`);
        await this.addA1Event(lead, 'outbound.queued', 'Pitcher queued outbound email in A1', { queueItem: item, outbound });
      }

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
  if (lead.mockup?.status === 'deployed' && lead.video?.ok && !lead.checker?.passed && lead.stageStatus !== 'checker_failed' && lead.status !== 'checker_failed') {
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

function retryDelayForJob(job) {
  const delays = {
    scout_sources: 5 * 60_000,
    enrich_lead: 90_000,
    diagnose_lead: 90_000,
    lovable_build: 20 * 60_000,
    coder_deploy: 10 * 60_000,
    filmer_render: 8 * 60_000,
    checker_eval: 90_000,
    outbound_queue: 60_000,
    a1_sync: 60_000,
  };
  return delays[job.type] || 60_000;
}

function isLongRunningJob(job) {
  return ['lovable_build', 'customer_preview_build', 'coder_deploy', 'filmer_render'].includes(job.type);
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

function outboundEmailSubject(lead) {
  const business = lead.name || 'вашего бизнеса';
  const owner = lead.ownerName || lead.contactName || '';
  return owner ? `${owner}, показали, как может продавать сайт ${business}` : `Показали, как может продавать сайт ${business}`;
}

function outboundEmailBody(lead, { botLink = '', siteUrl = '', videoUrl = '' } = {}) {
  const owner = lead.ownerName || lead.contactName || '';
  const greeting = owner ? `${owner}, здравствуйте.` : 'Здравствуйте.';
  const business = lead.name || 'ваша компания';
  const niche = lead.niche || 'ваш бизнес';
  const angle = lead.angle || `сайт, который быстро объясняет ценность ${business} и ведет клиента к заявке`;
  const currentSituation = lead.site
    ? 'У вас уже есть сайт, но первый экран можно сделать понятнее под заявки.'
    : 'В открытых источниках не нашли рабочий сайт, хотя карточка в картах уже дает доверие.';
  const proof = [lead.rating ? `рейтинг ${lead.rating}` : '', lead.reviews ? `${lead.reviews} отзывов` : '', lead.city || ''].filter(Boolean).join(', ');
  const price = formatRub(lead.deal || 30000);
  return [
    greeting,
    '',
    `Для ${business} подготовили первый вариант сайта под направление «${niche}». ${currentSituation}${proof ? ` Взяли за основу то, что уже видно клиенту: ${proof}.` : ''}`,
    '',
    `Идея первого экрана: ${angle}`,
    '',
    siteUrl ? `Превью сайта: ${siteUrl}` : '',
    videoUrl ? `Короткое видео-превью: ${videoUrl}` : '',
    '',
    `Если направление подходит, заменим тексты, фото, цены, контакты и форму под вашу студию. Старт простого сайта-визитки - от ${price}, оплата после согласованного превью.`,
    botLink ? `Правки и ТЗ можно дать в Telegram-боте: ${botLink}` : '',
    '',
    'Если не актуально, просто ответьте «не интересно», больше не будем отвлекать.',
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

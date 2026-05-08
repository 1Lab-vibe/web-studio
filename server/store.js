import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const initialState = {
  leads: [],
  events: [],
  approvals: [],
  jobs: [],
  orchestratorRuns: [],
  outreachQueue: [],
  integrationInbox: [],
  processedA1Events: {},
  authSecurity: {
    clients: {},
    attempts: [],
  },
  metrics: {
    mockupsToday: 0,
    customerMockupsToday: 0,
    mockupDate: '',
    scannedToday: 0,
    sentToday: 0,
    repliesToday: 0,
    googleSearchesToday: 0,
    googleSearchDate: '',
    pausedNiches: [],
    sendDate: '',
  },
  locks: {},
  scheduler: {
    nextLovableBuildAt: '',
  },
};

const laneMap = new Map([
  ['Р Р°Р·РІРµРґРєР°', 'Разведка'],
  ['Р”РёР°РіРЅРѕР·', 'Диагноз'],
  ['Р’РёРґРµРѕ', 'Видео'],
  ['РџСЂРѕРІРµСЂРєР°', 'Проверка'],
  ['РћС‚РїСЂР°РІРєР°', 'Отправка'],
  ['РћС‚РІРµС‚С‹', 'Ответы'],
]);

function normalizeLane(value) {
  return laneMap.get(value) || value || 'Разведка';
}

function pipelineStageFromLegacy(lead = {}) {
  if (lead.pipelineStage) return lead.pipelineStage;
  if (lead.status === 'needs_review') return 'needs_review';
  if (lead.pitch?.queued || ['РћС‚РІРµС‚С‹', 'Ответы'].includes(lead.lane)) return 'outbound_sent';
  if (['РћС‚РїСЂР°РІРєР°', 'Отправка'].includes(lead.lane)) return 'outbound_ready';
  if (['РџСЂРѕРІРµСЂРєР°', 'Проверка'].includes(lead.lane)) return 'checked';
  if (['Р’РёРґРµРѕ', 'Видео'].includes(lead.lane)) return lead.video?.ok ? 'media_ready' : 'deployed';
  if (lead.mockup?.status === 'deployed') return 'deployed';
  if (lead.mockup?.status === 'export_ready') return 'lovable_export_ready';
  if (lead.lane === 'Lovable') return 'lovable_building';
  if (['Р”РёР°РіРЅРѕР·', 'Диагноз'].includes(lead.lane)) return 'diagnosed';
  if (['Р Р°Р·РІРµРґРєР°', 'Разведка'].includes(lead.lane)) return 'scouted';
  return 'scouted';
}

function legacyForPipelineStage(stage) {
  const map = {
    scouted: { lane: 'Разведка', owner: 'Scout' },
    enriched: { lane: 'Разведка', owner: 'Scout' },
    diagnosed: { lane: 'Диагноз', owner: 'Diagnoser' },
    lovable_queued: { lane: 'Lovable', owner: 'Builder' },
    lovable_building: { lane: 'Lovable', owner: 'Builder' },
    lovable_export_ready: { lane: 'Lovable', owner: 'Coder' },
    deployed: { lane: 'Видео', owner: 'Filmer' },
    media_ready: { lane: 'Проверка', owner: 'Checker' },
    checked: { lane: 'Отправка', owner: 'Pitcher' },
    outbound_ready: { lane: 'Отправка', owner: 'Pitcher' },
    outbound_sent: { lane: 'Ответы', owner: 'Mobile' },
    replied: { lane: 'Ответы', owner: 'Mobile' },
    qualified: { lane: 'Ответы', owner: 'Mobile' },
    deal_created: { lane: 'Ответы', owner: 'Mobile' },
    payment_pending: { lane: 'Ответы', owner: 'Mobile' },
    paid: { lane: 'Ответы', owner: 'Mobile' },
    production: { lane: 'Ответы', owner: 'Coder' },
    needs_review: { lane: null, owner: 'Orchestrator' },
  };
  return map[stage] || {};
}

function compactMockup(value = {}) {
  if (!value || typeof value !== 'object') return value;
  const {
    files,
    raw,
    create,
    project,
    content,
    html,
    source,
    ...rest
  } = value;
  return {
    ...rest,
    filesCount: Array.isArray(files) ? files.length : Number(value.filesCount ?? 0) || 0,
  };
}

function compactLead(value = {}) {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    mockup: compactMockup(value.mockup),
  };
}

function compactPersistedLead(value = {}) {
  if (!value || typeof value !== 'object') return value;
  const status = value.mockup?.status || value.mockup?.mode || '';
  const canDropSourceFiles = ['deployed', 'internal_fallback_preview', 'public_url_attached', 'failed'].some((item) => String(status).includes(item));
  return canDropSourceFiles ? compactLead(value) : value;
}

function normalizeTelegramInboundLead(value = {}) {
  if (value.source !== 'telegram_inbound') return value;
  const emailVerified = Boolean(value.customerTelegram?.emailVerified);
  const hasPreview = Boolean(value.mockup?.publicUrl || value.mockup?.deployedUrl || value.mockup?.publishedUrl);
  if (emailVerified && hasPreview) return value;
  return {
    ...value,
    lane: 'Диагноз',
    owner: 'Mobile',
    pipelineStage: emailVerified && value.pipelineStage === 'lovable_building' ? 'lovable_building' : 'qualified',
    stageStatus: value.customerTelegram?.mode || value.status || 'registration_email',
    lastTransitionReason: value.lastTransitionReason || 'telegram_registration_not_finished',
  };
}

function compactJobResult(value = {}) {
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  if (result.lead) {
    result.lead = {
      id: result.lead.id,
      name: result.lead.name,
      pipelineStage: result.lead.pipelineStage,
      lane: result.lead.lane,
      status: result.lead.status,
      artifactStatus: result.lead.artifactStatus,
      mockup: compactMockup(result.lead.mockup),
      video: result.lead.video,
      qualityGate: result.lead.qualityGate,
      outboundStatus: result.lead.outboundStatus,
    };
  }
  if (result.scout?.saved) {
    result.scout = {
      ...result.scout,
      saved: result.scout.saved.map((lead) => ({ id: lead.id, name: lead.name, city: lead.city, niche: lead.niche })),
    };
  }
  return result;
}

function compactTopAction(action = {}) {
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

function compactOrchestratorRun(input = {}) {
  return {
    ...input,
    topActions: Array.isArray(input.topActions) ? input.topActions.map(compactTopAction) : input.topActions,
  };
}

export class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'state.json');
    this.state = structuredClone(initialState);
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      await this.save();
    }
    this.state.authSecurity ??= structuredClone(initialState.authSecurity);
    this.state.authSecurity.clients ??= {};
    this.state.authSecurity.attempts ??= [];
    this.state.events ??= [];
    this.state.leads ??= [];
    this.state.approvals ??= [];
    this.state.jobs ??= [];
    this.state.orchestratorRuns ??= [];
    this.state.outreachQueue ??= [];
    this.state.integrationInbox ??= [];
    this.state.processedA1Events ??= {};
    this.state.metrics ??= structuredClone(initialState.metrics);
    this.state.locks ??= {};
    this.state.scheduler ??= structuredClone(initialState.scheduler);
    this.state.leads = this.state.leads.map((lead) => {
      const normalizedLead = normalizeTelegramInboundLead(compactPersistedLead(lead));
      return {
        ...normalizedLead,
        lane: normalizeLane(normalizedLead.lane),
        owner: normalizedLead.owner || 'Scout',
        pipelineStage: normalizedLead.pipelineStage || pipelineStageFromLegacy(normalizedLead),
        stageStatus: normalizedLead.stageStatus || normalizedLead.status || 'new',
        assignedAgent: normalizedLead.assignedAgent || normalizedLead.owner || 'Scout',
        artifactStatus: normalizedLead.artifactStatus || normalizedLead.mockup?.status || normalizedLead.video?.status || '',
        lastTransitionAt: normalizedLead.lastTransitionAt || normalizedLead.updatedAt || normalizedLead.createdAt || '',
        lastTransitionReason: normalizedLead.lastTransitionReason || '',
        priority: Number.isFinite(Number(normalizedLead.priority)) ? Number(normalizedLead.priority) : 50,
        publicLeadToken: normalizedLead.publicLeadToken || randomToken(),
      };
    });
    this.state.jobs = this.state.jobs.map((job) => ({
      ...job,
      result: job.result ? compactJobResult(job.result) : job.result,
    }));
    this.state.orchestratorRuns = this.state.orchestratorRuns.map(compactOrchestratorRun);
    return this.state;
  }

  async save() {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.file, JSON.stringify(this.state, null, 2), 'utf8');
  }

  listLeads() {
    return this.state.leads;
  }

  getLead(id) {
    return this.state.leads.find((lead) => lead.id === id);
  }

  findLeadByPublicToken(token) {
    return this.state.leads.find((lead) => lead.publicLeadToken === token);
  }

  findLeadByA1Ref({ externalId, dedupeKey, a1LeadId, a1DealId } = {}) {
    return this.state.leads.find((lead) => {
      const leadDedupeKey = lead.a1?.dedupeKey || lead.a1Crm?.dedupeKey || `webstudio:${lead.id}`;
      return (
        (externalId && lead.id === externalId) ||
        (dedupeKey && leadDedupeKey === dedupeKey) ||
        (a1LeadId && (lead.a1LeadId === a1LeadId || lead.a1?.leadId === a1LeadId || lead.a1Crm?.a1Lead?.id === a1LeadId)) ||
        (a1DealId && lead.a1DealId === a1DealId)
      );
    });
  }

  async upsertLead(input) {
    const existing = this.state.leads.find(
      (lead) => lead.sourceKey === input.sourceKey || lead.name?.toLowerCase() === input.name?.toLowerCase(),
    );
    if (existing) {
      Object.assign(existing, { ...input, updatedAt: new Date().toISOString() });
      await this.save();
      return existing;
    }

    const lead = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lane: 'Разведка',
      owner: 'Scout',
      pipelineStage: 'scouted',
      stageStatus: 'new',
      assignedAgent: 'Scout',
      artifactStatus: '',
      lastTransitionAt: new Date().toISOString(),
      lastTransitionReason: 'lead_created',
      priority: 50,
      status: 'new',
      publicLeadToken: randomToken(),
      ...input,
    };
    this.state.leads.push(lead);
    await this.addEvent(lead.id, 'lead.created', `Создан лид ${lead.name}`, { silent: true });
    await this.save();
    return lead;
  }

  async transitionLead(id, input = {}) {
    const lead = this.getLead(id);
    if (!lead) return null;
    const now = new Date().toISOString();
    const pipelineStage = input.pipelineStage || lead.pipelineStage || pipelineStageFromLegacy(lead);
    const legacy = legacyForPipelineStage(pipelineStage);
    const patch = {
      ...(input.patch ?? {}),
      pipelineStage,
      stageStatus: input.stageStatus || input.status || lead.stageStatus || lead.status || 'in_progress',
      assignedAgent: input.assignedAgent || input.owner || legacy.owner || lead.assignedAgent || lead.owner || 'Orchestrator',
      artifactStatus: input.artifactStatus ?? lead.artifactStatus ?? lead.mockup?.status ?? '',
      lane: input.lane || legacy.lane || lead.lane,
      owner: input.owner || input.assignedAgent || legacy.owner || lead.owner,
      status: input.status || input.stageStatus || lead.status || 'in_progress',
      lastTransitionAt: now,
      lastTransitionReason: input.reason || lead.lastTransitionReason || '',
      updatedAt: now,
    };
    Object.assign(lead, patch);
    await this.addEvent(id, 'lead.transition', `${pipelineStage}: ${patch.lastTransitionReason || 'stage updated'}`, { silent: true });
    await this.save();
    return lead;
  }

  async updateLead(id, patch) {
    const lead = this.getLead(id);
    if (!lead) return null;
    Object.assign(lead, patch, { updatedAt: new Date().toISOString() });
    await this.save();
    return lead;
  }

  async lockLead(leadId, agent) {
    const current = this.state.locks[leadId];
    if (current && current.agent !== agent) return false;
    this.state.locks[leadId] = { agent, lockedAt: new Date().toISOString() };
    await this.save();
    return true;
  }

  async unlockLead(leadId, agent) {
    const current = this.state.locks[leadId];
    if (!current || current.agent === agent) {
      delete this.state.locks[leadId];
      await this.save();
    }
  }

  async addApproval(input) {
    const approval = {
      id: randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.state.approvals.push(approval);
    await this.save();
    return approval;
  }

  async resolveApproval(id, decision, actor = 'api') {
    const approval = this.state.approvals.find((item) => item.id === id);
    if (!approval) return null;
    approval.status = decision;
    approval.actor = actor;
    approval.resolvedAt = new Date().toISOString();
    await this.save();
    return approval;
  }

  listApprovals() {
    return this.state.approvals;
  }

  listJobs(filter = {}) {
    this.state.jobs ??= [];
    return this.state.jobs
      .filter((job) => {
        if (filter.status && job.status !== filter.status) return false;
        if (filter.type && job.type !== filter.type) return false;
        if (filter.leadId && job.leadId !== filter.leadId) return false;
        return true;
      })
      .sort((a, b) => Date.parse(b.createdAt || b.updatedAt || 0) - Date.parse(a.createdAt || a.updatedAt || 0));
  }

  listOrchestratorRuns(limit = 50) {
    this.state.orchestratorRuns ??= [];
    return this.state.orchestratorRuns.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
  }

  async addOrchestratorRun(input) {
    this.state.orchestratorRuns ??= [];
    const run = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...compactOrchestratorRun(input),
    };
    this.state.orchestratorRuns.unshift(run);
    this.state.orchestratorRuns = this.state.orchestratorRuns.slice(0, 200);
    await this.save();
    return run;
  }

  async enqueueJob(input) {
    this.state.jobs ??= [];
    const now = new Date().toISOString();
    const idempotencyKey = input.idempotencyKey || `${input.type}:${input.leadId || 'global'}`;
    const existing = this.state.jobs.find(
      (job) =>
        job.idempotencyKey === idempotencyKey &&
        ['queued', 'running', 'failed'].includes(job.status) &&
        Number(job.attempts ?? 0) < Number(job.maxAttempts ?? 3),
    );
    if (existing) return { job: existing, deduped: true };
    const job = {
      id: randomUUID(),
      type: input.type,
      leadId: input.leadId || '',
      status: 'queued',
      priority: Number(input.priority ?? 50),
      attempts: 0,
      maxAttempts: Number(input.maxAttempts ?? 3),
      nextRunAt: input.nextRunAt || now,
      lockedUntil: '',
      startedAt: '',
      finishedAt: '',
      lastError: '',
      payload: input.payload ?? {},
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
    };
    this.state.jobs.unshift(job);
    await this.addEvent(job.leadId || null, 'job.queued', `Queued job ${job.type}`, { silent: true });
    await this.save();
    return { job, deduped: false };
  }

  async recoverExpiredJobs({ now = new Date(), deadAfterAttempts = 3 } = {}) {
    this.state.jobs ??= [];
    const recovered = [];
    for (const job of this.state.jobs) {
      if (job.status !== 'running') continue;
      const lockedUntil = Date.parse(job.lockedUntil || '');
      if (!Number.isFinite(lockedUntil) || lockedUntil > now.getTime()) continue;
      job.status = Number(job.attempts ?? 0) >= Number(deadAfterAttempts) ? 'dead' : 'failed';
      job.lastError = job.lastError || 'Job lock expired';
      job.lockedUntil = '';
      job.nextRunAt = new Date(now.getTime() + 60_000).toISOString();
      job.updatedAt = now.toISOString();
      recovered.push(job);
    }
    if (recovered.length) await this.save();
    return recovered;
  }

  async claimNextJobs({ limit = 3, lockMinutes = 30, maxLovable = 1, maxFilmer = 1 } = {}) {
    this.state.jobs ??= [];
    const now = new Date();
    const runningLeadIds = new Set(
      this.state.jobs
        .filter((job) => job.status === 'running' && job.leadId && Date.parse(job.lockedUntil || '') > now.getTime())
        .map((job) => job.leadId),
    );
    const candidates = this.state.jobs
      .filter((job) => ['queued', 'failed'].includes(job.status))
      .filter((job) => Date.parse(job.nextRunAt || job.createdAt || '') <= now.getTime())
      .filter((job) => Number(job.attempts ?? 0) < Number(job.maxAttempts ?? 3))
      .sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0) || Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
    const claimed = [];
    let lovableCount = 0;
    let filmerCount = 0;
    for (const job of candidates) {
      if (claimed.length >= Number(limit)) break;
      if (job.leadId && runningLeadIds.has(job.leadId)) continue;
      if (job.type === 'lovable_build' && lovableCount >= Number(maxLovable)) continue;
      if (job.type === 'filmer_render' && filmerCount >= Number(maxFilmer)) continue;
      job.status = 'running';
      job.attempts = Number(job.attempts ?? 0) + 1;
      job.startedAt = now.toISOString();
      job.lockedUntil = new Date(now.getTime() + Number(lockMinutes) * 60_000).toISOString();
      job.updatedAt = now.toISOString();
      job.lastError = '';
      claimed.push(job);
      if (job.leadId) runningLeadIds.add(job.leadId);
      if (job.type === 'lovable_build') lovableCount += 1;
      if (job.type === 'filmer_render') filmerCount += 1;
    }
    if (claimed.length) await this.save();
    return claimed;
  }

  async finishJob(id, result = {}) {
    const job = this.state.jobs?.find((item) => item.id === id);
    if (!job) return null;
    const now = new Date().toISOString();
    job.status = result.status || 'succeeded';
    job.result = compactJobResult(result);
    job.finishedAt = now;
    job.lockedUntil = '';
    job.updatedAt = now;
    await this.addEvent(job.leadId || null, 'job.succeeded', `Succeeded job ${job.type}`, { silent: true });
    await this.save();
    return job;
  }

  async failJob(id, error, { retryDelayMs = 60_000 } = {}) {
    const job = this.state.jobs?.find((item) => item.id === id);
    if (!job) return null;
    const now = new Date();
    job.status = Number(job.attempts ?? 0) >= Number(job.maxAttempts ?? 3) ? 'dead' : 'failed';
    job.lastError = error?.message || String(error || 'Job failed');
    job.finishedAt = now.toISOString();
    job.lockedUntil = '';
    job.nextRunAt = new Date(now.getTime() + retryDelayMs).toISOString();
    job.updatedAt = now.toISOString();
    await this.addEvent(job.leadId || null, 'job.failed', `${job.type}: ${job.lastError}`, { silent: true });
    await this.save();
    return job;
  }

  async reserveLovableBuildSlot({ intervalHours = 2, now = new Date() } = {}) {
    this.state.scheduler ??= structuredClone(initialState.scheduler);
    const nextAt = Date.parse(this.state.scheduler.nextLovableBuildAt || '');
    if (Number.isFinite(nextAt) && nextAt > now.getTime()) {
      return { ok: false, nextRunAt: new Date(nextAt).toISOString(), waitMs: nextAt - now.getTime() };
    }
    const nextRunAt = new Date(now.getTime() + Math.max(0, Number(intervalHours) || 2) * 60 * 60 * 1000).toISOString();
    this.state.scheduler.nextLovableBuildAt = nextRunAt;
    await this.save();
    return { ok: true, nextRunAt };
  }

  listOutreachQueue() {
    this.state.outreachQueue ??= [];
    return this.state.outreachQueue;
  }

  async addOutreachQueueItem(input) {
    this.state.outreachQueue ??= [];
    const existing = this.state.outreachQueue.find((item) => item.leadId === input.leadId && item.status === 'queued');
    if (existing) return existing;
    const item = {
      id: randomUUID(),
      status: 'queued',
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.state.outreachQueue.push(item);
    await this.save();
    return item;
  }

  isA1EventProcessed(eventId) {
    this.state.processedA1Events ??= {};
    return Boolean(eventId && this.state.processedA1Events[eventId]);
  }

  async markA1EventProcessed(eventId, value = {}) {
    if (!eventId) return null;
    this.state.processedA1Events ??= {};
    this.state.processedA1Events[eventId] = {
      processedAt: new Date().toISOString(),
      ...value,
    };
    const entries = Object.entries(this.state.processedA1Events).slice(-1000);
    this.state.processedA1Events = Object.fromEntries(entries);
    await this.save();
    return this.state.processedA1Events[eventId];
  }

  async addIntegrationInboxItem(input) {
    this.state.integrationInbox ??= [];
    const item = {
      id: randomUUID(),
      status: 'unmatched',
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.state.integrationInbox.unshift(item);
    this.state.integrationInbox = this.state.integrationInbox.slice(0, 500);
    await this.save();
    return item;
  }

  async addEvent(leadId, type, message, options = {}) {
    this.state.events.unshift({
      id: randomUUID(),
      leadId,
      type,
      message,
      createdAt: new Date().toISOString(),
    });
    this.state.events = this.state.events.slice(0, 500);
    if (!options.silent) await this.save();
  }

  listEvents(leadId) {
    return leadId ? this.state.events.filter((event) => event.leadId === leadId) : this.state.events;
  }

  todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  async resetDailyUsageIfNeeded() {
    this.state.metrics ??= structuredClone(initialState.metrics);
    const today = this.todayKey();
    if (this.state.metrics.googleSearchDate !== today) {
      this.state.metrics.googleSearchDate = today;
      this.state.metrics.googleSearchesToday = 0;
      await this.save();
    }
    if (this.state.metrics.mockupDate !== today) {
      this.state.metrics.mockupDate = today;
      this.state.metrics.mockupsToday = 0;
      this.state.metrics.customerMockupsToday = 0;
      await this.save();
    }
    if (this.state.metrics.sendDate !== today) {
      this.state.metrics.sendDate = today;
      this.state.metrics.sentToday = 0;
      await this.save();
    }
  }

  async reserveGoogleSearches(limit, requested) {
    await this.resetDailyUsageIfNeeded();
    const used = Number(this.state.metrics.googleSearchesToday ?? 0);
    const remaining = Math.max(0, Number(limit) - used);
    const reserved = Math.min(Math.max(0, Number(requested)), remaining);
    this.state.metrics.googleSearchesToday = used + reserved;
    await this.save();
    return {
      reserved,
      used: this.state.metrics.googleSearchesToday,
      remaining: Math.max(0, Number(limit) - this.state.metrics.googleSearchesToday),
    };
  }

  async reserveSends(limit, requested) {
    await this.resetDailyUsageIfNeeded();
    const used = Number(this.state.metrics.sentToday ?? 0);
    const remaining = Math.max(0, Number(limit) - used);
    const reserved = Math.min(Math.max(0, Number(requested)), remaining);
    this.state.metrics.sentToday = used + reserved;
    await this.save();
    return {
      reserved,
      used: this.state.metrics.sentToday,
      remaining: Math.max(0, Number(limit) - this.state.metrics.sentToday),
    };
  }

  getAuthClient(key) {
    this.state.authSecurity ??= structuredClone(initialState.authSecurity);
    return this.state.authSecurity.clients[key] ?? null;
  }

  async setAuthClient(key, value) {
    this.state.authSecurity ??= structuredClone(initialState.authSecurity);
    this.state.authSecurity.clients[key] = value;
    await this.save();
    return value;
  }

  async addAuthAttempt(input) {
    this.state.authSecurity ??= structuredClone(initialState.authSecurity);
    const attempt = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.state.authSecurity.attempts.unshift(attempt);
    this.state.authSecurity.attempts = this.state.authSecurity.attempts.slice(0, 1000);
    await this.save();
    return attempt;
  }
}

function randomToken() {
  return randomBytes(16).toString('hex');
}

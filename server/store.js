import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const initialState = {
  leads: [],
  events: [],
  approvals: [],
  jobs: [],
  scoutQueries: {},
  orchestratorRuns: [],
  outreachQueue: [],
  integrationInbox: [],
  processedA1Events: {},
  adminAlerts: {},
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

const readableLanes = {
  scout: '\u0420\u0430\u0437\u0432\u0435\u0434\u043a\u0430',
  lovable: 'Lovable',
  replies: '\u041e\u0442\u0432\u0435\u0442\u044b',
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
    needs_review: { lane: 'Lovable', owner: 'Orchestrator' },
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
  if (
    value.stageStatus === 'content_review_required' ||
    value.artifactStatus === 'blocked' ||
    value.mockup?.status === 'blocked_by_safety_gate' ||
    value.outboundStatus === 'blocked_safety_gate'
  ) {
    return {
      ...value,
      lane: value.lane || 'Диагноз',
      owner: value.owner || 'Mobile',
      pipelineStage: value.pipelineStage || 'needs_review',
      stageStatus: value.stageStatus || 'content_review_required',
      status: value.status || 'needs_review',
      lastTransitionReason: value.lastTransitionReason || 'customer_brief_safety_gate_failed',
    };
  }
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

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function leadHasInvalidOutboundEmail(lead = {}) {
  if (/bounce|bounced|invalid_email/i.test(String(lead.outboundStatus || ''))) return true;
  const invalid = new Set(
    [
      ...(lead.contacts?.emailValidation?.invalid || []),
      ...(lead.contacts?.emailValidation?.bouncedEmails || []),
      ...(lead.contactReview?.invalidEmails || []),
      ...(lead.contactReview?.bouncedEmails || []),
    ]
      .map(normalizeEmail)
      .filter(Boolean),
  );
  if (invalid.size > 0 && !(lead.contacts?.emails || []).length) return true;
  const email = normalizeEmail(lead.contacts?.emails?.find?.(Boolean) || lead.email || lead.pitch?.to || '');
  return Boolean(email && invalid.has(email));
}

function sentOutreachItemForLead(lead = {}, outreachQueue = []) {
  return outreachQueue
    .filter((item) => item.leadId === lead.id && !item.followupStage)
    .filter((item) => ['sent', 'succeeded'].includes(String(item.status || '').toLowerCase()))
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))[0] || null;
}

function normalizeLegacyLeadState(lead = {}, outreachQueue = []) {
  const stageStatus = String(lead.stageStatus || lead.status || '');
  if (['awaiting_a1_email', 'a1_email_task_created', 'invalid_email_phone_handoff', 'phone_only_a1_handoff'].includes(stageStatus) || lead.status === 'a1_email_lookup') {
    return {
      ...lead,
      lane: readableLanes.scout,
      owner: 'Scout',
      assignedAgent: 'Scout',
      pipelineStage: 'scouted',
      status: lead.status || 'a1_email_lookup',
    };
  }

  const issues = [
    lead.lastTransitionReason,
    ...(lead.outboundPackage?.issues || []),
    lead.qualityGate?.ok === false ? 'preview_quality_not_passed' : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (
    String(lead.outboundStatus || '').startsWith('blocked') &&
    /preview_quality|missing_preview|quality_failed|build_failed/.test(issues)
  ) {
    return {
      ...lead,
      lane: readableLanes.lovable,
      owner: 'Builder',
      assignedAgent: 'Builder',
      pipelineStage: 'needs_review',
      stageStatus: lead.stageStatus || 'preview_quality_failed',
    };
  }

  const sentItem = sentOutreachItemForLead(lead, outreachQueue);
  const hasSentOutbound = Boolean(sentItem || lead.pitch?.sent || ['sent', 'succeeded'].includes(String(lead.outboundStatus || '').toLowerCase()));
  if (hasSentOutbound && !leadHasInvalidOutboundEmail(lead) && !String(lead.outboundStatus || '').startsWith('failed')) {
    const status = ['queued', 'ready', 'in_progress', ''].includes(String(lead.status || '')) ? 'sent' : lead.status;
    return {
      ...lead,
      lane: readableLanes.replies,
      owner: 'Mobile',
      assignedAgent: 'Mobile',
      pipelineStage: 'outbound_sent',
      stageStatus: ['queued', 'ready', 'in_progress', ''].includes(stageStatus) ? 'sent' : stageStatus,
      status,
      outboundStatus: 'sent',
      pitch: {
        ...(lead.pitch || {}),
        sent: true,
        queued: false,
        queueId: lead.pitch?.queueId || sentItem?.id || '',
      },
    };
  }
  return lead;
}

export class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'state.json');
    this.consentFile = path.join(this.dataDir, 'consents.json');
    this.state = structuredClone(initialState);
    this.consents = { records: [] };
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      await this.save();
    }
    try {
      this.consents = JSON.parse(await readFile(this.consentFile, 'utf8'));
    } catch {
      this.consents = { records: [] };
      await this.saveConsents();
    }
    this.consents.records ??= [];
    this.state.authSecurity ??= structuredClone(initialState.authSecurity);
    this.state.authSecurity.clients ??= {};
    this.state.authSecurity.attempts ??= [];
    this.state.events ??= [];
    this.state.leads ??= [];
    this.state.approvals ??= [];
    this.state.jobs ??= [];
    this.state.scoutQueries ??= {};
    this.state.orchestratorRuns ??= [];
    this.state.outreachQueue ??= [];
    this.state.integrationInbox ??= [];
    this.state.processedA1Events ??= {};
    this.state.adminAlerts ??= {};
    this.state.metrics ??= structuredClone(initialState.metrics);
    this.state.locks ??= {};
    this.state.scheduler ??= structuredClone(initialState.scheduler);
    this.state.leads = this.state.leads.map((lead) => {
      const normalizedLead = normalizeTelegramInboundLead(compactPersistedLead(lead));
      const hydrated = {
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
      const withConsent = {
        ...hydrated,
        consentSummary: this.consentSummaryForSubject(this.consentSubjectForLead(hydrated)),
      };
      return normalizeLegacyLeadState(withConsent, this.state.outreachQueue);
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

  async saveConsents() {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.consentFile, JSON.stringify(this.consents, null, 2), 'utf8');
  }

  consentSubjectForLead(lead = {}) {
    const telegram = lead.customerTelegram || {};
    const email = telegram.email || lead.contacts?.emails?.find?.(Boolean) || '';
    if (telegram.userId) return `telegram:${telegram.userId}`;
    if (telegram.chatId) return `telegram-chat:${telegram.chatId}`;
    if (email) return `email:${String(email).toLowerCase()}`;
    return lead.id ? `lead:${lead.id}` : '';
  }

  latestConsent(subjectKey, type) {
    if (!subjectKey || !type) return null;
    return [...(this.consents.records || [])]
      .filter((record) => record.subjectKey === subjectKey && record.type === type)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))[0] || null;
  }

  consentSummaryForSubject(subjectKey) {
    const types = ['personal_data', 'marketing'];
    const summary = {};
    for (const type of types) {
      const latest = this.latestConsent(subjectKey, type);
      summary[type] = latest
        ? {
            decision: latest.decision,
            granted: latest.decision === 'granted',
            declined: latest.decision === 'declined',
            withdrawn: latest.decision === 'withdrawn',
            documentVersion: latest.documentVersion,
            documentUrl: latest.documentUrl,
            updatedAt: latest.createdAt,
          }
        : { decision: 'pending', granted: false, declined: false, withdrawn: false };
    }
    return summary;
  }

  consentSummaryForLead(lead = {}) {
    return this.consentSummaryForSubject(this.consentSubjectForLead(lead));
  }

  async recordConsent(input = {}) {
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      createdAt: now,
      subjectKey: input.subjectKey || '',
      leadId: input.leadId || '',
      type: input.type || '',
      decision: input.decision || '',
      documentVersion: input.documentVersion || '',
      documentUrl: input.documentUrl || '',
      source: input.source || 'unknown',
      actor: input.actor || '',
      ip: input.ip || '',
      userAgent: String(input.userAgent || '').slice(0, 300),
      evidenceText: input.evidenceText || '',
      metadata: input.metadata || {},
    };
    if (!record.subjectKey || !record.type || !record.decision) return null;
    this.consents.records ??= [];
    this.consents.records.unshift(record);
    this.consents.records = this.consents.records.slice(0, 10000);
    await this.saveConsents();
    if (record.leadId) {
      const lead = this.getLead(record.leadId);
      if (lead) {
        lead.consentSummary = this.consentSummaryForLead(lead);
        lead.updatedAt = now;
        await this.save();
      }
    }
    return record;
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

  async recordLeadClick(leadId, info = {}) {
    if (!leadId) return null;
    const lead = this.getLead(leadId);
    if (!lead) return null;
    const tracking = lead.tracking ?? {};
    const clicks = Array.isArray(tracking.clicks) ? tracking.clicks.slice() : [];
    const entry = {
      at: new Date().toISOString(),
      kind: info.kind || 'link',
      target: info.target || '',
      variantId: info.variantId || '',
      stage: Number(info.stage) || 0,
      ip: info.ip || '',
      ua: String(info.ua || '').slice(0, 200),
    };
    clicks.unshift(entry);
    tracking.clicks = clicks.slice(0, 50);
    tracking.totalClicks = Number(tracking.totalClicks || 0) + 1;
    tracking.lastClickAt = entry.at;
    Object.assign(lead, { tracking, updatedAt: new Date().toISOString() });
    await this.save();
    return entry;
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
    const forceCreate = input.forceCreate === true;
    const cleanInput = { ...input };
    delete cleanInput.forceCreate;
    const existing = forceCreate
      ? null
      : this.state.leads.find(
          (lead) => lead.sourceKey === cleanInput.sourceKey || lead.name?.toLowerCase() === cleanInput.name?.toLowerCase(),
        );
    if (existing) {
      Object.assign(existing, { ...cleanInput, updatedAt: new Date().toISOString() });
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
      ...cleanInput,
    };
    this.state.leads.push(lead);
    await this.addEvent(lead.id, 'lead.created', `Создан лид ${lead.name}`, { silent: true });
    await this.save();
    return lead;
  }

  scoutQueryKey({ provider, city, area, niche, page = 0 } = {}) {
    return [provider, city, area || city, niche, `p${page}`]
      .map((part) =>
        String(part || '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .join('|');
  }

  shouldRunScoutQuery(input = {}) {
    this.state.scoutQueries ??= {};
    const key = this.scoutQueryKey(input);
    const existing = this.state.scoutQueries[key];
    const nextRunAt = Date.parse(existing?.nextRunAt || '');
    if (Number.isFinite(nextRunAt) && nextRunAt > Date.now()) {
      return { ok: false, key, nextRunAt: existing.nextRunAt, lastRunAt: existing.lastRunAt };
    }
    return { ok: true, key, lastRunAt: existing?.lastRunAt || '' };
  }

  async recordScoutQuery(input = {}, result = {}) {
    this.state.scoutQueries ??= {};
    const key = result.key || this.scoutQueryKey(input);
    const now = new Date();
    const cooldownDays = Math.max(1, Number(input.cooldownDays ?? 7) || 7);
    this.state.scoutQueries[key] = {
      key,
      provider: input.provider || '',
      city: input.city || '',
      area: input.area || input.city || '',
      niche: input.niche || '',
      page: Number(input.page ?? 0),
      query: input.query || '',
      status: result.status || 'done',
      resultCount: Number(result.resultCount ?? 0),
      newResultCount: Number(result.newResultCount ?? result.resultCount ?? 0),
      error: result.error || '',
      lastRunAt: now.toISOString(),
      nextRunAt: new Date(now.getTime() + cooldownDays * 24 * 60 * 60 * 1000).toISOString(),
    };
    await this.save();
    return this.state.scoutQueries[key];
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
    if (input.supersedeSameLeadType && input.leadId) {
      for (const job of this.state.jobs) {
        if (
          job.type === input.type &&
          job.leadId === input.leadId &&
          ['queued', 'failed'].includes(job.status) &&
          Number(job.attempts ?? 0) < Number(job.maxAttempts ?? 3)
        ) {
          job.status = 'skipped';
          job.lastError = `Superseded by newer ${input.type} job`;
          job.finishedAt = now;
          job.lockedUntil = '';
          job.updatedAt = now;
        }
      }
    }
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

  async claimNextJobs({ limit = 3, lockMinutes = 30, maxLovable = 1, maxFilmer = 1, maxDiagnose = Infinity } = {}) {
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
    let diagnoseCount = 0;
    for (const job of candidates) {
      if (claimed.length >= Number(limit)) break;
      if (job.leadId && runningLeadIds.has(job.leadId)) continue;
      if (job.type === 'lovable_build' && lovableCount >= Number(maxLovable)) continue;
      if (job.type === 'filmer_render' && filmerCount >= Number(maxFilmer)) continue;
      if (job.type === 'diagnose_lead' && diagnoseCount >= Number(maxDiagnose)) continue;
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
      if (job.type === 'diagnose_lead') diagnoseCount += 1;
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

  async cancelLeadJobs(leadId, types = [], reason = 'Cancelled') {
    this.state.jobs ??= [];
    const now = new Date().toISOString();
    const typeSet = new Set(types.filter(Boolean));
    const cancelled = [];
    for (const job of this.state.jobs) {
      if (job.leadId !== leadId) continue;
      if (typeSet.size && !typeSet.has(job.type)) continue;
      if (!['queued', 'failed', 'running'].includes(job.status)) continue;
      job.status = 'skipped';
      job.lastError = reason;
      job.finishedAt = now;
      job.lockedUntil = '';
      job.updatedAt = now;
      cancelled.push(job);
    }
    if (cancelled.length) {
      await this.addEvent(leadId || null, 'job.cancelled', `${reason}: ${cancelled.map((job) => job.type).join(', ')}`, { silent: true });
      await this.save();
    }
    return cancelled;
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
    const existing = this.state.outreachQueue.find((item) => item.leadId === input.leadId && ['queued', 'sent', 'succeeded'].includes(item.status));
    if (existing) {
      const stable = { id: existing.id, createdAt: existing.createdAt };
      const nextStatus = ['sent', 'succeeded'].includes(existing.status) ? existing.status : (input.status || existing.status);
      Object.assign(existing, input, stable, {
        status: nextStatus,
        updatedAt: new Date().toISOString(),
      });
      await this.save();
      return existing;
    }
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

  async reserveAdminAlert(key, { cooldownMs = 60 * 60 * 1000 } = {}) {
    if (!key) return { ok: false, skipped: true, reason: 'missing_key' };
    this.state.adminAlerts ??= {};
    const now = Date.now();
    const existing = this.state.adminAlerts[key];
    const lastSentAt = Date.parse(existing?.sentAt || '');
    if (Number.isFinite(lastSentAt) && now - lastSentAt < Number(cooldownMs)) {
      return { ok: true, reserved: false, lastSentAt: existing.sentAt };
    }
    const value = { sentAt: new Date(now).toISOString(), count: Number(existing?.count || 0) + 1 };
    this.state.adminAlerts[key] = value;
    const entries = Object.entries(this.state.adminAlerts).slice(-500);
    this.state.adminAlerts = Object.fromEntries(entries);
    await this.save();
    return { ok: true, reserved: true, ...value };
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

  async googleSearchBudget(limit) {
    await this.resetDailyUsageIfNeeded();
    const used = Number(this.state.metrics.googleSearchesToday ?? 0);
    return {
      used,
      remaining: Math.max(0, Number(limit) - used),
      limit: Number(limit),
    };
  }

  async recordGoogleSearches(count, limit = Infinity) {
    await this.resetDailyUsageIfNeeded();
    const used = Number(this.state.metrics.googleSearchesToday ?? 0);
    this.state.metrics.googleSearchesToday = used + Math.max(0, Number(count) || 0);
    await this.save();
    return {
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

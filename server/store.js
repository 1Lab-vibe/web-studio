import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const initialState = {
  leads: [],
  events: [],
  approvals: [],
  outreachQueue: [],
  integrationInbox: [],
  processedA1Events: {},
  authSecurity: {
    clients: {},
    attempts: [],
  },
  metrics: {
    mockupsToday: 0,
    scannedToday: 0,
    sentToday: 0,
    repliesToday: 0,
    googleSearchesToday: 0,
    googleSearchDate: '',
    pausedNiches: [],
    sendDate: '',
  },
  locks: {},
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
    this.state.outreachQueue ??= [];
    this.state.integrationInbox ??= [];
    this.state.processedA1Events ??= {};
    this.state.metrics ??= structuredClone(initialState.metrics);
    this.state.locks ??= {};
    this.state.leads = this.state.leads.map((lead) => ({
      ...lead,
      lane: normalizeLane(lead.lane),
      owner: lead.owner || 'Scout',
      priority: Number.isFinite(Number(lead.priority)) ? Number(lead.priority) : 50,
      publicLeadToken: lead.publicLeadToken || randomToken(),
    }));
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

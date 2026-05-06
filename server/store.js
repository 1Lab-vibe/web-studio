import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const initialState = {
  leads: [],
  events: [],
  approvals: [],
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
    this.state.metrics ??= structuredClone(initialState.metrics);
    this.state.locks ??= {};
    this.state.leads = this.state.leads.map((lead) => ({
      ...lead,
      lane: normalizeLane(lead.lane),
      owner: lead.owner || 'Scout',
      priority: Number.isFinite(Number(lead.priority)) ? Number(lead.priority) : 50,
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

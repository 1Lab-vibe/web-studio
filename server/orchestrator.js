import { config } from './config.js';
import { scoutYandexMaps } from './services/yandexMaps.js';
import { diagnoseLead } from './services/openaiAgent.js';
import { createA1LeadTask } from './services/a1Client.js';
import { createLovableMockup } from './services/lovableMcp.js';
import { approvalKeyboard, sendTelegram } from './services/telegram.js';

const nextLane = {
  Разведка: { agent: 'Diagnoser', lane: 'Диагноз' },
  Диагноз: { agent: 'Builder', lane: 'Lovable' },
  Lovable: { agent: 'Filmer', lane: 'Видео' },
  Видео: { agent: 'Checker', lane: 'Проверка' },
  Проверка: { agent: 'Pitcher', lane: 'Отправка' },
  Отправка: { agent: 'Mobile', lane: 'Ответы' },
};

export class Orchestrator {
  constructor(store) {
    this.store = store;
  }

  async scout() {
    const result = await scoutYandexMaps();
    if (!result.ok) return result;
    const saved = [];
    for (const lead of result.leads) saved.push(await this.store.upsertLead(lead));
    this.store.state.metrics.scannedToday += saved.length;
    await this.store.save();
    return { ok: true, saved };
  }

  async tick() {
    const scout = await this.scout();
    const active = this.store
      .listLeads()
      .filter((lead) => !['done', 'paused', 'waiting_approval'].includes(lead.status))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .slice(0, 12);

    const advanced = [];
    for (const lead of active) {
      const result = await this.advanceLead(lead.id);
      if (result?.ok) advanced.push(result.lead);
    }
    return { ok: true, scout, advanced };
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
        const diagnosis = await diagnoseLead(lead);
        Object.assign(lead, diagnosis);
        await this.store.addEvent(lead.id, 'diagnosis.created', 'Diagnoser подготовил диагноз и сообщение');
      }

      if (lead.lane === 'Диагноз' && this.store.state.metrics.mockupsToday < config.DAILY_MOCKUP_LIMIT) {
        const mockup = await createLovableMockup(lead);
        lead.mockup = mockup;
        if (!mockup.skipped) this.store.state.metrics.mockupsToday += 1;
        await this.store.addEvent(lead.id, 'mockup.requested', 'Builder отправил задачу в Lovable MCP');
      }

      lead.a1Task = await createA1LeadTask(
        lead,
        currentAgent,
        `Обработай лида строго в роли ${currentAgent}. Не выполняй write-действия вне A1 task. Верни результат для оркестратора.`,
      );

      const next = nextLane[lead.lane];
      if (next) {
        await this.store.updateLead(lead.id, { lane: next.lane, owner: next.agent, status: 'in_progress' });
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

function formatRub(value) {
  return `${Number(value ?? 0).toLocaleString('ru-RU')} ₽`;
}

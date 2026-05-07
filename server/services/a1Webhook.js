import { crmAddEvent, crmConvertLeadToDeal } from './a1Client.js';

const LANES = {
  scout: '\u0420\u0430\u0437\u0432\u0435\u0434\u043a\u0430',
  diagnosis: '\u0414\u0438\u0430\u0433\u043d\u043e\u0437',
  lovable: 'Lovable',
  video: '\u0412\u0438\u0434\u0435\u043e',
  check: '\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430',
  sending: '\u041e\u0442\u043f\u0440\u0430\u0432\u043a\u0430',
  replies: '\u041e\u0442\u0432\u0435\u0442\u044b',
};

const SUPPORTED_EVENTS = new Set([
  'lead.stage_changed',
  'lead.replied',
  'lead.converted_to_deal',
  'deal.stage_changed',
  'deal.payment_link_created',
  'deal.payment_paid',
  'outbound.message_sent',
  'outbound.message_failed',
  'customer.telegram_started',
  'customer.brief_updated',
  'customer.revision_requested',
]);

export async function handleA1Webhook(store, envelope, idempotencyKey = '') {
  const eventId = String(envelope?.eventId || idempotencyKey || '').trim();
  if (!eventId) return { ok: false, status: 400, error: 'Missing eventId' };
  if (store.isA1EventProcessed(eventId)) return { ok: true, duplicate: true };

  const eventType = String(envelope?.eventType || '').trim();
  if (!SUPPORTED_EVENTS.has(eventType)) {
    await store.addIntegrationInboxItem({ eventId, eventType, status: 'unsupported', envelope });
    await store.markA1EventProcessed(eventId, { status: 'unsupported' });
    return { ok: true, unsupported: true };
  }

  const entity = envelope?.entity ?? {};
  const lead = store.findLeadByA1Ref({
    externalId: entity.externalId,
    dedupeKey: entity.dedupeKey,
    a1LeadId: entity.a1LeadId,
    a1DealId: entity.a1DealId,
  });

  if (!lead) {
    const item = await store.addIntegrationInboxItem({ eventId, eventType, status: 'unmatched', envelope });
    await store.markA1EventProcessed(eventId, { status: 'unmatched', inboxId: item.id });
    return { ok: true, unmatched: true, inboxId: item.id };
  }

  const patch = patchForA1Event(lead, envelope);
  const updatedLead = Object.keys(patch).length ? await store.updateLead(lead.id, patch) : lead;
  if (envelope.eventType === 'lead.replied' && isPositiveReply(envelope.payload) && (updatedLead.a1LeadId || updatedLead.a1?.leadId)) {
    const convert = await crmConvertLeadToDeal({
      a1LeadId: updatedLead.a1LeadId || updatedLead.a1?.leadId,
      dealTitle: `Site for ${updatedLead.name}`,
      customerContact: updatedLead.reply || {},
      sourceLead: updatedLead,
      initialBrief: updatedLead.customerBrief || {},
      idempotencyKey: `webstudio:${updatedLead.id}:convert:${eventId}`,
      reason: 'positive_a1_reply',
    });
    if (convert.ok) {
      await store.updateLead(updatedLead.id, {
        status: 'positive_reply',
        a1: {
          ...(updatedLead.a1 ?? {}),
          conversionRequestedAt: new Date().toISOString(),
          conversionMode: convert.conversionMode || 'a1',
        },
      });
    }
  }
  await store.addEvent(lead.id, `a1.${eventType}`, eventMessage(envelope));
  await store.markA1EventProcessed(eventId, { status: 'processed', leadId: lead.id });
  return { ok: true, lead: store.getLead(lead.id), patch };
}

export async function emitCustomerA1Event(lead, eventType, text, payload = {}) {
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
    idempotencyKey: `webstudio:${lead.id}:${eventType}:${Date.now()}`,
  });
}

function patchForA1Event(lead, envelope) {
  const payload = envelope.payload ?? {};
  const entity = envelope.entity ?? {};
  const base = {
    a1LeadId: entity.a1LeadId || lead.a1LeadId,
    a1DealId: entity.a1DealId || lead.a1DealId,
    a1: {
      ...(lead.a1 ?? {}),
      leadId: entity.a1LeadId || lead.a1?.leadId,
      dealId: entity.a1DealId || lead.a1?.dealId,
      lastEventType: envelope.eventType,
      lastEventAt: envelope.occurredAt || new Date().toISOString(),
    },
  };

  if (envelope.eventType === 'lead.stage_changed' || envelope.eventType === 'deal.stage_changed') {
    return {
      ...base,
      lane: payload.webstudioLane || localLaneForA1Stage(payload.stage || payload.toStage),
      status: payload.status || 'in_progress',
    };
  }
  if (envelope.eventType === 'lead.replied') {
    return {
      ...base,
      lane: LANES.replies,
      owner: 'Mobile',
      status: 'replied',
      reply: {
        text: payload.text || payload.replyText || '',
        channel: payload.channel || '',
        receivedAt: envelope.occurredAt || new Date().toISOString(),
      },
    };
  }
  if (envelope.eventType === 'lead.converted_to_deal') {
    return { ...base, status: 'converted', lane: LANES.replies };
  }
  if (envelope.eventType === 'deal.payment_link_created') {
    return {
      ...base,
      payment: {
        ...(lead.payment ?? {}),
        invoiceId: payload.invoiceId || '',
        paymentUrl: payload.paymentUrl || '',
        amountRub: payload.amountRub || payload.amount || '',
        status: 'created',
        updatedAt: envelope.occurredAt || new Date().toISOString(),
      },
    };
  }
  if (envelope.eventType === 'deal.payment_paid') {
    return {
      ...base,
      payment: {
        ...(lead.payment ?? {}),
        status: 'paid',
        paidAt: envelope.occurredAt || new Date().toISOString(),
      },
    };
  }
  if (envelope.eventType === 'outbound.message_sent') {
    return { ...base, pitch: { ...(lead.pitch ?? {}), sent: true, sentAt: envelope.occurredAt || new Date().toISOString(), provider: 'a1' } };
  }
  if (envelope.eventType === 'outbound.message_failed') {
    return { ...base, status: 'needs_review', pitch: { ...(lead.pitch ?? {}), sent: false, error: payload.error || 'A1 outbound failed' } };
  }
  if (envelope.eventType === 'customer.telegram_started') {
    return { ...base, customerTelegram: payload.customerTelegram || lead.customerTelegram || {}, status: 'customer_chat' };
  }
  if (envelope.eventType === 'customer.brief_updated') {
    return { ...base, customerBrief: payload.brief || lead.customerBrief || {}, status: 'briefing' };
  }
  if (envelope.eventType === 'customer.revision_requested') {
    return { ...base, revision: { requestedAt: envelope.occurredAt || new Date().toISOString(), text: payload.text || '' }, status: 'revision_requested' };
  }
  return base;
}

function localLaneForA1Stage(stage) {
  const value = String(stage || '').toLowerCase();
  if (value === 'new') return LANES.scout;
  if (value === 'qualification') return LANES.diagnosis;
  if (value === 'in_work') return LANES.lovable;
  if (value === 'offer') return LANES.check;
  if (value === 'follow_up' || value === 'converted') return LANES.replies;
  return LANES.diagnosis;
}

function eventMessage(envelope) {
  const payload = envelope.payload ?? {};
  return payload.text || payload.message || `${envelope.eventType} from A1`;
}

function isPositiveReply(payload = {}) {
  const values = [
    payload.intent,
    payload.replyIntent,
    payload.sentiment,
    payload.status,
    payload.classification,
  ].map((value) => String(value || '').toLowerCase());
  return payload.positive === true || values.some((value) => ['positive', 'interested', 'qualified', 'hot', 'accepted'].includes(value));
}

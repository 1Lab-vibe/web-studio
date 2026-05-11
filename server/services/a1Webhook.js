import { crmAddEvent, crmConvertLeadToDeal } from './a1Client.js';
import { enrichLeadScore } from './scoring.js';
import { recordSubjectReply } from './subjectAB.js';

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
  'lead.contact_updated',
  'lead.email_found',
  'lead.email_not_obtained',
  'lead.disqualified',
  'lead.failed',
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
  let updatedLead = Object.keys(patch).length ? await store.updateLead(lead.id, patch) : lead;
  if (isEmailUpdateEvent(envelope)) {
    const email = extractEmail(envelope.payload);
    if (email) {
      await store.enqueueJob({
        type: 'enrich_lead',
        leadId: updatedLead.id,
        priority: 440,
        idempotencyKey: `enrich:${updatedLead.id}:a1-email:${eventId}`,
        payload: { source: 'a1_email_found', eventId, email },
      });
      await crmAddEvent({
        entityType: 'lead',
        entityId: updatedLead.a1LeadId || updatedLead.a1?.leadId || updatedLead.id,
        eventType: 'webstudio.email_rescore_queued',
        text: 'Web Studio queued contact validation and rescore after A1 returned email',
        payload: { webstudioLeadId: updatedLead.id, email },
        idempotencyKey: `webstudio:${updatedLead.id}:a1-email-rescore:${eventId}`,
      });
    }
  }
  if (isFailureEvent(envelope)) {
    await store.cancelLeadJobs(updatedLead.id, ['enrich_lead', 'diagnose_lead', 'lovable_build', 'checker_eval', 'outbound_queue'], 'a1_lead_failed');
  }
  if (envelope.eventType === 'lead.replied') {
    const subjectVariantId = updatedLead.subjectVariantId || updatedLead.pitch?.subjectVariantId || lead.subjectVariantId || lead.pitch?.subjectVariantId;
    if (subjectVariantId) await recordSubjectReply(store, subjectVariantId);
    const cancelled = await store.cancelLeadJobs(lead.id, ['outbound_followup_1', 'outbound_followup_2'], 'lead_replied');
    if (cancelled.length) {
      const followups = { ...(updatedLead.followups || {}) };
      for (const job of cancelled) {
        const stage = job.payload?.stage || (job.type === 'outbound_followup_1' ? 1 : 2);
        const key = `stage_${stage}`;
        if (followups[key] && !followups[key].sentAt) {
          followups[key] = { ...followups[key], status: 'cancelled', cancelledReason: 'lead_replied' };
        }
      }
      await store.updateLead(lead.id, { followups });
    }
  }
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

  if (isEmailUpdateEvent(envelope)) {
    const email = extractEmail(payload);
    if (!email) return { ...base, status: 'a1_contact_updated_without_email' };
    const contacts = mergeEmailIntoContacts(lead.contacts, email, payload);
    return enrichLeadScore({
      ...lead,
      ...base,
      contacts,
      lane: LANES.scout,
      pipelineStage: 'scouted',
      stageStatus: 'a1_email_received',
      status: 'new',
      owner: 'Scout',
      contactReview: {
        ...(lead.contactReview || {}),
        status: 'a1_email_received',
        emailReceivedAt: envelope.occurredAt || new Date().toISOString(),
        source: payload.source || 'a1_manager',
      },
      a1EmailLookup: {
        ...(lead.a1EmailLookup || {}),
        status: 'email_received',
        email,
        receivedAt: envelope.occurredAt || new Date().toISOString(),
      },
    });
  }
  if (envelope.eventType === 'lead.stage_changed' || envelope.eventType === 'deal.stage_changed') {
    if (isFailureStage(payload)) {
      return {
        ...base,
        lane: LANES.scout,
        pipelineStage: 'failed',
        stageStatus: 'a1_disqualified',
        status: 'failed',
        owner: 'A1',
        contactReview: {
          ...(lead.contactReview || {}),
          status: 'a1_disqualified',
          failedAt: envelope.occurredAt || new Date().toISOString(),
          reason: payload.reason || payload.status || payload.stage || payload.toStage || '',
        },
      };
    }
    return {
      ...base,
      lane: payload.webstudioLane || localLaneForA1Stage(payload.stage || payload.toStage),
      status: payload.status || 'in_progress',
    };
  }
  if (isFailureEvent(envelope)) {
    return {
      ...base,
      lane: LANES.scout,
      pipelineStage: 'failed',
      stageStatus: 'a1_email_not_obtained',
      status: 'failed',
      owner: 'A1',
      contactReview: {
        ...(lead.contactReview || {}),
        status: 'a1_email_not_obtained',
        failedAt: envelope.occurredAt || new Date().toISOString(),
        reason: payload.reason || payload.text || payload.message || 'A1 marked lead as failed',
      },
      a1EmailLookup: {
        ...(lead.a1EmailLookup || {}),
        status: 'failed',
        failedAt: envelope.occurredAt || new Date().toISOString(),
        reason: payload.reason || payload.text || payload.message || '',
      },
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

function isEmailUpdateEvent(envelope = {}) {
  const eventType = String(envelope.eventType || '');
  return ['lead.contact_updated', 'lead.email_found'].includes(eventType) || (eventType === 'lead.stage_changed' && Boolean(extractEmail(envelope.payload || {})));
}

function isFailureEvent(envelope = {}) {
  const eventType = String(envelope.eventType || '');
  return ['lead.email_not_obtained', 'lead.disqualified', 'lead.failed'].includes(eventType) || (eventType === 'lead.stage_changed' && isFailureStage(envelope.payload || {}));
}

function isFailureStage(payload = {}) {
  const values = [
    payload.stage,
    payload.toStage,
    payload.status,
    payload.result,
    payload.reason,
  ].map((value) => String(value || '').toLowerCase());
  return values.some((value) => ['lost', 'failed', 'failure', 'refused', 'declined', 'rejected', 'disqualified', 'not_interested', 'email_not_obtained'].includes(value));
}

function extractEmail(payload = {}) {
  const direct = [payload.email, payload.contactEmail, payload.customerEmail, payload?.contact?.email].find(Boolean);
  const fromContacts = Array.isArray(payload.contacts?.emails) ? payload.contacts.emails.find(Boolean) : '';
  const fromEmails = Array.isArray(payload.emails) ? payload.emails.find(Boolean) : '';
  return normalizeEmail(direct || fromContacts || fromEmails);
}

function mergeEmailIntoContacts(existing = {}, email, payload = {}) {
  const normalized = normalizeEmail(email);
  const emails = unique([...(existing.emails || []), normalized]);
  const channels = Array.isArray(existing.channels) ? existing.channels.filter(Boolean) : [];
  if (!channels.some((channel) => channel.type === 'email' && normalizeEmail(channel.value) === normalized)) {
    channels.push({
      type: 'email',
      value: normalized,
      confidence: Number(payload.confidence ?? 0.9),
      source: payload.source || 'a1_manager',
    });
  }
  return {
    ...existing,
    ...payload.contacts,
    emails,
    channels,
    emailValidation: {
      ...(existing.emailValidation || {}),
      best: {
        value: normalized,
        confidence: Number(payload.confidence ?? 0.9),
        source: payload.source || 'a1_manager',
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function unique(values = []) {
  return [...new Set(values.map(normalizeEmail).filter(Boolean))];
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

import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { crmAddEvent, crmCreateManagerTask, crmMoveLeadStage, parsedToolData, syncA1CrmLead } from '../server/services/a1Client.js';
import { buildPhoneEmailRequestArtifact, phoneEmailRequestEventPayload, shouldPreparePhoneEmailRequest } from '../server/services/phoneEmailRequest.js';

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
const noA1 = process.argv.includes('--no-a1');

const store = new Store(config.DATA_DIR);
await store.load();

let scanned = 0;
let prepared = 0;
let skipped = 0;
let taskCreated = 0;
let taskSkipped = 0;
let a1Ok = 0;
let a1Failed = 0;

for (const lead of store.listLeads()) {
  if (!shouldPreparePhoneEmailRequest(lead)) continue;
  scanned += 1;

  const artifact = buildPhoneEmailRequestArtifact(lead);
  const existing = lead.phoneEmailRequest || {};
  const sameText = existing.version === artifact.version && existing.text === artifact.text && existing.phone === artifact.phone;
  const existingTaskOk = Boolean(lead.a1EmailLookup?.task?.ok);
  if (!force && sameText && existingTaskOk) {
    skipped += 1;
    continue;
  }

  if (dryRun) {
    prepared += 1;
    console.log(`[dry-run] ${lead.name} -> ${artifact.phone}\n${artifact.text}\n`);
    continue;
  }

  const now = new Date().toISOString();
  let updated = await store.updateLead(lead.id, {
    contacts: {
      ...(lead.contacts || {}),
      phone: lead.contacts?.phone || lead.phone || artifact.phone,
      channels: ensurePhoneChannels(lead.contacts?.channels, lead.phone || artifact.phone),
    },
    contactReview: {
      ...(lead.contactReview || {}),
      checkedAt: lead.contactReview?.checkedAt || now,
      status: 'phone_only_a1_handoff',
      hasAnyEmail: false,
      hasPhone: true,
      handedOffToA1At: lead.contactReview?.handedOffToA1At || now,
    },
    phoneEmailRequest: {
      ...existing,
      ...artifact,
      status: 'prepared',
      updatedAt: now,
      backfilledAt: now,
    },
    a1EmailLookup: {
      ...(lead.a1EmailLookup || {}),
      status: existingTaskOk ? 'task_created' : 'pending',
      requestedAt: lead.a1EmailLookup?.requestedAt || now,
      reason: lead.a1EmailLookup?.reason || 'phone_only_no_email',
    },
    pipelineStage: lead.pipelineStage === 'failed' ? lead.pipelineStage : 'scouted',
    stageStatus: existingTaskOk ? 'a1_email_task_created' : 'awaiting_a1_email',
    status: 'a1_email_lookup',
    lastTransitionReason: 'phone_only_manager_lookup_backfill',
  });
  await store.addEvent(updated.id, 'manager.email_request_prepared', 'Prepared phone-only email request message for A1 manager');
  prepared += 1;

  if (noA1) continue;

  const sync = await syncA1CrmLead(updated, 'phone_email_request_backfill');
  const data = parsedToolData(sync.upsert) || parsedToolData(sync) || {};
  updated = await store.updateLead(updated.id, {
    a1Crm: sync,
    a1LeadId: sync.a1LeadId || data.a1LeadId || data.leadId || data.id || updated.a1LeadId || '',
    a1: {
      ...(updated.a1 || {}),
      leadId: sync.a1LeadId || data.a1LeadId || data.leadId || data.id || updated.a1?.leadId || '',
      dedupeKey: sync.dedupeKey || updated.a1?.dedupeKey || `webstudio:${updated.id}`,
      lastSyncAt: new Date().toISOString(),
    },
  });
  const a1LeadId = updated.a1LeadId || updated.a1?.leadId || updated.id;
  const stageMove = await crmMoveLeadStage({
    a1LeadId,
    externalId: updated.id,
    dedupeKey: `webstudio:${updated.id}`,
    stage: 'qualification',
    status: 'open',
    reason: 'phone_only_email_lookup',
    actor: 'web-studio-orchestrator',
    idempotencyKey: `webstudio:${updated.id}:stage:qualification:phone-email-lookup:v1`,
    payload: {
      webstudioStageStatus: 'awaiting_a1_email',
      phone: artifact.phone,
      phoneEmailRequest: phoneEmailRequestEventPayload(artifact),
    },
  });

  let task = updated.a1EmailLookup?.task || null;
  if (!existingTaskOk || force) {
    task = await crmCreateManagerTask({
      a1LeadId,
      externalId: updated.id,
      dedupeKey: `webstudio:${updated.id}`,
      title: `Уточнить email: ${updated.name}`,
      description: managerTaskDescription(updated, artifact),
      reason: 'phone_only_email_lookup',
      priority: Number(updated.fitScore || updated.priority || 0) >= 70 ? 'high' : 'normal',
      idempotencyKey: `webstudio:${updated.id}:manager-email-task:v1`,
      payload: {
        phoneEmailRequest: phoneEmailRequestEventPayload(artifact),
        webstudioLead: {
          id: updated.id,
          name: updated.name,
          city: updated.city,
          niche: updated.niche,
          phone: artifact.phone,
          address: updated.address,
          score: updated.fitScore ?? updated.priority ?? 0,
        },
      },
    });
    if (task.ok) taskCreated += 1;
  } else {
    taskSkipped += 1;
  }

  const eventResult = await crmAddEvent({
    entityType: updated.a1DealId ? 'deal' : 'lead',
    entityId: updated.a1DealId || a1LeadId || updated.id,
    eventType: 'manager.email_request_prepared',
    text: 'Phone-only lead: manager should request email for website preview',
    payload: {
      webstudioLeadId: updated.id,
      phoneEmailRequest: phoneEmailRequestEventPayload(artifact),
      stageMove,
      managerTask: task,
      source: 'backfill',
    },
    idempotencyKey: `webstudio:${updated.id}:phone-email-request:${artifact.version}`,
  });

  await store.updateLead(updated.id, {
    a1EmailLookup: {
      ...(updated.a1EmailLookup || {}),
      status: task?.ok ? 'task_created' : 'event_created',
      task,
      stageMove,
      taskCreatedAt: task?.ok ? new Date().toISOString() : updated.a1EmailLookup?.taskCreatedAt || '',
      lastError: task?.ok ? '' : task?.error || task?.reason || '',
    },
    stageStatus: task?.ok ? 'a1_email_task_created' : 'awaiting_a1_email',
    phoneEmailRequest: {
      ...(updated.phoneEmailRequest || {}),
      a1EventOk: Boolean(eventResult.ok),
      a1EventError: eventResult.ok ? '' : eventResult.error || eventResult.reason || '',
      a1SyncedAt: new Date().toISOString(),
    },
  });
  if (eventResult.ok || eventResult.skipped) a1Ok += 1;
  else a1Failed += 1;
}

console.log(JSON.stringify({ ok: true, dryRun, scanned, prepared, skipped, taskCreated, taskSkipped, a1Ok, a1Failed }, null, 2));

function ensurePhoneChannels(channels = [], phone = '') {
  const list = Array.isArray(channels) ? [...channels] : [];
  if (phone && !list.some((channel) => String(channel?.type || '').includes('phone') && channel?.value)) {
    list.push({ type: 'phone_call', value: phone, confidence: 0.7, source: 'webstudio' });
    list.push({ type: 'sms_requires_consent', value: phone, confidence: 0.2, source: 'webstudio' });
  }
  return list;
}

function managerTaskDescription(lead, artifact) {
  return [
    `Лид из Web Studio: ${lead.name}`,
    `Город: ${lead.city || 'не указан'}`,
    `Ниша: ${lead.niche || 'не указана'}`,
    `Телефон: ${artifact.phone || 'не указан'}`,
    `Адрес: ${lead.address || 'не указан'}`,
    '',
    'Задача: связаться с клиентом только для уточнения рабочей почты и согласия на дальнейшую коммуникацию по email.',
    'Если email получен, отправьте webhook lead.contact_updated / lead.email_found с externalId и email.',
    'Если клиент отказался, переведите лид в отказ/провал в A1, чтобы Web Studio получила webhook и закрыла его локально.',
    '',
    'Короткий текст для связи:',
    artifact.text,
  ].join('\n');
}

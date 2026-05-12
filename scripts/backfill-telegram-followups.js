import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { crmAddEvent, parsedToolData, syncA1CrmLead } from '../server/services/a1Client.js';
import { buildTelegramFollowupArtifact, shouldPrepareTelegramFollowup, telegramFollowupEventPayload } from '../server/services/telegramFollowup.js';

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
const noA1 = process.argv.includes('--no-a1');

const store = new Store(config.DATA_DIR);
await store.load();

let scanned = 0;
let prepared = 0;
let skipped = 0;
let noEmail = 0;
let a1Ok = 0;
let a1Failed = 0;

for (const lead of store.listLeads()) {
  if (!shouldPrepareTelegramFollowup(lead)) continue;
  scanned += 1;

  const artifact = buildTelegramFollowupArtifact(lead);
  if (!artifact.email) {
    noEmail += 1;
    continue;
  }

  const existing = lead.telegramFollowup || {};
  const sameText = existing.version === artifact.version && existing.text === artifact.text && existing.email === artifact.email;
  if (!force && sameText) {
    skipped += 1;
    continue;
  }

  if (dryRun) {
    prepared += 1;
    console.log(`[dry-run] ${lead.name} -> ${artifact.email}\n${artifact.text}\n`);
    continue;
  }

  const now = new Date().toISOString();
  let updated = await store.updateLead(lead.id, {
    telegramFollowup: {
      ...existing,
      ...artifact,
      status: 'prepared',
      updatedAt: now,
      backfilledAt: now,
    },
  });
  await store.addEvent(lead.id, 'outbound.telegram_followup_prepared', 'Backfilled Telegram follow-up message after outbound email');
  prepared += 1;

  if (noA1) continue;

  const eventResult = await crmAddEvent({
    entityType: updated.a1DealId ? 'deal' : 'lead',
    entityId: updated.a1DealId || updated.a1LeadId || updated.id,
    eventType: 'outbound.telegram_followup_prepared',
    text: 'Telegram follow-up message prepared after outbound email',
    payload: {
      webstudioLeadId: updated.id,
      telegramFollowup: telegramFollowupEventPayload(artifact),
      source: 'backfill',
    },
    idempotencyKey: `webstudio:${updated.id}:telegram-followup:${artifact.version}:${normalizeEmail(artifact.email)}`,
  });
  const crmResult = await syncA1CrmLead(updated, 'telegram_followup_backfill');
  const crmData = parsedToolData(crmResult.upsert) || parsedToolData(crmResult) || {};
  updated = await store.updateLead(updated.id, {
    a1LeadId: crmResult.a1LeadId || crmData.a1LeadId || crmData.leadId || crmData.id || updated.a1LeadId || '',
    telegramFollowup: {
      ...(updated.telegramFollowup || {}),
      a1EventOk: Boolean(eventResult.ok),
      a1EventError: eventResult.ok ? '' : eventResult.error || eventResult.reason || '',
      a1SyncedAt: new Date().toISOString(),
    },
  });
  if (eventResult.ok || eventResult.skipped) a1Ok += 1;
  else a1Failed += 1;
}

console.log(
  JSON.stringify(
    {
      ok: true,
      dryRun,
      scanned,
      prepared,
      skipped,
      noEmail,
      a1Ok,
      a1Failed,
    },
    null,
    2,
  ),
);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

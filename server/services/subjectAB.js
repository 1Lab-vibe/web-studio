import { createHash } from 'node:crypto';

const MIN_SENDS_FOR_EXPLOIT = 5;
const EXPLORE_RATIO = 0.2;

export function variantId(text) {
  if (!text) return '';
  return createHash('sha1').update(String(text).trim().toLowerCase()).digest('hex').slice(0, 12);
}

function ensureMetricsBucket(store) {
  store.state.metrics ??= {};
  store.state.metrics.subjectStats ??= {};
  return store.state.metrics.subjectStats;
}

function statsFor(store, id) {
  const bucket = ensureMetricsBucket(store);
  bucket[id] ??= { sent: 0, clicks: 0, replied: 0, lastSentAt: '', lastClickedAt: '', lastRepliedAt: '' };
  if (typeof bucket[id].clicks !== 'number') bucket[id].clicks = 0;
  return bucket[id];
}

function rate(stats) {
  if (!stats || !stats.sent) return 0;
  return stats.replied / stats.sent;
}

export function listSubjectVariants(lead) {
  const variants = Array.isArray(lead?.subjectVariants) ? lead.subjectVariants : [];
  const cleaned = variants
    .map((variant) => {
      if (typeof variant === 'string') return { text: variant };
      if (variant && typeof variant === 'object' && variant.text) return { text: String(variant.text), angle: variant.angle || '' };
      return null;
    })
    .filter(Boolean);
  if (cleaned.length) return cleaned;
  if (lead?.subject) return [{ text: String(lead.subject), angle: 'fallback_single' }];
  return [];
}

export function pickSubjectVariant(lead, store) {
  const variants = listSubjectVariants(lead);
  if (!variants.length) return null;
  if (lead?.outboundPackage?.subjectVariantId) {
    const sticky = variants.find((variant) => variantId(variant.text) === lead.outboundPackage.subjectVariantId);
    if (sticky) return { ...sticky, id: lead.outboundPackage.subjectVariantId, mode: 'sticky' };
  }
  const enriched = variants.map((variant) => {
    const id = variantId(variant.text);
    const stats = statsFor(store, id);
    return { ...variant, id, stats };
  });
  const explore = enriched.find((variant) => variant.stats.sent < MIN_SENDS_FOR_EXPLOIT);
  if (explore && Math.random() < 0.5) {
    return { ...explore, mode: 'explore_low_data' };
  }
  if (Math.random() < EXPLORE_RATIO) {
    const random = enriched[Math.floor(Math.random() * enriched.length)];
    return { ...random, mode: 'explore_random' };
  }
  enriched.sort((a, b) => rate(b.stats) - rate(a.stats) || (b.stats.replied || 0) - (a.stats.replied || 0));
  return { ...enriched[0], mode: 'exploit' };
}

export async function recordSubjectSend(store, id) {
  if (!id) return;
  const stats = statsFor(store, id);
  stats.sent += 1;
  stats.lastSentAt = new Date().toISOString();
  await store.save();
}

export async function recordSubjectReply(store, id) {
  if (!id) return;
  const stats = statsFor(store, id);
  stats.replied += 1;
  stats.lastRepliedAt = new Date().toISOString();
  await store.save();
}

export async function recordSubjectClick(store, id) {
  if (!id) return;
  const stats = statsFor(store, id);
  stats.clicks += 1;
  stats.lastClickedAt = new Date().toISOString();
  await store.save();
}

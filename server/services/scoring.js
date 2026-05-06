import { config } from '../config.js';

const nicheWeights = [
  [/стомат|дент/i, 18],
  [/недвиж|риел/i, 16],
  [/кров/i, 14],
  [/кондиционер|климат/i, 12],
  [/салон|beauty|красот/i, 10],
  [/ремонт|пол|строй/i, 8],
];

export function siteGapScore(lead) {
  const site = String(lead.site || '').toLowerCase();
  if (!site || site.includes('нет сайта')) return 25;
  if (site.includes('201') || site.includes('200') || site.includes('taplink')) return 16;
  return 5;
}

export function nicheWeight(lead) {
  const text = `${lead.niche || ''} ${lead.name || ''}`;
  return nicheWeights.find(([pattern]) => pattern.test(text))?.[1] ?? 6;
}

export function contactScore(lead) {
  const emails = Array.isArray(lead.contacts?.emails) ? lead.contacts.emails.filter(Boolean) : [];
  const hasEmailChannel = Array.isArray(lead.contacts?.channels)
    ? lead.contacts.channels.some((channel) => channel?.type === 'email' && channel?.value)
    : false;
  const hasPhone = Boolean(lead.phone || lead.contacts?.phone);
  if (emails.length || hasEmailChannel) return 18;
  if (hasPhone) return 4;
  return 0;
}

export function calculateFitScore(lead) {
  const priority = Number(lead.priority ?? 50);
  const dealScore = Math.min(25, Math.round(Number(lead.deal ?? 0) / 15000));
  const replyScore = Math.max(0, Math.min(20, Number(lead.replyRate ?? 12)));
  return Math.min(100, Math.round(priority * 0.3 + dealScore + replyScore + siteGapScore(lead) * 0.5 + nicheWeight(lead) + contactScore(lead)));
}

export function enrichLeadScore(lead) {
  const score = calculateFitScore(lead);
  lead.fitScore = score;
  lead.scoring = {
    fitScore: score,
    priority: Number(lead.priority ?? 50),
    deal: Number(lead.deal ?? 0),
    replyRate: Number(lead.replyRate ?? 0),
    siteGap: siteGapScore(lead),
    nicheWeight: nicheWeight(lead),
    contactScore: contactScore(lead),
    updatedAt: new Date().toISOString(),
  };
  return lead;
}

export function topLovableCandidates(leads, limit = config.DAILY_MOCKUP_LIMIT) {
  return leads
    .filter((lead) => lead.lane === 'Диагноз')
    .filter((lead) => !['done', 'paused', 'waiting_approval', 'needs_review'].includes(lead.status))
    .map((lead) => enrichLeadScore({ ...lead }))
    .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
    .slice(0, Math.max(0, Number(limit) || 0));
}

import { config } from '../config.js';

const nicheWeights = [
  [/\u0441\u0442\u043e\u043c\u0430\u0442|\u0434\u0435\u043d\u0442/i, 18],
  [/\u043d\u0435\u0434\u0432\u0438\u0436|\u0440\u0438\u0435\u043b/i, 16],
  [/\u043a\u0440\u043e\u0432/i, 14],
  [/\u043a\u043e\u043d\u0434\u0438\u0446\u0438\u043e\u043d\u0435\u0440|\u043a\u043b\u0438\u043c\u0430\u0442/i, 12],
  [/\u0441\u0430\u043b\u043e\u043d|beauty|\u043a\u0440\u0430\u0441\u043e\u0442/i, 10],
  [/\u0440\u0435\u043c\u043e\u043d\u0442|\u043f\u043e\u043b|\u0441\u0442\u0440\u043e\u0439/i, 8],
];

export function siteGapScore(lead) {
  const site = String(lead.site || '').toLowerCase();
  if (!site || site.includes('\u043d\u0435\u0442 \u0441\u0430\u0439\u0442\u0430')) return 25;
  if (site.includes('201') || site.includes('200') || site.includes('taplink')) return 16;
  return 5;
}

export function nicheWeight(lead) {
  const text = `${lead.niche || ''} ${lead.name || ''}`;
  return nicheWeights.find(([pattern]) => pattern.test(text))?.[1] ?? 6;
}

export function contactScore(lead) {
  const hasPhone = Boolean(lead.phone || lead.contacts?.phone);
  if (hasEmailContact(lead)) return 18;
  if (hasPhone) return 4;
  return 0;
}

export function hasEmailContact(lead) {
  const emails = Array.isArray(lead.contacts?.emails) ? lead.contacts.emails.filter(Boolean) : [];
  const hasEmailChannel = Array.isArray(lead.contacts?.channels)
    ? lead.contacts.channels.some((channel) => channel?.type === 'email' && channel?.value)
    : false;
  return Boolean(emails.length || hasEmailChannel || lead.email);
}

export function isQuotaFreeLead(lead) {
  return ['telegram_inbound', 'manual_smoke'].includes(String(lead.source || ''));
}

export function isLovableEligible(lead) {
  return isQuotaFreeLead(lead) || hasEmailContact(lead);
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
    hasEmail: hasEmailContact(lead),
    lovableEligible: isLovableEligible(lead),
    updatedAt: new Date().toISOString(),
  };
  return lead;
}

function isDiagnosisLane(lead) {
  const lane = String(lead.lane || '');
  return lead.pipelineStage === 'diagnosed' || lane === '\u0414\u0438\u0430\u0433\u043d\u043e\u0437' || lane === 'Р”РёР°РіРЅРѕР·';
}

export function topLovableCandidates(leads, limit = config.DAILY_MOCKUP_LIMIT) {
  return leads
    .filter(isDiagnosisLane)
    .filter((lead) => !['done', 'paused', 'waiting_approval', 'needs_review'].includes(lead.status))
    .filter((lead) => isLovableEligible(lead))
    .map((lead) => enrichLeadScore({ ...lead }))
    .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
    .slice(0, Math.max(0, Number(limit) || 0));
}

import { promises as dns } from 'node:dns';
import { config } from '../config.js';

const ROLE_LOCAL_PARTS = new Set([
  'info', 'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'admin', 'administrator', 'webmaster', 'postmaster', 'hostmaster',
  'support', 'help', 'helpdesk', 'service', 'office',
  'mail', 'mailbox', 'reply', 'spam', 'abuse',
  'sales', 'marketing', 'billing', 'accounts', 'accounting',
  'hr', 'jobs', 'career', 'careers', 'press', 'media',
  'order', 'orders', 'enquiry', 'enquiries', 'feedback', 'contact', 'contacts',
  'shop', 'store', 'reception', 'secretary', 'manager',
  'site', 'web', 'www',
]);

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yandex.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'ya.ru',
  'mail.ru', 'inbox.ru', 'list.ru', 'bk.ru', 'internet.ru',
  'rambler.ru', 'lenta.ru', 'autorambler.ru',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com',
  'yahoo.com', 'yahoo.ru', 'ymail.com',
  'protonmail.com', 'proton.me', 'pm.me',
  'aol.com', 'gmx.com', 'gmx.net',
]);

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

const mxCache = new Map();
const MX_CACHE_TTL_MS = 60 * 60 * 1000;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase().replace(/[),.;:]+$/, '');
}

function parseEmail(email) {
  const value = normalizeEmail(email);
  if (!EMAIL_RE.test(value)) return null;
  const [local, domain] = value.split('@');
  return { value, local, domain };
}

async function lookupMx(domain) {
  if (!domain) return [];
  const cached = mxCache.get(domain);
  if (cached && cached.expiresAt > Date.now()) return cached.records;
  try {
    const records = await dns.resolveMx(domain);
    const sorted = [...records].sort((a, b) => a.priority - b.priority);
    mxCache.set(domain, { records: sorted, expiresAt: Date.now() + MX_CACHE_TTL_MS });
    return sorted;
  } catch {
    mxCache.set(domain, { records: [], expiresAt: Date.now() + MX_CACHE_TTL_MS });
    return [];
  }
}

export function isRoleLocalPart(local) {
  if (!local) return false;
  const value = String(local).toLowerCase();
  if (ROLE_LOCAL_PARTS.has(value)) return true;
  return [...ROLE_LOCAL_PARTS].some((role) => value === role || value.startsWith(`${role}.`) || value.startsWith(`${role}-`) || value.startsWith(`${role}_`));
}

export function isFreeMailDomain(domain) {
  return FREE_MAIL_DOMAINS.has(String(domain || '').toLowerCase());
}

export async function validateEmail(email, { siteUrl = '' } = {}) {
  const parsed = parseEmail(email);
  if (!parsed) {
    return { ok: false, value: normalizeEmail(email), confidence: 0, reasons: ['invalid_format'] };
  }
  const { value, local, domain } = parsed;
  const reasons = [];
  const role = isRoleLocalPart(local);
  const freeMail = isFreeMailDomain(domain);
  let mxRecords = [];
  if (config.EMAIL_VALIDATION_ENABLED) {
    mxRecords = await lookupMx(domain);
    if (!mxRecords.length) reasons.push('no_mx');
  }
  if (role) reasons.push('role_local_part');
  if (freeMail) reasons.push('free_mail_domain');
  let siteDomain = '';
  try {
    siteDomain = siteUrl ? new URL(siteUrl).hostname.replace(/^www\./, '').toLowerCase() : '';
  } catch {
    siteDomain = '';
  }
  const matchesSite = Boolean(siteDomain && (siteDomain === domain || siteDomain.endsWith(`.${domain}`) || domain.endsWith(`.${siteDomain}`)));

  let confidence = 0.5;
  if (mxRecords.length) confidence += 0.2;
  if (!role) confidence += 0.2;
  if (matchesSite) confidence += 0.15;
  if (freeMail) confidence -= 0.15;
  if (role) confidence -= 0.2;
  if (!mxRecords.length && config.EMAIL_VALIDATION_ENABLED) confidence -= 0.35;
  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

  return {
    ok: confidence >= 0.45 && (!config.EMAIL_VALIDATION_ENABLED || mxRecords.length > 0),
    value,
    local,
    domain,
    confidence,
    role,
    freeMail,
    matchesSite,
    hasMx: mxRecords.length > 0,
    mx: mxRecords.slice(0, 3).map((record) => record.exchange),
    reasons,
  };
}

export async function pickBestEmail(candidates, { siteUrl = '' } = {}) {
  const seen = new Set();
  const validated = [];
  for (const candidate of candidates) {
    const value = normalizeEmail(candidate);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    validated.push(await validateEmail(value, { siteUrl }));
  }
  validated.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return { best: validated[0] || null, all: validated };
}

import { config, hasSecret } from '../config.js';
import { searchContactsViaA1Yandex } from './a1YandexSearch.js';
import { pickBestEmail } from './emailValidator.js';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function normalizeEmail(email) {
  return String(email || '').toLowerCase().replace(/[),.;:]+$/, '');
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function invalidEmailSet(lead = {}) {
  const validation = lead.contacts?.emailValidation || {};
  const review = lead.contactReview || {};
  return new Set(
    [
      ...(validation.invalid || []),
      ...(validation.bouncedEmails || []),
      ...(validation.invalidEmails || []),
      ...(review.invalidEmails || []),
      ...(review.bouncedEmails || []),
    ]
      .map(normalizeEmail)
      .filter(Boolean),
  );
}

async function fetchText(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'WebStudioLeadResearch/1.0 (+https://webstudio.1true.ru)',
        accept: 'text/html,text/plain,application/json',
      },
    });
    if (!response.ok) return '';
    return await response.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

async function findEmailsOnWebsite(url) {
  if (!url || !/^https?:\/\//i.test(url)) return [];
  const pages = [url, new URL('/contacts', url).toString(), new URL('/kontakty', url).toString()];
  const emails = [];
  for (const page of pages) {
    const text = await fetchText(page);
    emails.push(...(text.match(EMAIL_RE) || []).map(normalizeEmail));
  }
  return unique(emails).slice(0, 5);
}

async function searchEmails(lead) {
  if (!hasSecret(config.GOOGLE_MAPS_API_KEY) || !hasSecret(config.GOOGLE_CSE_ID)) return [];
  const query = `"${lead.name}" ${lead.city || ''} email OR почта OR контакты`;
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', config.GOOGLE_MAPS_API_KEY);
  url.searchParams.set('cx', config.GOOGLE_CSE_ID);
  url.searchParams.set('q', query);
  const text = await fetchText(url.toString());
  return unique((text.match(EMAIL_RE) || []).map(normalizeEmail)).slice(0, 5);
}

export async function enrichContacts(lead) {
  const invalidEmails = invalidEmailSet(lead);
  const notInvalid = (email) => !invalidEmails.has(normalizeEmail(email));
  const existingEmails = unique([lead.email, ...(lead.contacts?.emails ?? [])].map(normalizeEmail).filter(notInvalid));
  const existingEmailChannels = (lead.contacts?.channels ?? []).filter(
    (channel) => channel.type === 'email' && channel.value && notInvalid(channel.value),
  );
  const websiteEmails = await findEmailsOnWebsite(lead.url);
  const a1Yandex = websiteEmails.length ? { emails: [], urls: [] } : await searchContactsViaA1Yandex(lead);
  const a1YandexEmails = unique((a1Yandex.text?.match(EMAIL_RE) || []).map(normalizeEmail));
  const searchEmailsFound = websiteEmails.length || a1YandexEmails.length ? [] : await searchEmails(lead);
  const allCandidates = unique([...existingEmails, ...websiteEmails, ...a1YandexEmails, ...searchEmailsFound].filter(notInvalid));

  const validation = await pickBestEmail(allCandidates, { siteUrl: lead.url });
  const valid = validation.all.filter((entry) => entry.ok);
  const emails = valid.length ? valid.map((entry) => entry.value) : allCandidates;
  const best = validation.best;

  const channels = [...existingEmailChannels];
  if (best?.value && !channels.some((channel) => normalizeEmail(channel.value) === best.value)) {
    channels.push({
      type: 'email',
      value: best.value,
      confidence: best.confidence ?? 0,
      hasMx: Boolean(best.hasMx),
      role: Boolean(best.role),
      freeMail: Boolean(best.freeMail),
      matchesSite: Boolean(best.matchesSite),
      reasons: best.reasons || [],
    });
  }
  if (lead.phone) channels.push({ type: 'phone_call', value: lead.phone, confidence: 0.7 });
  if (lead.phone) channels.push({ type: 'sms_requires_consent', value: lead.phone, confidence: 0.2 });

  return {
    emails,
    phone: lead.phone || '',
    channels,
    emailValidation: {
      best: best
        ? {
            value: best.value,
            confidence: best.confidence,
            hasMx: best.hasMx,
            role: best.role,
            freeMail: best.freeMail,
            matchesSite: best.matchesSite,
            reasons: best.reasons,
          }
        : null,
      candidates: validation.all.map((entry) => ({
        value: entry.value,
        confidence: entry.confidence,
        hasMx: entry.hasMx,
        role: entry.role,
        freeMail: entry.freeMail,
        matchesSite: entry.matchesSite,
        reasons: entry.reasons,
      })),
      invalid: Array.from(invalidEmails),
    },
    sources: {
      website: { emails: websiteEmails.length },
      a1Yandex: { ok: Boolean(a1Yandex.ok), skipped: Boolean(a1Yandex.skipped), emails: a1YandexEmails.length, reason: a1Yandex.reason || '' },
      googleCse: { enabled: hasSecret(config.GOOGLE_CSE_ID), emails: searchEmailsFound.length },
    },
    policy: {
      phoneColdAdsAllowed: false,
      reason: 'Реклама по сетям электросвязи требует предварительного согласия адресата; без согласия телефон лучше использовать для ручного звонка/уточнения контакта, а не для рекламной рассылки.',
    },
    updatedAt: new Date().toISOString(),
  };
}

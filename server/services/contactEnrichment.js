import { config, hasSecret } from '../config.js';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function normalizeEmail(email) {
  return String(email || '').toLowerCase().replace(/[),.;:]+$/, '');
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
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
  const websiteEmails = await findEmailsOnWebsite(lead.url);
  const searchEmailsFound = websiteEmails.length ? [] : await searchEmails(lead);
  const emails = unique([...websiteEmails, ...searchEmailsFound]);
  const channels = [];
  if (emails.length) channels.push({ type: 'email', value: emails[0], confidence: websiteEmails.length ? 0.85 : 0.55 });
  if (lead.phone) channels.push({ type: 'phone_call', value: lead.phone, confidence: 0.7 });
  if (lead.phone) channels.push({ type: 'sms_requires_consent', value: lead.phone, confidence: 0.2 });

  return {
    emails,
    phone: lead.phone || '',
    channels,
    policy: {
      phoneColdAdsAllowed: false,
      reason: 'Реклама по сетям электросвязи требует предварительного согласия адресата; без согласия телефон лучше использовать для ручного звонка/уточнения контакта, а не для рекламной рассылки.',
    },
    updatedAt: new Date().toISOString(),
  };
}

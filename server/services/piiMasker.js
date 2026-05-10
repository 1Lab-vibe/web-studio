const PHONE_RE = /(?:\+?7|8)\s*[(\-\s]?\d{3,4}[)\-\s]?\s*\d{2,3}[\-\s]?\d{2}[\-\s]?\d{2}/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const PASSPORT_RE = /\b(?:\d{2}\s?\d{2}|\d{4})\s+\d{6}\b/g;
const SNILS_RE = /\b\d{3}-\d{3}-\d{3}[\s-]?\d{2}\b/g;
const INN_RE = /\b\d{12}\b|\b\d{10}\b/g;
const TELEGRAM_HANDLE_RE = /(?:^|[\s(])@[a-zA-Z][a-zA-Z0-9_]{3,}/g;
const URL_RE = /https?:\/\/[^\s<>"]+/g;

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 10) return '[phone]';
  const last2 = digits.slice(-2);
  return `[phone•${last2}]`;
}

function maskEmail(value) {
  const [local = '', domain = ''] = String(value || '').toLowerCase().split('@');
  if (!domain) return '[email]';
  const head = local.slice(0, 1);
  const tail = local.slice(-1);
  const masked = local.length <= 2 ? `${head}*` : `${head}${'*'.repeat(Math.max(1, local.length - 2))}${tail}`;
  return `${masked}@${domain}`;
}

function maskCardNumber(match) {
  const digits = String(match || '').replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return match;
  return `[card•${digits.slice(-4)}]`;
}

function maskPassport() {
  return '[passport]';
}

function maskSnils() {
  return '[snils]';
}

function maskInn(match) {
  const digits = String(match || '').replace(/\D/g, '');
  if (digits.length === 12) return '[inn-ip]';
  if (digits.length === 10) return '[inn-org]';
  return match;
}

function maskUrl(value) {
  try {
    const url = new URL(value);
    return `[url:${url.hostname}]`;
  } catch {
    return '[url]';
  }
}

export function maskPiiText(value) {
  if (typeof value !== 'string' || !value) return value;
  let next = value;
  next = next.replace(SNILS_RE, maskSnils);
  next = next.replace(INN_RE, (match) => maskInn(match));
  next = next.replace(PASSPORT_RE, maskPassport);
  next = next.replace(CARD_RE, maskCardNumber);
  next = next.replace(EMAIL_RE, (match) => maskEmail(match));
  next = next.replace(PHONE_RE, (match) => maskPhone(match));
  next = next.replace(TELEGRAM_HANDLE_RE, (match) => match.startsWith('@') ? '[tg-handle]' : `${match[0]}[tg-handle]`);
  next = next.replace(URL_RE, (match) => maskUrl(match));
  return next;
}

function maskRecordValues(input, transform) {
  if (Array.isArray(input)) return input.map((item) => maskRecordValues(item, transform));
  if (input && typeof input === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      out[key] = maskRecordValues(value, transform);
    }
    return out;
  }
  if (typeof input === 'string') return transform(input);
  return input;
}

export function maskBriefForLLM(brief = {}) {
  const cloned = JSON.parse(JSON.stringify(brief || {}));
  if (cloned.contacts) cloned.contacts = maskPiiText(String(cloned.contacts));
  if (cloned.materials) cloned.materials = maskPiiText(String(cloned.materials));
  if (cloned.notes) cloned.notes = maskPiiText(String(cloned.notes));
  if (cloned.rawCaptureText) cloned.rawCaptureText = maskPiiText(String(cloned.rawCaptureText));
  if (Array.isArray(cloned.capturedMessages)) {
    cloned.capturedMessages = cloned.capturedMessages.map((item) => ({
      ...item,
      text: typeof item?.text === 'string' ? maskPiiText(item.text) : item?.text,
    }));
  }
  if (Array.isArray(cloned.refinements)) {
    cloned.refinements = cloned.refinements.map((item) => ({
      ...item,
      text: typeof item?.text === 'string' ? maskPiiText(item.text) : item?.text,
    }));
  }
  return cloned;
}

export function maskCustomerLeadForLLM(lead = {}) {
  if (!lead) return lead;
  const cloned = { ...lead };
  if (lead.customerTelegram) {
    cloned.customerTelegram = {
      chatId: '[chat]',
      username: lead.customerTelegram.username ? '[tg-handle]' : '',
      mode: lead.customerTelegram.mode || '',
      step: lead.customerTelegram.step || 0,
      emailVerified: Boolean(lead.customerTelegram.emailVerified),
      email: lead.customerTelegram.email ? maskEmail(lead.customerTelegram.email) : '',
    };
  }
  if (lead.customerBrief) cloned.customerBrief = maskBriefForLLM(lead.customerBrief);
  if (lead.contacts) {
    cloned.contacts = {
      ...lead.contacts,
      emails: Array.isArray(lead.contacts.emails) ? lead.contacts.emails.map((email) => maskEmail(email)) : lead.contacts.emails,
      phone: lead.contacts.phone ? maskPhone(lead.contacts.phone) : lead.contacts.phone,
      channels: Array.isArray(lead.contacts.channels)
        ? lead.contacts.channels.map((channel) => {
            if (!channel?.value) return channel;
            if (channel.type === 'email') return { ...channel, value: maskEmail(channel.value) };
            if (channel.type === 'phone_call' || channel.type === 'sms_requires_consent') return { ...channel, value: maskPhone(channel.value) };
            return { ...channel, value: maskPiiText(channel.value) };
          })
        : lead.contacts.channels,
    };
  }
  if (typeof lead.phone === 'string') cloned.phone = lead.phone ? maskPhone(lead.phone) : lead.phone;
  if (typeof lead.email === 'string') cloned.email = lead.email ? maskEmail(lead.email) : lead.email;
  if (typeof lead.address === 'string') cloned.address = lead.address;
  if (lead.reply?.text) cloned.reply = { ...lead.reply, text: maskPiiText(lead.reply.text) };
  if (lead.revision?.text) cloned.revision = { ...lead.revision, text: maskPiiText(lead.revision.text) };
  return cloned;
}

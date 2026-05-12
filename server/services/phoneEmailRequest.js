const VERSION = 'phone-email-request-v1';

export function buildPhoneEmailRequestArtifact(lead = {}, options = {}) {
  const phone = options.phone || primaryPhone(lead);
  const sourceLabel = contactSourceLabel(lead);
  const text = buildPhoneEmailRequestText(lead, { sourceLabel });
  return {
    ok: Boolean(text && phone),
    version: VERSION,
    channel: 'manager_phone_email_request',
    text,
    phone,
    sourceLabel,
    preparedAt: options.preparedAt || new Date().toISOString(),
  };
}

export function phoneEmailRequestEventPayload(artifact = {}) {
  return {
    version: artifact.version || VERSION,
    channel: artifact.channel || 'manager_phone_email_request',
    text: artifact.text || '',
    phone: artifact.phone || '',
    sourceLabel: artifact.sourceLabel || '',
    preparedAt: artifact.preparedAt || '',
  };
}

export function shouldPreparePhoneEmailRequest(lead = {}) {
  return Boolean(primaryPhone(lead) && !primaryEmail(lead));
}

function buildPhoneEmailRequestText(lead = {}, { sourceLabel = '' } = {}) {
  const owner = lead.ownerName || lead.contactName || '';
  const business = lead.name || 'вашего бизнеса';
  const source = sourceLabel || 'в открытых источниках';
  const greeting = owner ? `${owner}, здравствуйте!` : 'Здравствуйте!';
  return [
    `${greeting} Нашел ваш контакт ${source}.`,
    `Подготовили для ${business} короткое превью сайта: первый экран, услуги, доверие и быстрый путь к заявке.`,
    'Подскажите, на какую рабочую почту можно отправить превью и подробности?',
    '',
    'С уважением, Иван, AI-студия 1Lab',
  ].join('\n').trim();
}

function primaryEmail(lead = {}) {
  const emails = Array.isArray(lead.contacts?.emails) ? lead.contacts.emails.filter(Boolean) : [];
  const emailChannel = Array.isArray(lead.contacts?.channels)
    ? lead.contacts.channels.find((channel) => channel?.type === 'email' && channel?.value)
    : null;
  return String(emails[0] || emailChannel?.value || lead.email || '').trim();
}

function primaryPhone(lead = {}) {
  const phoneChannel = Array.isArray(lead.contacts?.channels)
    ? lead.contacts.channels.find((channel) => String(channel?.type || '').includes('phone') && channel?.value)
    : null;
  return String(lead.phone || lead.contacts?.phone || phoneChannel?.value || '').trim();
}

function contactSourceLabel(lead = {}) {
  const sourceText = [
    lead.contacts?.source,
    lead.contacts?.provider,
    lead.contactSource,
    lead.source,
    lead.sourceKey,
    lead.site,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/yandex|яндекс/.test(sourceText) && /map|maps|карт/.test(sourceText)) return 'в открытых данных Яндекс Карт';
  if (/google|гугл/.test(sourceText) && /place|places|map|maps|карт/.test(sourceText)) return 'в открытых данных Google Maps';
  if (/yandex|яндекс/.test(sourceText) && /search|поиск/.test(sourceText)) return 'через открытый поиск Яндекса';
  if (/google|гугл/.test(sourceText) && /search|поиск/.test(sourceText)) return 'через открытый поиск Google';
  if (/site|website|web|сайт|http/.test(sourceText)) return 'на открытой странице сайта';
  if (/2gis|2гис|gis/.test(sourceText)) return 'в открытых данных 2ГИС';
  return 'в открытых источниках';
}

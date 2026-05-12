import { config } from '../config.js';

const VERSION = 'telegram-followup-v1';

export function buildTelegramFollowupArtifact(lead = {}, options = {}) {
  const email = options.email || primaryEmail(lead);
  const sourceLabel = contactSourceLabel(lead, email);
  const text = buildTelegramFollowupText(lead, { email, sourceLabel });
  return {
    ok: Boolean(text && email),
    version: VERSION,
    channel: 'telegram_manual_followup',
    text,
    email,
    sourceLabel,
    previewUrl: absolutePublicUrl(lead.mockup?.publishedUrl || lead.mockup?.deployedUrl || lead.mockup?.publicUrl || ''),
    preparedAt: options.preparedAt || new Date().toISOString(),
  };
}

export function telegramFollowupEventPayload(artifact = {}) {
  return {
    version: artifact.version || VERSION,
    channel: artifact.channel || 'telegram_manual_followup',
    text: artifact.text || '',
    email: artifact.email || '',
    sourceLabel: artifact.sourceLabel || '',
    previewUrl: artifact.previewUrl || '',
    preparedAt: artifact.preparedAt || '',
  };
}

export function shouldPrepareTelegramFollowup(lead = {}) {
  const outboundStatus = String(lead.outboundStatus || '').toLowerCase();
  const pitch = lead.pitch || {};
  return Boolean(
    pitch.sent ||
      pitch.queued ||
      ['sent', 'queued', 'succeeded'].includes(outboundStatus) ||
      lead.pipelineStage === 'outbound_sent',
  );
}

function buildTelegramFollowupText(lead = {}, { email = '', sourceLabel = '' } = {}) {
  const owner = lead.ownerName || lead.contactName || '';
  const business = lead.name || 'вашего бизнеса';
  const niche = lead.niche || 'вашей ниши';
  const previewLine = lead.site
    ? `Собрал короткое превью сайта для ${business}: сильнее первый экран, понятнее услуги и быстрее путь к заявке.`
    : `Собрал короткое превью сайта для ${business}: первый экран, услуги, доверие и быстрый запрос заявки.`;
  const source = sourceLabel || 'в открытых источниках';
  const emailLine = email ? `Отправил подробности на почту ${email}.` : 'Подготовил подробности для отправки на почту.';
  const greeting = owner ? `${owner}, здравствуйте!` : 'Здравствуйте!';
  return [
    `${greeting} Нашел ваш контакт ${source}.`,
    previewLine,
    `${emailLine} Подскажите, получили письмо? Если удобнее, скажите, куда лучше отправить превью и всю информацию.`,
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

function contactSourceLabel(lead = {}, email = '') {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const channels = Array.isArray(lead.contacts?.channels) ? lead.contacts.channels : [];
  const emailChannel =
    channels.find((channel) => channel?.type === 'email' && String(channel.value || '').trim().toLowerCase() === normalizedEmail) ||
    channels.find((channel) => channel?.type === 'email' && channel?.value) ||
    null;

  const sourceText = [
    emailChannel?.source,
    emailChannel?.provider,
    emailChannel?.sourceName,
    emailChannel?.foundOn,
    emailChannel?.url,
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
  if (/site|website|web|сайт|http/.test(sourceText)) return 'на открытой странице вашего сайта';
  if (/2gis|2гис|gis/.test(sourceText)) return 'в открытых данных 2ГИС';
  return 'в открытых источниках';
}

function absolutePublicUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  const base = String(config.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!base) return value;
  return `${base}${value.startsWith('/') ? '' : '/'}${value}`;
}

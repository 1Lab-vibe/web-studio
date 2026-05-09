import { randomInt } from 'node:crypto';
import OpenAI from 'openai';
import { config, hasSecret } from '../config.js';
import { crmConvertLeadToDeal, customerBotLink, dealAttachProduct, invoiceCreateYookassaLink, outboundQueueMessage, syncA1CrmLead } from './a1Client.js';
import { emitCustomerA1Event } from './a1Webhook.js';
import { prepareLovableMockup } from './lovableMcp.js';
import { deployLeadExportedProject, deployLeadGeneratedPreview, deployLeadPublicUrlProject } from './projectPublisher.js';
import { downloadTelegramFile, getTelegramFile, sendTelegram, sendTelegramTo } from './telegram.js';

const QUESTIONS = [
  { key: 'businessName', text: 'Как называется бизнес или проект? Если название в превью уже верное, напишите “оставить”.' },
  { key: 'previewDirection', text: 'Первый вопрос: оставить направление из превью сайта или сделать другой вариант? Если другой — опишите, каким он должен быть.' },
  { key: 'goal', text: 'Какая главная задача сайта: заявки, запись, доверие, каталог услуг или другое?' },
  { key: 'services', text: 'Какие услуги или товары обязательно показать на первом экране и в разделах?' },
  { key: 'style', text: 'Есть пожелания по стилю или примеры сайтов, которые нравятся?' },
  { key: 'contacts', text: 'Какие контакты и поля формы нужны на сайте?' },
  { key: 'materials', text: 'Есть логотип, фото, отзывы, лицензии или другие материалы? Можно прислать ссылкой или описанием.' },
  { key: 'deadline', text: 'К какому сроку хотите получить первый рабочий вариант?' },
];

const openai = hasSecret(config.OPENAI_API_KEY) ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : null;

function privacyUrl() {
  return `${process.env.PUBLIC_BASE_URL || 'https://webstudio.1true.ru'}/privacy`;
}

const RESETTABLE_JOB_TYPES = [
  'customer_preview_build',
  'customer_revision_triage',
  'customer_revision_apply',
  'lovable_build',
  'coder_deploy',
  'filmer_render',
  'checker_eval',
  'outbound_queue',
];

function normalizeText(text) {
  return String(text || '').trim();
}

function isResetBriefText(text) {
  const value = normalizeText(text).toLowerCase();
  return (
    /^\/(reset|restart|startover|newbrief)\b/i.test(value) ||
    /(начать|начнем|давай|собрать|собери|заполнить|заполни)\s+(тз\s+)?(заново|сначала|по новой)/i.test(value) ||
    /(сбрось|сбросить|очисти|очистить|удали|удалить)\s+(черновик|тз|бриф|ввод)/i.test(value) ||
    /(все|всё)\s+(заново|сначала|по новой)/i.test(value)
  );
}

function isComplaintWithoutBrief(text) {
  const value = normalizeText(text).toLowerCase();
  return /(не тяни|хватит|не то|ерунда|чушь|бред|не понял|не понимаешь|начал.*не с того|что за)/i.test(value);
}

function looksLikeKeyboardGibberish(text, key = '') {
  const value = normalizeText(text);
  if (value.length < 5) return false;
  if (key === 'style' && /(https?:\/\/|www\.|\.com|\.ru|apple|behance|dribbble|tilda|readymag|figma)/i.test(value)) return false;
  const letters = value.replace(/[^a-zа-яё]/gi, '');
  if (letters.length < 5) return false;
  const latin = (letters.match(/[a-z]/gi) || []).length;
  const russian = (letters.match(/[а-яё]/gi) || []).length;
  const latinRatio = latin / Math.max(1, latin + russian);
  const keyboardNoise = /(ghj|lkz|yf|dct|xnj|rfr|vfr|cnf|jxtym|gj|ght|ntcn|pf|ljk|bpf|rjnj|vfhr|gec|djd|fdw|ktq|xtuj|pfr)/i.test(value);
  const hasUsefulLatin = /\b(ai|it|crm|api|seo|ui|ux|b2b|saas|apple|google|meta|openai)\b/i.test(value);
  return keyboardNoise && latinRatio > 0.45 && !(hasUsefulLatin && latinRatio < 0.75);
}

function hasProhibitedBriefContent(text) {
  return /(наркот|заклад|казино|букмекер|ставк[аи]|эскорт|проститу|порно|18\+|оружи|взлом|фишинг|скам|кардинг|поддельн|паспорт|экстрем|террор|ненавист|убить|насили|malware|phishing|scam|casino|escort|weapon|drug)/i.test(normalizeText(text));
}

function isGenericTelegramLeadName(lead) {
  return lead?.source === 'telegram_inbound' && /^Новая заявка Telegram\b/i.test(String(lead?.name || ''));
}

function validateBriefAnswer(key, text) {
  const value = normalizeText(text);
  if (!value) return { ok: false, reason: 'empty' };
  if (hasProhibitedBriefContent(value)) return { ok: false, reason: 'prohibited' };
  if (looksLikeKeyboardGibberish(value, key)) return { ok: false, reason: 'gibberish' };
  if (key === 'deadline' && /^(вчера|срочно|как можно быстрее|asap)$/i.test(value)) {
    return { ok: true, normalizedText: 'как можно скорее', notice: 'Понял: срок срочный. Записал как “как можно скорее”.' };
  }
  return { ok: true, normalizedText: value };
}

function briefValidationIssues(lead) {
  const brief = lead?.customerBrief ?? {};
  const issues = [];
  const businessName = brief.businessName || (!isGenericTelegramLeadName(lead) ? lead?.name : '');
  const required = [
    ['businessName', businessName, 'название или описание бизнеса'],
    ['goal', brief.goal, 'цель сайта'],
    ['services', brief.services, 'услуги/продукты'],
    ['contacts', brief.contacts, 'контакты или поля формы'],
  ];
  for (const [key, value, label] of required) {
    if (!normalizeText(value) || normalizeText(value) === '-') issues.push(`Не заполнено: ${label}.`);
    else if (looksLikeKeyboardGibberish(value, key)) issues.push(`Похоже на случайный текст в поле “${label}”.`);
    else if (hasProhibitedBriefContent(value)) issues.push(`Поле “${label}” требует проверки: запрещенная или рискованная тематика.`);
  }
  for (const [key, value] of Object.entries(brief)) {
    if (typeof value !== 'string') continue;
    if (looksLikeKeyboardGibberish(value, key)) issues.push(`Похоже на случайный текст: ${key}.`);
    if (hasProhibitedBriefContent(value)) issues.push(`Рискованный контент: ${key}.`);
  }
  return Array.from(new Set(issues));
}

export async function handleCustomerTelegramMessage(store, message) {
  const chatId = message?.chat?.id;
  let text = String(message?.text || '').trim();
  if (!chatId) return { ok: true, skipped: true };
  if (!text && message?.voice?.file_id) {
    const voice = await transcribeTelegramVoice(message.voice.file_id);
    if (!voice.ok) {
      await sendTelegramTo(chatId, 'Не смог распознать голосовое сообщение. Пришлите текстом или попробуйте еще раз.');
      return { ok: false, voice };
    }
    text = voice.text;
  }
  if (!text) return { ok: true, skipped: true };

  const startMatch = text.match(/^\/start\s+lead_([a-f0-9]{16,64})/i);
  if (startMatch) return startCustomerLead(store, chatId, message.from, startMatch[1]);

  const lead = store.listLeads().find((item) => String(item.customerTelegram?.chatId || '') === String(chatId));
  if (!lead) {
    return startInboundCustomer(store, chatId, message.from, text);
  }

  const command = text.split(/\s+/)[0].split('@')[0];
  if (command === '/help') {
    await sendTelegramTo(chatId, customerHelpText(lead));
    return { ok: true, lead };
  }
  if (command === '/reset' || isResetBriefText(text)) return resetCustomerBrief(store, lead, chatId, 'customer_requested_reset');
  if (command === '/cancel') return cancelCustomerBrief(store, lead, chatId, 'customer_requested_cancel');
  if (command === '/brief') return sendBriefSummary(store, lead, chatId);
  if (command === '/approve') return approveBrief(store, lead, chatId);
  if (text === '/revision') {
    await store.updateLead(lead.id, { customerTelegram: { ...(lead.customerTelegram ?? {}), mode: 'revision' } });
    await sendTelegramTo(chatId, 'Напишите, что нужно изменить на сайте. Одним сообщением, можно списком.');
    return { ok: true };
  }

  if (lead.customerTelegram?.mode === 'revision') {
    const updated = await store.updateLead(lead.id, {
      status: 'revision_requested',
      revision: {
        text,
        requestedAt: new Date().toISOString(),
      },
      customerTelegram: { ...(lead.customerTelegram ?? {}), mode: 'brief' },
    });
    await emitCustomerA1Event(updated, 'customer.revision_requested', text, { text });
    await sendTelegramTo(chatId, 'Принял правку. Передал в работу, после обновления пришлю ссылку на просмотр.');
    return { ok: true };
  }

  const pendingEmail = extractEmail(text);
  if (lead.customerTelegram?.mode === 'registration_email') {
    if (isResendCodeText(text) && lead.customerTelegram?.email) {
      return requestEmailVerification(store, lead, chatId, lead.customerTelegram.email);
    }
    if (isChangeEmailText(text)) {
      await store.updateLead(lead.id, { customerTelegram: { ...(lead.customerTelegram ?? {}), mode: 'registration_email', email: '', emailCode: '', emailCodeExpiresAt: '' } });
      await sendTelegramTo(chatId, 'Хорошо, пришлите новый рабочий email. На него отправлю код подтверждения.');
      return { ok: true, lead };
    }
    if (!pendingEmail) {
      await sendTelegramTo(chatId, 'Пришлите, пожалуйста, рабочий email. На него я отправлю короткий код подтверждения.', emailEntryKeyboard());
      return { ok: true, lead };
    }
    return requestEmailVerification(store, lead, chatId, pendingEmail);
  }

  if (lead.customerTelegram?.mode === 'email_code') {
    if (isResendCodeText(text)) {
      const email = lead.customerTelegram?.email;
      if (!email) {
        await store.updateLead(lead.id, { customerTelegram: { ...(lead.customerTelegram ?? {}), mode: 'registration_email' } });
        await sendTelegramTo(chatId, 'Email не сохранен. Пришлите его еще раз, я отправлю новый код.', emailEntryKeyboard());
        return { ok: true, lead };
      }
      return requestEmailVerification(store, lead, chatId, email);
    }
    if (isChangeEmailText(text)) {
      await store.updateLead(lead.id, { customerTelegram: { ...(lead.customerTelegram ?? {}), mode: 'registration_email', email: '', emailCode: '', emailCodeExpiresAt: '' } });
      await sendTelegramTo(chatId, 'Ок, пришлите правильный email. Старый код больше не используем.', emailEntryKeyboard());
      return { ok: true, lead };
    }
    return confirmEmailCode(store, lead, chatId, text);
  }

  if (lead.payment?.status === 'needs_customer_email' && pendingEmail) {
    const updated = await store.updateLead(lead.id, {
      customerTelegram: { ...(lead.customerTelegram ?? {}), email: pendingEmail },
      payment: { ...(lead.payment ?? {}), customerEmail: pendingEmail, status: 'email_collected' },
    });
    await emitCustomerA1Event(updated, 'customer.brief_updated', 'Customer provided billing email', { customerEmail: pendingEmail });
    await sendTelegramTo(chatId, 'Почту сохранил. Теперь отправьте /approve, чтобы сформировать ссылку на оплату.');
    return { ok: true, lead: updated };
  }

  return collectBriefAnswer(store, lead, chatId, text);
}

export function isCustomerTelegramCommand(store, message) {
  const chatId = message?.chat?.id;
  const text = String(message?.text || '').trim();
  if (!chatId || !text.startsWith('/')) return false;
  if (/^\/start(\s+lead_[a-f0-9]{16,64})?/i.test(text)) return true;
  if (!store.listLeads().some((item) => String(item.customerTelegram?.chatId || '') === String(chatId))) return false;
  const command = text.split(/\s+/)[0].split('@')[0];
  return ['/help', '/brief', '/approve', '/reset', '/restart', '/startover', '/newbrief', '/cancel', '/revision', '/resend', '/email'].includes(command);
}

export async function handleCustomerTelegramCallback(store, callback) {
  const chatId = callback?.message?.chat?.id;
  const userId = callback?.from?.id;
  const data = String(callback?.data || '');
  if (!chatId || !data.startsWith('customer:')) return { ok: false, skipped: true };
  const lead = store.listLeads().find((item) => String(item.customerTelegram?.chatId || '') === String(chatId));
  if (!lead) {
    await sendTelegramTo(chatId, 'Не нашел вашу заявку. Напишите /start, и я создам новую.');
    return { ok: false, notFound: true };
  }
  if (data === 'customer:resend_email_code') {
    const email = lead.customerTelegram?.email;
    if (!email) {
      await store.updateLead(lead.id, { customerTelegram: { ...(lead.customerTelegram ?? {}), mode: 'registration_email' } });
      await sendTelegramTo(chatId, 'Email не сохранен. Пришлите его еще раз, я отправлю новый код.', emailEntryKeyboard());
      return { ok: true, lead };
    }
    return requestEmailVerification(store, lead, chatId, email);
  }
  if (data === 'customer:change_email') {
    const updated = await store.updateLead(lead.id, {
      customerTelegram: { ...(lead.customerTelegram ?? {}), mode: 'registration_email', email: '', emailCode: '', emailCodeExpiresAt: '' },
      status: 'registration_email',
    });
    await sendTelegramTo(chatId, 'Пришлите правильный email. Я отправлю новый код подтверждения.', emailEntryKeyboard());
    return { ok: true, lead: updated, userId };
  }
  if (data === 'customer:reset_brief') {
    return resetCustomerBrief(store, lead, chatId, 'customer_pressed_reset_button');
  }
  if (data === 'customer:approve_brief') {
    return approveBrief(store, lead, chatId);
  }
  return { ok: false, skipped: true };
}

async function startCustomerLead(store, chatId, from, token) {
  let lead = store.findLeadByPublicToken(token);
  if (!lead) {
    return startInboundCustomer(store, chatId, from, `/start lead_${token}`, { unmatchedStartToken: token });
  }

  const customerTelegram = {
    chatId,
    userId: from?.id || '',
    username: from?.username || '',
    firstName: from?.first_name || '',
    lastName: from?.last_name || '',
    mode: lead.customerTelegram?.emailVerified ? 'brief' : 'registration_email',
    step: 0,
    startedAt: new Date().toISOString(),
    email: lead.customerTelegram?.email || lead.contacts?.emails?.[0] || '',
    emailVerified: Boolean(lead.customerTelegram?.emailVerified),
  };
  lead = await store.updateLead(lead.id, { customerTelegram, status: customerTelegram.emailVerified ? 'customer_chat' : 'registration_email' });
  await store.addEvent(lead.id, 'customer.telegram_started', `Customer opened bot: ${from?.username || chatId}`);
  await emitCustomerA1Event(lead, 'customer.telegram_started', 'Customer started Telegram bot', { customerTelegram });
  await notifyAdminCustomerStarted(lead, customerTelegram);

  await sendTelegramTo(
    chatId,
    onboardingText(lead, true),
  );
  if (customerTelegram.emailVerified) await sendTelegramTo(chatId, QUESTIONS[0].text);
  else if (customerTelegram.email) await requestEmailVerification(store, lead, chatId, customerTelegram.email);
  else await sendTelegramTo(chatId, 'Для начала регистрации пришлите, пожалуйста, рабочий email. Я отправлю на него код подтверждения.', emailEntryKeyboard());
  return { ok: true, lead };
}

async function startInboundCustomer(store, chatId, from, text, options = {}) {
  const customerTelegram = {
    chatId,
    userId: from?.id || '',
    username: from?.username || '',
    firstName: from?.first_name || '',
    lastName: from?.last_name || '',
    mode: 'registration_email',
    step: 0,
    startedAt: new Date().toISOString(),
    emailVerified: false,
  };
  const displayName = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim() || from?.username || `Telegram ${chatId}`;
  let lead = await store.upsertLead({
    name: `Новая заявка Telegram · ${displayName}`,
    city: '',
    niche: 'индивидуальный сайт',
    source: 'telegram_inbound',
    sourceKey: `telegram:${chatId}`,
    lane: 'Диагноз',
    owner: 'Mobile',
    status: 'registration_email',
    pipelineStage: 'qualified',
    stageStatus: 'registration_email',
    customerTelegram,
    customerBrief: text && !text.startsWith('/start') ? { initialMessage: text, updatedAt: new Date().toISOString() } : {},
    unmatchedStartToken: options.unmatchedStartToken || '',
    contacts: { emails: [], phone: '', channels: [] },
  });
  lead = await store.updateLead(lead.id, {
    lane: 'Диагноз',
    owner: 'Mobile',
    status: 'registration_email',
    pipelineStage: 'qualified',
    stageStatus: 'registration_email',
    lastTransitionReason: options.unmatchedStartToken ? 'telegram_unmatched_start_token' : 'telegram_inbound_started',
  });
  lead = await syncLeadToA1(store, lead, 'telegram_inbound_started');
  await store.addEvent(lead.id, 'customer.telegram_started', `Inbound customer opened bot: ${from?.username || chatId}`);
  await notifyAdminCustomerStarted(lead, customerTelegram);
  await sendTelegramTo(chatId, onboardingText(lead, false));
  await sendTelegramTo(chatId, 'Для регистрации пришлите, пожалуйста, рабочий email. Я отправлю на него код подтверждения, и после этого мы соберем ТЗ.', emailEntryKeyboard());
  return { ok: true, lead };
}

function customerHelpText(lead) {
  return [
    '<b>1Lab · помощник по сайту</b>',
    '',
    'Я помогу собрать ТЗ, запустить сайт и принимать правки после публикации.',
    '',
    '<b>Команды</b>',
    '/brief — показать черновик ТЗ',
    '/approve — утвердить ТЗ и перейти к оплате/работе',
    '/reset — сбросить черновик и собрать ТЗ заново',
    '/cancel — остановить текущую заявку',
    '/revision — отправить правку по сайту',
    '/resend — отправить email-код заново',
    '/email — изменить email',
    '/help — показать это меню',
    '',
    `Проект: <b>${escapeHtml(lead?.name || 'ваш сайт')}</b>`,
    '🎁 На первый заказ действует скидка 50%: простой сайт-визитка начинается от 15 000 ₽ вместо 30 000 ₽. Итоговая цена зависит от объема страниц, контента и интеграций.',
    `Политика конфиденциальности: ${privacyUrl()}`,
  ].join('\n');
}

function onboardingText(lead, hasPreview) {
  return [
    `👋 Здравствуйте! Я ассистент студии <b>1Lab</b>.`,
    '',
    hasPreview
      ? `Мы уже подготовили для <b>${escapeHtml(lead.name)}</b> первый вариант превью сайта. Теперь я помогу уточнить, оставить это направление или собрать другой вариант под ваши пожелания.`
      : `Мы можем разработать для вас индивидуальный сайт за несколько коротких шагов: зарегистрируем заявку, соберем ТЗ, подготовим первое рабочее превью и доведем его правками.`,
    '',
    '🎁 Для первого заказа у нас действует скидка <b>50%</b>: простой сайт-визитка начинается от <b>15 000 ₽</b> вместо 30 000 ₽. Оплата — после первого готового превью, когда уже видно результат и можно спокойно принять решение.',
    '',
    '🛠 После запуска вы сможете пользоваться мной как помощником по сайту: писать обычным сообщением или голосом, какие тексты, контакты, фото или блоки нужно изменить.',
    '',
    `🔐 Продолжая диалог, вы соглашаетесь на обработку персональных данных. Политика конфиденциальности: ${privacyUrl()}`,
  ].join('\n');
}

async function requestEmailVerification(store, lead, chatId, email) {
  const code = String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  let updated = await store.updateLead(lead.id, {
    customerTelegram: {
      ...(lead.customerTelegram ?? {}),
      mode: 'email_code',
      email,
      emailVerified: false,
      emailCode: code,
      emailCodeExpiresAt: expiresAt,
    },
    contacts: {
      ...(lead.contacts ?? {}),
      emails: Array.from(new Set([...(lead.contacts?.emails || []), email])),
      channels: [
        ...(lead.contacts?.channels || []).filter((channel) => !(channel.type === 'email' && channel.value === email)),
        { type: 'email', value: email, confidence: 1, verified: false },
      ],
    },
    status: 'email_verification_sent',
    stageStatus: 'email_verification_sent',
  });
  await syncLeadToA1(store, updated, 'customer_email_verification');
  const sent = await outboundQueueMessage({
    a1LeadId: updated.a1LeadId || updated.a1?.leadId || '',
    externalId: updated.id,
    dedupeKey: `webstudio:${updated.id}:email-verification:${email}`,
    to: email,
    senderProfile: 'no-reply',
    fromAddress: 'no-reply@1true.ru',
    purpose: 'email_verification',
    subject: 'Код подтверждения 1Lab',
    body: `Ваш код подтверждения для 1Lab Web Studio: ${code}\n\nКод действует 15 минут.`,
    idempotencyKey: `webstudio:${updated.id}:email-code:${Date.now()}`,
  });
  await store.addEvent(updated.id, 'customer.email_code_sent', `Verification code sent to ${email}`);
  if (!sent.ok) {
    await sendTelegramTo(chatId, 'Не смог отправить код на почту через A1. Я сообщил администратору. Можно попробовать еще раз или изменить email.', emailCodeKeyboard());
    await sendTelegram(`<b>Не удалось отправить email-код</b>\nЛид: ${escapeHtml(updated.name)}\nEmail: <code>${escapeHtml(email)}</code>\nОшибка: <code>${escapeHtml(sent.error || sent.reason || 'unknown')}</code>`);
    return { ok: false, lead: updated, emailSent: sent };
  }
  await sendTelegramTo(chatId, `Отправил код подтверждения на ${escapeHtml(email)}. Введите сюда 6 цифр из письма.`, emailCodeKeyboard());
  return { ok: true, lead: updated, emailSent: sent };
}

async function confirmEmailCode(store, lead, chatId, text) {
  const code = String(text || '').replace(/\D/g, '').slice(0, 6);
  const expected = String(lead.customerTelegram?.emailCode || '');
  const expires = Date.parse(lead.customerTelegram?.emailCodeExpiresAt || '');
  if (!expected || !Number.isFinite(expires) || Date.now() > expires) {
    await store.updateLead(lead.id, { customerTelegram: { ...(lead.customerTelegram ?? {}), mode: 'registration_email' } });
    await sendTelegramTo(chatId, 'Код истек. Можно отправить код заново на тот же email или изменить email.', emailCodeKeyboard());
    return { ok: false, expired: true };
  }
  if (code !== expected) {
    await sendTelegramTo(chatId, 'Код не совпал. Проверьте письмо и отправьте 6 цифр еще раз. Если письма нет — нажмите «Отправить код заново».', emailCodeKeyboard());
    return { ok: false, invalid: true };
  }
  const email = lead.customerTelegram?.email || '';
  let updated = await store.updateLead(lead.id, {
    customerTelegram: {
      ...(lead.customerTelegram ?? {}),
      mode: 'brief',
      emailVerified: true,
      emailCode: '',
      emailCodeExpiresAt: '',
      step: Number(lead.customerTelegram?.step ?? 0),
    },
    payment: { ...(lead.payment ?? {}), customerEmail: email },
    status: 'email_verified',
  });
  await emitCustomerA1Event(updated, 'customer.email_verified', 'Customer verified email', { customerEmail: email });
  await syncLeadToA1(store, updated, 'customer_email_verified');
  await sendTelegramTo(chatId, `Email подтвержден. Теперь соберем короткое ТЗ.\n\n${QUESTIONS[Number(updated.customerTelegram?.step ?? 0)]?.text || QUESTIONS[0].text}`);
  return { ok: true, lead: updated };
}

function emailCodeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Отправить код заново', callback_data: 'customer:resend_email_code' }],
      [{ text: 'Изменить email', callback_data: 'customer:change_email' }],
    ],
  };
}

function emailEntryKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Изменить email', callback_data: 'customer:change_email' }],
    ],
  };
}

function briefSummaryKeyboard({ canApprove = true } = {}) {
  const rows = [];
  if (canApprove) rows.push([{ text: 'Утвердить ТЗ', callback_data: 'customer:approve_brief' }]);
  rows.push([{ text: 'Собрать заново', callback_data: 'customer:reset_brief' }]);
  return { inline_keyboard: rows };
}

async function resetCustomerBrief(store, lead, chatId, reason = 'customer_requested_reset') {
  const now = new Date().toISOString();
  const cancelled = await store.cancelLeadJobs?.(lead.id, RESETTABLE_JOB_TYPES, 'Customer reset the brief');
  const nextMode = lead.customerTelegram?.emailVerified ? 'brief' : 'registration_email';
  const updated = await store.updateLead(lead.id, {
    customerBrief: {
      resetAt: now,
      resetReason: reason,
    },
    customerTelegram: {
      ...(lead.customerTelegram ?? {}),
      mode: nextMode,
      step: 0,
    },
    status: 'brief_reset',
    pipelineStage: 'qualified',
    stageStatus: nextMode === 'brief' ? 'brief_collecting' : 'registration_email',
    lane: 'Диагноз',
    owner: 'Mobile',
    artifactStatus: 'brief_reset',
    lastTransitionReason: reason,
    nextAction: {
      type: 'customer_brief_collecting',
      title: 'Клиент собирает ТЗ заново',
      reason,
      createdAt: now,
    },
  });
  await store.addEvent(updated.id, 'customer.brief_reset', `Customer reset brief; cancelled jobs: ${cancelled?.length || 0}`);
  await emitCustomerA1Event(updated, 'customer.brief_updated', 'Customer reset brief and starts over', { reason, cancelledJobs: cancelled?.length || 0 });
  await sendTelegramTo(chatId, 'Ок, сбросил черновик. Начинаем заново, без старых ответов.');
  if (nextMode === 'brief') {
    await sendTelegramTo(chatId, QUESTIONS[0].text);
  } else {
    await sendTelegramTo(chatId, 'Сначала подтвердим рабочий email. Пришлите почту, и я отправлю код подтверждения.', emailEntryKeyboard());
  }
  return { ok: true, lead: updated, reset: true, cancelledJobs: cancelled?.length || 0 };
}

async function cancelCustomerBrief(store, lead, chatId, reason = 'customer_requested_cancel') {
  const now = new Date().toISOString();
  const cancelled = await store.cancelLeadJobs?.(lead.id, RESETTABLE_JOB_TYPES, 'Customer cancelled the current request');
  const updated = await store.updateLead(lead.id, {
    customerBrief: {
      resetAt: now,
      resetReason: reason,
      cancelledAt: now,
    },
    customerTelegram: {
      ...(lead.customerTelegram ?? {}),
      mode: 'cancelled',
    },
    status: 'customer_cancelled',
    pipelineStage: 'needs_review',
    stageStatus: 'customer_cancelled',
    lane: 'Ответы',
    owner: 'Mobile',
    artifactStatus: 'cancelled',
    lastTransitionReason: reason,
    nextAction: {
      type: 'customer_cancelled',
      title: 'Клиент остановил заявку',
      reason,
      createdAt: now,
    },
  });
  await store.addEvent(updated.id, 'customer.brief_cancelled', `Customer cancelled request; cancelled jobs: ${cancelled?.length || 0}`);
  await emitCustomerA1Event(updated, 'customer.brief_updated', 'Customer cancelled current request', { reason, cancelledJobs: cancelled?.length || 0 });
  await sendTelegramTo(chatId, 'Остановил текущую заявку и отменил запланированные действия. Если захотите начать заново, отправьте /reset.');
  await sendTelegram(`<b>Клиент остановил заявку</b>\nЛид: ${escapeHtml(updated.name)}\nID: <code>${escapeHtml(updated.id)}</code>\nОтменено jobs: <code>${escapeHtml(String(cancelled?.length || 0))}</code>`);
  return { ok: true, lead: updated, cancelled: true, cancelledJobs: cancelled?.length || 0 };
}

async function handleRejectedBriefInput(store, lead, chatId, reason, key, text) {
  const messages = {
    empty: 'Ответ пустой. Напишите коротко по смыслу, можно одним предложением.',
    gibberish: 'Похоже, текст введен случайно или в неправильной раскладке. Напишите этот пункт еще раз понятным текстом.',
    prohibited: 'Не могу собирать ТЗ для запрещенной или рискованной тематики. Если я неверно понял контекст, переформулируйте задачу без спорных формулировок.',
  };
  await store.addEvent(lead.id, 'customer.brief_input_rejected', `${reason}: ${key}`, { text: String(text || '').slice(0, 500) });
  if (reason === 'prohibited') {
    await sendTelegram(`<b>Клиентский бриф остановлен проверкой контента</b>\nЛид: ${escapeHtml(lead.name)}\nID: <code>${escapeHtml(lead.id)}</code>\nПоле: <code>${escapeHtml(key)}</code>\nТекст: <code>${escapeHtml(String(text || '').slice(0, 500))}</code>`);
  }
  await sendTelegramTo(chatId, messages[reason] || messages.empty);
}

function isResendCodeText(text) {
  return /^\/resend\b/i.test(text) || /отправить\s+код\s+заново|прислать\s+код\s+заново|повтор/i.test(String(text || '').toLowerCase());
}

function isChangeEmailText(text) {
  return /^\/email\b/i.test(text) || /изменить\s+email|поменять\s+email|другая\s+почта|другой\s+email/i.test(String(text || '').toLowerCase());
}

async function notifyAdminCustomerStarted(lead, customerTelegram) {
  const name = [customerTelegram.firstName, customerTelegram.lastName].filter(Boolean).join(' ').trim();
  const username = customerTelegram.username ? `@${customerTelegram.username}` : '';
  await sendTelegram(
    [
      '<b>Новый пользователь написал боту</b>',
      `${escapeHtml(name || username || String(customerTelegram.chatId))}`,
      username && name ? escapeHtml(username) : '',
      `Telegram ID: <code>${escapeHtml(customerTelegram.userId || customerTelegram.chatId)}</code>`,
      `Лид: <b>${escapeHtml(lead.name)}</b>`,
      `ID: <code>${escapeHtml(lead.id)}</code>`,
      `Этап: <code>${escapeHtml(lead.lane || '')}</code>`,
    ].filter(Boolean).join('\n'),
  );
}

async function collectBriefAnswer(store, lead, chatId, text) {
  if (isResetBriefText(text)) return resetCustomerBrief(store, lead, chatId, 'customer_requested_reset');
  const step = Number(lead.customerTelegram?.step ?? 0);
  if (step >= QUESTIONS.length || lead.customerTelegram?.mode === 'brief_review') {
    return refineBriefFromMessage(store, lead, chatId, text);
  }
  const question = QUESTIONS[step] || QUESTIONS[QUESTIONS.length - 1];
  const validation = validateBriefAnswer(question.key, text);
  if (!validation.ok) {
    await handleRejectedBriefInput(store, lead, chatId, validation.reason, question.key, text);
    return { ok: false, lead, reason: validation.reason };
  }
  if (validation.notice) await sendTelegramTo(chatId, validation.notice);
  const answerText =
    question.key === 'businessName' && /^оставить$/i.test(validation.normalizedText || '')
      ? (!isGenericTelegramLeadName(lead) ? lead.name : '')
      : validation.normalizedText || text;
  if (question.key === 'businessName' && !answerText) {
    await sendTelegramTo(chatId, 'У этой заявки пока нет названия бизнеса. Напишите название или коротко опишите проект.');
    return { ok: false, lead, reason: 'missing_business_name' };
  }
  const brief = {
    ...(lead.customerBrief ?? {}),
    [question.key]: answerText,
    updatedAt: new Date().toISOString(),
  };
  const leadPatch = question.key === 'businessName' && answerText && lead.name !== answerText
    ? { name: answerText }
    : {};
  const nextStep = step + 1;
  let updated = await store.updateLead(lead.id, {
    ...leadPatch,
    customerBrief: brief,
    customerTelegram: { ...(lead.customerTelegram ?? {}), step: nextStep, mode: nextStep >= QUESTIONS.length ? 'brief_review' : 'brief' },
    status: 'briefing',
  });
  if (Object.keys(leadPatch).length) updated = await syncLeadToA1(store, updated, 'customer_brief_business_name');
  await emitCustomerA1Event(updated, 'customer.brief_updated', `Brief answer: ${question.key}`, { brief, key: question.key, answer: answerText });

  if (nextStep < QUESTIONS.length) {
    await sendTelegramTo(chatId, QUESTIONS[nextStep].text);
    return { ok: true, lead: updated };
  }

  return sendBriefSummary(store, updated, chatId);
}

async function refineBriefFromMessage(store, lead, chatId, text) {
  if (isResetBriefText(text)) return resetCustomerBrief(store, lead, chatId, 'customer_requested_reset');
  if (hasProhibitedBriefContent(text)) {
    await handleRejectedBriefInput(store, lead, chatId, 'prohibited', 'refinement', text);
    return { ok: false, lead, reason: 'prohibited' };
  }
  if (looksLikeKeyboardGibberish(text, 'refinement')) {
    await handleRejectedBriefInput(store, lead, chatId, 'gibberish', 'refinement', text);
    return { ok: false, lead, reason: 'gibberish' };
  }
  if (isComplaintWithoutBrief(text)) {
    await sendTelegramTo(chatId, 'Понял, без лишних кругов. Напишите одним сообщением: бизнес, цель сайта, услуги, стиль и контакты. Я обновлю ТЗ по делу.');
    await store.addEvent(lead.id, 'customer.brief_complaint', text);
    return { ok: true, lead, complaint: true };
  }
  const currentBrief = lead.customerBrief ?? {};
  const refined = await briefDialogAgent(lead, currentBrief, text);
  const inferred = inferBusinessPatch(text);
  refined.patch = { ...(refined.patch || {}), ...inferred };
  const history = Array.isArray(currentBrief.refinements) ? currentBrief.refinements.slice(-10) : [];
  const leadPatch = {};
  if (refined.patch?.businessName) leadPatch.name = refined.patch.businessName;
  if (refined.patch?.niche) leadPatch.niche = refined.patch.niche;
  const briefPatch = { ...(refined.patch || {}) };
  delete briefPatch.businessName;
  delete briefPatch.niche;
  if ((leadPatch.name || leadPatch.niche) && /бизнес|проект|компани|сайт нужен/i.test(String(currentBrief.deadline || ''))) {
    briefPatch.deadline = '';
  }
  const brief = {
    ...currentBrief,
    ...briefPatch,
    refinements: [...history, { text, appliedAt: new Date().toISOString(), patch: refined.patch || {} }],
    updatedAt: new Date().toISOString(),
  };
  let updated = await store.updateLead(lead.id, {
    ...leadPatch,
    ...(Object.keys(leadPatch).length
      ? { mockup: { ...(lead.mockup ?? {}), status: 'needs_rebuild', previousPublicUrl: lead.mockup?.publicUrl || lead.mockup?.deployedUrl || lead.mockup?.publishedUrl || '' } }
      : {}),
    customerBrief: brief,
    customerTelegram: { ...(lead.customerTelegram ?? {}), mode: 'brief_review', step: QUESTIONS.length },
    status: 'brief_refined',
  });
  if (Object.keys(leadPatch).length) updated = await syncLeadToA1(store, updated, 'customer_changed_business');
  await emitCustomerA1Event(updated, 'customer.brief_updated', 'Customer refined brief in dialog', { brief, text, patch: refined.patch || {} });
  const reply = leadPatch.name || leadPatch.niche
    ? `Понял, меняю бизнес в ТЗ${leadPatch.name ? ` на «${leadPatch.name}»` : ''}. Проверьте /brief.`
    : refined.reply || 'Принял правку и обновил ТЗ. Проверьте /brief, если все верно — /approve.';
  await sendTelegramTo(chatId, reply);
  return { ok: true, lead: updated };
}

async function briefDialogAgent(lead, currentBrief, text) {
  if (!openai) return fallbackBriefPatch(text);
  try {
    const response = await openai.responses.create({
      model: config.OPENAI_MODEL,
      input: [
        {
          role: 'system',
          content: [
            'Ты короткий диалоговый агент 1Lab для уточнения ТЗ сайта.',
            'Клиент пишет свободно: это может быть правка, уточнение, ответ или сомнение.',
            'Не перезаписывай последний вопрос автоматически. Обновляй только поля, к которым относится сообщение.',
            'Верни строго JSON без markdown: patch object и reply string.',
            'patch может содержать только: businessName, niche, previewDirection, goal, services, style, contacts, materials, deadline, notes.',
            'Если клиент явно говорит, что бизнес/проект другой, добавь patch.businessName и/или patch.niche.',
            'Если клиент просит начать заново, сбросить ТЗ или очистить ввод, не обновляй поля: верни patch {} и короткий reply с просьбой использовать /reset.',
            'Если клиент ругается на тон или просит не тянуть время, не добавляй это в notes и не меняй ТЗ без фактов о бизнесе.',
            'Если в сообщении случайный текст, раскладка клавиатуры или запрещенная тематика, верни patch {}.',
            'reply: 1-2 короткие фразы, живо, без канцелярита. Если ТЗ стало понятнее, предложи /brief или /approve.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            lead: {
              name: lead.name,
              niche: lead.niche,
              previewUrl: lead.mockup?.publishedUrl || lead.mockup?.deployedUrl || '',
            },
            currentBrief,
            customerMessage: text,
          }),
        },
      ],
    });
    const parsed = JSON.parse(response.output_text?.trim() || '{}');
    return {
      patch: sanitizeBriefPatch(parsed.patch),
      reply: String(parsed.reply || '').trim().slice(0, 700),
    };
  } catch {
    return fallbackBriefPatch(text);
  }
}

function sanitizeBriefPatch(patch = {}) {
  const allowed = ['businessName', 'niche', 'previewDirection', 'goal', 'services', 'style', 'contacts', 'materials', 'deadline', 'notes'];
  return Object.fromEntries(
    Object.entries(patch)
      .filter(([key, value]) => allowed.includes(key) && value !== undefined && value !== null && String(value).trim())
      .map(([key, value]) => [key, String(value).trim()]),
  );
}

function fallbackBriefPatch(text) {
  const businessMatch = inferBusinessPatch(text);
  return {
    patch: Object.keys(businessMatch).length ? { ...businessMatch, notes: text } : { notes: text },
    reply: 'Принял как уточнение к ТЗ. Проверьте /brief, если все верно — отправьте /approve.',
  };
}

function inferBusinessPatch(text) {
  const value = String(text || '').trim();
  const result = {};
  const named = value.match(/(?:сайт\s+нужен\s+для|для\s+компании|для\s+бренда)\s+["«]?([^".,\n»]+)["»]?/i);
  if (named?.[1]) result.businessName = cleanBusinessName(named[1]);

  const namedAs = value.match(/(?:бизнес|проект|компания|бренд)\s+(?:называется|зовется|это)\s+["«]?([^".,\n»]+)["»]?/i);
  if (namedAs?.[1]) result.businessName ||= cleanBusinessName(namedAs[1]);

  const business = value.match(/(?:^|[,.;\n]\s*|нет[, ]*)?(?:бизнес|проект|компания|направление)\s*(?:-|—|:|это)?\s*["«]?([^".,\n»]+)["»]?/i);
  if (business?.[1]) {
    const parsed = cleanBusinessName(business[1]);
    result.businessName ||= parsed;
    if (!result.businessName || result.businessName === parsed) result.niche ||= parsed;
  }

  const aiFocus = value.match(/(?:фокус|акцент|занимаемся|делаем|направление)\s+(?:на\s+)?([^.\n]+(?:ИИ|AI|нейро|автоматизац|бот|it[- ]?продукт)[^.\n]*)/i);
  if (aiFocus?.[1]) result.niche = cleanBusinessName(aiFocus[1]);

  if (/разработк[аи]\s+it|it[- ]?продукт|ии|искусственн|AI|нейро|автоматизац/i.test(value)) {
    result.niche ||= 'разработка IT-продуктов с использованием ИИ';
    if (!result.businessName && /бизнес|проект|компания|направление/i.test(value)) {
      result.businessName = 'Разработка IT-продуктов с использованием ИИ';
    }
  }
  return result;
}

function cleanBusinessName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:называется|зовется|это|[-:—])\s+/i, '')
    .replace(/\s*(?:,?\s*а\s+сайт|,?\s*сайт|,?\s*нужно|,?\s*нужен).*$/i, '')
    .replace(/\s*(?:,?\s*фокус|,?\s*акцент|,?\s*сделай|,?\s*и\s+сделай).*$/i, '')
    .trim();
}

async function transcribeTelegramVoice(fileId) {
  if (!openai) return { ok: false, skipped: true, reason: 'OPENAI_API_KEY is not configured' };
  const file = await getTelegramFile(fileId);
  const filePath = file.data?.result?.file_path;
  if (!file.ok || !filePath) return { ok: false, error: file.error || 'Telegram getFile failed', file };
  const download = await downloadTelegramFile(filePath);
  if (!download.ok) return { ok: false, error: download.error || 'Telegram file download failed', download };
  const audioFile = new File([download.data], 'telegram-voice.ogg', { type: 'audio/ogg' });
  const result = await openai.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
    language: 'ru',
  });
  return { ok: true, text: String(result.text || '').trim() };
}

async function sendBriefSummary(store, lead, chatId) {
  const brief = lead.customerBrief ?? {};
  const businessName = brief.businessName || (!isGenericTelegramLeadName(lead) ? lead.name : '');
  const issues = briefValidationIssues(lead);
  const summary = [
    '<b>Черновик ТЗ</b>',
    `Бизнес: ${escapeHtml(businessName || 'нужно уточнить')}`,
    `Цель: ${escapeHtml(brief.goal || '-')}`,
    `Услуги: ${escapeHtml(brief.services || '-')}`,
    `Стиль: ${escapeHtml(brief.style || '-')}`,
    `Контакты/форма: ${escapeHtml(brief.contacts || '-')}`,
    `Материалы: ${escapeHtml(brief.materials || '-')}`,
    `Срок: ${escapeHtml(brief.deadline || '-')}`,
    brief.notes ? `Уточнения: ${escapeHtml(brief.notes)}` : '',
    issues.length ? `\n<b>Что нужно поправить перед запуском</b>\n${issues.map((issue) => `• ${escapeHtml(issue)}`).join('\n')}` : '',
    '',
    issues.length
      ? 'Можно написать уточнение одним сообщением или нажать “Собрать заново”.'
      : 'Если все верно, нажмите “Утвердить ТЗ” или отправьте /approve. Если нужно поправить, просто напишите уточнение.',
  ].filter(Boolean).join('\n');
  await sendTelegramTo(chatId, summary, briefSummaryKeyboard({ canApprove: !issues.length }));
  return { ok: true, lead };
}

async function approveBrief(store, lead, chatId) {
  const issues = briefValidationIssues(lead);
  if (issues.length) {
    await sendTelegramTo(
      chatId,
      [
        '<b>Пока не запускаю сборку.</b>',
        'В ТЗ есть ошибки или недостающие данные:',
        ...issues.map((issue) => `• ${escapeHtml(issue)}`),
        '',
        'Напишите недостающие данные одним сообщением или нажмите “Собрать заново”.',
      ].join('\n'),
      briefSummaryKeyboard({ canApprove: false }),
    );
    await store.addEvent(lead.id, 'customer.brief_validation_failed', issues.join('; '));
    return { ok: false, lead, reason: 'brief_validation_failed', issues };
  }
  const approvedAt = new Date().toISOString();
  let updated = await store.updateLead(lead.id, {
    status: 'brief_approved',
    customerBrief: { ...(lead.customerBrief ?? {}), approvedAt },
  });
  await store.addEvent(lead.id, 'customer.brief_approved', 'Customer approved the brief');
  await emitCustomerA1Event(updated, 'customer.brief_updated', 'Customer approved the brief', { brief: updated.customerBrief, approved: true });

  if (!hasReadyPreview(updated)) {
    const queued = await store.enqueueJob({
      type: 'customer_preview_build',
      leadId: updated.id,
      priority: 95,
      maxAttempts: 3,
      payload: { chatId },
      idempotencyKey: `customer_preview_build:${updated.id}:${updated.customerBrief?.approvedAt || approvedAt}`,
    });
    updated = await store.transitionLead(updated.id, {
      pipelineStage: 'lovable_queued',
      stageStatus: 'customer_preview_queued',
      reason: 'customer_brief_approved',
    });
    await sendTelegramTo(chatId, 'ТЗ утверждено. Я поставил сборку превью в очередь и пришлю ссылку после проверки качества.');
    return { ok: true, lead: updated, queued: queued.job };
  }

  const a1LeadId = updated.a1LeadId || updated.a1?.leadId || '';
  if (a1LeadId && !updated.a1?.conversionRequestedAt) {
    const convert = await crmConvertLeadToDeal({
      a1LeadId,
      dealTitle: `Site for ${updated.name}`,
      customerContact: updated.customerTelegram || {},
      sourceLead: updated,
      initialBrief: updated.customerBrief || {},
      idempotencyKey: `webstudio:${updated.id}:convert:brief-approved`,
      reason: 'brief_approved',
    });
    if (convert.ok) {
      updated = await store.updateLead(updated.id, {
        a1: {
          ...(updated.a1 ?? {}),
          conversionRequestedAt: new Date().toISOString(),
          conversionMode: convert.conversionMode || 'a1',
        },
      });
    }
  }

  const billingEmail = billingEmailForLead(updated);
  if (!billingEmail) {
    updated = await store.updateLead(updated.id, {
      payment: { ...(updated.payment ?? {}), status: 'needs_customer_email', amountRub: updated.deal || 140000 },
    });
    await store.addEvent(updated.id, 'payment.needs_customer_email', 'Payment link was not requested because customer email is missing');
    await sendTelegramTo(chatId, 'Для ссылки на оплату нужна почта. Пришлите email одним сообщением, затем снова отправьте /approve.');
    return { ok: true, lead: updated, needsEmail: true };
  }

  if (!a1LeadId) {
    await sendTelegramTo(chatId, 'ТЗ утверждено. Но лид еще не синхронизирован с A1, поэтому ссылку на оплату пока не сформировал. Администратор уже получит задачу проверить синхронизацию.');
    await sendTelegram(`<b>Нет A1 leadId для оплаты</b>\nЛид: ${escapeHtml(updated.name)}\nID: <code>${escapeHtml(updated.id)}</code>`);
    return { ok: true, lead: updated, needsA1Lead: true };
  }

  if (a1LeadId) {
    await dealAttachProduct({
      leadId: a1LeadId,
      a1DealId: updated.a1DealId,
      productCode: 'landing_site_setup',
      title: `Лендинг для ${updated.name}`,
      description: 'Готовый лендинг с первичным запуском, формой заявки и базовыми правками.',
      amountRub: updated.deal || 140000,
      idempotencyKey: `webstudio:${updated.id}:product:landing_site_setup`,
    });
    const invoice = await invoiceCreateYookassaLink({
      leadId: a1LeadId,
      a1DealId: updated.a1DealId,
      customerEmail: billingEmail,
      items: [{ productCode: 'landing_site_setup', title: `Лендинг для ${updated.name}`, amountRub: updated.deal || 140000, quantity: 1 }],
      amountRub: updated.deal || 140000,
      successUrl: customerBotLink(updated) || '',
      metadata: { webstudioLeadId: updated.id, a1LeadId, a1DealId: updated.a1DealId || '' },
      idempotencyKey: `webstudio:${updated.id}:invoice:${updated.deal || 140000}`,
    });
    const data = paymentData(invoice);
    if (invoice.ok && data?.paymentUrl) {
      updated = await store.updateLead(updated.id, {
        payment: { invoiceId: data.invoiceId || '', paymentUrl: data.paymentUrl, amountRub: updated.deal || 140000, status: 'created', customerEmail: billingEmail },
      });
    } else {
      updated = await store.updateLead(updated.id, {
        payment: {
          ...(updated.payment ?? {}),
          amountRub: updated.deal || 140000,
          customerEmail: billingEmail,
          status: invoice.ok ? 'requested' : 'failed',
          error: invoice.ok ? '' : invoice.error || invoice.reason || 'invoice_create_yookassa_link failed',
        },
      });
    }
  }

  if (updated.payment?.paymentUrl) {
    await sendTelegramTo(chatId, `ТЗ утверждено. Ссылка на оплату:\n${updated.payment.paymentUrl}\n\nПосле оплаты передам ТЗ в работу и пришлю обновленное превью сайта.`);
  } else if (updated.payment?.status === 'requested') {
    await sendTelegramTo(chatId, 'ТЗ утверждено. Запрос на ссылку оплаты отправлен в A1. Как только ссылка будет создана, пришлю ее сюда.');
  } else if (updated.payment?.status === 'failed') {
    await sendTelegramTo(chatId, 'ТЗ утверждено, но ссылку на оплату сейчас сформировать не удалось. Я сообщил администратору, проверим настройки продукта/ЮKassa.');
    await sendTelegram(`<b>Ошибка создания оплаты</b>\nЛид: ${escapeHtml(updated.name)}\nID: <code>${escapeHtml(updated.id)}</code>\nEmail: <code>${escapeHtml(billingEmail)}</code>\nОшибка: <code>${escapeHtml(updated.payment?.error || 'unknown')}</code>`);
  } else {
    await sendTelegramTo(chatId, 'ТЗ утверждено. Передаю его в работу, затем пришлю ссылку на обновленный сайт.');
  }
  return { ok: true, lead: updated };
}

async function buildApprovedBriefPreview(store, lead, chatId) {
  await sendTelegramTo(chatId, 'ТЗ утверждено. Готовлю первое превью сайта, это может занять немного времени.');
  let updated = await store.updateLead(lead.id, {
    lane: 'Lovable',
    owner: 'Builder',
    status: 'building_preview',
  });
  await store.addEvent(updated.id, 'customer.preview_build_started', 'Customer approved brief; preview build started');
  await syncLeadToA1(store, updated, 'customer_preview_build_started');

  const mockup = await prepareLovableMockup(updated);
  updated = await store.updateLead(updated.id, {
    mockup,
    status: mockup?.status === 'export_ready' ? 'export_ready' : mockup?.status || 'preview_waiting',
    owner: mockup?.status === 'export_ready' ? 'Coder' : 'Builder',
  });

  if (mockup?.ok === false || mockup?.status === 'failed') {
    const reason = mockup?.reason || mockup?.raw?.reason || mockup?.raw?.error || 'Lovable preview build failed';
    updated = await store.updateLead(updated.id, {
      status: 'coder_fallback_preview',
      owner: 'Coder',
      nextAction: {
        type: 'lovable_auth_or_handoff',
        title: 'Проверить Lovable и повторить сборку превью',
        reason,
        createdAt: new Date().toISOString(),
      },
    });
    await store.addEvent(updated.id, 'customer.preview_build_failed', reason);
    await sendTelegramTo(chatId, 'Lovable сейчас не отдал проект. Я передал это администратору и не буду отправлять технический черновик вместо нормального превью.');
    await sendTelegram(`<b>Ошибка сборки клиентского превью</b>\nЛид: ${escapeHtml(updated.name)}\nID: <code>${escapeHtml(updated.id)}</code>\nОшибка: <code>${escapeHtml(reason)}</code>`);
    const generated = await deployLeadGeneratedPreview(store, updated.id, { reason, projectName: updated.name, renderVideo: false });
    const finalLead = generated.lead || store.getLead(updated.id) || updated;
    if (generated.publicUrl || finalLead.mockup?.publicUrl) {
      const url = generated.publicUrl || finalLead.mockup.publicUrl;
      await sendTelegram(`<b>Внутренний Coder fallback создан</b>\nЛид: ${escapeHtml(updated.name)}\nURL: ${escapeHtml(url)}\nКлиенту не отправлен. Нужно восстановить Lovable и собрать нормальное превью.`);
      return { ok: true, lead: finalLead, publicUrl: url, fallback: true, reason, generated };
    }
    await sendTelegramTo(chatId, 'Не смог собрать даже аварийное превью. Я передал это администратору.');
    return { ok: false, lead: finalLead, reason, mockup, generated };
  }

  if (mockup?.status === 'export_ready') {
    const deployed = await deployLeadExportedProject(store, updated.id, {
      files: mockup.files ?? [],
      lovable: {
        projectId: mockup.projectId || '',
        editorUrl: mockup.editorUrl || '',
        previewUrl: mockup.previewUrl || '',
        publishedUrl: mockup.publishedUrl || mockup.url || '',
        latestRef: mockup.latestRef || '',
      },
      projectName: mockup.projectName || updated.name,
    });
    const finalLead = deployed.lead || store.getLead(updated.id) || updated;
    if (deployed.ok && (deployed.publicUrl || finalLead.mockup?.publicUrl)) {
      const url = deployed.publicUrl || finalLead.mockup.publicUrl;
      await sendTelegramTo(chatId, `Первое превью готово:\n${url}\n\nПосмотрите. Если направление подходит — отправьте /approve еще раз, и я сформирую оплату. Если нужно поправить — напишите обычным сообщением.`);
      return { ok: true, lead: finalLead, publicUrl: url };
    }
    await sendTelegramTo(chatId, 'Превью собрано, но деплой не завершился. Я передал это администратору.');
    await sendTelegram(`<b>Ошибка деплоя превью</b>\nЛид: ${escapeHtml(updated.name)}\nID: <code>${escapeHtml(updated.id)}</code>\nОшибка: <code>${escapeHtml(deployed.error || deployed.video?.reason || 'unknown')}</code>`);
    return { ok: false, lead: finalLead, deployed };
  }

  if (mockup?.status === 'public_url_attached') {
    const deployed = await deployLeadPublicUrlProject(store, updated.id, { url: mockup.publishedUrl || mockup.url, projectName: updated.name });
    const finalLead = deployed.lead || store.getLead(updated.id) || updated;
    if (deployed.ok && (deployed.publicUrl || finalLead.mockup?.publicUrl)) {
      const url = deployed.publicUrl || finalLead.mockup.publicUrl;
      await sendTelegramTo(chatId, `Первое превью готово:\n${url}\n\nПосмотрите. Если направление подходит — отправьте /approve еще раз, и я сформирую оплату. Если нужно поправить — напишите обычным сообщением.`);
      return { ok: true, lead: finalLead, publicUrl: url };
    }
  }

  await sendTelegramTo(chatId, 'Я поставил превью в работу. Как только Lovable вернет файлы или ссылку, пришлю результат.');
  await sendTelegram(`<b>Превью ждет handoff</b>\nЛид: ${escapeHtml(updated.name)}\nID: <code>${escapeHtml(updated.id)}</code>\nСтатус: <code>${escapeHtml(mockup?.status || 'unknown')}</code>`);
  return { ok: true, lead: updated, waiting: true };
}

function hasReadyPreview(lead) {
  return Boolean((lead.mockup?.publicUrl || lead.mockup?.deployedUrl || lead.mockup?.publishedUrl) && lead.mockup?.status === 'deployed');
}

function parseToolData(result) {
  const text = result?.data?.content?.find?.((item) => item.type === 'text')?.text;
  if (!text) return result?.data || null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function paymentData(result) {
  const parsed = parseToolData(result);
  const nested = parseMaybeJson(parsed?.result?.response?.final_response || parsed?.response?.final_response);
  const data = nested || parsed || {};
  return {
    invoiceId: data.invoiceId || data.invoice_id || data.id || data.result?.invoiceId || '',
    paymentUrl: data.paymentUrl || data.payment_url || data.confirmationUrl || data.confirmation_url || data.url || data.result?.paymentUrl || '',
  };
}

function billingEmailForLead(lead) {
  const candidates = [
    lead?.customerContact?.email,
    lead?.customerTelegram?.email,
    lead?.email,
    ...(Array.isArray(lead?.contacts?.emails) ? lead.contacts.emails : []),
    ...(Array.isArray(lead?.contacts?.channels) ? lead.contacts.channels.map((channel) => channel?.value || channel?.email || '') : []),
    lead?.customerBrief?.contacts,
  ];
  for (const candidate of candidates) {
    const email = extractEmail(candidate);
    if (email) return email;
  }
  return '';
}

async function syncLeadToA1(store, lead, reason) {
  const sync = await syncA1CrmLead(lead, reason).catch((error) => ({ ok: false, error: error.message }));
  const a1LeadId = sync?.a1LeadId || sync?.upsert?.data?.lead?.id || sync?.upsert?.data?.id || '';
  if (a1LeadId && !(lead.a1LeadId || lead.a1?.leadId)) {
    return store.updateLead(lead.id, {
      a1LeadId,
      a1: { ...(lead.a1 ?? {}), leadId: a1LeadId, dedupeKey: sync.dedupeKey || `webstudio:${lead.id}`, lastSyncAt: new Date().toISOString() },
    });
  }
  return lead;
}

function extractEmail(value) {
  const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] || '';
}

function parseMaybeJson(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

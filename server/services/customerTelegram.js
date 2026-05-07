import { randomInt } from 'node:crypto';
import OpenAI from 'openai';
import { config, hasSecret } from '../config.js';
import { crmConvertLeadToDeal, customerBotLink, dealAttachProduct, invoiceCreateYookassaLink, outboundQueueMessage, syncA1CrmLead } from './a1Client.js';
import { emitCustomerA1Event } from './a1Webhook.js';
import { prepareLovableMockup } from './lovableMcp.js';
import { deployLeadExportedProject, deployLeadGeneratedPreview, deployLeadPublicUrlProject } from './projectPublisher.js';
import { downloadTelegramFile, getTelegramFile, sendTelegram, sendTelegramTo } from './telegram.js';

const QUESTIONS = [
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
    if (!pendingEmail) {
      await sendTelegramTo(chatId, 'Пришлите, пожалуйста, рабочий email. На него я отправлю короткий код подтверждения.');
      return { ok: true, lead };
    }
    return requestEmailVerification(store, lead, chatId, pendingEmail);
  }

  if (lead.customerTelegram?.mode === 'email_code') {
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
  return ['/help', '/brief', '/approve', '/revision'].includes(command);
}

async function startCustomerLead(store, chatId, from, token) {
  let lead = store.findLeadByPublicToken(token);
  if (!lead) {
    await sendTelegramTo(chatId, 'Ссылка не найдена или устарела. Ответьте на письмо, и мы пришлем новую.');
    return { ok: true, unmatched: true };
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
  lead = await store.updateLead(lead.id, { customerTelegram, status: 'customer_chat' });
  await store.addEvent(lead.id, 'customer.telegram_started', `Customer opened bot: ${from?.username || chatId}`);
  await emitCustomerA1Event(lead, 'customer.telegram_started', 'Customer started Telegram bot', { customerTelegram });
  await notifyAdminCustomerStarted(lead, customerTelegram);

  await sendTelegramTo(
    chatId,
    onboardingText(lead, true),
  );
  if (customerTelegram.emailVerified) await sendTelegramTo(chatId, QUESTIONS[0].text);
  else if (customerTelegram.email) await requestEmailVerification(store, lead, chatId, customerTelegram.email);
  else await sendTelegramTo(chatId, 'Для начала регистрации пришлите, пожалуйста, рабочий email. Я отправлю на него код подтверждения.');
  return { ok: true, lead };
}

async function startInboundCustomer(store, chatId, from, text) {
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
    lane: 'Ответы',
    owner: 'Mobile',
    status: 'registration_email',
    customerTelegram,
    customerBrief: text && !text.startsWith('/start') ? { initialMessage: text, updatedAt: new Date().toISOString() } : {},
    contacts: { emails: [], phone: '', channels: [] },
  });
  lead = await syncLeadToA1(store, lead, 'telegram_inbound_started');
  await store.addEvent(lead.id, 'customer.telegram_started', `Inbound customer opened bot: ${from?.username || chatId}`);
  await notifyAdminCustomerStarted(lead, customerTelegram);
  await sendTelegramTo(chatId, onboardingText(lead, false));
  await sendTelegramTo(chatId, 'Для регистрации пришлите, пожалуйста, рабочий email. Я отправлю на него код подтверждения, и после этого мы соберем ТЗ.');
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
    '/revision — отправить правку по сайту',
    '/help — показать это меню',
    '',
    `Проект: <b>${escapeHtml(lead?.name || 'ваш сайт')}</b>`,
    'Стоимость простого сайта-визитки начинается от 30 000 ₽. Итоговая цена зависит от объема страниц, контента и интеграций.',
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
    '💼 Стоимость разработки начинается от <b>30 000 ₽</b> за простой сайт-визитку. Оплата — после первого готового превью, когда понятно, что именно получается.',
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
  });
  await syncLeadToA1(store, updated, 'customer_email_verification');
  const sent = await outboundQueueMessage({
    a1LeadId: updated.a1LeadId || updated.a1?.leadId || '',
    externalId: updated.id,
    dedupeKey: `webstudio:${updated.id}:email-verification:${email}`,
    to: email,
    subject: 'Код подтверждения 1Lab',
    body: `Ваш код подтверждения для 1Lab Web Studio: ${code}\n\nКод действует 15 минут.`,
    idempotencyKey: `webstudio:${updated.id}:email-code:${Date.now()}`,
  });
  await store.addEvent(updated.id, 'customer.email_code_sent', `Verification code sent to ${email}`);
  if (!sent.ok) {
    await sendTelegramTo(chatId, 'Не смог отправить код на почту через A1. Я сообщил администратору, попробуем вручную.');
    await sendTelegram(`<b>Не удалось отправить email-код</b>\nЛид: ${escapeHtml(updated.name)}\nEmail: <code>${escapeHtml(email)}</code>\nОшибка: <code>${escapeHtml(sent.error || sent.reason || 'unknown')}</code>`);
    return { ok: false, lead: updated, emailSent: sent };
  }
  await sendTelegramTo(chatId, `Отправил код подтверждения на ${escapeHtml(email)}. Введите сюда 6 цифр из письма.`);
  return { ok: true, lead: updated, emailSent: sent };
}

async function confirmEmailCode(store, lead, chatId, text) {
  const code = String(text || '').replace(/\D/g, '').slice(0, 6);
  const expected = String(lead.customerTelegram?.emailCode || '');
  const expires = Date.parse(lead.customerTelegram?.emailCodeExpiresAt || '');
  if (!expected || !Number.isFinite(expires) || Date.now() > expires) {
    await store.updateLead(lead.id, { customerTelegram: { ...(lead.customerTelegram ?? {}), mode: 'registration_email' } });
    await sendTelegramTo(chatId, 'Код истек. Пришлите email еще раз, я отправлю новый код.');
    return { ok: false, expired: true };
  }
  if (code !== expected) {
    await sendTelegramTo(chatId, 'Код не совпал. Проверьте письмо и отправьте 6 цифр еще раз.');
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
  const step = Number(lead.customerTelegram?.step ?? 0);
  if (step >= QUESTIONS.length || lead.customerTelegram?.mode === 'brief_review') {
    return refineBriefFromMessage(store, lead, chatId, text);
  }
  const question = QUESTIONS[step] || QUESTIONS[QUESTIONS.length - 1];
  const brief = {
    ...(lead.customerBrief ?? {}),
    [question.key]: text,
    updatedAt: new Date().toISOString(),
  };
  const nextStep = step + 1;
  const updated = await store.updateLead(lead.id, {
    customerBrief: brief,
    customerTelegram: { ...(lead.customerTelegram ?? {}), step: nextStep, mode: nextStep >= QUESTIONS.length ? 'brief_review' : 'brief' },
    status: 'briefing',
  });
  await emitCustomerA1Event(updated, 'customer.brief_updated', `Brief answer: ${question.key}`, { brief, key: question.key, answer: text });

  if (nextStep < QUESTIONS.length) {
    await sendTelegramTo(chatId, QUESTIONS[nextStep].text);
    return { ok: true, lead: updated };
  }

  return sendBriefSummary(store, updated, chatId);
}

async function refineBriefFromMessage(store, lead, chatId, text) {
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
  const summary = [
    '<b>Черновик ТЗ</b>',
    `Бизнес: ${lead.name}`,
    `Цель: ${brief.goal || '-'}`,
    `Услуги: ${brief.services || '-'}`,
    `Стиль: ${brief.style || '-'}`,
    `Контакты/форма: ${brief.contacts || '-'}`,
    `Материалы: ${brief.materials || '-'}`,
    `Срок: ${brief.deadline || '-'}`,
    brief.notes ? `Уточнения: ${brief.notes}` : '',
    '',
    'Если все верно, отправьте /approve. Если нужно поправить, просто напишите уточнение.',
  ].filter(Boolean).join('\n');
  await sendTelegramTo(chatId, summary);
  return { ok: true, lead };
}

async function approveBrief(store, lead, chatId) {
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
    await sendTelegramTo(chatId, 'Lovable сейчас не отдал проект, поэтому собираю первое превью внутренним Coder на основе вашего ТЗ.');
    await sendTelegram(`<b>Ошибка сборки клиентского превью</b>\nЛид: ${escapeHtml(updated.name)}\nID: <code>${escapeHtml(updated.id)}</code>\nОшибка: <code>${escapeHtml(reason)}</code>`);
    const generated = await deployLeadGeneratedPreview(store, updated.id, { reason, projectName: updated.name });
    const finalLead = generated.lead || store.getLead(updated.id) || updated;
    if (generated.publicUrl || finalLead.mockup?.publicUrl) {
      const url = generated.publicUrl || finalLead.mockup.publicUrl;
      await sendTelegramTo(chatId, `Первое превью готово:\n${url}\n\nЭто аварийный вариант от Web Studio Coder, пока Lovable требует повторной авторизации. Если направление подходит — отправьте /approve еще раз, и я сформирую оплату. Если нужно поправить — напишите обычным сообщением.`);
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

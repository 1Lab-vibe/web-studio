import { crmConvertLeadToDeal, customerBotLink, dealAttachProduct, invoiceCreateYookassaLink } from './a1Client.js';
import { emitCustomerA1Event } from './a1Webhook.js';
import { sendTelegramTo } from './telegram.js';

const QUESTIONS = [
  { key: 'goal', text: 'Какая главная задача сайта: заявки, запись, доверие, каталог услуг или другое?' },
  { key: 'services', text: 'Какие услуги или товары обязательно показать на первом экране и в разделах?' },
  { key: 'style', text: 'Есть пожелания по стилю или примеры сайтов, которые нравятся?' },
  { key: 'contacts', text: 'Какие контакты и поля формы нужны на сайте?' },
  { key: 'materials', text: 'Есть логотип, фото, отзывы, лицензии или другие материалы? Можно прислать ссылкой или описанием.' },
  { key: 'deadline', text: 'К какому сроку хотите получить первый рабочий вариант?' },
];

export async function handleCustomerTelegramMessage(store, message) {
  const chatId = message?.chat?.id;
  const text = String(message?.text || '').trim();
  if (!chatId || !text) return { ok: true, skipped: true };

  const startMatch = text.match(/^\/start\s+lead_([a-f0-9]{16,64})/i);
  if (startMatch) return startCustomerLead(store, chatId, message.from, startMatch[1]);

  const lead = store.listLeads().find((item) => String(item.customerTelegram?.chatId || '') === String(chatId));
  if (!lead) {
    await sendTelegramTo(chatId, 'Здравствуйте. Я не нашел активную заявку. Откройте ссылку из письма еще раз.');
    return { ok: true, unmatched: true };
  }

  if (text === '/brief') return sendBriefSummary(store, lead, chatId);
  if (text === '/approve') return approveBrief(store, lead, chatId);
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

  return collectBriefAnswer(store, lead, chatId, text);
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
    mode: 'brief',
    step: 0,
    startedAt: new Date().toISOString(),
  };
  lead = await store.updateLead(lead.id, { customerTelegram, status: 'customer_chat' });
  await store.addEvent(lead.id, 'customer.telegram_started', `Customer opened bot: ${from?.username || chatId}`);
  await emitCustomerA1Event(lead, 'customer.telegram_started', 'Customer started Telegram bot', { customerTelegram });

  const convert = await crmConvertLeadToDeal({
    a1LeadId: lead.a1LeadId || lead.a1?.leadId || '',
    dealTitle: `Сайт для ${lead.name}`,
    customerContact: customerTelegram,
    sourceLead: lead,
    initialBrief: lead.customerBrief || {},
    idempotencyKey: `webstudio:${lead.id}:convert:${chatId}`,
  });
  if (convert.ok) {
    const data = parseToolData(convert);
    lead = await store.updateLead(lead.id, {
      a1DealId: data?.a1DealId || data?.dealId || data?.id || lead.a1DealId,
      a1: { ...(lead.a1 ?? {}), dealId: data?.a1DealId || data?.dealId || data?.id || lead.a1?.dealId },
    });
  }

  await sendTelegramTo(
    chatId,
    [
      `Здравствуйте. Я помогу собрать ТЗ для сайта «${lead.name}».`,
      'Отвечайте коротко, как удобно. В конце я покажу готовое ТЗ на утверждение.',
      '',
      QUESTIONS[0].text,
    ].join('\n'),
  );
  return { ok: true, lead };
}

async function collectBriefAnswer(store, lead, chatId, text) {
  const step = Number(lead.customerTelegram?.step ?? 0);
  const question = QUESTIONS[step] || QUESTIONS[QUESTIONS.length - 1];
  const brief = {
    ...(lead.customerBrief ?? {}),
    [question.key]: text,
    updatedAt: new Date().toISOString(),
  };
  const nextStep = step + 1;
  const updated = await store.updateLead(lead.id, {
    customerBrief: brief,
    customerTelegram: { ...(lead.customerTelegram ?? {}), step: nextStep, mode: 'brief' },
    status: 'briefing',
  });
  await emitCustomerA1Event(updated, 'customer.brief_updated', `Brief answer: ${question.key}`, { brief, key: question.key, answer: text });

  if (nextStep < QUESTIONS.length) {
    await sendTelegramTo(chatId, QUESTIONS[nextStep].text);
    return { ok: true, lead: updated };
  }

  return sendBriefSummary(store, updated, chatId);
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
    '',
    'Если все верно, отправьте /approve. Если нужно поправить, просто напишите уточнение.',
  ].join('\n');
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

  if (updated.a1DealId) {
    await dealAttachProduct({
      a1DealId: updated.a1DealId,
      title: `Лендинг для ${updated.name}`,
      description: 'Готовый лендинг с первичным запуском, формой заявки и базовыми правками.',
      amountRub: updated.deal || 140000,
      idempotencyKey: `webstudio:${updated.id}:product:landing_site_setup`,
    });
    const invoice = await invoiceCreateYookassaLink({
      a1DealId: updated.a1DealId,
      items: [{ title: `Лендинг для ${updated.name}`, amountRub: updated.deal || 140000, quantity: 1 }],
      amountRub: updated.deal || 140000,
      successUrl: customerBotLink(updated) || '',
      metadata: { webstudioLeadId: updated.id },
      idempotencyKey: `webstudio:${updated.id}:invoice:${updated.deal || 140000}`,
    });
    const data = parseToolData(invoice);
    if (invoice.ok && data?.paymentUrl) {
      updated = await store.updateLead(updated.id, {
        payment: { invoiceId: data.invoiceId || '', paymentUrl: data.paymentUrl, amountRub: updated.deal || 140000, status: 'created' },
      });
    }
  }

  await sendTelegramTo(chatId, 'ТЗ утверждено. Передаю его в работу, затем пришлю ссылку на обновленный сайт.');
  return { ok: true, lead: updated };
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

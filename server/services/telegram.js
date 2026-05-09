import { config, hasSecret } from '../config.js';

function telegramUrl(method) {
  return `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`;
}

export async function sendTelegram(text, replyMarkup) {
  if (!hasSecret(config.TELEGRAM_BOT_TOKEN) || !hasSecret(config.TELEGRAM_CHAT_ID)) {
    return { ok: false, skipped: true, reason: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured' };
  }

  return sendTelegramTo(config.TELEGRAM_CHAT_ID, text, replyMarkup);
}

export async function sendTelegramTo(chatId, text, replyMarkup) {
  if (!hasSecret(config.TELEGRAM_BOT_TOKEN) || !chatId) {
    return { ok: false, skipped: true, reason: 'TELEGRAM_BOT_TOKEN or chatId is not configured' };
  }

  const response = await fetch(telegramUrl('sendMessage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: replyMarkup }),
  });

  if (!response.ok) return { ok: false, status: response.status, error: await response.text() };
  return { ok: true, data: await response.json() };
}

export async function getTelegramFile(fileId) {
  if (!hasSecret(config.TELEGRAM_BOT_TOKEN) || !fileId) {
    return { ok: false, skipped: true, reason: 'TELEGRAM_BOT_TOKEN or fileId is not configured' };
  }
  const response = await fetch(telegramUrl(`getFile?file_id=${encodeURIComponent(fileId)}`));
  if (!response.ok) return { ok: false, status: response.status, error: await response.text() };
  return { ok: true, data: await response.json() };
}

export async function downloadTelegramFile(filePath) {
  if (!hasSecret(config.TELEGRAM_BOT_TOKEN) || !filePath) {
    return { ok: false, skipped: true, reason: 'TELEGRAM_BOT_TOKEN or filePath is not configured' };
  }
  const response = await fetch(`https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!response.ok) return { ok: false, status: response.status, error: await response.text() };
  return { ok: true, data: Buffer.from(await response.arrayBuffer()) };
}

export function isAdminTelegramUser(userId, chatId = '') {
  const configuredAdmins = String(config.TELEGRAM_ADMIN_USER_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (configuredAdmins.length) return configuredAdmins.includes(String(userId));
  return Boolean(config.TELEGRAM_CHAT_ID && String(chatId || userId) === String(config.TELEGRAM_CHAT_ID));
}

export function approvalKeyboard(approvalId) {
  return {
    inline_keyboard: [
      [
        { text: 'Одобрить', callback_data: `approval:${approvalId}:approved` },
        { text: 'Отклонить', callback_data: `approval:${approvalId}:rejected` },
      ],
      [{ text: 'Пауза ниши', callback_data: `approval:${approvalId}:pause_niche` }],
    ],
  };
}

export async function answerCallback(callbackQueryId, text) {
  if (!hasSecret(config.TELEGRAM_BOT_TOKEN) || !callbackQueryId) return;
  await fetch(telegramUrl('answerCallbackQuery'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

export async function setTelegramCommands() {
  if (!hasSecret(config.TELEGRAM_BOT_TOKEN)) return { ok: false, skipped: true };
  const customerCommands = [
    { command: 'help', description: 'Как работает разработка сайта' },
    { command: 'brief', description: 'Показать черновик ТЗ' },
    { command: 'approve', description: 'Утвердить ТЗ' },
    { command: 'reset', description: 'Собрать ТЗ заново' },
    { command: 'cancel', description: 'Остановить текущую заявку' },
    { command: 'revision', description: 'Отправить правку по сайту' },
    { command: 'resend', description: 'Отправить email-код заново' },
    { command: 'email', description: 'Изменить email' },
  ];
  const adminCommands = [
    { command: 'help', description: 'Команды Web Studio' },
    { command: 'brief', description: 'Клиент: показать черновик ТЗ' },
    { command: 'approve', description: 'Клиент: утвердить ТЗ' },
    { command: 'reset', description: 'Клиент: собрать ТЗ заново' },
    { command: 'cancel', description: 'Клиент: остановить заявку' },
    { command: 'revision', description: 'Клиент: отправить правку по сайту' },
    { command: 'resend', description: 'Клиент: отправить email-код заново' },
    { command: 'email', description: 'Клиент: изменить email' },
    { command: 'actions', description: 'Топ действий оркестратора' },
    { command: 'lead', description: 'Карточка лида: /lead <id>' },
    { command: 'handoff', description: 'Lovable handoff prompt: /handoff <id>' },
  ];
  const results = [];
  results.push(await setCommands(customerCommands, { type: 'default' }));
  if (!results[0].ok) return results[0];

  const adminChatIds = new Set(
    [config.TELEGRAM_CHAT_ID, ...String(config.TELEGRAM_ADMIN_USER_IDS || '').split(',')]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
  for (const chatId of adminChatIds) {
    results.push(await setCommands(adminCommands, { type: 'chat', chat_id: chatId }));
  }

  return {
    ok: true,
    data: results.map((result) => result.data),
    warnings: results.filter((result) => !result.ok),
  };
}

async function setCommands(commands, scope) {
  const response = await fetch(telegramUrl('setMyCommands'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commands, scope }),
  });
  if (!response.ok) return { ok: false, status: response.status, error: await response.text(), scope };
  return { ok: true, data: await response.json(), scope };
}

export async function getTelegramWebhookInfo() {
  if (!hasSecret(config.TELEGRAM_BOT_TOKEN)) return { ok: false, skipped: true };
  const response = await fetch(telegramUrl('getWebhookInfo'));
  if (!response.ok) return { ok: false, status: response.status, error: await response.text() };
  return { ok: true, data: await response.json() };
}

export async function getTelegramUpdates(offset = 0) {
  if (!hasSecret(config.TELEGRAM_BOT_TOKEN)) return { ok: false, skipped: true, data: { result: [] } };
  const url = new URL(telegramUrl('getUpdates'));
  if (offset) url.searchParams.set('offset', String(offset));
  url.searchParams.set('timeout', '0');
  url.searchParams.set('allowed_updates', JSON.stringify(['message', 'callback_query']));
  const response = await fetch(url);
  if (!response.ok) return { ok: false, status: response.status, error: await response.text(), data: { result: [] } };
  return { ok: true, data: await response.json() };
}

import { config, hasSecret } from '../config.js';

function telegramUrl(method) {
  return `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`;
}

export async function sendTelegram(text, replyMarkup) {
  if (!hasSecret(config.TELEGRAM_BOT_TOKEN) || !hasSecret(config.TELEGRAM_CHAT_ID)) {
    return { ok: false, skipped: true, reason: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured' };
  }

  const response = await fetch(telegramUrl('sendMessage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: config.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', reply_markup: replyMarkup }),
  });

  if (!response.ok) return { ok: false, status: response.status, error: await response.text() };
  return { ok: true, data: await response.json() };
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

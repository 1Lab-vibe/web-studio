import { customerBotLink } from './a1Client.js';
import { sendTelegramTo } from './telegram.js';

export async function handleAdminTelegramMessage(store, orchestrator, message) {
  const chatId = message?.chat?.id;
  const text = String(message?.text || '').trim();
  if (!chatId || !text.startsWith('/')) return { ok: false, skipped: true };

  const [command, ...args] = text.split(/\s+/);
  if (command === '/actions') {
    const actions = orchestrator.topActions(8);
    await sendTelegramTo(
      chatId,
      actions.length
        ? actions.map((item, index) => `${index + 1}. ${item.label}\n${item.lead.name}\nID: <code>${item.lead.id}</code>`).join('\n\n')
        : 'Нет рекомендуемых действий.',
    );
    return { ok: true };
  }

  if (command === '/lead') {
    const lead = findLead(store, args[0]);
    if (!lead) return sendNotFound(chatId);
    await sendTelegramTo(chatId, leadSummary(lead));
    return { ok: true };
  }

  if (command === '/handoff') {
    const lead = findLead(store, args[0]);
    if (!lead) return sendNotFound(chatId);
    await sendTelegramTo(chatId, handoffPrompt(lead));
    return { ok: true };
  }

  if (command === '/help') {
    await sendTelegramTo(
      chatId,
      [
        '<b>Web Studio admin commands</b>',
        '/actions — топ действий оркестратора',
        '/lead &lt;id&gt; — краткая карточка лида',
        '/handoff &lt;id&gt; — prompt для Lovable, чтобы вернуть URL/код без rebuild',
      ].join('\n'),
    );
    return { ok: true };
  }

  return { ok: false, skipped: true };
}

function findLead(store, idOrPrefix = '') {
  const value = String(idOrPrefix).trim();
  if (!value) return null;
  return store.listLeads().find((lead) => lead.id === value || lead.id.startsWith(value));
}

async function sendNotFound(chatId) {
  await sendTelegramTo(chatId, 'Лид не найден. Используйте /actions, чтобы посмотреть ID.');
  return { ok: false, notFound: true };
}

function leadSummary(lead) {
  return [
    `<b>${escapeHtml(lead.name)}</b>`,
    `${escapeHtml(lead.city || '')} · ${escapeHtml(lead.niche || '')}`,
    `ID: <code>${escapeHtml(lead.id)}</code>`,
    `Lane: <code>${escapeHtml(lead.lane || '')}</code>`,
    `Status: <code>${escapeHtml(lead.status || '')}</code>`,
    `FitScore: <code>${escapeHtml(lead.fitScore ?? lead.priority ?? 0)}</code>`,
    `Lovable: <code>${escapeHtml(lead.mockup?.status || lead.mockup?.handoffStatus || 'none')}</code>`,
    lead.mockup?.buildOpenedAt ? `Build opened: <code>${escapeHtml(lead.mockup.buildOpenedAt)}</code>` : '',
    customerBotLink(lead) ? `Customer bot: ${escapeHtml(customerBotLink(lead))}` : '',
  ].filter(Boolean).join('\n');
}

function handoffPrompt(lead) {
  return [
    '<b>Lovable handoff prompt</b>',
    `Lead ID: <code>${escapeHtml(lead.id)}</code>`,
    '',
    escapeHtml(lead.mockup?.handoffPrompt || [
      `The landing page for Web Studio lead "${lead.name}" has already been created in this Lovable project.`,
      'Do not rebuild from scratch and do not resend the original generation prompt.',
      'Please hand the result back to Web Studio now.',
      `Call attach_lovable_url with leadId "${lead.id}", url, publishedUrl if available, projectName, and short notes.`,
      'If files can be exported, call deploy_static_project instead.',
    ].join('\n')),
  ].join('\n');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

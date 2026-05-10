import { createHash } from 'node:crypto';

export function isRevisionPaymentOk(lead = {}) {
  const status = String(lead.payment?.status || lead.paymentStatus || '').toLowerCase();
  return Boolean(
    lead.payment?.paidAt ||
      lead.payment?.paid === true ||
      ['paid', 'succeeded', 'confirmed', 'captured'].includes(status),
  );
}

export function classifyCustomerRevision(text = '') {
  const value = String(text || '').toLowerCase();
  if (/(полностью|заново|передел|новый\s+дизайн|сменить\s+стиль|другая\s+структура|личный\s+кабинет|интернет[-\s]?магазин|корзин|каталог\s+с\s+оплат|калькулятор|анимац|многостранич|сложн|интеграц|crm|api|авторизац)/i.test(value)) {
    return { route: 'lovable', reason: 'complex_revision_requires_lovable' };
  }
  return { route: 'coder', reason: 'simple_content_revision' };
}

export function revisionIdempotencyKey(leadId, text = '', requestedAt = '') {
  const hash = createHash('sha256').update(`${leadId}:${requestedAt}:${text}`).digest('hex').slice(0, 16);
  return `customer_revision:${leadId}:${hash}`;
}

export function revisionPaymentRequiredText(lead = {}) {
  const amount = Number(lead.payment?.amountRub || lead.deal || 15000);
  const paymentUrl = lead.payment?.paymentUrl || '';
  return [
    'Правку принял, но запускать доработки сайта можно только после оплаты.',
    amount ? `Текущая сумма заказа: ${amount.toLocaleString('ru-RU')} ₽.` : '',
    paymentUrl ? `Ссылка на оплату:\n${paymentUrl}` : 'Если ссылки на оплату еще нет, нажмите “Превью подходит” или отправьте /approve, и я сформирую счет.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

import crypto, { randomInt } from 'node:crypto';
import { config } from '../config.js';
import {
  crmAddEvent,
  crmConvertLeadToDeal,
  dealAttachProduct,
  invoiceCreateYookassaLink,
  outboundQueueMessage,
  parsedToolData,
  syncA1CrmLead,
} from './a1Client.js';
import { LEGAL_DOCUMENT_VERSION } from './legalDocs.js';
import { revisionIdempotencyKey } from './revisions.js';
import { sendTelegram } from './telegram.js';

const COOKIE_NAME = 'web_studio_customer_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 15 * 60 * 1000;

function sessionSecret() {
  return config.WEB_AUTH_SESSION_SECRET || config.WEB_STUDIO_MCP_TOKEN || 'web-studio-customer-session-secret';
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function parseCookies(header = '') {
  return Object.fromEntries(
    String(header)
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function createSession(email, leadId) {
  const encoded = Buffer.from(
    JSON.stringify({
      email: normalizeEmail(email),
      leadId,
      exp: Date.now() + SESSION_TTL_MS,
    }),
  ).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

function readSession(req) {
  const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  if (!token || !token.includes('.')) return null;
  const [encoded, signature] = token.split('.');
  if (signature !== sign(encoded)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.email || Number(payload.exp) <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function setSessionCookie(req, res, email, leadId) {
  res.cookie(COOKIE_NAME, createSession(email, leadId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(req.secure || req.get?.('x-forwarded-proto') === 'https' || config.NODE_ENV === 'production'),
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(req.secure || req.get?.('x-forwarded-proto') === 'https' || config.NODE_ENV === 'production'),
    path: '/',
  });
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function absoluteUrl(value) {
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `${config.PUBLIC_BASE_URL}${value.startsWith('/') ? '' : '/'}${value}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function leadEmails(lead = {}) {
  return Array.from(
    new Set([
      lead.customerWeb?.email,
      lead.customerTelegram?.email,
      ...(lead.contacts?.emails || []),
      ...(lead.contacts?.channels || []).filter((channel) => channel?.type === 'email').map((channel) => channel.value),
    ].map(normalizeEmail).filter(Boolean)),
  );
}

function findCustomerLeads(store, email) {
  const normalized = normalizeEmail(email);
  return store.listLeads().filter((lead) => leadEmails(lead).includes(normalized));
}

function customerSubject(email) {
  return `email:${normalizeEmail(email)}`;
}

function publicProject(lead = {}) {
  const previewUrl = absoluteUrl(lead.mockup?.deployedUrl || lead.mockup?.publishedUrl || lead.mockup?.publicUrl || '');
  return {
    id: lead.id,
    name: lead.name,
    businessName: lead.businessName || lead.name,
    status: lead.status,
    pipelineStage: lead.pipelineStage,
    stageStatus: lead.stageStatus,
    updatedAt: lead.updatedAt,
    previewUrl,
    videoUrl: absoluteUrl(lead.video?.videoUrl || ''),
    paymentUrl: lead.payment?.paymentUrl || '',
    payment: lead.payment || {},
    paymentOffer: paymentOfferForLead(lead),
    revision: lead.revision || {},
    customerBrief: lead.customerBrief || {},
    qualityGate: lead.qualityGate ? { ok: lead.qualityGate.ok, issues: lead.qualityGate.issues || [] } : null,
  };
}

function paymentOfferForLead(lead = {}) {
  const baseAmount = 30000;
  const amountRub = Math.max(baseAmount, Number(lead.payment?.amountRub || 0) || baseAmount);
  const fullEstimateRub = Math.max(baseAmount, Number(lead.payment?.fullEstimateRub || lead.deal || 0) || baseAmount);
  return {
    productCode: 'landing_site_setup',
    title: 'Разработка сайта-визитки 1Lab Web Studio',
    description: 'Первый экран, структура услуг, блок доверия, контакты, форма заявки, адаптивная версия и публикация после согласования.',
    amountRub,
    fullEstimateRub,
    billingMode: 'one_time',
  };
}

function customerPayload(store, session) {
  const projects = findCustomerLeads(store, session.email).map(publicProject);
  return {
    authenticated: true,
    email: session.email,
    leadId: session.leadId,
    projects,
  };
}

function hasReadyPreview(lead = {}) {
  return Boolean((lead.mockup?.deployedUrl || lead.mockup?.publishedUrl || lead.mockup?.publicUrl) && lead.mockup?.status === 'deployed' && lead.qualityGate?.ok);
}

function isPaid(lead = {}) {
  const status = String(lead.payment?.status || '').toLowerCase();
  return Boolean(lead.payment?.paidAt || lead.payment?.paid === true || ['paid', 'succeeded', 'confirmed', 'captured'].includes(status));
}

function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',').map((item) => item.trim()).filter(Boolean)[0] || req.ip || req.socket?.remoteAddress || '';
}

async function recordCustomerConsent(store, req, lead, email, type, decision) {
  const documentUrl = type === 'marketing' ? '/marketing-consent' : '/personal-data-consent';
  return store.recordConsent({
    subjectKey: customerSubject(email),
    leadId: lead.id,
    type,
    decision,
    documentVersion: LEGAL_DOCUMENT_VERSION,
    documentUrl: `${config.PUBLIC_BASE_URL}${documentUrl}`,
    source: 'web_customer_cabinet',
    actor: email,
    ip: requestIp(req),
    userAgent: req.get('user-agent') || '',
    evidenceText: decision === 'granted' ? `Customer clicked ${type} consent in registration form` : `Customer declined ${type} consent in registration form`,
    metadata: { leadId: lead.id },
  });
}

async function sendVerificationCode(store, lead, email, { mode = 'registration' } = {}) {
  const code = String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  const loginMode = mode === 'login';
  const alreadyVerified = Boolean(
    lead.customerWeb?.emailVerified ||
      (lead.contacts?.channels || []).some((channel) => channel.type === 'email' && normalizeEmail(channel.value) === email && channel.verified),
  );
  const emailVerified = loginMode ? alreadyVerified : false;
  const updated = await store.updateLead(lead.id, {
    customerWeb: {
      ...(lead.customerWeb || {}),
      email,
      emailVerified,
      emailCode: code,
      emailCodeExpiresAt: expiresAt,
      mode: loginMode ? 'login_email_code' : 'email_code',
      loginCodeRequestedAt: loginMode ? new Date().toISOString() : lead.customerWeb?.loginCodeRequestedAt || '',
    },
    contacts: {
      ...(lead.contacts || {}),
      emails: Array.from(new Set([...(lead.contacts?.emails || []), email])),
      channels: [
        ...(lead.contacts?.channels || []).filter((channel) => !(channel.type === 'email' && normalizeEmail(channel.value) === email)),
        { type: 'email', value: email, confidence: 1, verified: emailVerified, source: loginMode ? 'web_login' : 'web_registration' },
      ],
    },
    payment: { ...(lead.payment || {}), customerEmail: email },
    status: loginMode ? lead.status || 'login_email_verification_sent' : 'email_verification_sent',
    stageStatus: loginMode ? lead.stageStatus || 'login_email_verification_sent' : 'email_verification_sent',
  });
  const idempotencyKey = `webstudio:${updated.id}:web-email-code:${Date.now()}`;
  const sent = await outboundQueueMessage({
    a1LeadId: updated.a1LeadId || updated.a1?.leadId || '',
    externalId: updated.id,
    dedupeKey: idempotencyKey,
    to: email,
    senderProfile: 'no-reply',
    fromAddress: 'no-reply@1true.ru',
    purpose: loginMode ? 'login_code' : 'email_verification',
    subject: loginMode ? 'Код входа в кабинет 1Lab Web Studio' : 'Код подтверждения 1Lab Web Studio',
    body: `Ваш код ${loginMode ? 'входа' : 'подтверждения'} для личного кабинета 1Lab Web Studio: ${code}\n\nКод действует 15 минут.`,
    idempotencyKey,
  });
  await store.addEvent(updated.id, loginMode ? 'customer.web_login_code_sent' : 'customer.web_email_code_sent', `Web cabinet code sent to ${email}`);
  return { lead: updated, sent };
}

function requireCustomer(store, req, res) {
  const session = readSession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: 'Customer session required' });
    return null;
  }
  const leads = findCustomerLeads(store, session.email);
  if (!leads.length) {
    res.status(401).json({ ok: false, error: 'Customer not found' });
    return null;
  }
  return { session, leads };
}

function requireProject(store, req, res) {
  const customer = requireCustomer(store, req, res);
  if (!customer) return null;
  const lead = customer.leads.find((item) => item.id === req.params.id);
  if (!lead) {
    res.status(404).json({ ok: false, error: 'Project not found' });
    return null;
  }
  return { ...customer, lead };
}

export function registerCustomerWebRoutes(app, store) {
  app.get('/api/customer/session', (req, res) => {
    const session = readSession(req);
    if (!session) return res.json({ ok: true, authenticated: false, projects: [] });
    res.json({ ok: true, ...customerPayload(store, session) });
  });

  app.post('/api/customer/register', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ ok: false, error: 'Укажите корректный email' });
    if (req.body?.personalDataConsent !== true) {
      return res.status(428).json({ ok: false, error: 'Для регистрации нужно принять согласие на обработку персональных данных' });
    }

    const contactName = String(req.body?.name || '').trim().slice(0, 120);
    const businessName = String(req.body?.businessName || '').trim().slice(0, 160);
    const goal = String(req.body?.goal || '').trim().slice(0, 2000);
    const phone = String(req.body?.phone || '').trim().slice(0, 80);
    let lead = await store.upsertLead({
      name: businessName || `Заявка с сайта · ${contactName || email}`,
      businessName: businessName || '',
      contactName,
      source: 'web_inbound',
      sourceKey: `web:${email}`,
      lane: 'Диагноз',
      owner: 'Mobile',
      status: 'registration_email',
      pipelineStage: 'qualified',
      stageStatus: 'registration_email',
      priority: 80,
      deal: 30000,
      phone,
      contacts: {
        emails: [email],
        phone,
        channels: [{ type: 'email', value: email, confidence: 1, verified: false, source: 'web_registration' }],
      },
      customerWeb: {
        email,
        emailVerified: false,
        contactName,
        registeredAt: new Date().toISOString(),
        mode: 'registration_email',
      },
      customerBrief: goal ? { webInitialGoal: goal, capture: [goal], updatedAt: new Date().toISOString() } : {},
    });
    await recordCustomerConsent(store, req, lead, email, 'personal_data', 'granted');
    await recordCustomerConsent(store, req, lead, email, 'marketing', req.body?.marketingConsent === true ? 'granted' : 'declined');
    lead = await syncA1(store, lead, 'web_customer_registered');
    const { lead: codedLead, sent } = await sendVerificationCode(store, lead, email, { mode: 'registration' });
    await crmAddEvent({
      entityType: 'lead',
      entityId: codedLead.a1LeadId || codedLead.a1?.leadId || codedLead.id,
      eventType: 'customer.web_registered',
      text: 'Customer registered on Web Studio site and requested email verification',
      payload: { webstudioLeadId: codedLead.id, email, businessName, contactName },
      idempotencyKey: `webstudio:${codedLead.id}:web-registered:${codedLead.updatedAt}`,
    });
    res.status(201).json({ ok: true, leadId: codedLead.id, email, emailSent: sent.ok, emailError: sent.ok ? '' : sent.error || sent.reason || '' });
  });

  app.post('/api/customer/login-code', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ ok: false, error: 'Укажите корректный email' });
    const leads = findCustomerLeads(store, email);
    if (!leads.length) {
      return res.status(404).json({ ok: false, error: 'Проект с таким email не найден. Создайте заявку или проверьте адрес.' });
    }
    const lead = leads.find((item) => item.customerWeb?.emailVerified) || leads[0];
    const { lead: codedLead, sent } = await sendVerificationCode(store, lead, email, { mode: 'login' });
    await store.addEvent(codedLead.id, 'customer.web_login_code_requested', `Web cabinet login code requested for ${email}`);
    await crmAddEvent({
      entityType: 'lead',
      entityId: codedLead.a1LeadId || codedLead.a1?.leadId || codedLead.id,
      eventType: 'customer.web_login_code_requested',
      text: 'Customer requested Web Studio cabinet login code',
      payload: { webstudioLeadId: codedLead.id, email },
      idempotencyKey: `webstudio:${codedLead.id}:web-login-code:${codedLead.updatedAt}`,
    });
    res.json({ ok: true, leadId: codedLead.id, email, emailSent: sent.ok, emailError: sent.ok ? '' : sent.error || sent.reason || '' });
  });

  app.post('/api/customer/verify', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').replace(/\D/g, '').slice(0, 6);
    const lead = store.getLead(req.body?.leadId) || findCustomerLeads(store, email)[0];
    if (!lead || !leadEmails(lead).includes(email)) return res.status(404).json({ ok: false, error: 'Заявка не найдена' });
    const expected = String(lead.customerWeb?.emailCode || '');
    const expires = Date.parse(lead.customerWeb?.emailCodeExpiresAt || '');
    if (!expected || !Number.isFinite(expires) || Date.now() > expires) return res.status(410).json({ ok: false, error: 'Код истек, запросите новый' });
    if (code !== expected) return res.status(401).json({ ok: false, error: 'Код не совпал' });
    let updated = await store.updateLead(lead.id, {
      customerWeb: {
        ...(lead.customerWeb || {}),
        email,
        emailVerified: true,
        emailCode: '',
        emailCodeExpiresAt: '',
        mode: 'cabinet',
        verifiedAt: new Date().toISOString(),
      },
      contacts: {
        ...(lead.contacts || {}),
        channels: (lead.contacts?.channels || []).map((channel) => (channel.type === 'email' && normalizeEmail(channel.value) === email ? { ...channel, verified: true } : channel)),
      },
      payment: { ...(lead.payment || {}), customerEmail: email },
      status: 'customer_registered',
      stageStatus: 'customer_registered',
    });
    updated = await syncA1(store, updated, 'web_customer_email_verified');
    setSessionCookie(req, res, email, updated.id);
    res.json({ ok: true, ...customerPayload(store, { email, leadId: updated.id }) });
  });

  app.post('/api/customer/resend-code', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const lead = store.getLead(req.body?.leadId) || findCustomerLeads(store, email)[0];
    if (!lead || !leadEmails(lead).includes(email)) return res.status(404).json({ ok: false, error: 'Заявка не найдена' });
    const result = await sendVerificationCode(store, lead, email, { mode: req.body?.mode === 'login' ? 'login' : 'registration' });
    res.json({ ok: true, emailSent: result.sent.ok, error: result.sent.ok ? '' : result.sent.error || result.sent.reason || '' });
  });

  app.post('/api/customer/logout', (req, res) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.post('/api/customer/projects', async (req, res) => {
    const context = requireCustomer(store, req, res);
    if (!context) return;
    const email = normalizeEmail(context.session.email);
    const contactName = String(req.body?.name || '').trim().slice(0, 120);
    const businessName = String(req.body?.businessName || '').trim().slice(0, 160);
    const goal = String(req.body?.goal || '').trim().slice(0, 3000);
    const phone = String(req.body?.phone || '').trim().slice(0, 80);
    if (!businessName) return res.status(400).json({ ok: false, error: 'Укажите название бизнеса или проекта' });
    if (!goal) return res.status(400).json({ ok: false, error: 'Коротко опишите задачу сайта' });

    let lead = await store.upsertLead({
      forceCreate: true,
      name: businessName,
      businessName,
      contactName,
      source: 'web_inbound',
      sourceKey: `web:${email}:${Date.now()}`,
      lane: 'Диагноз',
      owner: 'Mobile',
      status: 'brief_collecting',
      pipelineStage: 'qualified',
      stageStatus: 'brief_collecting',
      priority: 82,
      deal: 30000,
      phone,
      contacts: {
        emails: [email],
        phone,
        channels: [{ type: 'email', value: email, confidence: 1, verified: true, source: 'web_cabinet' }],
      },
      payment: { amountRub: 30000, customerEmail: email, status: 'not_requested' },
      customerWeb: {
        email,
        emailVerified: true,
        contactName,
        registeredAt: new Date().toISOString(),
        mode: 'cabinet',
      },
      customerBrief: { webInitialGoal: goal, capture: [goal], webCapture: [{ text: goal, at: new Date().toISOString() }], updatedAt: new Date().toISOString() },
    });
    lead = await syncA1(store, lead, 'web_customer_project_created');
    await store.addEvent(lead.id, 'customer.web_project_created', goal.slice(0, 500));
    await crmAddEvent({
      entityType: 'lead',
      entityId: lead.a1LeadId || lead.a1?.leadId || lead.id,
      eventType: 'customer.web_project_created',
      text: goal,
      payload: { webstudioLeadId: lead.id, email, businessName, source: 'web_cabinet' },
      idempotencyKey: `webstudio:${lead.id}:web-project-created:${lead.updatedAt}`,
    });
    res.status(201).json({ ok: true, project: publicProject(lead), ...customerPayload(store, context.session) });
  });

  app.post('/api/customer/projects/:id/brief', async (req, res) => {
    const context = requireProject(store, req, res);
    if (!context) return;
    const text = String(req.body?.text || '').trim().slice(0, 8000);
    if (!text) return res.status(400).json({ ok: false, error: 'Опишите задачу или правки' });
    const approved = req.body?.approved === true;
    let lead = await store.updateLead(context.lead.id, {
      customerBrief: {
        ...(context.lead.customerBrief || {}),
        webCapture: [...(context.lead.customerBrief?.webCapture || []), { text, at: new Date().toISOString() }].slice(-50),
        webLatestText: text,
        approvedAt: approved ? new Date().toISOString() : context.lead.customerBrief?.approvedAt || '',
        updatedAt: new Date().toISOString(),
      },
      status: approved ? 'brief_approved' : 'brief_collecting',
      stageStatus: approved ? 'brief_approved' : 'brief_collecting',
    });
    await store.addEvent(lead.id, approved ? 'customer.web_brief_approved' : 'customer.web_brief_updated', text.slice(0, 500));
    await crmAddEvent({
      entityType: 'lead',
      entityId: lead.a1LeadId || lead.a1?.leadId || lead.id,
      eventType: approved ? 'customer.brief_updated' : 'customer.web_brief_message',
      text,
      payload: { webstudioLeadId: lead.id, approved, source: 'web_cabinet' },
      idempotencyKey: `webstudio:${lead.id}:web-brief:${Date.now()}`,
    });
    if (approved && !hasReadyPreview(lead)) {
      await store.enqueueJob({
        type: 'customer_preview_build',
        leadId: lead.id,
        priority: 980,
        maxAttempts: 3,
        payload: { source: 'web_cabinet' },
        idempotencyKey: `customer_preview_build:${lead.id}:${lead.customerBrief?.approvedAt || lead.updatedAt}`,
      });
      lead = await store.transitionLead(lead.id, {
        pipelineStage: 'lovable_building',
        stageStatus: 'customer_preview_starting',
        artifactStatus: 'building',
        reason: 'web_customer_brief_approved',
      });
    }
    res.json({ ok: true, project: publicProject(lead) });
  });

  app.post('/api/customer/projects/:id/revision', async (req, res) => {
    const context = requireProject(store, req, res);
    if (!context) return;
    const text = String(req.body?.text || '').trim().slice(0, 5000);
    if (!text) return res.status(400).json({ ok: false, error: 'Опишите правку' });
    if (!isPaid(context.lead)) {
      const lead = await store.updateLead(context.lead.id, {
        revision: { ...(context.lead.revision || {}), text, status: 'payment_required', paymentRequired: true, requestedAt: new Date().toISOString() },
        payment: { ...(context.lead.payment || {}), status: context.lead.payment?.status || 'revision_payment_required' },
      });
      return res.status(402).json({ ok: false, error: 'Правки запускаются после оплаты', project: publicProject(lead) });
    }
    const requestedAt = new Date().toISOString();
    const lead = await store.updateLead(context.lead.id, {
      revision: { ...(context.lead.revision || {}), text, status: 'queued', paymentRequired: false, requestedAt, source: 'web_cabinet' },
      status: 'revision_requested',
    });
    const queued = await store.enqueueJob({
      type: 'customer_revision_triage',
      leadId: lead.id,
      priority: 930,
      payload: { text, requestedAt, source: 'web_cabinet' },
      idempotencyKey: revisionIdempotencyKey(lead.id, text, requestedAt),
    });
    await store.addEvent(lead.id, 'customer.web_revision_queued', text.slice(0, 500));
    res.json({ ok: true, project: publicProject(lead), job: queued.job });
  });

  app.post('/api/customer/projects/:id/payment', async (req, res) => {
    const context = requireProject(store, req, res);
    if (!context) return;
    let lead = context.lead;
    if (lead.payment?.paymentUrl) return res.json({ ok: true, project: publicProject(lead) });
    if (!hasReadyPreview(lead)) return res.status(409).json({ ok: false, error: 'Счет формируется после готового превью', project: publicProject(lead) });
    lead = await syncA1(store, lead, 'web_customer_payment_requested');
    const a1LeadId = lead.a1LeadId || lead.a1?.leadId || '';
    if (!a1LeadId) return res.status(409).json({ ok: false, error: 'Лид еще синхронизируется с A1', project: publicProject(lead) });
    const offer = paymentOfferForLead(lead);
    const amountRub = offer.amountRub;
    let invoice;
    try {
      await crmConvertLeadToDeal({
        a1LeadId,
        dealTitle: `Site for ${lead.name}`,
        customerContact: lead.customerWeb || {},
        sourceLead: lead,
        initialBrief: lead.customerBrief || {},
        idempotencyKey: `webstudio:${lead.id}:convert:web-payment`,
        reason: 'web_customer_payment_requested',
      });
      await dealAttachProduct({
        leadId: a1LeadId,
        productCode: offer.productCode,
        title: offer.title,
        description: offer.description,
        amountRub,
        idempotencyKey: `webstudio:${lead.id}:product:web-cabinet`,
      });
      invoice = await invoiceCreateYookassaLink({
        leadId: a1LeadId,
        customerEmail: context.session.email,
        items: [{ productCode: offer.productCode, title: offer.title, description: offer.description, amountRub, quantity: 1 }],
        amountRub,
        successUrl: `${config.PUBLIC_BASE_URL}/cabinet`,
        metadata: { webstudioLeadId: lead.id, source: 'web_cabinet' },
        idempotencyKey: `webstudio:${lead.id}:invoice:web-cabinet:${amountRub}`,
      });
    } catch (error) {
      invoice = { ok: false, error: error.message || String(error) };
    }
    const data = paymentData(invoice);
    if (invoice.ok && data.paymentUrl) {
      lead = await store.updateLead(lead.id, {
        payment: { ...(lead.payment || {}), invoiceId: data.invoiceId || '', paymentUrl: data.paymentUrl, amountRub, status: 'created', customerEmail: context.session.email },
      });
      return res.json({ ok: true, project: publicProject(lead) });
    }
    const rawError = invoice.error || invoice.reason || 'invoice_create_yookassa_link failed';
    const userMessage = 'Счет не создался автоматически. Мы уже получили заявку и сформируем ссылку на оплату вручную.';
    lead = await store.updateLead(lead.id, {
      payment: {
        ...(lead.payment || {}),
        amountRub,
        offer,
        status: 'manual_invoice_requested',
        error: rawError,
        customerMessage: userMessage,
        requestedAt: new Date().toISOString(),
        customerEmail: context.session.email,
      },
    });
    await store.addEvent(lead.id, 'payment.manual_invoice_requested', rawError.slice(0, 500));
    await sendTelegram(
      [
        '<b>Счет Web Studio требует ручного формирования</b>',
        `Лид: <code>${escapeHtml(lead.name || lead.id)}</code>`,
        `Email: <code>${escapeHtml(context.session.email)}</code>`,
        `Сумма: <code>${amountRub.toLocaleString('ru-RU')} ₽</code>`,
        `Ошибка: <code>${escapeHtml(rawError).slice(0, 900)}</code>`,
      ].join('\n'),
    );
    res.status(202).json({ ok: true, warning: userMessage, project: publicProject(lead) });
  });
}

async function syncA1(store, lead, reason) {
  const crm = await syncA1CrmLead(lead, reason);
  const data = parsedToolData(crm.upsert) || parsedToolData(crm) || {};
  return store.updateLead(lead.id, {
    a1Crm: crm,
    a1LeadId: crm.a1LeadId || data.a1LeadId || data.leadId || data.id || lead.a1LeadId || '',
    a1: {
      ...(lead.a1 || {}),
      leadId: crm.a1LeadId || data.a1LeadId || data.leadId || data.id || lead.a1?.leadId || '',
      dedupeKey: crm.dedupeKey || lead.a1?.dedupeKey || `webstudio:${lead.id}`,
      lastSyncAt: new Date().toISOString(),
    },
  });
}

function paymentData(result) {
  const data = parsedToolData(result) || {};
  return {
    invoiceId: data.invoiceId || data.invoice_id || data.id || data.result?.invoiceId || '',
    paymentUrl: data.paymentUrl || data.payment_url || data.confirmationUrl || data.confirmation_url || data.url || data.result?.paymentUrl || '',
  };
}

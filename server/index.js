import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { Store } from './store.js';
import { Orchestrator } from './orchestrator.js';
import { answerCallback, getTelegramUpdates, getTelegramWebhookInfo, isAdminTelegramUser, sendTelegram, setTelegramCommands } from './services/telegram.js';
import { registerMcpRoutes } from './mcp.js';
import { registerAuth } from './auth.js';
import { handleA1Webhook } from './services/a1Webhook.js';
import { handleCustomerTelegramMessage, isCustomerTelegramCommand } from './services/customerTelegram.js';
import { handleAdminTelegramMessage } from './services/adminTelegram.js';
import { deployLeadExportedProject, deployLeadPublicUrlProject } from './services/projectPublisher.js';
import { listLovableTools, lovableOAuthTokenStatus, lovableOfficialConfigured, probeLovableAuth } from './services/lovableOfficialMcp.js';
import { customerBotLink } from './services/a1Client.js';

const app = express();
const store = new Store(config.DATA_DIR);
await store.load();
const orchestrator = new Orchestrator(store);

app.set('trust proxy', true);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'", 'https:', 'data:', 'blob:'],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https:', 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
        imgSrc: ["'self'", 'https:', 'data:', 'blob:'],
        connectSrc: ["'self'", 'https:', 'wss:'],
        frameSrc: ["'self'", 'https:'],
        fontSrc: ["'self'", 'https:', 'data:'],
        baseUri: ["'self'", 'https:'],
      },
    },
  }),
);
app.use(cors({ origin: config.WEB_ORIGIN, credentials: true }));
app.use(express.json({ limit: '15mb' }));
registerMcpRoutes(app, store);
registerAuth(app, store);
app.use('/renders', express.static(path.resolve(config.DATA_DIR, 'renders')));
app.use('/projects', express.static(path.resolve(config.DATA_DIR, 'projects')));

app.get('/privacy', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Политика конфиденциальности 1Lab Web Studio</title>
  <style>
    body{font-family:Arial,sans-serif;line-height:1.55;margin:0;color:#111827;background:#f8fafc}
    main{max-width:820px;margin:0 auto;padding:40px 20px}
    h1{font-size:28px;margin:0 0 16px}
    h2{font-size:18px;margin:28px 0 8px}
    p,li{font-size:15px}
    a{color:#0f766e}
  </style>
</head>
<body>
  <main>
    <h1>Политика конфиденциальности 1Lab Web Studio</h1>
    <p>Эта политика описывает, как 1Lab Web Studio обрабатывает данные, которые вы передаете через сайт, email и Telegram-бота.</p>
    <h2>Какие данные обрабатываются</h2>
    <p>Мы можем получать имя, название компании, телефон, email, Telegram ID/username, ответы на вопросы по сайту, материалы для сайта и историю обращений.</p>
    <h2>Для чего используются данные</h2>
    <p>Данные используются для подготовки технического задания, создания и доработки сайта, связи с вами, формирования счета/ссылки на оплату и сопровождения проекта.</p>
    <h2>Передача третьим лицам</h2>
    <p>Данные могут передаваться сервисам, необходимым для работы: CRM, платежному провайдеру, email/Telegram-инфраструктуре, сервисам генерации и размещения сайта. Мы не продаем ваши данные.</p>
    <h2>Срок хранения</h2>
    <p>Данные хранятся столько, сколько нужно для выполнения заявки, сопровождения сайта и исполнения обязательств по закону.</p>
    <h2>Отзыв согласия</h2>
    <p>Вы можете запросить удаление или уточнение данных, написав в Telegram-бот или на email студии.</p>
    <h2>Контакты</h2>
    <p>Оператор: 1Lab Web Studio. Сайт: <a href="${config.PUBLIC_BASE_URL}">${config.PUBLIC_BASE_URL}</a>.</p>
  </main>
</body>
</html>`);
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'web-studio-orchestrator',
    autonomyEnabled: config.AUTONOMY_ENABLED,
    integrations: {
      openai: Boolean(config.OPENAI_API_KEY),
      yandexMaps: Boolean(config.YANDEX_MAPS_API_KEY),
      googleMaps: Boolean(config.GOOGLE_MAPS_API_KEY),
      a1Api: Boolean(config.A1_API_URL),
      a1Mcp: Boolean(config.A1_MCP_URL),
      lovableMcp: Boolean(config.LOVABLE_MCP_URL),
      lovableOfficialMcp: lovableOfficialConfigured(),
      telegram: Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID),
      webAuth: Boolean(config.WEB_AUTH_LOGIN && config.WEB_AUTH_PASSWORD),
    },
    autonomy: {
      maxJobsPerTick: config.AUTONOMY_MAX_JOBS_PER_TICK,
      maxLovableJobsPerTick: config.AUTONOMY_MAX_LOVABLE_JOBS_PER_TICK,
      maxFilmerJobsPerTick: config.AUTONOMY_MAX_FILMER_JOBS_PER_TICK,
      jobLockMinutes: config.AUTONOMY_JOB_LOCK_MINUTES,
      deadAfterAttempts: config.AUTONOMY_DEAD_AFTER_ATTEMPTS,
      cron: config.AUTONOMY_CRON,
      dailyMockupLimit: config.DAILY_MOCKUP_LIMIT,
      lovableBuildIntervalHours: config.LOVABLE_BUILD_INTERVAL_HOURS,
      lovableHeartbeatCron: config.LOVABLE_TOKEN_HEARTBEAT_CRON,
    },
  });
});

app.get('/api/state', (req, res) => res.json({ ok: true, data: publicState() }));
app.get('/api/leads', (req, res) => res.json({ ok: true, data: publicLeads() }));

app.post('/api/leads', async (req, res) => {
  const lead = await store.upsertLead(req.body ?? {});
  res.status(201).json({ ok: true, data: lead });
});

app.post('/api/leads/:id/advance', async (req, res) => {
  const result = await orchestrator.advanceLead(req.params.id);
  res.status(result.ok ? 200 : 409).json(result);
});

app.get('/api/leads/:id/lovable/open', async (req, res) => {
  const lead = store.getLead(req.params.id);
  const url = lead?.mockup?.buildUrl;
  if (!lead || !url) return res.status(404).send('Lovable build URL not found');
  const openedAt = new Date().toISOString();
  await store.updateLead(lead.id, {
    mockup: {
      ...(lead.mockup ?? {}),
      buildOpenedAt: openedAt,
      buildOpenCount: Number(lead.mockup?.buildOpenCount ?? 0) + 1,
    },
  });
  await store.addEvent(lead.id, 'lovable.build_opened', `Lovable build URL opened manually at ${openedAt}`);
  res.redirect(302, url);
});

app.post('/api/leads/:id/coder/deploy', async (req, res) => {
  const lead = store.getLead(req.params.id);
  const result =
    lead?.mockup?.status === 'export_ready' || req.body?.mode === 'export'
      ? await deployLeadExportedProject(store, req.params.id, {
          files: req.body?.files || lead?.mockup?.files || [],
          lovable: req.body?.lovable || {
            projectId: lead?.mockup?.projectId || '',
            editorUrl: lead?.mockup?.editorUrl || '',
            previewUrl: lead?.mockup?.previewUrl || '',
            publishedUrl: lead?.mockup?.publishedUrl || lead?.mockup?.url || '',
            latestRef: lead?.mockup?.latestRef || '',
          },
          projectName: req.body?.projectName || lead?.mockup?.projectName || lead?.name,
        })
      : await deployLeadPublicUrlProject(store, req.params.id, {
          url: req.body?.url,
          projectName: req.body?.projectName,
        });
  res.status(result.ok ? 200 : 409).json(result);
});

app.post('/api/orchestrator/scout', async (req, res) => {
  const result = await orchestrator.scout();
  res.status(result.ok || result.skipped ? 200 : 500).json(result);
});

app.post('/api/orchestrator/tick', async (req, res) => {
  const result = await runAutonomyTick('api');
  res.json(result);
});

app.post('/api/orchestrator/advance-lane', async (req, res) => {
  const result = await orchestrator.advanceLane(req.body?.lane ?? 'Разведка', req.body?.limit ?? 50);
  res.status(result.ok ? 200 : 500).json(result);
});

app.get('/api/events', (req, res) => res.json({ ok: true, data: store.listEvents(req.query.leadId) }));
app.get('/api/approvals', (req, res) => res.json({ ok: true, data: store.listApprovals() }));
app.get('/api/outreach-queue', (req, res) => res.json({ ok: true, data: store.listOutreachQueue().map(publicOutreachItem) }));
app.get('/api/jobs', (req, res) =>
  res.json({
    ok: true,
    data: store.listJobs({ status: req.query.status, type: req.query.type, leadId: req.query.leadId }).map(publicJob),
  }),
);
app.get('/api/orchestrator/runs', (req, res) => res.json({ ok: true, data: store.listOrchestratorRuns(Number(req.query.limit ?? 50)) }));
app.get('/api/orchestrator/top-actions', (req, res) => {
  res.json({ ok: true, data: orchestrator.topActions(Number(req.query.limit ?? 12)) });
});

app.get('/api/lovable/tools', async (req, res) => {
  const result = await listLovableTools();
  res.status(result.ok || result.skipped ? 200 : 502).json(result);
});

app.get('/oauth/lovable-client-metadata.json', (req, res) => {
  const redirectUri = req.query.redirect_uri || 'http://127.0.0.1:8789/oauth/callback';
  res.json({
    client_name: 'Web Studio Lovable OAuth',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'offline projects:create projects:read projects:write workspaces:read workspaces:write',
  });
});

app.post('/api/a1/webhook', async (req, res) => {
  if (config.A1_WEBHOOK_SECRET) {
    const got = req.header('x-a1-webhook-secret');
    if (got !== config.A1_WEBHOOK_SECRET) return res.status(401).json({ ok: false, error: 'Unauthorized A1 webhook' });
  }
  const result = await handleA1Webhook(store, req.body ?? {}, req.header('x-idempotency-key') || '');
  res.status(result.status || 200).json(result);
});

app.post('/api/approvals/:id/:decision', async (req, res) => {
  const approval = await store.resolveApproval(req.params.id, req.params.decision, req.body?.actor ?? 'api');
  if (!approval) return res.status(404).json({ ok: false, error: 'Approval not found' });
  const lead = await store.updateLead(approval.leadId, {
    status: req.params.decision === 'approved' ? 'in_progress' : 'paused',
  });
  res.json({ ok: true, data: { approval, lead } });
});

async function processTelegramUpdate(update) {
  const callback = update?.callback_query;
  if (callback || update?.message) {
    const source = callback ? callback.from : update.message.from;
    const chat = callback?.message?.chat || update.message.chat;
    console.log('Telegram update received', {
      updateId: update?.update_id,
      userId: source?.id,
      chatId: chat?.id,
      text: update?.message?.text || callback?.data || '',
      isAdmin: isAdminTelegramUser(source?.id, chat?.id),
    });
  }
  const data = callback?.data || '';
  const match = data.match(/^approval:([^:]+):(approved|rejected|pause_niche)$/);
  if (match) {
    if (!isAdminTelegramUser(callback.from?.id, callback.message?.chat?.id)) {
      await answerCallback(callback.id, 'Недостаточно прав');
      return { ok: true };
    }
    const [, approvalId, decision] = match;
    const approval = await store.resolveApproval(approvalId, decision, `telegram:${callback.from?.id ?? 'unknown'}`);
    if (approval) {
      await store.updateLead(approval.leadId, { status: decision === 'approved' ? 'in_progress' : 'paused' });
    }
    await answerCallback(callback.id, decision === 'approved' ? 'Одобрено' : 'Поставлено на паузу');
  }
  if (update?.message) {
    const message = update.message;
    if (isCustomerTelegramCommand(store, message)) {
      await handleCustomerTelegramMessage(store, message).catch((error) => handleTelegramCustomerError(message, error));
      return { ok: true };
    }
    if (isAdminTelegramUser(message.from?.id, message.chat?.id)) {
      const handled = await handleAdminTelegramMessage(store, orchestrator, message);
      if (!handled.skipped) return { ok: true };
    }
    await handleCustomerTelegramMessage(store, message).catch((error) => handleTelegramCustomerError(message, error));
  }
  return { ok: true };
}

async function handleTelegramCustomerError(message, error) {
  console.error('Customer Telegram handling failed', error);
  const chatId = message?.chat?.id;
  if (chatId) {
    const { sendTelegramTo, sendTelegram } = await import('./services/telegram.js');
    await sendTelegramTo(chatId, 'Произошла техническая ошибка. Я уже передал ее администратору, вернемся с ответом.');
    await sendTelegram(
      [
        '<b>Ошибка customer Telegram</b>',
        `Chat: <code>${String(chatId)}</code>`,
        `Text: <code>${String(message?.text || message?.voice?.file_id || '').slice(0, 200)}</code>`,
        `Error: <code>${String(error?.message || error).slice(0, 300)}</code>`,
      ].join('\n'),
    );
  }
}

app.post('/api/telegram/webhook', async (req, res) => {
  if (config.TELEGRAM_WEBHOOK_SECRET) {
    const got = req.header('x-telegram-bot-api-secret-token');
    if (got !== config.TELEGRAM_WEBHOOK_SECRET) return res.status(401).json({ ok: false });
  }

  await processTelegramUpdate(req.body);
  res.json({ ok: true });
});

if (config.NODE_ENV === 'production') {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const distDir = path.join(root, 'dist');
  app.use(express.static(distDir));
  app.get(/^(?!\/api|\/mcp).*/, (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

let autonomyTickRunning = false;
async function runAutonomyTick(reason = 'cron') {
  if (autonomyTickRunning) {
    console.warn('Autonomy tick skipped because previous tick is still running', { reason });
    return { ok: false, skipped: true, reason: 'previous_tick_running' };
  }
  autonomyTickRunning = true;
  const startedAt = Date.now();
  try {
    const result = await orchestrator.tick();
    console.log('Autonomy tick finished', {
      reason,
      durationMs: Date.now() - startedAt,
      scoutOk: result.scout?.ok,
      scoutSkipped: result.scout?.skipped,
      advanced: result.advanced?.length || 0,
    });
    return result;
  } finally {
    autonomyTickRunning = false;
  }
}

if (config.AUTONOMY_ENABLED) {
  cron.schedule(config.AUTONOMY_CRON, async () => {
    try {
      await runAutonomyTick('cron');
    } catch (error) {
      console.error('Autonomy tick failed', error);
    }
  });
}

async function lovableTokenHeartbeat() {
  if (!lovableOfficialConfigured()) return;
  const tokenStatus = await lovableOAuthTokenStatus();
  if (tokenStatus.ok && !tokenStatus.hasRefreshToken && !config.LOVABLE_API_KEY) {
    console.error('Lovable token heartbeat failed: OAuth token has no refresh_token', tokenStatus);
    await sendTelegram(
      [
        '<b>Lovable OAuth без refresh_token</b>',
        'Текущий токен нельзя продлить автоматически.',
        'Нужна повторная OAuth-авторизация с offline scope, иначе Builder отвалится после истечения access token.',
      ].join('\n'),
    );
    return;
  }
  const result = await probeLovableAuth();
  if (result.ok) {
    console.log('Lovable token heartbeat ok', { email: result.email, workspaceCount: result.workspaceCount });
  } else {
    console.error('Lovable token heartbeat failed', result.reason || result.error || result);
    await sendTelegram(
      [
        '<b>Lovable OAuth требует внимания</b>',
        'Heartbeat не смог проверить авторизацию Lovable MCP.',
        `Причина: <code>${String(result.reason || result.error || 'unknown').slice(0, 500)}</code>`,
        'Нужна повторная OAuth-авторизация, иначе Builder не сможет создавать проекты в Lovable.',
      ].join('\n'),
    );
  }
}

if (config.LOVABLE_TOKEN_HEARTBEAT_ENABLED) {
  cron.schedule(config.LOVABLE_TOKEN_HEARTBEAT_CRON, () => {
    lovableTokenHeartbeat().catch((error) => console.error('Lovable token heartbeat crashed', error));
  });
  setTimeout(() => {
    lovableTokenHeartbeat().catch((error) => console.error('Lovable token startup heartbeat crashed', error));
  }, 15000);
}

function publicState() {
  return {
    metrics: store.state.metrics ?? {},
    locks: store.state.locks ?? {},
    integrationInbox: store.state.integrationInbox ?? [],
    processedA1EventsCount: Object.keys(store.state.processedA1Events ?? {}).length,
    jobsCount: store.state.jobs?.length ?? 0,
    orchestratorRunsCount: store.state.orchestratorRuns?.length ?? 0,
    leads: publicLeads(),
  };
}

function publicLeads() {
  return store.listLeads().map(publicLead);
}

function publicLead(lead) {
  return {
    ...lead,
    mockup: publicMockup(lead.mockup),
    a1Crm: lead.a1Crm ? publicA1Result(lead.a1Crm) : undefined,
    pitch: lead.pitch ? { ...lead.pitch, a1Outbound: lead.pitch.a1Outbound ? publicA1Result(lead.pitch.a1Outbound) : undefined } : undefined,
    customerBotLink: customerBotLink(lead),
  };
}

function publicMockup(mockup = {}) {
  if (!mockup || typeof mockup !== 'object') return mockup;
  const {
    files,
    raw,
    create,
    project,
    content,
    html,
    source,
    ...rest
  } = mockup;
  return {
    ...rest,
    filesCount: Array.isArray(files) ? files.length : Number(mockup.filesCount ?? 0) || 0,
  };
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    leadId: job.leadId,
    status: job.status,
    priority: job.priority,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    nextRunAt: job.nextRunAt,
    lockedUntil: job.lockedUntil,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastError: job.lastError,
    payload: job.payload,
    idempotencyKey: job.idempotencyKey,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result ? publicJobResult(job.result) : undefined,
  };
}

function publicJobResult(result = {}) {
  return {
    ok: result.ok,
    skipped: result.skipped,
    reason: result.reason,
    error: result.error,
    status: result.status,
    publicUrl: result.publicUrl,
    slug: result.slug,
    quality: result.quality,
    video: result.video,
    lead: result.lead
      ? {
          id: result.lead.id,
          name: result.lead.name,
          pipelineStage: result.lead.pipelineStage,
          status: result.lead.status,
          mockup: publicMockup(result.lead.mockup),
        }
      : undefined,
  };
}

function publicOutreachItem(item = {}) {
  return {
    ...item,
    a1Outbound: item.a1Outbound ? publicA1Result(item.a1Outbound) : undefined,
  };
}

function publicA1Result(result = {}) {
  return {
    ok: result.ok,
    skipped: result.skipped,
    reason: result.reason,
    error: result.error,
    status: result.status,
    method: result.method,
    a1LeadId: result.a1LeadId,
    stage: result.stage,
  };
}

app.listen(config.PORT, config.HOST, () => {
  console.log(`Web Studio API listening on http://${config.HOST}:${config.PORT}`);
});

setTelegramCommands()
  .then((result) => {
    if (!result.skipped) console.log('Telegram bot commands configured', { ok: result.ok });
  })
  .catch((error) => console.error('Telegram command setup failed', error));

let telegramPollingOffset = 0;
async function pollTelegramUpdates() {
  const result = await getTelegramUpdates(telegramPollingOffset);
  if (!result.ok) {
    console.error('Telegram polling failed', result.error || result.status);
    return;
  }
  const updates = Array.isArray(result.data?.result) ? result.data.result : [];
  for (const update of updates) {
    telegramPollingOffset = Math.max(telegramPollingOffset, Number(update.update_id || 0) + 1);
    await processTelegramUpdate(update).catch((error) => console.error('Telegram update handling failed', error));
  }
}

getTelegramWebhookInfo()
  .then(async (result) => {
    const hasWebhook = Boolean(result.data?.result?.url);
    if (result.ok && !hasWebhook) {
      console.log('Telegram webhook is not configured; starting getUpdates polling fallback');
      await pollTelegramUpdates();
      setInterval(() => {
        pollTelegramUpdates().catch((error) => console.error('Telegram polling loop failed', error));
      }, 5000);
    }
  })
  .catch((error) => console.error('Telegram webhook info check failed', error));

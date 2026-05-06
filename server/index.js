import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { Store } from './store.js';
import { Orchestrator } from './orchestrator.js';
import { answerCallback, getTelegramUpdates, getTelegramWebhookInfo, isAdminTelegramUser, setTelegramCommands } from './services/telegram.js';
import { registerMcpRoutes } from './mcp.js';
import { registerAuth } from './auth.js';
import { handleA1Webhook } from './services/a1Webhook.js';
import { handleCustomerTelegramMessage } from './services/customerTelegram.js';
import { handleAdminTelegramMessage } from './services/adminTelegram.js';
import { deployLeadPublicUrlProject } from './services/projectPublisher.js';
import { listLovableTools, lovableOfficialConfigured } from './services/lovableOfficialMcp.js';

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
  });
});

app.get('/api/state', (req, res) => res.json({ ok: true, data: store.state }));
app.get('/api/leads', (req, res) => res.json({ ok: true, data: store.listLeads() }));

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
  const result = await deployLeadPublicUrlProject(store, req.params.id, {
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
  const result = await orchestrator.tick();
  res.json(result);
});

app.post('/api/orchestrator/advance-lane', async (req, res) => {
  const result = await orchestrator.advanceLane(req.body?.lane ?? 'Разведка', req.body?.limit ?? 50);
  res.status(result.ok ? 200 : 500).json(result);
});

app.get('/api/events', (req, res) => res.json({ ok: true, data: store.listEvents(req.query.leadId) }));
app.get('/api/approvals', (req, res) => res.json({ ok: true, data: store.listApprovals() }));
app.get('/api/outreach-queue', (req, res) => res.json({ ok: true, data: store.listOutreachQueue() }));
app.get('/api/orchestrator/top-actions', (req, res) => {
  res.json({ ok: true, data: orchestrator.topActions(Number(req.query.limit ?? 12)) });
});

app.get('/api/lovable/tools', async (req, res) => {
  const result = await listLovableTools();
  res.status(result.ok || result.skipped ? 200 : 502).json(result);
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
    if (isAdminTelegramUser(message.from?.id, message.chat?.id)) {
      const handled = await handleAdminTelegramMessage(store, orchestrator, message);
      if (!handled.skipped) return { ok: true };
    }
    await handleCustomerTelegramMessage(store, message);
  }
  return { ok: true };
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

if (config.AUTONOMY_ENABLED) {
  cron.schedule(config.AUTONOMY_CRON, async () => {
    try {
      await orchestrator.tick();
    } catch (error) {
      console.error('Autonomy tick failed', error);
    }
  });
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

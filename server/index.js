import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { Store } from './store.js';
import { Orchestrator } from './orchestrator.js';
import { answerCallback } from './services/telegram.js';
import { registerMcpRoutes } from './mcp.js';
import { registerAuth } from './auth.js';

const app = express();
const store = new Store(config.DATA_DIR);
await store.load();
const orchestrator = new Orchestrator(store);

app.set('trust proxy', true);
app.use(helmet());
app.use(cors({ origin: config.WEB_ORIGIN, credentials: true }));
app.use(express.json({ limit: '2mb' }));
registerMcpRoutes(app, store);
registerAuth(app, store);

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

app.post('/api/approvals/:id/:decision', async (req, res) => {
  const approval = await store.resolveApproval(req.params.id, req.params.decision, req.body?.actor ?? 'api');
  if (!approval) return res.status(404).json({ ok: false, error: 'Approval not found' });
  const lead = await store.updateLead(approval.leadId, {
    status: req.params.decision === 'approved' ? 'in_progress' : 'paused',
  });
  res.json({ ok: true, data: { approval, lead } });
});

app.post('/api/telegram/webhook', async (req, res) => {
  if (config.TELEGRAM_WEBHOOK_SECRET) {
    const got = req.header('x-telegram-bot-api-secret-token');
    if (got !== config.TELEGRAM_WEBHOOK_SECRET) return res.status(401).json({ ok: false });
  }

  const callback = req.body?.callback_query;
  const data = callback?.data || '';
  const match = data.match(/^approval:([^:]+):(approved|rejected|pause_niche)$/);
  if (match) {
    const [, approvalId, decision] = match;
    const approval = await store.resolveApproval(approvalId, decision, `telegram:${callback.from?.id ?? 'unknown'}`);
    if (approval) {
      await store.updateLead(approval.leadId, { status: decision === 'approved' ? 'in_progress' : 'paused' });
    }
    await answerCallback(callback.id, decision === 'approved' ? 'Одобрено' : 'Поставлено на паузу');
  }
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

import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { config, hasSecret } from './config.js';
import { calculateFitScore } from './services/scoring.js';
import { renderLeadVideo } from './services/filmer.js';
import { sendTelegram } from './services/telegram.js';

function mcpText(data) {
  return {
    content: [
      {
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function requireMcpAuth(req, res) {
  if (!hasSecret(config.WEB_STUDIO_MCP_TOKEN)) return true;
  const auth = req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : req.header('x-web-studio-mcp-token');
  if (token === config.WEB_STUDIO_MCP_TOKEN) return true;
  res.status(401).json({ error: 'Unauthorized MCP request' });
  return false;
}

function landingBrief(lead) {
  return {
    leadId: lead.id,
    business: {
      name: lead.name,
      city: lead.city,
      niche: lead.niche,
      rating: lead.rating,
      reviews: lead.reviews,
      yearsOnMap: lead.years,
      currentSite: lead.site,
      address: lead.address,
      phone: lead.phone,
    },
    strategy: {
      diagnosis: lead.diagnosis,
      heroAngle: lead.angle,
      tone: lead.tone,
      coldMessage: lead.message,
    },
    pageRequirements: [
      'Russian language landing page for a local business.',
      'No marketing filler or generic SaaS sections.',
      'First viewport: clear offer, trust from Yandex Maps, fast contact action.',
      'Sections: proof/reviews, services, before-after or portfolio, process, price/request form, contacts.',
      'Mobile-first, fast, easy to edit in Lovable.',
    ],
    boundaries: {
      source: 'Yandex Maps',
      owner: lead.owner,
      noDuplicateAgentTouch: true,
      humanApprovalAboveRub: config.DEAL_APPROVAL_RUB,
      pauseNicheBelowReplyRate: config.MIN_REPLY_RATE,
    },
  };
}

function landingPrompt(lead) {
  const brief = landingBrief(lead);
  return [
    `Build a Lovable landing page for Russian local business "${lead.name}".`,
    `City: ${lead.city}. Niche: ${lead.niche}.`,
    `Hero angle: ${lead.angle || 'show trust and generate a direct lead request'}.`,
    `Diagnosis: ${lead.diagnosis || 'The Yandex Maps card is stronger than the current web presence.'}`,
    `Tone: ${lead.tone || 'specific, calm, practical'}.`,
    '',
    'Requirements:',
    ...brief.pageRequirements.map((item) => `- ${item}`),
    '',
    'Use real Russian UI copy. Keep the design practical for this exact industry.',
    '',
    'After the landing page is created, use the connected Web Studio Orchestrator MCP tool attach_lovable_url.',
    `Call attach_lovable_url with leadId "${lead.id}", the current Lovable project or preview URL, and short notes.`,
    'This write-back is required so the orchestrator can move the lead from Lovable to Video.',
  ].join('\n');
}

export function registerMcpRoutes(app, store) {
  const transports = {};

  const getServer = () => {
    const server = new McpServer({
      name: 'web-studio-orchestrator',
      version: '0.2.0',
      websiteUrl: config.PUBLIC_BASE_URL,
    });

    server.registerTool(
      'list_top_leads',
      {
        title: 'List top leads',
        description: 'Read-only list of top leads ready for Lovable mockups.',
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: {
          limit: z.number().int().min(1).max(20).default(5),
          city: z.string().optional(),
          niche: z.string().optional(),
        },
      },
      async ({ limit, city, niche }) => {
        const leads = store
          .listLeads()
          .filter((lead) => !city || lead.city === city)
          .filter((lead) => !niche || lead.niche === niche)
          .filter((lead) => ['Диагноз', 'Lovable'].includes(lead.lane))
          .sort((a, b) => calculateFitScore(b) - calculateFitScore(a))
          .slice(0, limit)
          .map((lead) => ({
            id: lead.id,
            name: lead.name,
            city: lead.city,
            niche: lead.niche,
            priority: lead.priority,
            fitScore: lead.fitScore ?? calculateFitScore(lead),
            lane: lead.lane,
            owner: lead.owner,
            rating: lead.rating,
            reviews: lead.reviews,
            site: lead.site,
          }));
        return mcpText({ leads });
      },
    );

    server.registerTool(
      'get_landing_brief',
      {
        title: 'Get landing brief',
        description: 'Return a complete landing page brief for one lead.',
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: { leadId: z.string() },
      },
      async ({ leadId }) => {
        const lead = store.getLead(leadId);
        if (!lead) return mcpText({ error: 'Lead not found' });
        return mcpText(landingBrief(lead));
      },
    );

    server.registerTool(
      'get_lovable_prompt',
      {
        title: 'Get Lovable prompt',
        description: 'Return a ready-to-paste Lovable prompt for a selected lead.',
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: { leadId: z.string() },
      },
      async ({ leadId }) => {
        const lead = store.getLead(leadId);
        if (!lead) return mcpText({ error: 'Lead not found' });
        return mcpText({ leadId, prompt: landingPrompt(lead) });
      },
    );

    server.registerTool(
      'attach_lovable_url',
      {
        title: 'Attach Lovable URL',
        description: 'Write the Lovable project or preview URL back to the orchestrator.',
        inputSchema: {
          leadId: z.string(),
          url: z.string().url(),
          notes: z.string().optional(),
        },
      },
      async ({ leadId, url, notes }) => {
        let lead = await store.updateLead(leadId, {
          mockup: { ok: true, mode: 'lovable_mcp_connector', url, notes: notes || '', updatedAt: new Date().toISOString() },
          lane: 'Видео',
          owner: 'Filmer',
        });
        if (!lead) return mcpText({ error: 'Lead not found' });
        await store.addEvent(leadId, 'lovable.url.attached', `Lovable URL attached: ${url}`);
        const video = await renderLeadVideo(lead);
        if (!video.ok) {
          lead = await store.updateLead(leadId, { video, status: 'needs_review' });
          await store.addEvent(leadId, 'video.failed', `Filmer не смог собрать видео: ${video.reason}`);
          await sendTelegram(
            [
              '<b>Filmer требует решения</b>',
              `${lead.name} · ${lead.city} · ${lead.niche}`,
              `Ошибка: ${video.reason}`,
              `Lovable URL: ${url}`,
              'Лид оставлен в Видео со статусом needs_review.',
            ].join('\n'),
          );
          return mcpText({ ok: false, lead, video });
        }
        lead = await store.updateLead(leadId, { video, lane: 'Проверка', owner: 'Checker', status: 'in_progress' });
        await store.addEvent(leadId, 'video.created', `Filmer собрал видео: ${video.videoUrl}`);
        await store.addEvent(leadId, 'lead.advanced', 'Лид передан агенту Checker');
        return mcpText({ ok: true, lead });
      },
    );

    return server;
  };

  const postHandler = async (req, res) => {
    if (!requireMcpAuth(req, res)) return;
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports[newSessionId] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      const server = getServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid MCP session ID' },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  };

  const sessionHandler = async (req, res) => {
    if (!requireMcpAuth(req, res)) return;
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing MCP session ID');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  app.post('/mcp', postHandler);
  app.get('/mcp', sessionHandler);
  app.delete('/mcp', sessionHandler);
}

export { landingPrompt, landingBrief };

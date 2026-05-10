import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { config, hasSecret } from './config.js';
import { calculateFitScore } from './services/scoring.js';
import { renderLeadVideo } from './services/filmer.js';
import { crmAddEvent, syncA1CrmLead } from './services/a1Client.js';
import { projectSlug } from './services/projectPublisher.js';
import { loadNicheConfig } from './services/niches.js';
import { analyzeLeadSite, summarizeSiteAnalysisForPrompt } from './services/siteAnalyzer.js';

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

function safeProjectPath(root, filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0') || normalized.split('/').some((part) => part === '..')) return null;
  const target = path.resolve(root, normalized);
  if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) return null;
  return target;
}

function requireMcpAuth(req, res) {
  if (!hasSecret(config.WEB_STUDIO_MCP_TOKEN)) return true;
  const auth = req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : req.header('x-web-studio-mcp-token');
  if (token === config.WEB_STUDIO_MCP_TOKEN) return true;
  res.status(401).json({ error: 'Unauthorized MCP request' });
  return false;
}

async function landingBrief(lead) {
  const niche = await loadNicheConfig(lead);
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
      heroAngle: lead.angle || niche.heroAngle,
      tone: lead.tone,
      coldMessage: lead.message,
    },
    nicheConfig: {
      slug: niche.slug,
      label: niche.label,
      heroAngle: niche.heroAngle,
      sections: niche.sections,
      ctaPrimary: niche.ctaPrimary,
      ctaSecondary: niche.ctaSecondary,
      trustSignals: niche.trustSignals,
      palette: niche.palette,
      typography: niche.typography,
      imageHints: niche.imageHints,
    },
    pageRequirements: [
      'Russian language landing page for a local business.',
      'No marketing filler or generic SaaS sections.',
      'First viewport: clear offer, trust from Yandex Maps, fast contact action.',
      'First viewport must include a relevant hero image or media block for this exact business; do not use a plain text-only hero.',
      'Use several distinct contextual images across the page; never repeat the same image for multiple sections.',
      'Add one lightweight inline SVG animation or animated process visual that makes the preview feel custom, without decorative gradient blobs.',
      'If an address is provided, use that exact address only; never invent another city, street, rating, review count, or map location.',
      'If adding Yandex Maps, embed a concrete point/address widget, not a generic maps link.',
      `Use the niche-specific section list from nicheConfig.sections (in order): ${niche.sections.join(' | ')}.`,
      `Use niche palette as guidance: background ${niche.palette?.background || 'нейтральный'}, primary ${niche.palette?.primary || 'основной'}, accent ${niche.palette?.accent || 'дополнительный'}; do not produce a generic dark SaaS page if the niche calls for warm/light tones.`,
      `Typography mood: ${niche.typography?.mood || 'практичный'}; use ${niche.typography?.headlineFont || 'Manrope'} for headlines and ${niche.typography?.bodyFont || 'Inter'} for body.`,
      `Primary CTA copy: "${niche.ctaPrimary}". Secondary CTA copy: "${niche.ctaSecondary}".`,
      `Trust signals to include where natural: ${niche.trustSignals.join(', ')}.`,
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

export async function landingPrompt(lead) {
  const niche = await loadNicheConfig(lead);
  const brief = await landingBrief(lead);
  const customerBrief = lead.customerBrief || {};
  const revision = lead.revision?.text ? `Customer revision request: ${lead.revision.text}` : '';
  const siteAnalysis = lead.siteAnalysis?.ok
    ? lead.siteAnalysis
    : (lead?.url ? await analyzeLeadSite(lead).catch(() => null) : null);
  const siteSummary = summarizeSiteAnalysisForPrompt(siteAnalysis);
  return [
    `Build a Lovable landing page for Russian local business "${lead.name}".`,
    `City: ${lead.city}. Niche: ${lead.niche} (resolved profile: ${niche.label}).`,
    `Hero angle: ${lead.angle || niche.heroAngle}.`,
    `Diagnosis: ${lead.diagnosis || 'The Yandex Maps card is stronger than the current web presence.'}`,
    `Tone: ${lead.tone || niche.typography?.mood || 'specific, calm, practical'}.`,
    '',
    `Niche profile JSON: ${JSON.stringify({
      slug: niche.slug,
      label: niche.label,
      palette: niche.palette,
      typography: niche.typography,
      heroAngle: niche.heroAngle,
      sections: niche.sections,
      ctaPrimary: niche.ctaPrimary,
      ctaSecondary: niche.ctaSecondary,
      trustSignals: niche.trustSignals,
      imageHints: niche.imageHints,
    })}`,
    '',
    siteSummary
      ? [
          'Existing client website analysis (use real services/headlines/contacts from here, do NOT invent fake competitors or unrelated examples):',
          siteSummary,
          'Reuse the actual service names, addresses and phone numbers from the analysis where they exist. Replace what looks weak/outdated with the niche-specific structure above.',
        ].join('\n')
      : '',
    '',
    'Requirements:',
    ...brief.pageRequirements.map((item) => `- ${item}`),
    '',
    'Use real Russian UI copy. Keep the design practical for this exact industry — do not produce a generic dark SaaS landing.',
    Object.keys(customerBrief).length ? `Customer brief JSON: ${JSON.stringify(customerBrief)}` : '',
    revision,
    lead.mockup?.publicUrl ? `Existing Web Studio preview URL: ${lead.mockup.publicUrl}` : '',
    '',
    'After the landing page is created, hand the result back to Web Studio through MCP.',
    'Preferred: call attach_lovable_url with a public preview or published URL.',
    `Call attach_lovable_url with leadId "${lead.id}", url or publishedUrl, projectName, and short notes.`,
    'Web Studio Coder will deploy that public URL under /projects/<slug>, then Filmer will create screenshots/video from our domain.',
    'If a real public GitHub repository is available, attach_lovable_repo is also supported, but do not use Lovable internal code storage URLs.',
  ].filter(Boolean).join('\n');
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
        let lead = store.getLead(leadId);
        if (!lead) return mcpText({ error: 'Lead not found' });
        return mcpText(await landingBrief(lead));
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
        let lead = store.getLead(leadId);
        if (!lead) return mcpText({ error: 'Lead not found' });
        return mcpText({ leadId, prompt: await landingPrompt(lead) });
      },
    );

    server.registerTool(
      'get_lovable_handoff_request',
      {
        title: 'Get Lovable handoff request',
        description: 'Return a handoff-only prompt for an existing Lovable project that must send URL or files back to Web Studio.',
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: { leadId: z.string() },
      },
      async ({ leadId }) => {
        let lead = store.getLead(leadId);
        if (!lead) return mcpText({ error: 'Lead not found' });
        return mcpText({
          leadId,
          prompt: [
            `The landing page for Web Studio lead "${lead.name}" has already been created in this Lovable project.`,
            'Do not rebuild from scratch and do not resend the original generation prompt.',
            'Please hand the result back to Web Studio now.',
            '',
            'Preferred: call Web Studio Orchestrator MCP tool attach_lovable_url with a public preview or published URL.',
            `Call attach_lovable_url with leadId "${lead.id}", url or publishedUrl, projectName, and short notes.`,
            '',
            'If a real public GitHub repository is available, call attach_lovable_repo. Do not pass lovable.code.storage internal remotes.',
            `Call attach_lovable_repo with leadId "${lead.id}", githubUrl, repoName if available, branch, and short notes.`,
            '',
            'If this project can export files, call deploy_static_project instead with leadId, projectName, and all static files.',
            'Web Studio will deploy it under /projects/<slug>, then make screenshots/video and continue the pipeline.',
          ].join('\n'),
        });
      },
    );

    server.registerTool(
      'attach_lovable_repo',
      {
        title: 'Attach Lovable GitHub repo',
        description: 'Write the GitHub repository created by Lovable back to the orchestrator. This does not require a published site URL.',
        inputSchema: {
          leadId: z.string(),
          githubUrl: z.string().url(),
          repoName: z.string().optional(),
          branch: z.string().optional(),
          projectName: z.string().optional(),
          notes: z.string().optional(),
        },
      },
      async ({ leadId, githubUrl, repoName, branch, projectName, notes }) => {
        let lead = await store.updateLead(leadId, {
          mockup: {
            ...(store.getLead(leadId)?.mockup ?? {}),
            ok: true,
            mode: 'lovable_github_repo',
            status: 'github_repo_attached',
            githubUrl,
            repoName: repoName || '',
            branch: branch || 'main',
            projectName: projectName || repoName || '',
            notes: notes || '',
            handoffStatus: 'repo_received',
            updatedAt: new Date().toISOString(),
          },
          owner: 'Coder',
          status: 'repo_attached',
        });
        if (!lead) return mcpText({ error: 'Lead not found' });
        await store.addEvent(leadId, 'lovable.repo.attached', `Lovable GitHub repo attached: ${githubUrl}`);
        await crmAddEvent({
          entityType: lead.a1DealId ? 'deal' : 'lead',
          entityId: lead.a1DealId || lead.a1LeadId || lead.id,
          eventType: 'lovable.repo.attached',
          text: `Lovable GitHub repo attached: ${githubUrl}`,
          payload: { webstudioLeadId: lead.id, githubUrl, repoName, branch, projectName },
          idempotencyKey: `webstudio:${lead.id}:lovable.repo.attached:${githubUrl}`,
        });
        await syncA1CrmLead(lead, 'lovable_repo_attached');
        return mcpText({ ok: true, lead, nextAction: 'Deploy this GitHub repo to Web Studio projects, then run Filmer.' });
      },
    );

    server.registerTool(
      'deploy_static_project',
      {
        title: 'Deploy static project',
        description: 'Deploy built static landing page files under webstudio.1true.ru/projects/<slug>.',
        inputSchema: {
          leadId: z.string(),
          projectName: z.string().min(1).max(120),
          files: z.array(
            z.object({
              path: z.string().min(1).max(300),
              content: z.string(),
            }),
          ).min(1).max(80),
          notes: z.string().optional(),
        },
      },
      async ({ leadId, projectName, files, notes }) => {
        let lead = store.getLead(leadId);
        if (!lead) return mcpText({ error: 'Lead not found' });
        const slug = projectSlug(projectName || lead.name);
        const root = path.resolve(config.DATA_DIR, 'projects', slug);
        await fs.mkdir(root, { recursive: true });
        const written = [];
        for (const file of files) {
          const target = safeProjectPath(root, file.path);
          if (!target) return mcpText({ error: `Unsafe file path: ${file.path}` });
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, file.content, 'utf8');
          written.push(file.path);
        }
        const publicUrl = `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/projects/${slug}/`;
        lead = await store.updateLead(leadId, {
          mockup: {
            ...(lead.mockup ?? {}),
            ok: true,
            mode: 'lovable_mcp_static_deploy',
            projectName,
            projectSlug: slug,
            publishedUrl: publicUrl,
            notes: notes || lead.mockup?.notes || '',
            updatedAt: new Date().toISOString(),
          },
          lane: 'Видео',
          owner: 'Filmer',
          status: 'in_progress',
        });
        await store.addEvent(leadId, 'project.deployed', `Static project deployed: ${publicUrl}`);
        await crmAddEvent({
          entityType: lead.a1DealId ? 'deal' : 'lead',
          entityId: lead.a1DealId || lead.a1LeadId || lead.id,
          eventType: 'project.deployed',
          text: `Static project deployed: ${publicUrl}`,
          payload: { webstudioLeadId: lead.id, publicUrl, slug, files: written },
          idempotencyKey: `webstudio:${lead.id}:project.deployed:${slug}`,
        });
        const video = await renderLeadVideo(lead);
        if (!video.ok) {
          lead = await store.updateLead(leadId, { video, status: 'needs_review' });
          await store.addEvent(leadId, 'video.failed', `Filmer could not render deployed project: ${video.reason}`);
          return mcpText({ ok: false, publicUrl, slug, files: written, lead, video });
        }
        lead = await store.updateLead(leadId, { video, lane: 'Проверка', owner: 'Checker', status: 'in_progress' });
        await store.addEvent(leadId, 'video.created', `Filmer rendered deployed project: ${video.videoUrl}`);
        await store.addEvent(leadId, 'lead.advanced', 'Lead moved to Checker after static project deploy');
        await syncA1CrmLead(lead, 'project_deployed');
        return mcpText({ ok: true, publicUrl, slug, files: written, lead });
      },
    );

    server.registerTool(
      'attach_lovable_url',
      {
        title: 'Attach Lovable URL',
        description: 'Write the Lovable project or preview URL back to the orchestrator.',
        inputSchema: {
          leadId: z.string(),
          url: z.string().url().optional(),
          projectName: z.string().optional(),
          publishedUrl: z.string().url().optional(),
          githubUrl: z.string().url().optional(),
          sourceUrl: z.string().url().optional(),
          notes: z.string().optional(),
        },
      },
      async ({ leadId, url, projectName, publishedUrl, githubUrl, sourceUrl, notes }) => {
        const primaryUrl = publishedUrl || url || '';
        if (!primaryUrl && !githubUrl && !sourceUrl) return mcpText({ error: 'Provide url, publishedUrl, githubUrl, or sourceUrl' });
        if (!primaryUrl && githubUrl) {
          let lead = await store.updateLead(leadId, {
            mockup: {
              ...(store.getLead(leadId)?.mockup ?? {}),
              ok: true,
              mode: 'lovable_github_repo',
              status: 'github_repo_attached',
              githubUrl,
              sourceUrl: sourceUrl || '',
              projectName: projectName || '',
              notes: notes || '',
              handoffStatus: 'repo_received',
              updatedAt: new Date().toISOString(),
            },
            owner: 'Coder',
            status: 'repo_attached',
          });
          if (!lead) return mcpText({ error: 'Lead not found' });
          await store.addEvent(leadId, 'lovable.repo.attached', `Lovable GitHub repo attached: ${githubUrl}`);
          await crmAddEvent({
            entityType: lead.a1DealId ? 'deal' : 'lead',
            entityId: lead.a1DealId || lead.a1LeadId || lead.id,
            eventType: 'lovable.repo.attached',
            text: `Lovable GitHub repo attached: ${githubUrl}`,
            payload: { webstudioLeadId: lead.id, githubUrl, sourceUrl, projectName },
            idempotencyKey: `webstudio:${lead.id}:lovable.repo.attached:${githubUrl}`,
          });
          await syncA1CrmLead(lead, 'lovable_repo_attached');
          return mcpText({ ok: true, lead, nextAction: 'Deploy this GitHub repo to Web Studio projects, then run Filmer.' });
        }
        let lead = await store.updateLead(leadId, {
          mockup: {
            ...(store.getLead(leadId)?.mockup ?? {}),
            ok: true,
            mode: 'lovable_mcp_connector',
            status: 'public_url_attached',
            url: url || primaryUrl,
            projectName: projectName || '',
            publishedUrl: publishedUrl || '',
            githubUrl: githubUrl || '',
            sourceUrl: sourceUrl || '',
            notes: notes || '',
            handoffStatus: 'url_received',
            updatedAt: new Date().toISOString(),
          },
          owner: 'Coder',
          status: 'public_url_attached',
        });
        if (!lead) return mcpText({ error: 'Lead not found' });
        await store.addEvent(leadId, 'lovable.url.attached', `Lovable URL attached: ${primaryUrl}`);
        await crmAddEvent({
          entityType: lead.a1DealId ? 'deal' : 'lead',
          entityId: lead.a1DealId || lead.a1LeadId || lead.id,
          eventType: 'lovable.url.attached',
          text: `Lovable URL attached: ${primaryUrl}`,
          payload: { webstudioLeadId: lead.id, url, publishedUrl, githubUrl, sourceUrl, projectName },
          idempotencyKey: `webstudio:${lead.id}:lovable.url.attached:${primaryUrl}`,
        });
        await store.addEvent(leadId, 'coder.deploy_queued', 'Coder queued deploy from public Lovable URL');
        await syncA1CrmLead(lead, 'lovable_url_attached');
        return mcpText({ ok: true, lead, nextAction: 'Coder will deploy this public URL under /projects/<slug>, then run Filmer.' });
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

export { landingBrief };

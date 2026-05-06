import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config, hasSecret } from '../config.js';

function authHeaders() {
  return hasSecret(config.A1_API_KEY) ? { Authorization: `Bearer ${config.A1_API_KEY}` } : {};
}

export async function createA1LeadTask(lead, agentName, instruction) {
  const url = new URL('/v1/agents/tasks', config.A1_API_URL);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        agentName,
        environment: config.A1_AGENT_ENVIRONMENT,
        title: `[Web Studio] ${lead.name}: ${agentName}`,
        instruction,
        input: { source: 'web-studio-orchestrator', lead },
      }),
    });
  } catch (error) {
    return { ok: false, skipped: true, error: error.message };
  }

  if (!response.ok) return { ok: false, status: response.status, error: await response.text() };
  return { ok: true, data: await response.json() };
}

export async function callA1McpTool(toolName, payload) {
  if (!hasSecret(config.A1_MCP_URL)) return { ok: false, skipped: true, reason: 'A1_MCP_URL is not configured' };
  const headers = a1McpHeaders();

  if (config.A1_MCP_URL.includes('/mcp')) {
    const client = new Client({ name: 'web-studio-orchestrator', version: '0.1.0' });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(config.A1_MCP_URL), {
        requestInit: { headers },
      });
      await client.connect(transport);
      const data = await client.callTool({ name: toolName, arguments: payload });
      const embeddedError = mcpEmbeddedError(data);
      if (data?.isError || embeddedError) return { ok: false, error: embeddedError || mcpErrorText(data), data };
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      await client.close().catch(() => {});
    }
  }

  const response = await fetch(config.A1_MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'tools/call',
      params: { name: toolName, arguments: payload },
    }),
  });

  if (!response.ok) return { ok: false, status: response.status, error: await response.text() };
  const data = await response.json();
  const embeddedError = mcpEmbeddedError(data?.result || data);
  if (data?.error || data?.result?.isError || embeddedError) return { ok: false, error: embeddedError || mcpErrorText(data?.result || data), data };
  return { ok: true, data };
}

export async function runA1Workflow(workflowId, inputData) {
  if (!hasSecret(workflowId)) return { ok: false, skipped: true, reason: 'workflow id is not configured' };
  return callA1McpTool('run_workflow', { workflowId, inputData });
}

export async function syncA1CrmLead(lead, reason = 'sync') {
  const dedupeKey = `webstudio:${lead.id}`;
  const upsert = await crmUpsertLead(lead, reason);
  const upsertData = parsedToolData(upsert);
  const a1LeadId = upsertData?.a1LeadId || upsertData?.leadId || upsertData?.id || lead.a1LeadId || lead.a1?.leadId || '';

  if (!upsert.ok) return { ...upsert, method: 'crm_upsert_lead', dedupeKey };

  const stage = a1StageForLead(lead);
  const move = await crmMoveLeadStage({
    a1LeadId,
    externalId: lead.id,
    dedupeKey,
    stage,
    reason,
    actor: 'web-studio-orchestrator',
    idempotencyKey: `webstudio:${lead.id}:stage:${stage}:${lead.updatedAt || reason}`,
  });

  return {
    ok: upsert.ok && (move.ok || move.skipped),
    method: 'typed_mcp_tools',
    dedupeKey,
    a1LeadId,
    stage,
    upsert,
    move,
  };
}

export async function crmUpsertLead(lead, reason = 'sync') {
  const email = Array.isArray(lead.contacts?.emails) ? lead.contacts.emails.find(Boolean) : '';
  return callA1McpTool('crm_upsert_lead', {
    externalId: lead.id,
    dedupeKey: `webstudio:${lead.id}`,
    companyName: lead.name || '',
    city: lead.city || '',
    niche: lead.niche || '',
    contacts: {
      emails: lead.contacts?.emails || (email ? [email] : []),
      phone: lead.contacts?.phone || lead.phone || '',
      channels: lead.contacts?.channels || [],
    },
    score: lead.fitScore ?? lead.priority ?? 0,
    source: 'webstudio',
    stage: a1StageForLead(lead),
    reason,
    webstudioLead: publicLeadPayload(lead),
    idempotencyKey: `webstudio:${lead.id}:upsert:${lead.updatedAt || reason}`,
  });
}

export async function crmMoveLeadStage(input) {
  if (!input?.a1LeadId && !input?.externalId && !input?.dedupeKey) {
    return { ok: false, skipped: true, reason: 'Missing A1 lead reference' };
  }
  return callA1McpTool('crm_move_lead_stage', input);
}

export async function crmAddEvent(input) {
  return callA1McpTool('crm_add_event', {
    source: 'webstudio',
    ...input,
    idempotencyKey: input.idempotencyKey || `webstudio:event:${input.entityType}:${input.entityId}:${input.eventType}:${Date.now()}`,
  });
}

export async function crmConvertLeadToDeal(input) {
  return callA1McpTool('crm_convert_lead_to_deal', input);
}

export async function dealAttachProduct(input) {
  return callA1McpTool('deal_attach_product', {
    productCode: 'landing_site_setup',
    billingMode: 'one_time',
    ...input,
  });
}

export async function invoiceCreateYookassaLink(input) {
  return callA1McpTool('invoice_create_yookassa_link', input);
}

export async function outboundQueueMessage(input) {
  if (input.channel && String(input.channel).toLowerCase() !== 'email') {
    return { ok: false, skipped: true, reason: 'Only email outbound is enabled in Web Studio v1' };
  }
  return callA1McpTool('outbound_queue_message', { channel: 'email', requiresApproval: false, ...input });
}

export async function voiceCallQueue() {
  return { ok: false, skipped: true, reason: 'voice_call_queue is disabled until cold-call prompt and policy are configured' };
}

export async function crmGetUpdatesSince(since) {
  return callA1McpTool('crm_get_updates_since', { since, source: 'webstudio' });
}

export function a1StageForLead(lead) {
  return a1StageForLane(lead?.lane || lead?.stage || 'scout');
}

export function a1StageForLane(lane) {
  const value = String(lane || '').toLowerCase();
  if (value.includes('diagnosis') || value.includes('\u0434\u0438\u0430\u0433') || value.includes('РґРёР°Рі')) return 'qualification';
  if (value.includes('mockup') || value.includes('lovable') || value.includes('video') || value.includes('\u0432\u0438\u0434') || value.includes('РІРёРґ')) return 'in_work';
  if (value.includes('checked') || value.includes('offer') || value.includes('check') || value.includes('\u043f\u0440\u043e\u0432') || value.includes('РїСЂРѕРІ')) return 'offer';
  if (value.includes('outreach') || value.includes('sent') || value.includes('replied') || value.includes('reply') || value.includes('\u043e\u0442\u043f\u0440\u0430\u0432') || value.includes('\u043e\u0442\u0432\u0435\u0442') || value.includes('РѕС‚РїСЂР°РІ') || value.includes('РѕС‚РІРµС‚')) return 'follow_up';
  if (value.includes('deal') || value.includes('converted')) return 'converted';
  return 'new';
}

export function customerBotLink(lead) {
  if (!config.TELEGRAM_BOT_USERNAME || !lead?.publicLeadToken) return '';
  return `https://t.me/${config.TELEGRAM_BOT_USERNAME.replace(/^@/, '')}?start=lead_${lead.publicLeadToken}`;
}

export function parsedToolData(result) {
  const text = result?.data?.content?.find?.((item) => item.type === 'text')?.text;
  if (!text) return result?.data || null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function publicLeadPayload(lead) {
  return {
    id: lead.id,
    name: lead.name,
    city: lead.city,
    niche: lead.niche,
    lane: lead.lane,
    owner: lead.owner,
    status: lead.status,
    sourceKey: lead.sourceKey,
    publicLeadToken: lead.publicLeadToken,
    rating: lead.rating,
    reviews: lead.reviews,
    years: lead.years,
    site: lead.site,
    address: lead.address,
    phone: lead.phone,
    contacts: lead.contacts,
    diagnosis: lead.diagnosis,
    angle: lead.angle,
    tone: lead.tone,
    message: lead.message,
    fitScore: lead.fitScore,
    deal: lead.deal,
    mockup: lead.mockup,
    video: lead.video,
    customerBotLink: customerBotLink(lead),
  };
}

function mcpErrorText(data) {
  return data?.content?.find?.((item) => item.type === 'text')?.text || data?.error?.message || 'MCP tool returned an error';
}

function mcpEmbeddedError(data) {
  const text = data?.content?.find?.((item) => item.type === 'text')?.text;
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    return parsed?.ok === false ? parsed?.error?.message || parsed?.error?.code || 'MCP tool returned ok:false' : '';
  } catch {
    return '';
  }
}

function a1McpHeaders() {
  const headers = {
    'x-role': config.A1_MCP_ROLE,
    'x-environment': config.A1_MCP_ENVIRONMENT,
    'x-actor-id': config.A1_MCP_ACTOR_ID,
  };
  if (!hasSecret(config.A1_MCP_API_KEY)) return headers;
  const authHeader = config.A1_MCP_AUTH_HEADER || 'x-a1-mcp-key';
  const authValue = authHeader.toLowerCase() === 'authorization' ? `Bearer ${config.A1_MCP_API_KEY}` : config.A1_MCP_API_KEY;
  headers[authHeader] = authValue;
  headers.Authorization = `Bearer ${config.A1_MCP_API_KEY}`;
  headers['X-A1-MCP-Key'] = config.A1_MCP_API_KEY;
  return headers;
}

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
  return { ok: true, data: await response.json() };
}

export async function runA1Workflow(workflowId, inputData) {
  if (!hasSecret(workflowId)) return { ok: false, skipped: true, reason: 'workflow id is not configured' };
  return callA1McpTool('run_workflow', { workflowId, inputData });
}

export async function syncA1CrmLead(lead, reason = 'sync') {
  if (!hasSecret(config.A1_CRM_LEADS_WORKFLOW_ID)) {
    return { ok: false, skipped: true, reason: 'A1_CRM_LEADS_WORKFLOW_ID is not configured' };
  }
  const email = Array.isArray(lead.contacts?.emails) ? lead.contacts.emails.find(Boolean) : '';
  const dedupeKey = `webstudio:${lead.id}`;
  const subject = `[Web Studio] ${lead.name} · ${lead.city} · ${lead.lane}`;
  const text = [
    `Лид: ${lead.name}`,
    `Город: ${lead.city || ''}`,
    `Ниша: ${lead.niche || ''}`,
    `Этап Web Studio: ${lead.lane || ''}`,
    `Владелец: ${lead.owner || ''}`,
    `FitScore: ${lead.fitScore ?? lead.priority ?? 0}`,
    `Оценка сайта: ${lead.deal ?? 0} RUB`,
    `Email: ${email || ''}`,
    `Телефон: ${lead.phone || ''}`,
    `Сайт/статус: ${lead.site || ''}`,
    `Адрес: ${lead.address || ''}`,
    `Диагноз: ${lead.diagnosis || ''}`,
    `Сообщение: ${lead.message || ''}`,
  ].join('\n');
  const payload = {
    company_id: config.A1_COMPANY_ID || undefined,
    crm: {
      lead: {
        dedupe_key: dedupeKey,
        external_id: lead.id,
        name: lead.name,
        stage: lead.lane,
        payload: lead,
      },
    },
    routing: {
      crm_direction: 'inbound',
    },
    event: {
      event_id: `webstudio:${lead.id}:${reason}:${lead.updatedAt || lead.createdAt || Date.now()}`,
      message_id: `webstudio:${lead.id}:${reason}`,
      channel: 'webstudio',
      source: 'webstudio',
      direction: 'inbound',
      from_email: email || `lead-${lead.id}@webstudio.local`,
      subject,
      text,
      meta: {
        source: 'web-studio-orchestrator',
        webstudio: {
          lead_id: lead.id,
          source_key: lead.sourceKey,
          lane: lead.lane,
          owner: lead.owner,
          status: lead.status,
          fitScore: lead.fitScore,
          deal: lead.deal,
        },
      },
    },
  };
  const result = await runA1Workflow(config.A1_CRM_LEADS_WORKFLOW_ID, { data: [{ json: payload }] });
  return { ...result, workflowId: config.A1_CRM_LEADS_WORKFLOW_ID, dedupeKey };
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

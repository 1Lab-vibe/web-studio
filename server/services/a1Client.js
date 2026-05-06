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
      if (data?.isError) return { ok: false, error: mcpErrorText(data), data };
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
  if (data?.error || data?.result?.isError) return { ok: false, error: mcpErrorText(data?.result || data), data };
  return { ok: true, data };
}

export async function runA1Workflow(workflowId, inputData) {
  if (!hasSecret(workflowId)) return { ok: false, skipped: true, reason: 'workflow id is not configured' };
  return callA1McpTool('run_workflow', { workflowId, inputData });
}

export async function runA1PostgresSafeQuery(sql) {
  return callA1McpTool('postgres_safe_query', { sql });
}

export async function queryA1Postgres(sql) {
  return callA1McpTool('postgres_query', { sql });
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
  const workflowResult = await runA1Workflow(config.A1_CRM_LEADS_WORKFLOW_ID, { data: [{ json: payload }] });
  if (workflowResult.ok) {
    const verified = await verifyA1CrmLead(dedupeKey);
    if (verified.ok) return { ...workflowResult, workflowId: config.A1_CRM_LEADS_WORKFLOW_ID, dedupeKey, verified: true, a1Lead: verified.lead };
  }

  const directResult = await upsertA1CrmLeadDirect(lead, dedupeKey, payload.event.event_id);
  return {
    ok: directResult.ok,
    workflowId: config.A1_CRM_LEADS_WORKFLOW_ID,
    dedupeKey,
    method: directResult.ok ? 'postgres_safe_query' : 'failed',
    workflowError: workflowResult.ok ? undefined : workflowResult.error,
    data: directResult.data,
    error: directResult.error,
    a1Lead: directResult.lead,
  };
}

async function verifyA1CrmLead(dedupeKey) {
  const sql = `
SELECT id, dedupe_key, stage, status, company_name, contact_email, updated_at
FROM a1_leads
WHERE dedupe_key = ${qText(dedupeKey)}
LIMIT 1`.trim();
  const result = await queryA1Postgres(sql);
  const rows = parseMcpRows(result);
  return rows[0] ? { ok: true, lead: rows[0] } : { ok: false };
}

async function upsertA1CrmLeadDirect(lead, dedupeKey, eventId) {
  const stage = a1StageForLane(lead.lane);
  const email = Array.isArray(lead.contacts?.emails) ? lead.contacts.emails.find(Boolean) : '';
  const tags = ['webstudio', lead.city, lead.niche, lead.source].filter(Boolean);
  const data = {
    source: 'web-studio-orchestrator',
    webstudioLeadId: lead.id,
    lane: lead.lane,
    owner: lead.owner,
    sourceKey: lead.sourceKey,
    fitScore: lead.fitScore ?? lead.priority ?? 0,
    dealRub: lead.deal ?? 0,
    contacts: lead.contacts ?? {},
    lead,
  };
  const sql = `
INSERT INTO a1_leads (
  company_id, dedupe_key, source, direction, channel, status, stage,
  contact_email, contact_phone, company_name, website, title, description,
  lead_score, priority, tags, data, last_event_id, last_event_at, stage_updated_at, user_id
) VALUES (
  ${qUuid(config.A1_COMPANY_ID)}, ${qText(dedupeKey)}, 'webstudio', 'inbound', 'webstudio', 'open', ${qText(stage)},
  ${qText(email)}, ${qText(lead.phone || '')}, ${qText(lead.name || '')}, ${qText(lead.site || '')}, ${qText(lead.name || '')}, ${qText(lead.diagnosis || lead.message || '')},
  ${qNumber(lead.fitScore ?? lead.priority ?? 0)}, ${qInt(lead.fitScore ?? lead.priority ?? 0)}, ${qJson(tags)}::jsonb, ${qJson(data)}::jsonb, ${qText(eventId)}, NOW(), NOW(), 'web-studio-orchestrator'
)
ON CONFLICT (company_id, dedupe_key) DO UPDATE SET
  stage = EXCLUDED.stage,
  contact_email = COALESCE(NULLIF(EXCLUDED.contact_email, ''), a1_leads.contact_email),
  contact_phone = COALESCE(NULLIF(EXCLUDED.contact_phone, ''), a1_leads.contact_phone),
  company_name = COALESCE(NULLIF(EXCLUDED.company_name, ''), a1_leads.company_name),
  website = COALESCE(NULLIF(EXCLUDED.website, ''), a1_leads.website),
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  lead_score = EXCLUDED.lead_score,
  priority = EXCLUDED.priority,
  tags = EXCLUDED.tags,
  data = EXCLUDED.data,
  last_event_id = EXCLUDED.last_event_id,
  last_event_at = NOW(),
  stage_updated_at = CASE WHEN a1_leads.stage IS DISTINCT FROM EXCLUDED.stage THEN NOW() ELSE a1_leads.stage_updated_at END,
  updated_at = NOW()
RETURNING id, dedupe_key, stage, status, company_name, contact_email, updated_at;`.trim();
  const result = await runA1PostgresSafeQuery(sql);
  const rows = parseMcpRows(result);
  return { ...result, lead: rows[0] };
}

function a1StageForLane(lane) {
  const value = String(lane || '').toLowerCase();
  if (value.includes('диаг') || value.includes('diagn')) return 'qualification';
  if (value.includes('lovable') || value.includes('film') || value.includes('видео')) return 'in_work';
  if (value.includes('пров') || value.includes('check')) return 'offer';
  if (value.includes('отправ') || value.includes('pitch') || value.includes('ответ')) return 'follow_up';
  return 'new';
}

function parseMcpRows(result) {
  const text = result?.data?.content?.find((item) => item.type === 'text')?.text;
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.rows) ? parsed.rows : [];
  } catch {
    return [];
  }
}

function mcpErrorText(data) {
  return data?.content?.find?.((item) => item.type === 'text')?.text || data?.error?.message || 'MCP tool returned an error';
}

function qText(value) {
  return `'${String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function qUuid(value) {
  return `${qText(value)}::uuid`;
}

function qJson(value) {
  return `${qText(JSON.stringify(value ?? null))}`;
}

function qNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : '0';
}

function qInt(value) {
  return String(Math.max(0, Math.round(Number(value) || 0)));
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

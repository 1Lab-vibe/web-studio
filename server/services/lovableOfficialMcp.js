import { readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config, hasSecret } from '../config.js';

const LOVABLE_LONG_REQUEST = { timeout: 15 * 60 * 1000, maxTotalTimeout: 20 * 60 * 1000, resetTimeoutOnProgress: true };
const LOVABLE_SHORT_REQUEST = { timeout: 2 * 60 * 1000 };

export function parseToolContent(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((item) => item?.type === 'text' && item.text)
    .map((item) => item.text)
    .join('\n')
    .trim();
  if (!text) return result?.structuredContent || result || {};
  try {
    return JSON.parse(text);
  } catch {
    return { text, raw: result };
  }
}

function projectIdFrom(data) {
  return data.project_id || data.projectId || data.id || data.project?.id || '';
}

function latestRefFrom(data) {
  return data.latest_commit_sha || data.latestCommitSha || data.latest_commit?.sha || data.project?.latest_commit_sha || data.project?.latestCommitSha || '';
}

function urlFrom(data, keys) {
  for (const key of keys) {
    const value = data[key] || data.project?.[key];
    if (value) return value;
  }
  return '';
}

export function lovableOfficialConfigured() {
  return (hasSecret(config.LOVABLE_API_KEY) || hasSecret(config.LOVABLE_OAUTH_TOKEN_PATH)) && hasSecret(config.LOVABLE_WORKSPACE_ID);
}

async function loadOAuthToken() {
  if (!hasSecret(config.LOVABLE_OAUTH_TOKEN_PATH)) return null;
  try {
    const token = JSON.parse(await readFile(config.LOVABLE_OAUTH_TOKEN_PATH, 'utf8'));
    if (!token.access_token) return null;
    return token;
  } catch {
    return null;
  }
}

async function refreshOAuthToken(token) {
  if (!token?.refresh_token) return token;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
    client_id: token.client?.client_id || '6d465f583e1e4ce5801b1616f735670c',
    resource: token.mcpUrl || 'https://mcp.lovable.dev',
  });
  const response = await fetch('https://lovable.dev/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) return token;
  const refreshed = await response.json();
  const next = {
    ...token,
    ...refreshed,
    refresh_token: refreshed.refresh_token || token.refresh_token,
    refreshedAt: new Date().toISOString(),
  };
  await writeFile(config.LOVABLE_OAUTH_TOKEN_PATH, JSON.stringify(next, null, 2), 'utf8').catch(() => {});
  return next;
}

export async function withLovableClient(callback) {
  if (!lovableOfficialConfigured()) return { ok: false, skipped: true, reason: 'LOVABLE_API_KEY or LOVABLE_WORKSPACE_ID is not configured' };
  const oauthToken = hasSecret(config.LOVABLE_API_KEY) ? null : await refreshOAuthToken(await loadOAuthToken());
  if (!hasSecret(config.LOVABLE_API_KEY) && !oauthToken?.access_token) {
    return { ok: false, skipped: true, reason: 'LOVABLE_OAUTH_TOKEN_PATH does not contain an access token' };
  }
  const client = new Client({ name: 'web-studio-orchestrator', version: '0.1.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(config.LOVABLE_OFFICIAL_MCP_URL), {
    requestInit: {
      headers: {
        ...(hasSecret(config.LOVABLE_API_KEY)
          ? { 'Lovable-API-Key': config.LOVABLE_API_KEY }
          : { Authorization: `Bearer ${oauthToken.access_token}` }),
      },
    },
  });
  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function listLovableTools() {
  return withLovableClient(async (client) => {
    const result = await client.listTools();
    return { ok: true, tools: result.tools?.map((tool) => tool.name) ?? [] };
  });
}

export async function createAndMaybeDeployLovableProject({ lead, prompt }) {
  return withLovableClient(async (client) => {
    const createResult = await client.callTool({
      name: 'create_project',
      arguments: {
        workspace_id: config.LOVABLE_WORKSPACE_ID,
        description: `${lead.name} - ${lead.city}`,
        tech_stack: 'classic',
        initial_message: prompt,
        wait: true,
        timeout_seconds: 900,
      },
    }, undefined, LOVABLE_LONG_REQUEST);
    const create = parseToolContent(createResult);
    const projectId = projectIdFrom(create);
    const previewUrl = urlFrom(create, ['preview_url', 'previewUrl', 'sandbox_url', 'sandboxUrl']);
    const editorUrl = urlFrom(create, ['editor_url', 'editorUrl']);
    const createMessageId = create.message_id || create.messageId || create.initial_message_id || create.initialMessageId || '';
    if (!projectId) {
      return { ok: false, reason: 'Lovable create_project did not return project_id', create };
    }

    const projectResult = await client.callTool({ name: 'get_project', arguments: { project_id: projectId } }, undefined, LOVABLE_SHORT_REQUEST);
    const project = parseToolContent(projectResult);
    const latestRef = latestRefFrom(project) || latestRefFrom(create);
    const exportedFiles = latestRef ? await exportLovableFiles(client, projectId, latestRef) : [];
    return {
      ok: true,
      projectId,
      previewUrl,
      editorUrl,
      publishedUrl: '',
      latestRef,
      createMessageId,
      files: exportedFiles,
      create,
      deploy: { skipped: true, reason: 'Web Studio deploys exported source under /projects/<slug>; Lovable publishing is disabled.' },
      project,
      deployed: false,
    };
  });
}

function normalizeFilesList(data) {
  const files = data.files || data.items || data.tree || (Array.isArray(data) ? data : []);
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => ({
      path: file.path || file.name || file.file_path || file.filePath || '',
      size: Number(file.size ?? 0),
      binary: Boolean(file.binary ?? file.is_binary ?? file.isBinary),
    }))
    .filter((file) => file.path && !file.path.endsWith('/'));
}

function contentFromReadFileResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
  if (text) return text;
  const data = parseToolContent(result);
  if (typeof data === 'string') return data;
  return data.content || data.text || data.file?.content || '';
}

export async function exportLovableFiles(client, projectId, ref) {
  const listResult = await client.callTool({ name: 'list_files', arguments: { project_id: projectId, ref } }, undefined, LOVABLE_SHORT_REQUEST);
  const listed = normalizeFilesList(parseToolContent(listResult));
  const wanted = listed.filter((file) => {
    const base = file.path.split('/').pop()?.toLowerCase() || '';
    return !file.binary && !/^(node_modules|dist|build|\.git)\//.test(file.path) && base !== '.env' && !base.startsWith('.env.');
  });
  const files = [];
  for (const file of wanted) {
    const readResult = await client.callTool({ name: 'read_file', arguments: { project_id: projectId, path: file.path, ref } }, undefined, LOVABLE_SHORT_REQUEST);
    files.push({
      ...file,
      content: contentFromReadFileResult(readResult),
    });
  }
  return files;
}

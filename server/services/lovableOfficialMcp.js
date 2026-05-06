import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config, hasSecret } from '../config.js';

function parseToolContent(result) {
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

function urlFrom(data, keys) {
  for (const key of keys) {
    const value = data[key] || data.project?.[key];
    if (value) return value;
  }
  return '';
}

export function lovableOfficialConfigured() {
  return hasSecret(config.LOVABLE_API_KEY) && hasSecret(config.LOVABLE_WORKSPACE_ID);
}

export async function withLovableClient(callback) {
  if (!lovableOfficialConfigured()) return { ok: false, skipped: true, reason: 'LOVABLE_API_KEY or LOVABLE_WORKSPACE_ID is not configured' };
  const client = new Client({ name: 'web-studio-orchestrator', version: '0.1.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(config.LOVABLE_OFFICIAL_MCP_URL), {
    requestInit: {
      headers: {
        'Lovable-API-Key': config.LOVABLE_API_KEY,
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
        initial_message: prompt,
      },
    });
    const create = parseToolContent(createResult);
    const projectId = projectIdFrom(create);
    const previewUrl = urlFrom(create, ['preview_url', 'previewUrl', 'sandbox_url', 'sandboxUrl']);
    const editorUrl = urlFrom(create, ['editor_url', 'editorUrl']);
    if (!projectId) {
      return { ok: false, reason: 'Lovable create_project did not return project_id', create };
    }

    if (!config.LOVABLE_AUTO_DEPLOY) {
      return {
        ok: true,
        projectId,
        previewUrl,
        editorUrl,
        create,
        deployed: false,
      };
    }

    const deployResult = await client.callTool({
      name: 'deploy_project',
      arguments: { project_id: projectId },
    });
    const deploy = parseToolContent(deployResult);
    const publishedUrl = urlFrom(deploy, ['live_url', 'liveUrl', 'published_url', 'publishedUrl', 'url']);
    return {
      ok: true,
      projectId,
      previewUrl,
      editorUrl,
      publishedUrl,
      create,
      deploy,
      deployed: Boolean(publishedUrl),
    };
  });
}

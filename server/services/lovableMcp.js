import { randomUUID } from 'node:crypto';
import { config, hasSecret } from '../config.js';

export async function createLovableMockup(lead) {
  if (!hasSecret(config.LOVABLE_MCP_URL)) {
    return { ok: false, skipped: true, reason: 'LOVABLE_MCP_URL is not configured' };
  }

  const prompt = [
    `Создай landing page mockup в Lovable для российского локального бизнеса "${lead.name}".`,
    `Город: ${lead.city}. Ниша: ${lead.niche}.`,
    `Hero angle: ${lead.angle || ''}`,
    'Страница должна быть готовым редактируемым прототипом, без маркетинговой воды, с формой заявки.',
  ].join('\n');

  const response = await fetch(config.LOVABLE_MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(hasSecret(config.LOVABLE_MCP_API_KEY) ? { Authorization: `Bearer ${config.LOVABLE_MCP_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'tools/call',
      params: {
        name: 'create_project',
        arguments: { prompt, metadata: { source: 'web-studio-orchestrator', leadId: lead.id } },
      },
    }),
  });

  if (!response.ok) return { ok: false, status: response.status, error: await response.text() };
  return { ok: true, data: await response.json() };
}

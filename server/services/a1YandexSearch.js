import { config, hasSecret } from '../config.js';
import { callA1McpTool } from './a1Client.js';

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function searchQuery(lead) {
  return unique([lead.name, lead.city, lead.address, lead.url, lead.niche])
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectStrings(value, result = []) {
  if (!value) return result;
  if (typeof value === 'string') {
    result.push(value);
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, result);
    return result;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, result);
  }
  return result;
}

export async function searchContactsViaA1Yandex(lead) {
  if (!hasSecret(config.A1_YANDEX_SEARCH_WORKFLOW_ID) && !hasSecret(config.A1_YANDEX_SEARCH_TOOL)) {
    return { ok: false, skipped: true, reason: 'A1_YANDEX_SEARCH_WORKFLOW_ID is not configured', emails: [], urls: [] };
  }

  const query = `${searchQuery(lead)} email почта контакты`;
  const yandexPayload = {
    action: {
      params: {
        payload: {
          operation: 'web_search',
          query,
          fetchPages: true,
          maxPageFetch: 3,
          responseFormat: 'FORMAT_HTML',
        },
      },
    },
    lead: {
      name: lead.name,
      city: lead.city,
      address: lead.address,
      url: lead.url,
      niche: lead.niche,
      phone: lead.phone,
    },
    task: 'Find official contact emails for this Russian local business. Prefer official site/contact pages and return source URLs.',
  };
  const result = hasSecret(config.A1_YANDEX_SEARCH_WORKFLOW_ID)
    ? await callA1McpTool('run_workflow', {
        workflowId: config.A1_YANDEX_SEARCH_WORKFLOW_ID,
        inputData: { data: [{ json: yandexPayload }] },
      })
    : await callA1McpTool(config.A1_YANDEX_SEARCH_TOOL, yandexPayload);

  if (!result.ok) return { ...result, emails: [], urls: [], query };
  return {
    ok: true,
    query,
    raw: result.data,
    text: collectStrings(result.data).join('\n').slice(0, 20000),
  };
}

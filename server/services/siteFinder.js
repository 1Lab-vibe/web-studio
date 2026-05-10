import { config, hasSecret } from '../config.js';
import { callA1McpTool } from './a1Client.js';

const URL_RE = /https?:\/\/[A-Z0-9.\-]+(?:\.[A-Z]{2,})(?:\/[^\s"'<>)]*)?/gi;

const BLOCKED_HOSTS = [
  'maps.yandex',
  'yandex.ru/maps',
  'yandex.com/maps',
  'yandex.ru/search',
  'yandex.ru/uslugi',
  'google.com/maps',
  '2gis.ru',
  '2gis.com',
  'wikipedia.org',
  'instagram.com',
  'facebook.com',
  'fb.com',
  't.me',
  'telegram.org',
  'vk.com',
  'vk.ru',
  'm.vk.com',
  'ok.ru',
  'twitter.com',
  'x.com',
  'youtube.com',
  'tiktok.com',
  'flamp.ru',
  'zoon.ru',
  'otzovik.com',
  'irecommend.ru',
  'avito.ru',
  'cian.ru',
  'profi.ru',
  'yell.ru',
  'spr.ru',
  'rusprofile.ru',
  'list-org.com',
  'rusfirms.ru',
];

const cyrillicMap = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function translit(value) {
  return String(value || '')
    .toLowerCase()
    .split('')
    .map((char) => cyrillicMap[char] ?? char)
    .join('');
}

function nameTokens(name) {
  return translit(name)
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 3 && !['ooo', 'ipo', 'ip', 'ao', 'company', 'company', 'studio'].includes(token));
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeUrl(raw) {
  try {
    const url = new URL(raw.trim());
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isBlockedHost(url) {
  const host = hostOf(url);
  if (!host) return true;
  return BLOCKED_HOSTS.some((needle) => host.includes(needle));
}

function isPlausibleSiteUrl(url) {
  const host = hostOf(url);
  if (!host || host.length < 4) return false;
  if (host.includes(' ')) return false;
  if (isBlockedHost(url)) return false;
  return true;
}

function scoreCandidate(url, lead, position) {
  const host = hostOf(url);
  const tokens = nameTokens(lead.name);
  const hostBare = host.replace(/\.(ru|su|рф|com|net|org|biz|info|pro|store|shop|online|tech|site|space|website|club|cc|io)$/i, '');
  let score = 100 - position * 5;
  if (host.endsWith('.ru') || host.endsWith('.рф') || host.endsWith('.su')) score += 15;
  if (host.endsWith('.com') || host.endsWith('.net')) score += 4;
  if (host.split('.').length === 2) score += 6;
  for (const token of tokens) {
    if (hostBare.includes(token)) score += 18;
  }
  if (lead.city) {
    const city = translit(lead.city);
    if (host.includes(city) || hostBare.includes(city)) score += 6;
  }
  if (host.length <= 20) score += 4;
  if (host.length > 40) score -= 6;
  return score;
}

function extractCandidatesFromText(text) {
  const matches = String(text || '').match(URL_RE) || [];
  return unique(
    matches
      .map((value) => normalizeUrl(value))
      .filter(Boolean)
      .filter(isPlausibleSiteUrl),
  );
}

function searchQueryForBusiness(lead) {
  return [lead.name, lead.city, 'официальный сайт'].filter(Boolean).join(' ').trim();
}

async function searchViaA1Yandex(lead) {
  if (!hasSecret(config.A1_YANDEX_SEARCH_WORKFLOW_ID) && !hasSecret(config.A1_YANDEX_SEARCH_TOOL)) {
    return { ok: false, skipped: true, reason: 'A1_YANDEX_SEARCH not configured', candidates: [] };
  }
  const query = searchQueryForBusiness(lead);
  const yandexPayload = {
    action: {
      params: {
        payload: {
          operation: 'web_search',
          query,
          fetchPages: false,
          maxPageFetch: 0,
          responseFormat: 'FORMAT_HTML',
        },
      },
    },
    lead: {
      name: lead.name,
      city: lead.city,
      address: lead.address,
      niche: lead.niche,
      phone: lead.phone,
    },
    task: 'Find the official website URL for this Russian local business. Return real first-party domains, not directories like 2gis, yandex maps, vk, instagram.',
  };
  const result = hasSecret(config.A1_YANDEX_SEARCH_WORKFLOW_ID)
    ? await callA1McpTool('run_workflow', {
        workflowId: config.A1_YANDEX_SEARCH_WORKFLOW_ID,
        inputData: { data: [{ json: yandexPayload }] },
      })
    : await callA1McpTool(config.A1_YANDEX_SEARCH_TOOL, yandexPayload);
  if (!result.ok) return { ok: false, reason: result.error || result.reason || 'a1_yandex_search_failed', candidates: [] };
  const text = collectStrings(result.data).join('\n').slice(0, 80_000);
  return { ok: true, query, candidates: extractCandidatesFromText(text), source: 'a1_yandex' };
}

async function searchViaGoogleCse(lead) {
  if (!hasSecret(config.GOOGLE_MAPS_API_KEY) || !hasSecret(config.GOOGLE_CSE_ID)) {
    return { ok: false, skipped: true, reason: 'GOOGLE_CSE not configured', candidates: [] };
  }
  const query = searchQueryForBusiness(lead);
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', config.GOOGLE_MAPS_API_KEY);
  url.searchParams.set('cx', config.GOOGLE_CSE_ID);
  url.searchParams.set('q', query);
  url.searchParams.set('num', '10');
  url.searchParams.set('hl', 'ru');
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) return { ok: false, reason: `http_${response.status}`, candidates: [] };
    const json = await response.json();
    const candidates = unique(
      (json.items || [])
        .map((item) => normalizeUrl(item.link || ''))
        .filter(Boolean)
        .filter(isPlausibleSiteUrl),
    );
    return { ok: true, query, candidates, source: 'google_cse' };
  } catch (error) {
    return { ok: false, reason: error.message, candidates: [] };
  }
}

async function searchViaDuckDuckGo(lead) {
  const query = searchQueryForBusiness(lead);
  const url = `https://lite.duckduckgo.com/lite/?${new URLSearchParams({ q: query, kl: 'ru-ru' })}`;
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; WebStudioFinder/1.0; +https://webstudio.1true.ru)',
        accept: 'text/html',
        'accept-language': 'ru,en;q=0.7',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return { ok: false, reason: `http_${response.status}`, candidates: [] };
    const html = await response.text();
    const candidates = [];
    const linkRe = /uddg=([^&"']+)/gi;
    let match;
    while ((match = linkRe.exec(html))) {
      const decoded = decodeURIComponent(match[1]);
      const normalized = normalizeUrl(decoded);
      if (normalized && isPlausibleSiteUrl(normalized)) candidates.push(normalized);
      if (candidates.length >= 15) break;
    }
    return { ok: true, query, candidates: unique(candidates), source: 'duckduckgo' };
  } catch (error) {
    return { ok: false, reason: error.message, candidates: [] };
  }
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

export async function discoverLeadSite(lead) {
  if (!lead?.name) {
    return { ok: false, skipped: true, reason: 'no_lead_name', updatedAt: new Date().toISOString() };
  }
  if (lead.url && /^https?:\/\//i.test(lead.url)) {
    return { ok: true, skipped: true, reason: 'lead_already_has_url', url: lead.url, updatedAt: new Date().toISOString() };
  }
  const sources = [];
  const allCandidates = [];

  for (const fn of [searchViaA1Yandex, searchViaGoogleCse, searchViaDuckDuckGo]) {
    const result = await fn(lead);
    sources.push({
      source: result.source || fn.name,
      ok: Boolean(result.ok),
      skipped: Boolean(result.skipped),
      reason: result.reason || '',
      candidatesCount: result.candidates?.length || 0,
    });
    if (result.ok && result.candidates?.length) {
      allCandidates.push(...result.candidates.map((url, index) => ({ url, source: result.source || fn.name, position: index })));
    }
    if (result.ok && result.candidates?.length >= 5) break;
  }

  const dedup = new Map();
  for (const candidate of allCandidates) {
    const key = hostOf(candidate.url);
    if (!key) continue;
    if (!dedup.has(key)) dedup.set(key, candidate);
  }
  const ranked = [...dedup.values()]
    .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate.url, lead, candidate.position) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (!ranked.length) {
    return { ok: false, reason: 'no_candidates_found', sources, updatedAt: new Date().toISOString() };
  }
  const best = ranked[0];
  return {
    ok: true,
    url: best.url,
    host: hostOf(best.url),
    score: best.score,
    source: best.source,
    sources,
    candidates: ranked,
    updatedAt: new Date().toISOString(),
  };
}

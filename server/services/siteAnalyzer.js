const FETCH_TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 600_000;
const STOPWORDS = new Set([
  'и', 'в', 'на', 'с', 'по', 'за', 'к', 'от', 'для', 'из', 'у', 'о', 'об', 'про',
  'это', 'что', 'как', 'все', 'все', 'мы', 'вы', 'наш', 'наша', 'наши', 'который',
  'которая', 'которые', 'компания', 'сайт', 'home', 'page', 'main', 'and', 'or', 'the', 'a',
]);

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&laquo;/gi, '«')
    .replace(/&raquo;/gi, '»')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–');
}

function stripTags(html) {
  return decodeEntities(String(html || '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractTagText(html, tag, limit = 12) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out = [];
  let match;
  while ((match = re.exec(html)) && out.length < limit) {
    const text = stripTags(match[1]).trim();
    if (text && text.length >= 3) out.push(text.slice(0, 240));
  }
  return out;
}

function extractMeta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']{0,400})["']`, 'i');
  return decodeEntities((html.match(re)?.[1] || '').trim());
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeEntities(stripTags(match?.[1] || ''));
}

function extractPhones(text) {
  const phones = new Set();
  const re = /(?:\+7|8|7)\s*[(\-\s]?\d{3,4}[)\-\s]?\s*\d{2,3}[\-\s]?\d{2}[\-\s]?\d{2}/g;
  let match;
  while ((match = re.exec(text))) {
    phones.add(match[0].replace(/\s+/g, ' ').trim());
    if (phones.size >= 5) break;
  }
  return [...phones];
}

function extractAddresses(text) {
  const addresses = new Set();
  const re = /(?:г\.?\s?[А-ЯЁ][а-яё-]+|город\s[А-ЯЁ][а-яё-]+)[^.\n]{5,140}(?:ул\.?|улица|пр\.?|просп\.?|пер\.?|переулок|ш\.?|шоссе|пл\.?|площадь|наб\.?|набережная|д\.?|дом)\s?[^.\n]{1,80}/gi;
  let match;
  while ((match = re.exec(text))) {
    addresses.add(match[0].replace(/\s+/g, ' ').trim());
    if (addresses.size >= 3) break;
  }
  return [...addresses];
}

function extractEmails(text) {
  const emails = new Set();
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  let match;
  while ((match = re.exec(text))) {
    emails.add(match[0].toLowerCase());
    if (emails.size >= 5) break;
  }
  return [...emails];
}

function extractKeywords(text) {
  const counts = new Map();
  for (const raw of text.toLowerCase().split(/[^a-zа-яё0-9]+/i)) {
    if (raw.length < 4 || raw.length > 24) continue;
    if (STOPWORDS.has(raw)) continue;
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([word]) => word);
}

function looksLikeService(text) {
  if (!text) return false;
  const value = text.toLowerCase();
  if (value.length < 4 || value.length > 120) return false;
  if (/cookie|политика|меню|menu|navigation|©|войти|корзин/i.test(value)) return false;
  return true;
}

async function fetchHtml(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; WebStudioAnalyzer/1.0; +https://webstudio.1true.ru)',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'ru,en;q=0.7',
      },
    });
    if (!response.ok) return { ok: false, status: response.status, finalUrl: response.url || url };
    const reader = response.body?.getReader?.();
    const finalUrl = response.url || url;
    if (!reader) {
      const text = await response.text();
      return { ok: true, status: response.status, finalUrl, html: text.slice(0, MAX_BODY_BYTES) };
    }
    const chunks = [];
    let received = 0;
    while (received < MAX_BODY_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
    }
    try { reader.cancel(); } catch { /* noop */ }
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return { ok: true, status: response.status, finalUrl, html: buffer.toString('utf8') };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

export async function analyzeLeadSite(lead) {
  const url = String(lead?.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, skipped: true, reason: 'no_lead_site_url', url: '', updatedAt: new Date().toISOString() };
  }
  const fetched = await fetchHtml(url);
  if (!fetched.ok || !fetched.html) {
    return {
      ok: false,
      skipped: false,
      reason: fetched.error || `http_${fetched.status || 'unknown'}`,
      url,
      finalUrl: fetched.finalUrl || '',
      status: fetched.status || 0,
      updatedAt: new Date().toISOString(),
    };
  }
  const html = fetched.html;
  const text = stripTags(html);
  const title = extractTitle(html);
  const description = extractMeta(html, 'description');
  const ogTitle = extractMeta(html, 'og:title');
  const ogDescription = extractMeta(html, 'og:description');
  const headings = [
    ...extractTagText(html, 'h1', 5),
    ...extractTagText(html, 'h2', 8),
  ];
  const liItems = extractTagText(html, 'li', 30).filter(looksLikeService);
  const services = [...new Set(liItems)].slice(0, 12);
  const phones = extractPhones(text);
  const emails = extractEmails(text);
  const addresses = extractAddresses(text);
  const keywords = extractKeywords(text);
  const yearMatches = [...html.matchAll(/©\s*(?:[^\d]{0,30})(20\d{2})\s*(?:[—\-–]\s*(20\d{2}))?/g)];
  const lastYear = yearMatches
    .map((match) => Number(match[2] || match[1]))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  const usesTilda = /tilda|tildacdn|tildawww/i.test(html);
  const usesWix = /wix\.com|wixstatic/i.test(html);
  const usesTaplink = /taplink/i.test(html) || /taplink/i.test(url);
  const usesBitrix = /bitrix/i.test(html);
  const usesWordpress = /wp-content|wp-includes|wp-json/i.test(html);
  const looksOutdated = Boolean(lastYear && lastYear <= 2018);

  return {
    ok: true,
    url,
    finalUrl: fetched.finalUrl || url,
    status: fetched.status,
    title: title.slice(0, 200),
    description: (description || ogDescription || '').slice(0, 400),
    ogTitle: ogTitle.slice(0, 200),
    headings: headings.slice(0, 10),
    services,
    phones,
    emails,
    addresses,
    keywords,
    lastCopyrightYear: lastYear || null,
    looksOutdated,
    platform: {
      tilda: usesTilda,
      wix: usesWix,
      taplink: usesTaplink,
      bitrix: usesBitrix,
      wordpress: usesWordpress,
    },
    snippet: text.slice(0, 600),
    bodyLength: text.length,
    updatedAt: new Date().toISOString(),
  };
}

export function summarizeSiteAnalysisForPrompt(analysis) {
  if (!analysis || !analysis.ok) return '';
  const lines = [];
  if (analysis.title) lines.push(`Title: ${analysis.title}`);
  if (analysis.description) lines.push(`Meta description: ${analysis.description}`);
  if (analysis.headings?.length) lines.push(`Headings: ${analysis.headings.slice(0, 6).join(' | ')}`);
  if (analysis.services?.length) lines.push(`Listed services/items: ${analysis.services.slice(0, 8).join(' | ')}`);
  if (analysis.phones?.length) lines.push(`Phones: ${analysis.phones.slice(0, 3).join(', ')}`);
  if (analysis.emails?.length) lines.push(`Emails: ${analysis.emails.slice(0, 3).join(', ')}`);
  if (analysis.addresses?.length) lines.push(`Addresses: ${analysis.addresses.slice(0, 2).join(' | ')}`);
  if (analysis.keywords?.length) lines.push(`Frequent keywords: ${analysis.keywords.join(', ')}`);
  const platforms = Object.entries(analysis.platform || {})
    .filter(([, used]) => used)
    .map(([name]) => name);
  if (platforms.length) lines.push(`Platform: ${platforms.join(', ')}`);
  if (analysis.lastCopyrightYear) lines.push(`Last copyright year on site: ${analysis.lastCopyrightYear}${analysis.looksOutdated ? ' (looks outdated)' : ''}`);
  return lines.join('\n');
}

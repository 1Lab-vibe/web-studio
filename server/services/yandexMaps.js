import { config, csv, hasSecret } from '../config.js';

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCompanyMeta(feature) {
  const company = feature?.properties?.CompanyMetaData ?? {};
  const rating = safeNumber(company.rating?.value ?? company.rating, 0);
  const reviews = safeNumber(company.rating?.count ?? company.reviewCount ?? company.reviews, 0);
  const url = company.url || company.Links?.[0]?.href || '';
  const categories = Array.isArray(company.Categories)
    ? company.Categories.map((category) => category.name).filter(Boolean)
    : [];
  return { company, rating, reviews, url, categories };
}

function estimateYearsOnMap(feature) {
  const company = feature?.properties?.CompanyMetaData ?? {};
  const raw = company.ogrn_date || company.founded || company.created_at || '';
  const year = String(raw).match(/\b(19|20)\d{2}\b/)?.[0];
  if (!year) return config.MIN_YEARS_ON_MAP;
  return Math.max(0, new Date().getFullYear() - Number(year));
}

function siteLabel(url) {
  if (!url) return 'нет сайта';
  const oldYear = String(url).match(/\b20(0\d|1[0-8])\b/)?.[0];
  return oldYear ? `сайт ${oldYear}` : 'сайт есть';
}

function qualifies(lead) {
  const weakSite = lead.site === 'нет сайта' || lead.site.includes('сайт 20') || lead.site.toLowerCase().includes('taplink');
  return (
    lead.rating >= config.MIN_RATING &&
    lead.reviews <= config.MAX_REVIEWS &&
    lead.years >= config.MIN_YEARS_ON_MAP &&
    weakSite
  );
}

export async function scoutYandexMaps() {
  if (!hasSecret(config.YANDEX_MAPS_API_KEY)) {
    return { ok: false, skipped: true, reason: 'YANDEX_MAPS_API_KEY is not configured', leads: [] };
  }

  const leads = [];
  for (const city of csv(config.SCOUT_CITIES)) {
    for (const niche of csv(config.SCOUT_NICHES)) {
      const url = new URL('https://search-maps.yandex.ru/v1/');
      const authHeaders = yandexAuthHeaders();
      url.searchParams.set('apikey', yandexApiKeyValue());
      url.searchParams.set('text', `${niche} ${city}`);
      url.searchParams.set('lang', config.YANDEX_MAPS_LANG);
      url.searchParams.set('type', 'biz');
      url.searchParams.set('results', String(config.YANDEX_MAPS_RESULTS));

      const response = await fetch(url, { headers: authHeaders });
      if (!response.ok) {
        throw new Error(`Yandex Maps API failed: ${response.status} ${await response.text()}`);
      }
      const data = await response.json();
      for (const feature of data.features ?? []) {
        const meta = parseCompanyMeta(feature);
        const lead = {
          source: 'yandex_maps',
          sourceKey: feature.properties?.CompanyMetaData?.id || feature.uri || `${city}:${niche}:${feature.properties?.name}`,
          name: feature.properties?.name || meta.company.name || 'Без названия',
          city,
          niche,
          rating: meta.rating,
          reviews: meta.reviews,
          years: estimateYearsOnMap(feature),
          site: siteLabel(meta.url),
          url: meta.url,
          address: meta.company.address || feature.properties?.description || '',
          phone: meta.company.Phones?.[0]?.formatted || '',
          categories: meta.categories,
        };
        if (qualifies(lead)) leads.push({ ...lead, priority: scoreLead(lead) });
      }
    }
  }

  return { ok: true, leads };
}

function yandexAuthHeaders() {
  const value = config.YANDEX_MAPS_API_KEY.trim();
  if (/^(Api-Key|Bearer)\s+/i.test(value)) return { Authorization: value };
  if (/^Api-Key:/i.test(value)) return { Authorization: value.replace(/^Api-Key:/i, 'Api-Key').trim() };
  return {};
}

function yandexApiKeyValue() {
  return config.YANDEX_MAPS_API_KEY.trim().replace(/^(Api-Key|Bearer)[:\s]+/i, '').trim();
}

export function scoreLead(lead) {
  const noSite = lead.site === 'нет сайта' ? 25 : 0;
  const oldSite = lead.site.includes('сайт 20') || lead.site.includes('Taplink') ? 15 : 0;
  const ratingScore = Math.round((lead.rating - config.MIN_RATING) * 25);
  const reviewGap = Math.max(0, config.MAX_REVIEWS - lead.reviews);
  return Math.min(99, 50 + noSite + oldSite + ratingScore + Math.round(reviewGap / 5));
}

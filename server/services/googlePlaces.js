import { config, csv, hasSecret } from '../config.js';
import { plannedScoutQueries, scoutAreas } from './scoutAreas.js';
import { scoreLead } from './yandexMaps.js';

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function siteLabel(place) {
  const url = place.websiteUri || '';
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

function estimateYearsOnMap() {
  return config.MIN_YEARS_ON_MAP;
}

function normalizePlace(place, city, niche, area = '') {
  const name = place.displayName?.text || 'Без названия';
  const lead = {
    source: 'google_places',
    sourceKey: place.id || `${city}:${niche}:${name}`,
    name,
    city,
    area,
    niche,
    rating: safeNumber(place.rating, 0),
    reviews: safeNumber(place.userRatingCount, 0),
    years: estimateYearsOnMap(place),
    site: siteLabel(place),
    url: place.websiteUri || '',
    address: place.formattedAddress || '',
    phone: place.nationalPhoneNumber || place.internationalPhoneNumber || '',
    categories: Array.isArray(place.types) ? place.types : [],
  };
  return { ...lead, priority: scoreLead(lead) };
}

async function searchText(query, city, niche, area = '', pageToken = '') {
  const body = {
    textQuery: query,
    languageCode: 'ru',
    regionCode: 'RU',
    maxResultCount: Math.max(1, Math.min(20, Number(config.GOOGLE_MAPS_RESULTS) || 20)),
  };
  if (pageToken) body.pageToken = pageToken;

  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': [
        'places.id',
        'places.displayName',
        'places.formattedAddress',
        'places.rating',
        'places.userRatingCount',
        'places.websiteUri',
        'places.nationalPhoneNumber',
        'places.internationalPhoneNumber',
        'places.types',
        'nextPageToken',
      ].join(','),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Google Places API failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return {
    leads: (data.places ?? []).map((place) => normalizePlace(place, city, niche, area)).filter(qualifies),
    resultCount: Array.isArray(data.places) ? data.places.length : 0,
    nextPageToken: data.nextPageToken || '',
  };
}

export async function scoutGooglePlaces(searchLimit, options = {}) {
  if (!hasSecret(config.GOOGLE_MAPS_API_KEY)) {
    return { ok: false, skipped: true, reason: 'GOOGLE_MAPS_API_KEY is not configured', leads: [], searchesUsed: 0 };
  }

  if (searchLimit <= 0) {
    return { ok: false, skipped: true, reason: 'GOOGLE_DAILY_SEARCH_LIMIT reached', leads: [], searchesUsed: 0 };
  }

  const leads = [];
  const skippedQueries = [];
  let searchesUsed = 0;
  const pageLimit = Math.max(1, Math.min(3, Number(config.SCOUT_GOOGLE_PAGES) || 1));

  for (const scoutArea of scoutAreas()) {
    for (const niche of csv(config.SCOUT_NICHES)) {
      let nextPageToken = '';
      for (let page = 0; page < pageLimit; page += 1) {
        if (searchesUsed >= searchLimit) return { ok: true, leads, searchesUsed, skippedQueries, limited: true };
        const query = `${niche} ${scoutArea.queryLocation}`;
        const queryInput = { provider: 'google_places', city: scoutArea.city, area: scoutArea.area, niche, page, query, cooldownDays: config.SCOUT_QUERY_COOLDOWN_DAYS };
        const gate = options.shouldRunQuery?.(queryInput) ?? { ok: true };
        if (!gate.ok) {
          skippedQueries.push({ ...queryInput, reason: 'cooldown', nextRunAt: gate.nextRunAt });
          break;
        }
        const found = await searchText(query, scoutArea.city, niche, scoutArea.area, nextPageToken);
        searchesUsed += 1;
        leads.push(...found.leads);
        await options.recordQuery?.(queryInput, { key: gate.key, status: 'done', resultCount: found.resultCount, newResultCount: found.leads.length });
        if (!found.nextPageToken) break;
        nextPageToken = found.nextPageToken;
      }
    }
  }

  return { ok: true, leads, searchesUsed, skippedQueries, limited: false };
}

export function plannedGoogleSearches() {
  return plannedScoutQueries({ provider: 'google', pageLimit: config.SCOUT_GOOGLE_PAGES });
}

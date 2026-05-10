import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NICHES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'niches');

let cachedConfigs = null;
let defaultConfig = null;

function emptyConfig() {
  return {
    slug: 'unknown',
    label: 'Локальный бизнес',
    match: [],
    palette: {},
    typography: {},
    heroAngle: '',
    sections: [],
    ctaPrimary: 'Оставить заявку',
    ctaSecondary: 'Получить консультацию',
    trustSignals: [],
    imageHints: [],
    emailHook: '',
    emailProofIdea: '',
    emailRiskIfIgnored: '',
  };
}

async function loadAllConfigs() {
  if (cachedConfigs) return cachedConfigs;
  const entries = await readdir(NICHES_DIR, { withFileTypes: true }).catch(() => []);
  const configs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = await readFile(path.join(NICHES_DIR, entry.name), 'utf8');
      const parsed = JSON.parse(raw);
      const merged = { ...emptyConfig(), ...parsed };
      if (merged.slug === '_default') {
        defaultConfig = merged;
      } else {
        configs.push(merged);
      }
    } catch (error) {
      console.warn(`niches: failed to load ${entry.name}: ${error.message}`);
    }
  }
  if (!defaultConfig) defaultConfig = emptyConfig();
  cachedConfigs = configs;
  return cachedConfigs;
}

function nicheHaystack(lead = {}) {
  return [lead.niche, lead.name, lead.categories?.join(' '), lead.customerBrief?.businessName, lead.customerBrief?.services]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export async function loadNicheConfig(lead) {
  const configs = await loadAllConfigs();
  const haystack = nicheHaystack(lead);
  if (!haystack) return defaultConfig || emptyConfig();
  for (const config of configs) {
    const matches = Array.isArray(config.match) ? config.match : [];
    if (matches.some((token) => token && haystack.includes(String(token).toLowerCase()))) {
      return config;
    }
  }
  return defaultConfig || emptyConfig();
}

export async function listNicheConfigs() {
  const configs = await loadAllConfigs();
  return [...(defaultConfig ? [defaultConfig] : []), ...configs];
}

export function clearNicheCache() {
  cachedConfigs = null;
  defaultConfig = null;
}

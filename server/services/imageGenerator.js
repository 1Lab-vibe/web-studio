import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import { config, hasSecret } from '../config.js';

const openai = hasSecret(config.OPENAI_API_KEY) ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : null;

const inFlight = new Map();

function imagesDir() {
  return path.resolve(config.DATA_DIR, 'generated-images');
}

function publicUrlFor(fileName) {
  const base = String(config.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return `${base}/generated-images/${fileName}`;
}

const LOCAL_URL_PREFIX = '/generated-images/';

export function localImagePath(url) {
  if (!url) return '';
  let pathname = '';
  if (url.startsWith(LOCAL_URL_PREFIX)) {
    pathname = url;
  } else {
    try {
      const parsed = new URL(url);
      const base = String(config.PUBLIC_BASE_URL || '').replace(/\/$/, '');
      const baseHost = base ? new URL(base).host : '';
      if (baseHost && parsed.host !== baseHost) return '';
      pathname = parsed.pathname;
    } catch {
      return '';
    }
  }
  if (!pathname.startsWith(LOCAL_URL_PREFIX)) return '';
  const fileName = pathname.slice(LOCAL_URL_PREFIX.length);
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) return '';
  return path.join(imagesDir(), fileName);
}

function fallbackImageUrl(prompt, seed) {
  const encoded = encodeURIComponent(prompt);
  const safeSeed = Number.isFinite(Number(seed)) ? Number(seed) : 100000 + Math.floor(Math.random() * 800000);
  return `https://image.pollinations.ai/prompt/${encoded}?width=1600&height=1000&seed=${safeSeed}&nologo=true&enhance=true`;
}

function promptHash(parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(String(part || '').trim());
  return hash.digest('hex').slice(0, 24);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function generateAndStore({ prompt, fileName }) {
  const directory = imagesDir();
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, fileName);
  const response = await openai.images.generate({
    model: config.OPENAI_IMAGE_MODEL,
    prompt,
    size: config.OPENAI_IMAGE_SIZE,
    quality: config.OPENAI_IMAGE_QUALITY,
    n: 1,
  });
  const item = response.data?.[0];
  const b64 = item?.b64_json;
  if (b64) {
    await writeFile(target, Buffer.from(b64, 'base64'));
    return { ok: true, file: target };
  }
  if (item?.url) {
    const fetched = await fetch(item.url);
    if (!fetched.ok) throw new Error(`image_url_fetch_failed_${fetched.status}`);
    await writeFile(target, Buffer.from(await fetched.arrayBuffer()));
    return { ok: true, file: target };
  }
  throw new Error('image_response_missing_data');
}

export async function generateNicheImageUrl(prompt, { seed = 0, niche = '', size = config.OPENAI_IMAGE_SIZE } = {}) {
  const safePrompt = String(prompt || '').trim();
  if (!safePrompt) return '';
  if (!openai) return fallbackImageUrl(safePrompt, seed);

  const hash = promptHash([safePrompt, niche, size, seed, config.OPENAI_IMAGE_MODEL, config.OPENAI_IMAGE_QUALITY]);
  const fileName = `${hash}.png`;
  const target = path.join(imagesDir(), fileName);
  if (await fileExists(target)) return publicUrlFor(fileName);

  if (inFlight.has(hash)) {
    try {
      await inFlight.get(hash);
      return publicUrlFor(fileName);
    } catch {
      return fallbackImageUrl(safePrompt, seed);
    }
  }

  const promise = generateAndStore({ prompt: safePrompt, fileName }).finally(() => inFlight.delete(hash));
  inFlight.set(hash, promise);
  try {
    await promise;
    return publicUrlFor(fileName);
  } catch (error) {
    console.warn('imageGenerator: gpt-image generation failed, falling back to pollinations.ai', error.message);
    return fallbackImageUrl(safePrompt, seed);
  }
}

export function imagesPublicMount() {
  return {
    route: '/generated-images',
    directory: imagesDir(),
  };
}

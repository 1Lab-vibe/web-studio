import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

function safeName(value) {
  return String(value || 'lead')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function renderDir(lead) {
  return path.resolve(config.DATA_DIR, 'renders', `${safeName(lead.id)}-${safeName(lead.name)}`);
}

async function ffmpegAvailable() {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

async function captureScreenshots(lead, url, dir) {
  const count = Math.max(1, Math.min(8, Number(config.FILMER_SCREENSHOT_COUNT) || 5));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const shots = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const scrollHeight = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
    const maxScroll = Math.max(0, scrollHeight - 1920);
    for (let index = 0; index < count; index += 1) {
      const y = count === 1 ? 0 : Math.round((maxScroll * index) / (count - 1));
      await page.evaluate((scrollY) => window.scrollTo({ top: scrollY, behavior: 'instant' }), y);
      await page.waitForTimeout(500);
      const shotPath = path.join(dir, `shot-${String(index + 1).padStart(2, '0')}.png`);
      await page.screenshot({ path: shotPath, fullPage: false });
      shots.push(shotPath);
    }
  } finally {
    await browser.close();
  }
  return shots;
}

async function makeVideo(shots, dir) {
  const duration = Math.max(2, Number(config.FILMER_VIDEO_SECONDS) || 10);
  const perShot = Math.max(1, duration / Math.max(1, shots.length));
  const listPath = path.join(dir, 'frames.txt');
  const videoPath = path.join(dir, 'video.mp4');
  const list = [
    ...shots.flatMap((shot) => [`file '${shot.replaceAll("'", "'\\''")}'`, `duration ${perShot.toFixed(2)}`]),
    `file '${shots.at(-1).replaceAll("'", "'\\''")}'`,
  ].join('\n');
  await writeFile(listPath, list, 'utf8');
  await execFileAsync(
    'ffmpeg',
    ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-vf', 'fps=30,format=yuv420p', '-movflags', '+faststart', videoPath],
    { timeout: 120000, maxBuffer: 1024 * 1024 * 5 },
  );
  return videoPath;
}

export async function renderLeadVideo(lead) {
  if (!config.FILMER_ENABLED) {
    return { ok: false, skipped: true, reason: 'FILMER_ENABLED is false' };
  }
  const url = lead.mockup?.url || lead.mockup?.previewUrl || '';
  if (!url) {
    return { ok: false, skipped: false, reason: 'Lovable preview URL is missing' };
  }
  if (!(await ffmpegAvailable())) {
    return { ok: false, skipped: false, reason: 'ffmpeg is not installed in the container' };
  }

  const dir = renderDir(lead);
  await mkdir(dir, { recursive: true });
  const screenshots = await captureScreenshots(lead, url, dir);
  const video = await makeVideo(screenshots, dir);
  const publicBase = `/renders/${path.basename(dir)}`;
  return {
    ok: true,
    sourceUrl: url,
    screenshots: screenshots.map((shot) => `${publicBase}/${path.basename(shot)}`),
    videoUrl: `${publicBase}/${path.basename(video)}`,
    durationSeconds: Math.max(2, Number(config.FILMER_VIDEO_SECONDS) || 10),
    resolution: '1080x1920',
    updatedAt: new Date().toISOString(),
  };
}

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { withBrowserContext } from './browserPool.js';

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

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

async function captureScrollFrames(lead, url, dir) {
  const screenshotCount = Math.max(1, Math.min(8, Number(config.FILMER_SCREENSHOT_COUNT) || 5));
  const duration = Math.max(2, Number(config.FILMER_VIDEO_SECONDS) || 10);
  const frameCount = Math.max(30, Math.min(180, Math.round(duration * 12)));
  const frames = [];
  const screenshots = [];
  await withBrowserContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 }, async (context) => {
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    const status = response?.status() ?? 0;
    const currentUrl = page.url();
    const title = await page.title().catch(() => '');
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const forbidden = status >= 400 || /403|forbidden|auth-bridge|sign in|login/i.test(`${status} ${currentUrl} ${title} ${bodyText.slice(0, 300)}`);
    if (forbidden) {
      throw new Error(`Preview is not publicly renderable from server: status=${status}, url=${currentUrl}, title=${title || 'empty'}`);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const scrollHeight = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
    const maxScroll = Math.max(0, scrollHeight - 1920);
    const screenshotEvery = Math.max(1, Math.floor(frameCount / screenshotCount));
    for (let index = 0; index < frameCount; index += 1) {
      const progress = frameCount === 1 ? 0 : index / (frameCount - 1);
      const y = Math.round(maxScroll * easeInOutCubic(progress));
      await page.evaluate((scrollY) => window.scrollTo({ top: scrollY, behavior: 'instant' }), y);
      await page.waitForTimeout(40);
      const framePath = path.join(dir, `frame-${String(index + 1).padStart(4, '0')}.png`);
      await page.screenshot({ path: framePath, fullPage: false });
      frames.push(framePath);
      if (screenshots.length < screenshotCount && (index % screenshotEvery === 0 || index === frameCount - 1)) {
        const shotPath = path.join(dir, `shot-${String(screenshots.length + 1).padStart(2, '0')}.png`);
        await page.screenshot({ path: shotPath, fullPage: false });
        screenshots.push(shotPath);
      }
    }
  });
  return { frames, screenshots };
}

async function makeVideo(frames, dir) {
  const duration = Math.max(2, Number(config.FILMER_VIDEO_SECONDS) || 10);
  const inputFps = Math.max(1, frames.length / duration);
  const videoPath = path.join(dir, 'video.mp4');
  await execFileAsync(
    'ffmpeg',
    ['-y', '-framerate', inputFps.toFixed(3), '-i', path.join(dir, 'frame-%04d.png'), '-vf', 'fps=30,format=yuv420p', '-movflags', '+faststart', videoPath],
    { timeout: 120000, maxBuffer: 1024 * 1024 * 5 },
  );
  return videoPath;
}

export async function renderLeadVideo(lead) {
  if (!config.FILMER_ENABLED) {
    return { ok: false, skipped: true, reason: 'FILMER_ENABLED is false' };
  }
  const url = lead.mockup?.publishedUrl || lead.mockup?.url || lead.mockup?.previewUrl || '';
  if (!url) {
    return { ok: false, skipped: false, reason: 'Lovable preview URL is missing' };
  }
  if (!(await ffmpegAvailable())) {
    return { ok: false, skipped: false, reason: 'ffmpeg is not installed in the container' };
  }

  const dir = renderDir(lead);
  await mkdir(dir, { recursive: true });
  const { frames, screenshots } = await captureScrollFrames(lead, url, dir);
  const video = await makeVideo(frames, dir);
  const publicBase = `/renders/${path.basename(dir)}`;
  return {
    ok: true,
    sourceUrl: url,
    screenshots: screenshots.map((shot) => `${publicBase}/${path.basename(shot)}`),
    frames: frames.length,
    videoUrl: `${publicBase}/${path.basename(video)}`,
    durationSeconds: Math.max(2, Number(config.FILMER_VIDEO_SECONDS) || 10),
    resolution: '1080x1920',
    updatedAt: new Date().toISOString(),
  };
}

import { chromium } from 'playwright';
import { config } from '../config.js';

const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

let browserPromise = null;
let browser = null;
let activeCount = 0;
let idleTimer = null;

function idleMs() {
  return Math.max(60_000, Number(config.BROWSER_POOL_IDLE_MINUTES ?? 5) * 60_000);
}

async function launchBrowser() {
  const next = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  next.on('disconnected', () => {
    if (browser === next) {
      browser = null;
      browserPromise = null;
    }
  });
  return next;
}

async function getBrowser() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (browser?.isConnected()) return browser;
  if (!browserPromise) {
    browserPromise = launchBrowser().then((next) => {
      browser = next;
      return next;
    }).catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

function scheduleIdleClose() {
  if (idleTimer || activeCount > 0) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (activeCount > 0) return;
    const target = browser;
    browser = null;
    browserPromise = null;
    if (target?.isConnected()) target.close().catch(() => {});
  }, idleMs());
}

export async function withBrowserContext(options, callback) {
  activeCount += 1;
  let context;
  try {
    const instance = await getBrowser();
    context = await instance.newContext(options || {});
    return await callback(context);
  } finally {
    if (context) await context.close().catch(() => {});
    activeCount = Math.max(0, activeCount - 1);
    scheduleIdleClose();
  }
}

export async function withBrowserPage(options, callback) {
  return withBrowserContext(options, async (context) => {
    const page = await context.newPage();
    return callback(page, context);
  });
}

export async function shutdownBrowserPool() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const target = browser;
  browser = null;
  browserPromise = null;
  if (target?.isConnected()) await target.close().catch(() => {});
}

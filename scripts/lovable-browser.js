import 'dotenv/config';
import { chromium } from 'playwright';
import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from '../server/config.js';

const mode = process.argv[2] || 'help';
const leadId = process.argv[3] || process.env.LEAD_ID || '';

function bool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

async function browserContext() {
  const storageStatePath = path.resolve(config.LOVABLE_STORAGE_STATE);
  await mkdir(path.dirname(storageStatePath), { recursive: true });
  const launchOptions = {
    headless: bool(process.env.LOVABLE_HEADLESS || config.LOVABLE_HEADLESS),
  };
  if (config.LOVABLE_BROWSER_CHANNEL) {
    launchOptions.channel = config.LOVABLE_BROWSER_CHANNEL;
  }

  if (config.LOVABLE_USE_CHROME_PROFILE) {
    const userDataDir =
      config.LOVABLE_CHROME_USER_DATA_DIR ||
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      args: [`--profile-directory=${config.LOVABLE_CHROME_PROFILE}`],
    });
    return { browser: context.browser(), context, storageStatePath };
  }

  const browser = await chromium.launch(launchOptions);
  const contextOptions = {};
  try {
    await access(storageStatePath);
    contextOptions.storageState = storageStatePath;
  } catch {
    // First login has no storage state yet.
  }
  const context = await browser.newContext(contextOptions);
  return { browser, context, storageStatePath };
}

async function login() {
  const { browser, context, storageStatePath } = await browserContext();
  const page = await context.newPage();
  await page.goto('https://lovable.dev', { waitUntil: 'domcontentloaded' });
  console.log('Lovable opened. Log in manually if needed, then return here.');
  console.log('Saving browser session every 5 seconds for 120 seconds...');
  for (let i = 0; i < 24; i += 1) {
    try {
      await page.waitForTimeout(5_000);
      await context.storageState({ path: storageStatePath });
      console.log(`Saved Lovable session checkpoint ${i + 1}/24`);
    } catch (error) {
      console.log(`Browser closed before final checkpoint: ${error.message}`);
      break;
    }
  }
  console.log(`Saved Lovable session to ${storageStatePath}`);
  await browser?.close().catch(() => null);
}

function chromePath() {
  return (
    process.env.CHROME_PATH ||
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  );
}

function chromeUserDataDir() {
  return (
    config.LOVABLE_CHROME_USER_DATA_DIR ||
    path.join(process.cwd(), 'data', 'lovable-chrome-profile')
  );
}

async function openChromeForCdp() {
  const args = [
    `--remote-debugging-port=${new URL(config.LOVABLE_CDP_URL).port || '9222'}`,
    '--remote-debugging-address=127.0.0.1',
    `--profile-directory=${config.LOVABLE_CHROME_PROFILE}`,
    `--user-data-dir=${path.resolve(chromeUserDataDir())}`,
    'https://lovable.dev',
  ];
  const child = spawn(chromePath(), args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log('Opened real Chrome with remote debugging.');
  console.log(`Chrome user data dir: ${path.resolve(chromeUserDataDir())}`);
  console.log(`CDP URL: ${config.LOVABLE_CDP_URL}`);
}

async function connectCdp() {
  const storageStatePath = path.resolve(config.LOVABLE_STORAGE_STATE);
  await mkdir(path.dirname(storageStatePath), { recursive: true });
  const browser = await chromium.connectOverCDP(config.LOVABLE_CDP_URL);
  const context = browser.contexts()[0] || (await browser.newContext());
  return { browser, context, storageStatePath };
}

async function captureCdpSession() {
  const { browser, context, storageStatePath } = await connectCdp();
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://lovable.dev', { waitUntil: 'domcontentloaded' }).catch(() => null);
  await page.waitForTimeout(2_000);
  await context.storageState({ path: storageStatePath });
  console.log(`Captured Lovable/Chrome session to ${storageStatePath}`);
  await browser.close();
}

async function fetchPrompt() {
  if (!leadId) throw new Error('Pass lead id: npm run lovable:create -- <leadId>');
  const response = await fetch(`http://127.0.0.1:${config.PORT}/api/leads`);
  if (!response.ok) throw new Error(`Cannot read leads: ${response.status}`);
  const data = await response.json();
  const lead = data.data.find((item) => item.id === leadId);
  if (!lead) throw new Error(`Lead not found: ${leadId}`);
  return [
    `Build a Lovable landing page for Russian local business "${lead.name}".`,
    `City: ${lead.city}. Niche: ${lead.niche}.`,
    `Hero angle: ${lead.angle || 'show trust and generate a direct lead request'}.`,
    `Diagnosis: ${lead.diagnosis || 'The Yandex Maps card is stronger than the current web presence.'}`,
    `Tone: ${lead.tone || 'specific, calm, practical'}.`,
    '',
    'Requirements:',
    '- Russian language landing page for a local business.',
    '- No marketing filler or generic SaaS sections.',
    '- First viewport: clear offer, trust from Yandex Maps, fast contact action.',
    '- Sections: proof/reviews, services, portfolio or before-after, process, request form, contacts.',
    '- Mobile-first, fast, easy to edit in Lovable.',
  ].join('\n');
}

async function createProject() {
  const prompt = await fetchPrompt();
  const useCdp = process.env.LOVABLE_USE_CDP === 'true';
  const { browser, context } = useCdp ? await connectCdp() : await browserContext();
  const page = await context.newPage();
  await page.goto('https://lovable.dev', { waitUntil: 'domcontentloaded' });

  const textArea = page.locator('textarea').first();
  await textArea.waitFor({ timeout: 60_000 });
  await textArea.fill(prompt);
  await page.keyboard.press('Control+Enter').catch(() => null);
  console.log('Prompt inserted into Lovable. If submission did not start, press the visible send button manually.');
  console.log('Prompt:');
  console.log(prompt);
  await page.waitForTimeout(60_000);
  await browser.close().catch(() => null);
}

if (mode === 'chrome') {
  await openChromeForCdp();
} else if (mode === 'capture') {
  await captureCdpSession();
} else if (mode === 'login') {
  await login();
} else if (mode === 'create') {
  await createProject();
} else {
  console.log('Usage:');
  console.log('  npm run lovable:chrome');
  console.log('  npm run lovable:capture');
  console.log('  npm run lovable:login');
  console.log('  npm run lovable:create -- <leadId>');
}

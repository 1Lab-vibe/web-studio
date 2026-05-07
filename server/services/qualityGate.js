import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../config.js';

export async function runPreviewQualityGate(lead, { outputDir = path.resolve(config.DATA_DIR, 'renders') } = {}) {
  const url = absolutePublicUrl(lead.mockup?.publishedUrl || lead.mockup?.deployedUrl || lead.mockup?.publicUrl || lead.mockup?.url || '');
  const checkedAt = new Date().toISOString();
  const issues = [];
  const warnings = [];
  if (!url) {
    return { ok: false, checkedAt, url: '', issues: ['missing_preview_url'], warnings };
  }

  await mkdir(outputDir, { recursive: true });
  const badAssets = [];
  const consoleErrors = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300));
    });
    page.on('response', (response) => {
      const request = response.request();
      const type = request.resourceType();
      if (!['script', 'stylesheet'].includes(type)) return;
      const contentType = response.headers()['content-type'] || '';
      if (response.status() >= 400 || contentType.includes('text/html')) {
        badAssets.push({ url: response.url(), status: response.status(), type, contentType });
      }
    });

    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
    const status = response?.status() || 0;
    if (status !== 200) issues.push(`preview_status_${status || 'missing'}`);

    const bodyText = (await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '')).trim();
    if (bodyText.length < 80) issues.push('empty_or_too_short_body');
    if (/404|not found|page not found|react router/i.test(bodyText.slice(0, 1500))) issues.push('possible_router_404');

    const firstScreen = bodyText.slice(0, 1500).toLowerCase();
    const businessToken = String(lead.name || '').split(/\s+/).find((part) => part.length >= 4)?.toLowerCase();
    const nicheToken = String(lead.niche || '').split(/\s+/).find((part) => part.length >= 4)?.toLowerCase();
    if (businessToken && nicheToken && !firstScreen.includes(businessToken) && !firstScreen.includes(nicheToken)) {
      issues.push('first_screen_missing_business_or_offer');
    }
    if (badAssets.length) issues.push('broken_or_wrong_mime_assets');
    if (consoleErrors.length) warnings.push('console_errors');

    const screenshotName = `quality-${lead.id}-mobile.png`;
    await page.screenshot({ path: path.join(outputDir, screenshotName), fullPage: false });
    return {
      ok: issues.length === 0,
      checkedAt,
      url,
      status,
      bodyLength: bodyText.length,
      issues,
      warnings,
      badAssets: badAssets.slice(0, 10),
      consoleErrors: consoleErrors.slice(0, 5),
      screenshotUrl: `/renders/${screenshotName}`,
    };
  } catch (error) {
    return { ok: false, checkedAt, url, issues: [error.message || 'quality_gate_failed'], warnings };
  } finally {
    await browser.close().catch(() => {});
  }
}

function absolutePublicUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  const base = String(config.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}${url.startsWith('/') ? '' : '/'}${url}` : url;
}

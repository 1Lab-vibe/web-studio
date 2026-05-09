import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../config.js';

export async function runPreviewQualityGate(lead, { outputDir = path.resolve(config.DATA_DIR, 'renders') } = {}) {
  const url = absolutePublicUrl(lead.mockup?.publishedUrl || lead.mockup?.deployedUrl || lead.mockup?.publicUrl || lead.mockup?.url || '');
  const checkedAt = new Date().toISOString();
  const issues = [];
  const warnings = [];
  const mockup = lead.mockup || {};
  if (mockup.clientSendAllowed === false) issues.push('preview_not_client_sendable');
  if (['build_failed', 'no_package_json'].includes(String(mockup.deploymentStrategy || ''))) {
    issues.push(`deployment_${mockup.deploymentStrategy}`);
  }
  if (['build_failed', 'internal_fallback_preview'].includes(String(mockup.status || ''))) {
    issues.push(`mockup_${mockup.status}`);
  }
  if (!url) {
    return { ok: false, checkedAt, url: '', issues: [...issues, 'missing_preview_url'], warnings };
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

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    const status = response?.status() || 0;
    if (status !== 200) issues.push(`preview_status_${status || 'missing'}`);

    const bodyText = (await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '')).trim();
    if (bodyText.length < 80) issues.push('empty_or_too_short_body');
    if (/404|not found|page not found|react router/i.test(bodyText.slice(0, 1500))) issues.push('possible_router_404');
    if (isBuildFailurePage(bodyText)) issues.push('build_failed_stub_page');

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

function isBuildFailurePage(text) {
  const sample = String(text || '').slice(0, 5000);
  return /Экспорт Lovable получен|локальная сборка проекта не прошла|Build failed|error during build|Command failed|Could not load|ENOENT|vite:asset|diagnostic page/i.test(sample);
}

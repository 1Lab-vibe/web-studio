import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { renderLeadVideo } from './filmer.js';
import { crmAddEvent, syncA1CrmLead } from './a1Client.js';
import { publishFilesToGitHub } from './githubPublisher.js';

const execFileAsync = promisify(execFile);

const cyrillicMap = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function translit(value) {
  return String(value || '')
    .toLowerCase()
    .split('')
    .map((char) => cyrillicMap[char] ?? char)
    .join('');
}

export function projectSlug(value, fallback = 'project') {
  return translit(value || fallback)
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
}

function projectUrl(slug) {
  return `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/projects/${slug}/`;
}

function sourceUrlForLead(lead, overrideUrl = '') {
  return overrideUrl || lead.mockup?.publishedUrl || lead.mockup?.url || lead.mockup?.previewUrl || '';
}

function safeProjectPath(root, filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0') || normalized.split('/').some((part) => part === '..')) return null;
  const target = path.resolve(root, normalized);
  if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) return null;
  return target;
}

function isPublishableSourceFile(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const base = path.basename(normalized).toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return false;
  if (/(^|\/)(node_modules|dist|build|\.git)\//.test(normalized)) return false;
  return true;
}

function injectBase(html, sourceUrl) {
  const baseTag = `<base href="${escapeHtml(sourceUrl)}">`;
  const marker = '<head>';
  if (html.includes('<base ')) return html;
  if (html.includes(marker)) return html.replace(marker, `${marker}\n    ${baseTag}`);
  return `${baseTag}\n${html}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function fallbackFrameHtml({ title, sourceUrl }) {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      html, body { margin: 0; width: 100%; min-height: 100%; background: #fff; }
      iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
    </style>
  </head>
  <body>
    <iframe src="${escapeHtml(sourceUrl)}" title="${escapeHtml(title)}" loading="eager"></iframe>
  </body>
</html>`;
}

async function capturePublicPage(sourceUrl) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1400 }, deviceScaleFactor: 1 });
    const response = await page.goto(sourceUrl, { waitUntil: 'networkidle', timeout: 90000 });
    const status = response?.status() ?? 0;
    const finalUrl = page.url();
    const title = (await page.title().catch(() => '')) || 'Web Studio project';
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const forbidden = status >= 400 || /403|forbidden|auth-bridge|sign in|login/i.test(`${status} ${finalUrl} ${title} ${bodyText.slice(0, 300)}`);
    if (forbidden) throw new Error(`Public URL is not renderable: status=${status}, url=${finalUrl}, title=${title}`);
    await page.waitForTimeout(750);
    const html = await page.content();
    return { ok: true, html: injectBase(html, finalUrl), title, finalUrl, status };
  } finally {
    await browser.close();
  }
}

export async function deployLeadPublicUrlProject(store, leadId, options = {}) {
  let lead = store.getLead(leadId);
  if (!lead) return { ok: false, error: 'Lead not found' };
  const sourceUrl = sourceUrlForLead(lead, options.url);
  if (!sourceUrl) return { ok: false, error: 'Lead has no public Lovable URL to deploy' };

  const slugBase = options.projectName || lead.mockup?.projectName || lead.name || lead.id;
  const slug = projectSlug(`${slugBase}-${lead.id.slice(0, 8)}`, `project-${lead.id.slice(0, 8)}`);
  const root = path.resolve(config.DATA_DIR, 'projects', slug);
  await mkdir(root, { recursive: true });

  let capture;
  let strategy = 'html_snapshot';
  try {
    capture = await capturePublicPage(sourceUrl);
  } catch (error) {
    strategy = 'iframe_fallback';
    capture = {
      ok: true,
      html: fallbackFrameHtml({ title: lead.name || 'Web Studio project', sourceUrl }),
      title: lead.name || 'Web Studio project',
      finalUrl: sourceUrl,
      warning: error.message,
    };
  }

  const publicUrl = projectUrl(slug);
  await writeFile(path.join(root, 'index.html'), capture.html, 'utf8');
  await writeFile(
    path.join(root, 'webstudio-project.json'),
    JSON.stringify(
      {
        leadId: lead.id,
        businessName: lead.name,
        city: lead.city,
        niche: lead.niche,
        sourceUrl,
        finalUrl: capture.finalUrl,
        publicUrl,
        strategy,
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  lead = await store.updateLead(lead.id, {
    mockup: {
      ...(lead.mockup ?? {}),
      ok: true,
      mode: 'coder_public_url_deploy',
      status: 'deployed',
      sourceUrl,
      lovableUrl: sourceUrl,
      publishedUrl: publicUrl,
      deployedUrl: publicUrl,
      publicUrl,
      projectSlug: slug,
      projectName: options.projectName || lead.mockup?.projectName || lead.name || '',
      deploymentStrategy: strategy,
      deploymentWarning: capture.warning || '',
      deployedAt: new Date().toISOString(),
    },
    lane: 'Видео',
    owner: 'Filmer',
    status: 'in_progress',
  });
  await store.addEvent(lead.id, 'project.deployed', `Coder deployed project from public URL: ${publicUrl}`);
  await crmAddEvent({
    entityType: lead.a1DealId ? 'deal' : 'lead',
    entityId: lead.a1DealId || lead.a1LeadId || lead.id,
    eventType: 'project.deployed',
    text: `Coder deployed project from public URL: ${publicUrl}`,
    payload: { webstudioLeadId: lead.id, publicUrl, sourceUrl, slug, strategy },
    idempotencyKey: `webstudio:${lead.id}:project.deployed:${slug}`,
  });

  const video = await renderLeadVideo(lead);
  if (!video.ok) {
    lead = await store.updateLead(lead.id, { video, status: 'needs_review' });
    await store.addEvent(lead.id, 'video.failed', `Filmer could not render Coder project: ${video.reason}`);
    await syncA1CrmLead(lead, 'project_deployed_video_failed');
    return { ok: false, publicUrl, slug, strategy, lead, video };
  }

  lead = await store.updateLead(lead.id, { video, lane: 'Проверка', owner: 'Checker', status: 'in_progress' });
  await store.addEvent(lead.id, 'video.created', `Filmer rendered Coder project: ${video.videoUrl}`);
  await store.addEvent(lead.id, 'lead.advanced', 'Lead moved to Checker after Coder deploy');
  await syncA1CrmLead(lead, 'project_deployed');
  return { ok: true, publicUrl, slug, strategy, lead };
}

async function writeSourceFiles(root, files) {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const written = [];
  for (const file of files) {
    if (file.binary || typeof file.content !== 'string') continue;
    if (!isPublishableSourceFile(file.path)) continue;
    const target = safeProjectPath(root, file.path);
    if (!target) throw new Error(`Unsafe project file path: ${file.path}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
    written.push(file.path);
  }
  return written;
}

async function buildSourceProject(sourceRoot, publicRoot) {
  await rm(publicRoot, { recursive: true, force: true });
  const packageJson = path.join(sourceRoot, 'package.json');
  try {
    await execFileAsync('npm', ['install'], { cwd: sourceRoot, timeout: 240000, maxBuffer: 1024 * 1024 * 20 });
    await execFileAsync('npm', ['run', 'build'], { cwd: sourceRoot, timeout: 240000, maxBuffer: 1024 * 1024 * 20 });
    const dist = path.join(sourceRoot, 'dist');
    await cp(dist, publicRoot, { recursive: true });
    return { ok: true, strategy: 'vite_build' };
  } catch (error) {
    await mkdir(publicRoot, { recursive: true });
    const hasPackage = await import('node:fs/promises').then((fs) => fs.access(packageJson).then(() => true).catch(() => false));
    return { ok: false, strategy: hasPackage ? 'build_failed' : 'no_package_json', error: error.message };
  }
}

export async function deployLeadExportedProject(store, leadId, { files = [], lovable = {}, projectName = '' } = {}) {
  let lead = store.getLead(leadId);
  if (!lead) return { ok: false, error: 'Lead not found' };
  if (!files.length) return { ok: false, error: 'No Lovable files to deploy' };

  const slugBase = projectName || lead.mockup?.projectName || lead.name || lead.id;
  const slug = projectSlug(`${slugBase}-${lead.id.slice(0, 8)}`, `project-${lead.id.slice(0, 8)}`);
  const sourceRoot = path.resolve(config.DATA_DIR, 'sources', slug);
  const publicRoot = path.resolve(config.DATA_DIR, 'projects', slug);
  const written = await writeSourceFiles(sourceRoot, files);
  const build = await buildSourceProject(sourceRoot, publicRoot);
  const publicUrl = projectUrl(slug);
  const repoName = `${config.GITHUB_REPO_PREFIX}${slug}`.slice(0, 100).replace(/-+$/g, '');
  const github = await publishFilesToGitHub({
    repoName,
    description: `Web Studio landing for ${lead.name}`,
    files,
    metadata: { leadId: lead.id, businessName: lead.name, lovableProjectId: lovable.projectId, publicUrl },
  }).catch((error) => ({ ok: false, error: error.message }));

  if (!build.ok) {
    await writeFile(
      path.join(publicRoot, 'index.html'),
      fallbackFrameHtml({ title: lead.name || 'Web Studio project', sourceUrl: lovable.publishedUrl || lovable.previewUrl || lovable.editorUrl || '' }),
      'utf8',
    );
  }
  await writeFile(
    path.join(publicRoot, 'webstudio-project.json'),
    JSON.stringify(
      {
        leadId: lead.id,
        businessName: lead.name,
        city: lead.city,
        niche: lead.niche,
        publicUrl,
        slug,
        sourceFiles: written.length,
        build,
        github,
        lovable,
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  lead = await store.updateLead(lead.id, {
    mockup: {
      ...(lead.mockup ?? {}),
      ok: true,
      mode: 'lovable_official_mcp_export',
      status: 'deployed',
      publishedUrl: publicUrl,
      deployedUrl: publicUrl,
      publicUrl,
      projectSlug: slug,
      sourceRoot,
      sourceFiles: written.length,
      deploymentStrategy: build.strategy,
      deploymentWarning: build.ok ? '' : build.error,
      github,
      lovable,
      deployedAt: new Date().toISOString(),
    },
    lane: 'Видео',
    owner: 'Filmer',
    status: 'in_progress',
  });

  await store.addEvent(lead.id, 'project.deployed', `Coder deployed Lovable export: ${publicUrl}`);
  await crmAddEvent({
    entityType: lead.a1DealId ? 'deal' : 'lead',
    entityId: lead.a1DealId || lead.a1LeadId || lead.id,
    eventType: 'project.deployed',
    text: `Coder deployed Lovable export: ${publicUrl}`,
    payload: { webstudioLeadId: lead.id, publicUrl, slug, github, lovable, build },
    idempotencyKey: `webstudio:${lead.id}:project.deployed:${slug}`,
  });

  const video = await renderLeadVideo(lead);
  if (!video.ok) {
    lead = await store.updateLead(lead.id, { video, status: 'needs_review' });
    await store.addEvent(lead.id, 'video.failed', `Filmer could not render exported project: ${video.reason}`);
    await syncA1CrmLead(lead, 'project_deployed_video_failed');
    return { ok: false, publicUrl, slug, github, build, lead, video };
  }
  lead = await store.updateLead(lead.id, { video, lane: 'Проверка', owner: 'Checker', status: 'in_progress' });
  await store.addEvent(lead.id, 'video.created', `Filmer rendered exported project: ${video.videoUrl}`);
  await syncA1CrmLead(lead, 'project_deployed');
  return { ok: true, publicUrl, slug, github, build, lead };
}

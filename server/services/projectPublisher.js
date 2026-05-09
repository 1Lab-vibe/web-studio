import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

function compactStoredMockup(mockup = {}) {
  const {
    files,
    raw,
    create,
    project,
    content,
    html,
    source,
    ...rest
  } = mockup || {};
  return {
    ...rest,
    filesCount: Array.isArray(files) ? files.length : Number(mockup?.filesCount ?? 0) || 0,
  };
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

function buildFailedHtml({ title, build }) {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; background: #f8fafc; }
      main { width: min(760px, calc(100vw - 32px)); padding: 28px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
      h1 { margin: 0 0 12px; font-size: 24px; }
      p { margin: 0 0 14px; color: #475569; }
      pre { overflow: auto; max-height: 360px; padding: 14px; border-radius: 6px; background: #111827; color: #e5e7eb; font-size: 12px; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>Экспорт Lovable получен, но локальная сборка проекта не прошла. Coder сохранил исходники и GitHub-репозиторий для ручной диагностики.</p>
      <pre>${escapeHtml(build?.error || 'Build failed')}</pre>
    </main>
  </body>
</html>`;
}

function generatedPreviewHtml(lead) {
  const brief = lead.customerBrief ?? {};
  const business = lead.name || brief.businessName || 'Ваш бизнес';
  const niche = lead.niche || 'услуги для бизнеса';
  const goal = brief.goal || 'получать больше целевых заявок';
  const services = splitItems(brief.services || niche);
  const contacts = brief.contacts || 'форма заявки, телефон, email';
  const style = brief.style || 'современный, аккуратный, быстрый';
  const proof = brief.materials || 'показываем кейсы, подход и понятный следующий шаг';
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(business)}</title>
    <style>
      :root { color-scheme: dark; --bg: #0b0d12; --panel: #121722; --text: #f6f7fb; --muted: #aeb7c8; --line: #273144; --accent: #55d6be; --accent2: #ffcf5a; }
      * { box-sizing: border-box; }
      body { margin: 0; font: 16px/1.55 Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: var(--bg); letter-spacing: 0; }
      a { color: inherit; }
      .wrap { width: min(1120px, calc(100% - 32px)); margin: 0 auto; }
      header { position: sticky; top: 0; z-index: 2; border-bottom: 1px solid rgba(255,255,255,.08); background: rgba(11,13,18,.9); backdrop-filter: blur(16px); }
      nav { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
      .brand { font-weight: 800; font-size: 18px; }
      .nav-note { color: var(--muted); font-size: 14px; }
      .hero { min-height: 82vh; display: grid; align-items: center; padding: 64px 0 48px; border-bottom: 1px solid var(--line); }
      .hero-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(320px, .85fr); gap: 48px; align-items: center; }
      .eyebrow { color: var(--accent); font-weight: 700; text-transform: uppercase; font-size: 13px; }
      h1 { margin: 14px 0 18px; font-size: clamp(42px, 7vw, 82px); line-height: .96; letter-spacing: 0; max-width: 900px; }
      .lead { color: var(--muted); font-size: clamp(18px, 2vw, 22px); max-width: 760px; }
      .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 30px; }
      .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; padding: 0 18px; border: 1px solid var(--line); border-radius: 6px; text-decoration: none; font-weight: 750; }
      .btn.primary { background: var(--accent); color: #06110f; border-color: var(--accent); }
      .panel { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 22px; }
      .metric { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 18px; }
      .metric div { border: 1px solid var(--line); border-radius: 6px; padding: 14px; }
      .metric b { display: block; color: var(--accent2); font-size: 24px; line-height: 1; margin-bottom: 8px; }
      section { padding: 72px 0; border-bottom: 1px solid var(--line); }
      h2 { margin: 0 0 22px; font-size: clamp(28px, 4vw, 48px); line-height: 1.05; }
      .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
      .card { border: 1px solid var(--line); border-radius: 8px; padding: 20px; background: #10151f; min-height: 148px; }
      .card b { display: block; margin-bottom: 10px; font-size: 18px; }
      .muted { color: var(--muted); }
      .steps { display: grid; gap: 12px; counter-reset: step; }
      .step { display: grid; grid-template-columns: 48px 1fr; gap: 16px; align-items: start; padding: 18px; border: 1px solid var(--line); border-radius: 8px; background: #10151f; }
      .step::before { counter-increment: step; content: counter(step); display: grid; place-items: center; width: 40px; height: 40px; border-radius: 999px; background: var(--accent); color: #06110f; font-weight: 900; }
      form { display: grid; gap: 12px; }
      input, textarea { width: 100%; border: 1px solid var(--line); background: #0b0f17; color: var(--text); border-radius: 6px; padding: 14px 16px; font: inherit; }
      textarea { min-height: 120px; resize: vertical; }
      footer { padding: 32px 0; color: var(--muted); }
      @media (max-width: 820px) { .hero-grid, .grid { grid-template-columns: 1fr; } h1 { font-size: 44px; } .nav-note { display: none; } }
    </style>
  </head>
  <body>
    <header><nav class="wrap"><div class="brand">${escapeHtml(business)}</div><div class="nav-note">${escapeHtml(niche)}</div></nav></header>
    <main>
      <section class="hero">
        <div class="wrap hero-grid">
          <div>
            <div class="eyebrow">Первое превью сайта</div>
            <h1>${escapeHtml(business)}</h1>
            <p class="lead">Сайт для задачи: ${escapeHtml(goal)}. Стиль: ${escapeHtml(style)}.</p>
            <div class="actions">
              <a class="btn primary" href="#request">Обсудить проект</a>
              <a class="btn" href="#services">Посмотреть услуги</a>
            </div>
          </div>
          <aside class="panel">
            <b>Что важно показать сразу</b>
            <p class="muted">${escapeHtml(proof)}</p>
            <div class="metric">
              <div><b>2 дня</b><span class="muted">до первого рабочего варианта</span></div>
              <div><b>30 000 ₽</b><span class="muted">старт для сайта-визитки</span></div>
            </div>
          </aside>
        </div>
      </section>
      <section id="services"><div class="wrap"><h2>Ключевые направления</h2><div class="grid">${services.map((item) => `<article class="card"><b>${escapeHtml(item)}</b><p class="muted">Коротко объясняем ценность, результат и следующий шаг для клиента.</p></article>`).join('')}</div></div></section>
      <section><div class="wrap"><h2>Как будет устроен запуск</h2><div class="steps"><div class="step"><div><b>Уточняем задачу</b><p class="muted">Собираем цели, услуги, стиль, контакты и ограничения.</p></div></div><div class="step"><div><b>Собираем рабочий сайт</b><p class="muted">Делаем структуру, тексты, форму заявки и адаптивную верстку.</p></div></div><div class="step"><div><b>Вносим правки через бота</b><p class="muted">После запуска можно писать обычным текстом или голосом, что поменять.</p></div></div></div></div></section>
      <section id="request"><div class="wrap hero-grid"><div><h2>Заявка на проект</h2><p class="muted">Контакты и поля формы: ${escapeHtml(contacts)}.</p></div><form><input placeholder="Имя"><input placeholder="Телефон или email"><textarea placeholder="Коротко опишите задачу"></textarea><button class="btn primary" type="button">Отправить заявку</button></form></div></section>
    </main>
    <footer><div class="wrap">Превью подготовлено Web Studio Coder на основе клиентского ТЗ.</div></footer>
  </body>
</html>`;
}

function splitItems(value) {
  const items = String(value || '')
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6);
  return items.length ? items : ['Главная услуга', 'Консультация', 'Заявка'];
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
      ...compactStoredMockup(lead.mockup),
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

  if (options.renderVideo === false) {
    await syncA1CrmLead(lead, 'project_deployed');
    return { ok: true, publicUrl, slug, strategy, lead, videoQueued: true };
  }

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

export async function deployLeadGeneratedPreview(store, leadId, options = {}) {
  let lead = store.getLead(leadId);
  if (!lead) return { ok: false, error: 'Lead not found' };
  const slugBase = options.projectName || lead.name || lead.id;
  const slug = projectSlug(`${slugBase}-${lead.id.slice(0, 8)}`, `project-${lead.id.slice(0, 8)}`);
  const root = path.resolve(config.DATA_DIR, 'projects', slug);
  const publicUrl = projectUrl(slug);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const html = generatedPreviewHtml(lead);
  const files = [
    { path: 'index.html', content: html },
    {
      path: 'webstudio-project.json',
      content: JSON.stringify(
        {
          leadId: lead.id,
          businessName: lead.name,
          city: lead.city,
          niche: lead.niche,
          publicUrl,
          slug,
          strategy: 'coder_generated_preview',
          fallbackReason: options.reason || '',
          deployedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    },
  ];
  for (const file of files) await writeFile(path.join(root, file.path), file.content, 'utf8');

  const repoName = `${config.GITHUB_REPO_PREFIX}${slug}`.slice(0, 100).replace(/-+$/g, '');
  const github = await publishFilesToGitHub({
    repoName,
    description: `Web Studio generated preview for ${lead.name}`,
    files,
    metadata: { leadId: lead.id, businessName: lead.name, publicUrl, fallbackReason: options.reason || '' },
  }).catch((error) => ({ ok: false, error: error.message }));

  lead = await store.updateLead(lead.id, {
    mockup: {
      ...compactStoredMockup(lead.mockup),
      ok: true,
      mode: 'coder_generated_preview',
      status: 'internal_fallback_preview',
      publishedUrl: publicUrl,
      deployedUrl: publicUrl,
      publicUrl,
      projectSlug: slug,
      projectName: options.projectName || lead.name || '',
      deploymentStrategy: 'coder_generated_preview',
      deploymentWarning: options.reason || '',
      clientSendAllowed: false,
      github,
      deployedAt: new Date().toISOString(),
    },
    lane: 'Lovable',
    owner: 'Builder',
    status: 'needs_lovable_preview',
  });
  await store.addEvent(lead.id, 'project.internal_fallback_preview', `Coder generated internal fallback preview: ${publicUrl}`);
  await crmAddEvent({
    entityType: lead.a1DealId ? 'deal' : 'lead',
    entityId: lead.a1DealId || lead.a1LeadId || lead.id,
    eventType: 'project.internal_fallback_preview',
    text: `Coder generated internal fallback preview: ${publicUrl}`,
    payload: { webstudioLeadId: lead.id, publicUrl, slug, github, fallbackReason: options.reason || '' },
    idempotencyKey: `webstudio:${lead.id}:project.deployed:${slug}`,
  });

  if (options.renderVideo === false) {
    await syncA1CrmLead(lead, 'generated_preview_deployed');
    return { ok: true, publicUrl, slug, github, lead, videoQueued: true };
  }

  const video = await renderLeadVideo(lead);
  if (!video.ok) {
    lead = await store.updateLead(lead.id, { video, status: 'needs_review' });
    await store.addEvent(lead.id, 'video.failed', `Filmer could not render generated preview: ${video.reason}`);
    await syncA1CrmLead(lead, 'generated_preview_video_failed');
    return { ok: false, publicUrl, slug, github, lead, video };
  }
  lead = await store.updateLead(lead.id, { video, lane: 'Проверка', owner: 'Checker', status: 'in_progress' });
  await store.addEvent(lead.id, 'video.created', `Filmer rendered generated preview: ${video.videoUrl}`);
  await syncA1CrmLead(lead, 'generated_preview_deployed');
  return { ok: true, publicUrl, slug, github, lead };
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

async function buildSourceProject(sourceRoot, publicRoot, basePath = '') {
  await rm(publicRoot, { recursive: true, force: true });
  const packageJson = path.join(sourceRoot, 'package.json');
  try {
    const env = { ...process.env, NODE_ENV: 'development', NPM_CONFIG_PRODUCTION: 'false' };
    await execFileAsync('npm', ['install', '--include=dev'], { cwd: sourceRoot, env, timeout: 240000, maxBuffer: 1024 * 1024 * 20 });
    const buildArgs = ['run', 'build'];
    if (basePath) buildArgs.push('--', '--base', basePath);
    await execFileAsync('npm', buildArgs, { cwd: sourceRoot, env, timeout: 240000, maxBuffer: 1024 * 1024 * 20 });
    const dist = path.join(sourceRoot, 'dist');
    await cp(dist, publicRoot, { recursive: true });
    return { ok: true, strategy: 'vite_build' };
  } catch (error) {
    await mkdir(publicRoot, { recursive: true });
    const hasPackage = await import('node:fs/promises').then((fs) => fs.access(packageJson).then(() => true).catch(() => false));
    return { ok: false, strategy: hasPackage ? 'build_failed' : 'no_package_json', error: error.message };
  }
}

async function repairAndBuildSourceProject(sourceRoot, publicRoot, basePath = '', lead = {}) {
  const repairs = [];
  const duplicateRepair = await repairDuplicateRemoteImageConstants(sourceRoot, lead);
  if (duplicateRepair.ok) repairs.push(duplicateRepair);
  let build = await buildSourceProject(sourceRoot, publicRoot, basePath);
  for (let attempt = 0; !build.ok && attempt < 10; attempt += 1) {
    const repair = await repairMissingAssetImports(sourceRoot, build.error || '', lead);
    if (!repair.ok) break;
    repairs.push(repair);
    build = await buildSourceProject(sourceRoot, publicRoot, basePath);
  }
  return { ...build, repairs };
}

async function repairMissingAssetImports(sourceRoot, buildError, lead = {}) {
  const matches = [...String(buildError || '').matchAll(/Could not load\s+(.+?)\s+\(imported by\s+([^)]+)\)/g)];
  const repaired = [];
  for (const match of matches) {
    const missingPath = path.resolve(match[1].trim());
    const importer = safeProjectPath(sourceRoot, match[2].trim());
    if (!importer) continue;
    let content = '';
    try {
      content = await readFile(importer, 'utf8');
    } catch {
      continue;
    }
    const escapedMissing = escapeRegExp(missingPath.replaceAll('\\', '/').split('/').pop() || '');
    if (!escapedMissing) continue;
    const replacementUrl = imageRepairUrlV2(lead, `${path.basename(missingPath)} ${path.basename(importer)} ${content.slice(0, 300)}`);
    const next = content.replace(
      new RegExp(`import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+["'][^"']*${escapedMissing}["'];?`, 'g'),
      `const $1 = "${replacementUrl}";`,
    );
    if (next !== content) {
      await writeFile(importer, next, 'utf8');
      repaired.push({ importer: path.relative(sourceRoot, importer), missing: path.relative(sourceRoot, missingPath), strategy: 'replace_import_with_remote_image' });
      continue;
    }

    const created = await createPlaceholderAsset(missingPath);
    if (created.ok) repaired.push({ importer: path.relative(sourceRoot, importer), missing: path.relative(sourceRoot, missingPath), strategy: created.strategy });
  }
  return repaired.length ? { ok: true, repaired } : { ok: false, reason: 'no_repairable_missing_asset_imports' };
}

async function repairDuplicateRemoteImageConstants(sourceRoot, lead = {}) {
  const files = await listSourceCodeFiles(path.join(sourceRoot, 'src'));
  const repaired = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8').catch(() => '');
    if (!content.includes('images.unsplash.com') && !content.includes('image.pollinations.ai')) continue;
    let ordinal = 0;
    let next = content;
    const matches = [...content.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*["'](?:https:\/\/images\.unsplash\.com|https:\/\/image\.pollinations\.ai)\/[^"']+["'];/g)];
    for (const match of matches) {
      const [statement, variableName] = match;
      const url = imageRepairUrlV2(lead, `${variableName} ${path.basename(file)}`, ordinal);
      const asset = await materializeRepairImage(sourceRoot, file, variableName, url);
      ordinal += 1;
      repaired.push({ file: path.relative(sourceRoot, file), variableName, strategy: asset.ok ? 'generated_local_image_asset' : 'generated_remote_image_url', url: asset.url });
      next = next.replace(statement, `const ${variableName} = ${asset.expression};`);
    }
    if (next !== content) await writeFile(file, next, 'utf8');
  }
  return repaired.length ? { ok: true, repaired } : { ok: false, reason: 'no_duplicate_remote_image_constants' };
}

async function materializeRepairImage(sourceRoot, importerFile, variableName, url) {
  const fileName = `webstudio-${variableName.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}.png`;
  const assetPath = path.join(sourceRoot, 'src', 'assets', fileName);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.startsWith('image/')) throw new Error(`image_fetch_failed_${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length < 1024) throw new Error('image_fetch_empty_body');
    await mkdir(path.dirname(assetPath), { recursive: true });
    await writeFile(assetPath, body);
    const relative = path.relative(path.dirname(importerFile), assetPath).replace(/\\/g, '/');
    const importPath = relative.startsWith('.') ? relative : `./${relative}`;
    return { ok: true, url, expression: `new URL("${importPath}", import.meta.url).href` };
  } catch {
    return { ok: false, url, expression: `"${url}"` };
  }
}

async function listSourceCodeFiles(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'build', '.git'].includes(entry.name)) continue;
      files.push(...(await listSourceCodeFiles(fullPath)));
    } else if (/\.(tsx|ts|jsx|js|css)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function createPlaceholderAsset(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.svg') {
    await writeFile(filePath, `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#111827"/><circle cx="1220" cy="260" r="260" fill="#334155"/><rect x="120" y="620" width="980" height="90" rx="24" fill="#e5e7eb" opacity=".18"/></svg>`, 'utf8');
    return { ok: true, strategy: 'created_svg_placeholder' };
  }
  if (['.jpg', '.jpeg'].includes(ext)) {
    await writeFile(filePath, Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Ap//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QE//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QE//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QE//Z', 'base64'));
    return { ok: true, strategy: 'created_jpeg_placeholder' };
  }
  await writeFile(filePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3ScwAAAABJRU5ErkJggg==', 'base64'));
  return { ok: true, strategy: 'created_png_placeholder' };
}

function imageRepairUrl(lead = {}) {
  const niche = `${lead.niche || ''} ${lead.name || ''}`.toLowerCase();
  if (/фото|photo|studio|студи/.test(niche)) return 'https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&w=1800&q=80';
  if (/beauty|salon|крас|салон/.test(niche)) return 'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=1800&q=80';
  if (/ремонт|стро|кров|дом/.test(niche)) return 'https://images.unsplash.com/photo-1503387762-592deb58ef4e?auto=format&fit=crop&w=1800&q=80';
  return 'https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1800&q=80';
}

function imageRepairUrlV2(lead = {}, context = '', ordinal = 0) {
  const niche = `${lead.niche || ''} ${lead.name || ''}`.toLowerCase();
  const key = String(context || '').toLowerCase();
  const photoStudio = [
    ['hero|studio|main', generatedImageUrl('premium commercial photography studio interior, large cyclorama wall, professional softboxes and camera stands, elegant rental studio atmosphere, realistic architectural photography, no people, no mountains, no road, no office desk', 1101)],
    ['loft|brick|industrial', generatedImageUrl('loft photography studio hall, exposed brick wall, large industrial windows, seamless paper backdrops, softbox lighting, wooden floor, realistic interior photo, no mountains, no road, no landscape, no office desk', 1102)],
    ['cyc|cyclorama|white|light', generatedImageUrl('white cyclorama photography studio hall, clean curved wall, bright daylight, professional studio lights, minimal rental studio interior, realistic photo, no bedroom, no mountains, no road, no office desk', 1103)],
    ['cozy|warm|family', generatedImageUrl('cozy warm photography studio hall for family portraits, neutral sofa, textured wall, soft curtains, warm studio lights, realistic interior photo, no wedding couple, no mountains, no road, no office desk', 1104)],
    ['dark|black|contrast', generatedImageUrl('dark black photography studio hall, matte black backdrop, dramatic portrait lighting, grid softbox, professional photo studio equipment, realistic interior photo, no office desk, no computer, no mountains, no road', 1105)],
    ['detail|camera|equipment', generatedImageUrl('close detail of professional photography studio equipment, camera on tripod, softbox lights, backdrops, premium studio rental mood, realistic photo, no office desk, no mountains, no road', 1106)],
  ];
  const beauty = [
    ['hero|main', 'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=1800&q=80'],
    ['interior|room', 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=1800&q=80'],
    ['detail|service', 'https://images.unsplash.com/photo-1521590832167-7bcbfaa6381f?auto=format&fit=crop&w=1800&q=80'],
  ];
  const construction = [
    ['hero|main', 'https://images.unsplash.com/photo-1503387762-592deb58ef4e?auto=format&fit=crop&w=1800&q=80'],
    ['detail|tool', 'https://images.unsplash.com/photo-1581094794329-c8112a89af12?auto=format&fit=crop&w=1800&q=80'],
    ['interior|finish', 'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=1800&q=80'],
  ];
  const generic = [
    ['hero|main', 'https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1800&q=80'],
    ['detail|team', 'https://images.unsplash.com/photo-1556761175-b413da4baf72?auto=format&fit=crop&w=1800&q=80'],
    ['interior|office', 'https://images.unsplash.com/photo-1497366811353-6870744d04b2?auto=format&fit=crop&w=1800&q=80'],
  ];
  const set = /фото|photo|studio|студи/.test(niche)
    ? photoStudio
    : /beauty|salon|крас|салон/.test(niche)
      ? beauty
      : /ремонт|стро|кров|дом/.test(niche)
        ? construction
        : generic;
  const matched = set.find(([pattern]) => new RegExp(pattern, 'i').test(key));
  return (matched || set[Math.abs(Number(ordinal) || 0) % set.length])[1];
}

function generatedImageUrl(prompt, seed) {
  const encoded = encodeURIComponent(prompt);
  return `https://image.pollinations.ai/prompt/${encoded}?width=1600&height=1000&seed=${seed}&nologo=true&enhance=true`;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function patchBrowserRouterBasename(sourceRoot) {
  const candidates = ['src/App.tsx', 'src/App.jsx', 'src/App.ts', 'src/App.js'];
  for (const relative of candidates) {
    const filePath = path.join(sourceRoot, relative);
    let content = '';
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    if (!content.includes('<BrowserRouter>')) continue;
    const patched = content.replace(
      '<BrowserRouter>',
      '<BrowserRouter basename={import.meta.env.BASE_URL.replace(/\\/$/, "") || "/"}>',
    );
    if (patched !== content) {
      await writeFile(filePath, patched, 'utf8');
      return { ok: true, file: relative };
    }
  }
  return { ok: false };
}

export async function deployLeadExportedProject(store, leadId, { files = [], lovable = {}, projectName = '', renderVideo = true } = {}) {
  let lead = store.getLead(leadId);
  if (!lead) return { ok: false, error: 'Lead not found' };
  if (!files.length) return { ok: false, error: 'No Lovable files to deploy' };

  const slugBase = projectName || lead.mockup?.projectName || lead.name || lead.id;
  const slug = projectSlug(`${slugBase}-${lead.id.slice(0, 8)}`, `project-${lead.id.slice(0, 8)}`);
  const sourceRoot = path.resolve(config.DATA_DIR, 'sources', slug);
  const publicRoot = path.resolve(config.DATA_DIR, 'projects', slug);
  const written = await writeSourceFiles(sourceRoot, files);
  const publicUrl = projectUrl(slug);
  const routerPatch = await patchBrowserRouterBasename(sourceRoot);
  const build = await repairAndBuildSourceProject(sourceRoot, publicRoot, `/projects/${slug}/`, lead);
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
      buildFailedHtml({ title: lead.name || 'Web Studio project', build }),
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
        routerPatch,
        github,
        lovable,
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  if (!build.ok) {
    lead = await store.updateLead(lead.id, {
      mockup: {
        ...compactStoredMockup(lead.mockup),
        ok: false,
        mode: 'lovable_official_mcp_export',
        status: 'build_failed',
        diagnosticUrl: publicUrl,
        projectSlug: slug,
        sourceRoot,
        sourceFiles: written.length,
        deploymentStrategy: build.strategy,
        deploymentWarning: build.error,
        routerPatch,
        github,
        lovable,
        clientSendAllowed: false,
        buildFailedAt: new Date().toISOString(),
      },
      qualityGate: {
        ok: false,
        checkedAt: new Date().toISOString(),
        url: publicUrl,
        issues: [`deployment_${build.strategy}`, 'build_failed_stub_page'],
        warnings: [],
      },
      video: { ok: false, reason: 'build_failed_before_filmer', invalidatedAt: new Date().toISOString() },
      outboundStatus: 'blocked_build_failed',
      lane: 'Lovable',
      owner: 'Builder',
      status: 'needs_review',
    });
    await store.addEvent(lead.id, 'project.build_failed', `Lovable export build failed: ${build.error || build.strategy}`);
    await crmAddEvent({
      entityType: lead.a1DealId ? 'deal' : 'lead',
      entityId: lead.a1DealId || lead.a1LeadId || lead.id,
      eventType: 'project.build_failed',
      text: `Lovable export build failed: ${build.error || build.strategy}`,
      payload: { webstudioLeadId: lead.id, diagnosticUrl: publicUrl, slug, github, lovable, build, routerPatch },
      idempotencyKey: `webstudio:${lead.id}:project.build_failed:${slug}`,
    });
    await syncA1CrmLead(lead, 'project_build_failed');
    return { ok: false, error: build.error || build.strategy || 'Build failed', publicUrl, diagnosticUrl: publicUrl, slug, github, build, lead };
  }

  lead = await store.updateLead(lead.id, {
    mockup: {
      ...compactStoredMockup(lead.mockup),
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
      routerPatch,
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
    payload: { webstudioLeadId: lead.id, publicUrl, slug, github, lovable, build, routerPatch },
    idempotencyKey: `webstudio:${lead.id}:project.deployed:${slug}`,
  });

  if (renderVideo === false) {
    await syncA1CrmLead(lead, 'project_deployed');
    return { ok: true, publicUrl, slug, github, build, lead, videoQueued: true };
  }

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

export async function repairLeadSourceProject(store, leadId, { renderVideo = false } = {}) {
  let lead = store.getLead(leadId);
  if (!lead) return { ok: false, error: 'Lead not found' };
  const sourceRoot = lead.mockup?.sourceRoot;
  const slug = lead.mockup?.projectSlug;
  if (!sourceRoot || !slug) return { ok: false, error: 'Lead has no saved source project to repair' };

  const publicRoot = path.resolve(config.DATA_DIR, 'projects', slug);
  const publicUrl = projectUrl(slug);
  const routerPatch = await patchBrowserRouterBasename(sourceRoot);
  const build = await repairAndBuildSourceProject(sourceRoot, publicRoot, `/projects/${slug}/`, lead);

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
        build,
        routerPatch,
        repairedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  if (!build.ok) {
    await writeFile(path.join(publicRoot, 'index.html'), buildFailedHtml({ title: lead.name || 'Web Studio project', build }), 'utf8');
    lead = await store.updateLead(lead.id, {
      mockup: {
        ...compactStoredMockup(lead.mockup),
        ok: false,
        status: 'build_failed',
        diagnosticUrl: publicUrl,
        publicUrl: '',
        publishedUrl: '',
        deployedUrl: '',
        deploymentStrategy: build.strategy,
        deploymentWarning: build.error,
        clientSendAllowed: false,
        repairAttempts: Number(lead.mockup?.repairAttempts ?? 0) + 1,
        lastRepair: build.repairs || [],
        buildFailedAt: new Date().toISOString(),
      },
      qualityGate: {
        ok: false,
        checkedAt: new Date().toISOString(),
        url: publicUrl,
        issues: [`deployment_${build.strategy}`, 'build_failed_stub_page'],
        warnings: [],
      },
      video: { ok: false, reason: 'build_failed_after_coder_repair', invalidatedAt: new Date().toISOString() },
      outboundStatus: 'blocked_build_failed',
      lane: 'Lovable',
      owner: 'Builder',
      status: 'needs_review',
    });
    await store.addEvent(lead.id, 'project.repair_failed', `Coder repair failed: ${build.error || build.strategy}`);
    await syncA1CrmLead(lead, 'project_repair_failed');
    return { ok: false, error: build.error || build.strategy || 'Repair build failed', publicUrl, diagnosticUrl: publicUrl, slug, build, lead };
  }

  lead = await store.updateLead(lead.id, {
    mockup: {
      ...compactStoredMockup(lead.mockup),
      ok: true,
      mode: 'lovable_official_mcp_export',
      status: 'deployed',
      diagnosticUrl: '',
      publishedUrl: publicUrl,
      deployedUrl: publicUrl,
      publicUrl,
      projectSlug: slug,
      sourceRoot,
      deploymentStrategy: build.strategy,
      deploymentWarning: '',
      clientSendAllowed: true,
      routerPatch,
      repairAttempts: Number(lead.mockup?.repairAttempts ?? 0) + 1,
      lastRepair: build.repairs || [],
      deployedAt: new Date().toISOString(),
    },
    outboundStatus: String(lead.outboundStatus || '').startsWith('blocked_quality_regression') ? 'blocked_previous_queue_needs_review' : '',
    pipelineStage: 'deployed',
    stageStatus: 'quality_pending',
    assignedAgent: 'Filmer',
    artifactStatus: 'deployed',
    lane: 'Видео',
    owner: 'Filmer',
    status: 'in_progress',
    lastTransitionAt: new Date().toISOString(),
    lastTransitionReason: 'coder_repair_deployed',
  });
  await store.addEvent(lead.id, 'project.repaired_deployed', `Coder repaired and deployed Lovable export: ${publicUrl}`);
  await crmAddEvent({
    entityType: lead.a1DealId ? 'deal' : 'lead',
    entityId: lead.a1DealId || lead.a1LeadId || lead.id,
    eventType: 'project.repaired_deployed',
    text: `Coder repaired and deployed Lovable export: ${publicUrl}`,
    payload: { webstudioLeadId: lead.id, publicUrl, slug, build, routerPatch },
    idempotencyKey: `webstudio:${lead.id}:project.repaired_deployed:${slug}`,
  });
  await syncA1CrmLead(lead, 'project_repaired_deployed');
  return { ok: true, publicUrl, slug, build, lead, videoQueued: renderVideo === false };
}

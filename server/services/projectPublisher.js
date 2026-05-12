import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { renderLeadVideo } from './filmer.js';
import { crmAddEvent, syncA1CrmLead } from './a1Client.js';
import { publishFilesToGitHub } from './githubPublisher.js';
import { withBrowserContext } from './browserPool.js';
import { generateNicheImageUrl, localImagePath } from './imageGenerator.js';

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

async function generatedPreviewHtml(lead) {
  const brief = lead.customerBrief ?? {};
  const business = lead.name || brief.businessName || 'Ваш бизнес';
  const niche = lead.niche || 'услуги для бизнеса';
  const profile = completeProfile(templateProfile(lead));
  const goal = brief.goal || lead.angle || profile.goal;
  const services = splitItems(brief.services || niche, profile.services);
  const contacts = brief.contacts || lead.phone || 'форма заявки, телефон, email';
  const style = brief.style || profile.style;
  const proof = brief.materials || lead.diagnosis || profile.proof;
  const city = lead.city ? ` в ${lead.city}` : '';
  const imageContext = [
    business,
    city,
    niche,
    brief.businessName,
    brief.services,
    brief.style,
  ].filter(Boolean).join(', ');
  const [heroImage, detailImage, resultImage, processImage] = await Promise.all(
    profile.images.map((prompt, index) =>
      generateNicheImageUrl(`${prompt}. Business context: ${imageContext}. Premium Russian landing page visual, realistic commercial photography, no text, no logos, no random office desk, no mountains, no roads.`, {
        seed: stableImageSeed(lead, `coder-template-${profile.id}`, index + 1),
        niche: profile.id,
        slot: index === 0 ? 'hero' : 'section',
      }),
    ),
  );
  const contactHref = lead.phone ? `tel:${String(lead.phone).replace(/[^\d+]/g, '')}` : '#request';
  const serviceCards = services.slice(0, 3);
  const serviceList = services.slice(0, 6);
  const stats = profile.stats;
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(business)}</title>
    <style>
      :root { color-scheme: ${profile.dark ? 'dark' : 'light'}; --bg: ${profile.tokens.bg}; --panel: ${profile.tokens.panel}; --surface: ${profile.tokens.surface}; --text: ${profile.tokens.text}; --muted: ${profile.tokens.muted}; --line: ${profile.tokens.line}; --accent: ${profile.tokens.accent}; --accent2: ${profile.tokens.accent2}; --soft: ${profile.tokens.soft}; }
      * { box-sizing: border-box; }
      body { margin: 0; font: 16px/1.55 Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: var(--bg); letter-spacing: 0; }
      a { color: inherit; }
      .wrap { width: min(1120px, calc(100% - 32px)); margin: 0 auto; }
      header { position: sticky; top: 0; z-index: 2; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--bg) 90%, transparent); backdrop-filter: blur(16px); }
      nav { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
      .brand { font-weight: 800; font-size: 18px; }
      .nav-note { color: var(--muted); font-size: 14px; }
      .hero { min-height: 86vh; display: grid; align-items: center; padding: 58px 0 54px; border-bottom: 1px solid var(--line); }
      .hero-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, .92fr); gap: 46px; align-items: stretch; }
      .eyebrow { color: var(--accent); font-weight: 850; font-size: 14px; }
      h1 { margin: 14px 0 18px; font-size: clamp(44px, 6vw, 78px); line-height: .98; letter-spacing: 0; max-width: 900px; }
      .lead { color: var(--muted); font-size: clamp(18px, 1.8vw, 22px); max-width: 760px; }
      .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 30px; }
      .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; padding: 0 18px; border: 1px solid var(--line); border-radius: 8px; text-decoration: none; font-weight: 800; }
      .btn.primary { background: var(--accent); color: ${profile.tokens.buttonText}; border-color: var(--accent); }
      .panel { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 18px; box-shadow: 0 26px 80px ${profile.dark ? 'rgba(0,0,0,.35)' : 'rgba(20,27,39,.12)'}; }
      .media-img { width: 100%; background-size: cover; background-position: center; background-repeat: no-repeat; }
      .hero-photo { aspect-ratio: 16 / 10; border-radius: 8px; display: block; margin-bottom: 16px; border: 1px solid var(--line); }
      .hero-svg { width: 100%; height: auto; display: block; margin: 18px 0; }
      .hero-svg .pulse { animation: wsPulse 2.4s ease-in-out infinite; transform-origin: center; }
      .hero-svg .flow { stroke-dasharray: 10 12; animation: wsFlow 5s linear infinite; }
      @keyframes wsPulse { 0%, 100% { opacity: .45; transform: scale(.96); } 50% { opacity: 1; transform: scale(1.05); } }
      @keyframes wsFlow { to { stroke-dashoffset: -88; } }
      .metric { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 24px; }
      .metric div { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: var(--surface); }
      .metric b { display: block; color: var(--accent2); font-size: 24px; line-height: 1; margin-bottom: 8px; }
      section { padding: 72px 0; border-bottom: 1px solid var(--line); }
      h2 { margin: 0 0 22px; font-size: clamp(28px, 4vw, 48px); line-height: 1.05; }
      .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
      .card { border: 1px solid var(--line); border-radius: 8px; padding: 20px; background: var(--surface); min-height: 148px; }
      .card b { display: block; margin-bottom: 10px; font-size: 18px; }
      .muted { color: var(--muted); }
      .image-card { overflow: hidden; padding: 0; }
      .image-card .media-img { aspect-ratio: 1.35; display: block; }
      .image-card div { padding: 18px; }
      .split { display: grid; grid-template-columns: minmax(0, .95fr) minmax(360px, 1.05fr); gap: 28px; align-items: center; }
      .split .media-img { aspect-ratio: 16 / 10; border-radius: 8px; display: block; border: 1px solid var(--line); box-shadow: 0 18px 54px ${profile.dark ? 'rgba(0,0,0,.22)' : 'rgba(20,27,39,.12)'}; }
      .steps { display: grid; gap: 12px; counter-reset: step; }
      .step { display: grid; grid-template-columns: 48px 1fr; gap: 16px; align-items: start; padding: 18px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
      .step::before { counter-increment: step; content: counter(step); display: grid; place-items: center; width: 40px; height: 40px; border-radius: 999px; background: var(--accent); color: ${profile.tokens.buttonText}; font-weight: 900; }
      form { display: grid; gap: 12px; }
      input, textarea { width: 100%; border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 8px; padding: 14px 16px; font: inherit; }
      textarea { min-height: 120px; resize: vertical; }
      footer { padding: 32px 0; color: var(--muted); }
      @media (max-width: 820px) { .hero-grid, .grid, .split { grid-template-columns: 1fr; } h1 { font-size: 42px; } .nav-note { display: none; } .metric { grid-template-columns: 1fr; } .hero { min-height: auto; padding-top: 36px; } }
    </style>
  </head>
  <body>
    <header><nav class="wrap"><div class="brand">${escapeHtml(business)}</div><div class="nav-note">${escapeHtml(niche)}</div></nav></header>
    <main>
      <section class="hero">
        <div class="wrap hero-grid">
          <div>
            <div class="eyebrow">${escapeHtml(profile.eyebrow)}</div>
            <h1>${escapeHtml(profile.headline(business, city))}</h1>
            <p class="lead">${escapeHtml(profile.lead(goal, style))}</p>
            <div class="actions">
              <a class="btn primary" href="${escapeHtml(contactHref)}">${escapeHtml(profile.cta)}</a>
              <a class="btn" href="#services">${escapeHtml(profile.secondaryCta)}</a>
            </div>
            <div class="metric">
              ${stats.map((item) => `<div><b>${escapeHtml(item.value)}</b><span class="muted">${escapeHtml(item.label)}</span></div>`).join('')}
            </div>
          </div>
          <aside class="panel">
            ${templateImageTag(heroImage, `${business}: ${niche}`, 'hero-photo', fallbackImageDataUrl(profile, 'hero'))}
            ${animatedHeroSvg(profile)}
            <b>${escapeHtml(profile.panelTitle)}</b>
            <p class="muted">${escapeHtml(proof)}</p>
          </aside>
        </div>
      </section>
      <section id="services"><div class="wrap"><h2>${escapeHtml(profile.servicesTitle)}</h2><div class="grid">${serviceCards.map((item, index) => `<article class="card image-card">${templateImageTag([detailImage, resultImage, processImage][index] || detailImage, item, '', fallbackImageDataUrl(profile, `card-${index}`))}<div><b>${escapeHtml(item)}</b><p class="muted">${escapeHtml(profile.cardText(item))}</p></div></article>`).join('')}</div></div></section>
      <section><div class="wrap split"><div><h2>${escapeHtml(profile.proofTitle)}</h2><p class="muted">${escapeHtml(proof)}</p><div class="grid">${serviceList.slice(0, 3).map((item) => `<article class="card"><b>${escapeHtml(item)}</b><p class="muted">${escapeHtml(profile.bulletText)}</p></article>`).join('')}</div></div>${templateImageTag(resultImage, `${business}: результат`, '', fallbackImageDataUrl(profile, 'result'))}</div></section>
      <section><div class="wrap"><h2>${escapeHtml(profile.processTitle)}</h2><div class="steps">${profile.steps.map((step) => `<div class="step"><div><b>${escapeHtml(step[0])}</b><p class="muted">${escapeHtml(step[1])}</p></div></div>`).join('')}</div></div></section>
      <section id="request"><div class="wrap hero-grid"><div><h2>${escapeHtml(profile.requestTitle)}</h2><p class="muted">Контакты и поля формы: ${escapeHtml(contacts)}.</p></div><form><input placeholder="Имя"><input placeholder="Телефон или email"><textarea placeholder="Коротко опишите задачу"></textarea><button class="btn primary" type="button">${escapeHtml(profile.formButton)}</button></form></div></section>
    </main>
    <footer><div class="wrap">${escapeHtml(business)} · рабочее превью сайта</div></footer>
  </body>
</html>`;
}

function fallbackImageDataUrl(profile = {}, variant = 'preview') {
  const tokens = profile.tokens || {};
  const accent = tokens.accent || '#0f766e';
  const accent2 = tokens.accent2 || '#f97316';
  const bg = tokens.panel || tokens.bg || '#f8fafc';
  const surface = tokens.surface || '#ffffff';
  const stroke = tokens.line || '#d7dee8';
  const variantShift = String(variant || '').split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) % 220;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${surface}"/></linearGradient><filter id="blur"><feGaussianBlur stdDeviation="22"/></filter></defs><rect width="1600" height="1000" fill="url(#g)"/><circle cx="${280 + variantShift}" cy="250" r="230" fill="${accent}" opacity=".20" filter="url(#blur)"/><circle cx="${1180 - variantShift}" cy="760" r="280" fill="${accent2}" opacity=".16" filter="url(#blur)"/><rect x="210" y="190" width="1180" height="620" rx="52" fill="${surface}" stroke="${stroke}" stroke-width="4"/><rect x="300" y="290" width="480" height="58" rx="18" fill="${accent}" opacity=".78"/><rect x="300" y="390" width="790" height="34" rx="17" fill="${stroke}" opacity=".70"/><rect x="300" y="450" width="620" height="34" rx="17" fill="${stroke}" opacity=".52"/><rect x="300" y="610" width="220" height="120" rx="26" fill="${accent2}" opacity=".22"/><rect x="560" y="610" width="220" height="120" rx="26" fill="${accent}" opacity=".18"/><rect x="820" y="610" width="220" height="120" rx="26" fill="${accent2}" opacity=".15"/><path d="M1040 520C1120 430 1220 430 1300 520C1220 610 1120 610 1040 520Z" fill="${accent}" opacity=".35"/><circle cx="1170" cy="520" r="48" fill="${accent2}" opacity=".55"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function templateImageTag(src, alt, className = '', fallback = '') {
  const finalSrc = src || fallback;
  const classList = ['media-img', className].filter(Boolean).join(' ');
  const backgrounds = [finalSrc, fallback].filter(Boolean).map((url) => `url('${escapeHtml(url)}')`).join(', ');
  return `<div class="${escapeHtml(classList)}" role="img" aria-label="${escapeHtml(alt)}" style="background-image: ${backgrounds};"></div>`;
}

function templateProfile(lead = {}) {
  const key = imageRepairContextKey(lead, '');
  const profiles = {
    photo: {
      id: 'photo-studio',
      match: /фото|photo|photography|photographer|фотограф|фотостуди/,
      dark: false,
      tokens: { bg: '#f5f0ea', panel: '#fffaf4', surface: '#ffffff', text: '#171717', muted: '#5d6470', line: '#ded4ca', accent: '#9b4d24', accent2: '#1f6f72', soft: '#eadfd4', buttonText: '#ffffff' },
      eyebrow: 'Фотостудия и бронирование',
      goal: 'показывать залы, условия аренды и быстро получать заявки на съемки',
      style: 'теплый премиальный визуал, крупные интерьерные фото, спокойная типографика',
      proof: 'В первом экране сразу показываем атмосферу залов, сценарии съемок, стоимость/условия и быстрый запрос бронирования.',
      services: ['Loft-зал', 'Светлая циклорама', 'Контент-съемки', 'Семейные съемки', 'Бронь зала', 'Аренда оборудования'],
      stats: [{ value: '5 залов', label: 'структура под каталог' }, { value: '1 клик', label: 'быстрый запрос брони' }, { value: 'Mobile', label: 'удобно с телефона' }],
      images: [
        'premium photography studio hero interior, cyclorama wall, loft hall, softbox lights, elegant rental studio atmosphere',
        'loft photography studio hall with textured wall, professional lighting, clean rental interior',
        'bright white cyclorama photography studio, clean curved wall, daylight, photo equipment',
        'close detail of studio camera, backdrops and softbox lights, premium creative workspace',
      ],
    },
    ai: {
      id: 'ai-studio',
      match: /\bai\b|ии|нейро|neuro|chatbot|bot|бот|crm|api|a1|automation|автоматизац|интеграц|операцион|it|saas/,
      dark: true,
      tokens: { bg: '#080d14', panel: '#101722', surface: '#121b29', text: '#f8fafc', muted: '#a9b5c8', line: '#243044', accent: '#62e3ff', accent2: '#b9f45f', soft: '#172235', buttonText: '#061018' },
      eyebrow: 'AI-автоматизация для бизнеса',
      goal: 'объяснить сложный продукт простым языком и довести клиента до заявки',
      style: 'темный технологичный стиль, продуктовые экраны, аккуратная SaaS-подача',
      proof: 'Показываем сценарии внедрения, выгоду для отдела продаж/поддержки и понятный следующий шаг без перегруза терминологией.',
      services: ['AI-сотрудники', 'CRM-интеграции', 'Автоматизация заявок', 'Чат-боты', 'Операционный контур', 'Аналитика процессов'],
      stats: [{ value: '24/7', label: 'автоматическая обработка' }, { value: 'CRM', label: 'интеграции и статусы' }, { value: 'API', label: 'связка с сервисами' }],
      images: [
        'premium dark AI automation studio workspace, CRM pipeline dashboard on large monitor, neural network workflow diagrams',
        'close-up of CRM automation dashboard, API integration nodes, sales pipeline analytics on screen',
        'AI chatbot conversation dashboard for sales and support, messenger automation interface, dark control room',
        'AI agent workflow map on large screen, connected business process blocks, automation operations center',
      ],
    },
    estate: {
      id: 'real-estate',
      match: /недвиж|риелт|real\s*estate|estate|квартир|дом|property/,
      dark: false,
      tokens: { bg: '#f3f0ea', panel: '#fffaf0', surface: '#ffffff', text: '#10241f', muted: '#5f665f', line: '#ddd3c4', accent: '#b87432', accent2: '#27665a', soft: '#eee4d6', buttonText: '#ffffff' },
      eyebrow: 'Недвижимость и объекты',
      goal: 'показать объекты, доверие эксперта и быстрый запрос консультации',
      style: 'премиальный спокойный сайт с крупными фотографиями и чистой сеткой объектов',
      proof: 'Сильный первый экран должен быстро объяснять специализацию, показывать уровень объектов и вести к заявке на подбор.',
      services: ['Подбор объектов', 'Продажа квартир', 'Коммерческая недвижимость', 'Сопровождение сделки', 'Оценка', 'Ипотечная консультация'],
      stats: [{ value: 'Объекты', label: 'удобная витрина' }, { value: 'Доверие', label: 'экспертность на первом экране' }, { value: 'Заявка', label: 'быстрый контакт' }],
      images: [
        'premium real estate landing hero, modern apartment building, elegant interior preview, warm daylight',
        'luxury apartment interior, clean living room, high-end real estate photography',
        'modern residential building exterior, premium real estate presentation, city context',
        'real estate consultation desk with floor plans and elegant materials, no people faces',
      ],
    },
    clinic: {
      id: 'clinic-dental',
      match: /стомат|клиник|медиц|dental|clinic|doctor|dent/,
      dark: false,
      tokens: { bg: '#f4fbfb', panel: '#ffffff', surface: '#ffffff', text: '#0c3034', muted: '#557075', line: '#cce5e5', accent: '#159b9b', accent2: '#1a6f86', soft: '#e7f6f5', buttonText: '#ffffff' },
      eyebrow: 'Клиника и запись',
      goal: 'снять тревогу, показать услуги и быстро привести пациента к записи',
      style: 'чистый медицинский интерфейс, спокойные цвета, доверие и понятная запись',
      proof: 'Для медицинской ниши важны лицензии, отзывы, врачи, услуги и ясный путь к записи без агрессивной рекламы.',
      services: ['Первичный прием', 'Диагностика', 'Лечение', 'Профилактика', 'Имплантация', 'Запись онлайн'],
      stats: [{ value: 'Запись', label: 'видна сразу' }, { value: 'Отзывы', label: 'социальное доверие' }, { value: 'Услуги', label: 'структура без хаоса' }],
      images: [
        'modern dental clinic reception and treatment room, clean medical interior, calm premium healthcare photography',
        'dental clinic equipment in bright clean room, professional medical photography',
        'doctor consultation room, clean healthcare interior, trust and calm atmosphere',
        'close detail of dental tools and hygienic treatment setup, premium clinic mood',
      ],
    },
    construction: {
      id: 'construction',
      match: /ремонт|стро|кров|отдел|construction|renovation|roof|инженер|монтаж/,
      dark: false,
      tokens: { bg: '#f4f1ec', panel: '#ffffff', surface: '#ffffff', text: '#181818', muted: '#5f6670', line: '#ded8d0', accent: '#d77a2d', accent2: '#2f5f7c', soft: '#ece5dc', buttonText: '#ffffff' },
      eyebrow: 'Работы, смета и заявка',
      goal: 'показать виды работ, сроки, гарантии и быстро собрать заявку на расчет',
      style: 'практичный сайт услуг, крупные реальные фото, понятная структура и сильные CTA',
      proof: 'Клиент должен сразу понять перечень работ, увидеть аккуратность результата и оставить заявку на расчет без лишних вопросов.',
      services: ['Ремонт под ключ', 'Отделочные работы', 'Инженерные работы', 'Смета', 'Гарантия', 'Выезд специалиста'],
      stats: [{ value: 'Смета', label: 'заявка на расчет' }, { value: 'Сроки', label: 'понятные этапы' }, { value: 'Гарантия', label: 'снятие риска' }],
      images: [
        'professional apartment renovation hero, clean construction site, tools and finished walls, realistic commercial photo',
        'finished renovated apartment interior with modern flooring and fresh walls, daylight',
        'construction tools, measuring tape, level and materials on renovation site, clean professional photo',
        'renovation team planning with drawings and material samples, no faces, realistic',
      ],
    },
    beauty: {
      id: 'beauty',
      match: /beauty|salon|крас|салон|spa|cosmetic|космет/,
      dark: false,
      tokens: { bg: '#fff5f7', panel: '#ffffff', surface: '#ffffff', text: '#26171e', muted: '#75606a', line: '#ead1db', accent: '#cf5d83', accent2: '#7a6a42', soft: '#f7e6ec', buttonText: '#ffffff' },
      eyebrow: 'Салон и запись',
      goal: 'показать атмосферу, услуги, мастеров и быстро привести клиента к записи',
      style: 'мягкая премиальная подача, чистые фото интерьера и акцент на записи',
      proof: 'Для салона важны атмосфера, понятные услуги, доверие к мастерам и быстрый путь к записи с телефона.',
      services: ['Уходовые процедуры', 'Мастера', 'Прайс', 'Запись', 'Подарочные сертификаты', 'Акции'],
      stats: [{ value: 'Запись', label: 'кнопка на первом экране' }, { value: 'Прайс', label: 'без лишних вопросов' }, { value: 'Мастера', label: 'доверие к услуге' }],
      images: [
        'modern beauty salon interior, reception and styling chairs, soft natural light, premium calm atmosphere',
        'beauty salon treatment room, mirrors, styling chairs, warm lighting, clean premium interior',
        'professional cosmetics and tools on clean counter, elegant spa mood',
        'premium salon details, soft fabrics, warm light, beauty workspace',
      ],
    },
    hvac: {
      id: 'hvac',
      match: /кондиционер|климат|вентиляц|hvac|air\s*condition|сплит/,
      dark: false,
      tokens: { bg: '#eef8fc', panel: '#ffffff', surface: '#ffffff', text: '#0d2633', muted: '#536b76', line: '#cbe1ea', accent: '#1f83b5', accent2: '#1aa885', soft: '#dff1f7', buttonText: '#ffffff' },
      eyebrow: 'Климат и монтаж',
      goal: 'объяснить подбор, монтаж и сервис кондиционеров с быстрой заявкой',
      style: 'свежий чистый сервисный сайт с акцентом на надежность и быстрый расчет',
      proof: 'Важны понятные пакеты, сроки монтажа, гарантия, сервис и возможность быстро оставить заявку на подбор.',
      services: ['Подбор кондиционера', 'Монтаж', 'Сервис', 'Демонтаж', 'Заправка', 'Гарантия'],
      stats: [{ value: '1 день', label: 'быстрый расчет' }, { value: 'Гарантия', label: 'на монтаж' }, { value: 'Сервис', label: 'после установки' }],
      images: [
        'modern apartment interior with wall mounted air conditioner, clean daylight, premium climate service photo',
        'HVAC technician installing air conditioner indoor unit, clean professional service, no faces',
        'air conditioner outdoor unit and tools, neat installation service, realistic commercial photo',
        'close-up of climate control remote and cool clean interior, fresh atmosphere',
      ],
    },
    generic: {
      id: 'local-service',
      match: /.*/,
      dark: false,
      tokens: { bg: '#f6f7f9', panel: '#ffffff', surface: '#ffffff', text: '#111318', muted: '#626a75', line: '#dfe3e8', accent: '#087f74', accent2: '#b7791f', soft: '#eef2f6', buttonText: '#ffffff' },
      eyebrow: 'Локальный бизнес',
      goal: 'собрать больше целевых заявок и понятно объяснить услуги',
      style: 'современный практичный сайт с сильным первым экраном и понятной формой заявки',
      proof: 'Сайт должен быстро объяснять предложение, показывать доверие и давать клиенту простой следующий шаг.',
      services: ['Услуги', 'Консультация', 'Портфолио', 'Цены', 'Отзывы', 'Заявка'],
      stats: [{ value: 'Оффер', label: 'ясно с первого экрана' }, { value: 'Форма', label: 'быстрая заявка' }, { value: 'Mobile', label: 'удобно с телефона' }],
      images: [
        'modern local business reception area, clean premium commercial interior, realistic photography',
        'professional local business workspace detail, service tools and documents, clean photo',
        'happy service business environment without faces, premium interior, realistic commercial photo',
        'close detail of business planning, forms, phone and service materials, clean desk',
      ],
    },
  };
  return Object.values(profiles).find((profile) => profile.match.test(key)) || profiles.generic;
}

function completeProfile(profile) {
  return {
    headline: (business, city) => `${business}${city}: понятный сайт для заявок`,
    lead: (goal, style) => `${goal}. Визуальная подача: ${style}.`,
    cta: 'Оставить заявку',
    secondaryCta: 'Посмотреть услуги',
    panelTitle: 'Что видит клиент сразу',
    servicesTitle: 'Услуги и сценарии',
    proofTitle: 'Почему выбирают нас',
    processTitle: 'Как проходит работа',
    requestTitle: 'Оставить заявку',
    formButton: 'Отправить заявку',
    cardText: (item) => `Показываем ${item.toLowerCase()} простым языком: результат, условия и следующий шаг.`,
    bulletText: 'Короткий блок с пользой, доверием и понятным действием.',
    steps: [
      ['Уточняем задачу', 'Собираем цель, услуги, стиль, контакты и ограничения.'],
      ['Показываем решение', 'Даем клиенту быстрый маршрут: оффер, доверие, услуги и форма заявки.'],
      ['Доводим до обращения', 'Оптимизируем первый экран, мобильный сценарий и контактное действие.'],
    ],
    ...profile,
  };
}

function animatedHeroSvg(profile = {}) {
  const accent = profile.tokens?.accent || '#55d6be';
  const accent2 = profile.tokens?.accent2 || '#ffcf5a';
  const panel = profile.tokens?.panel || '#121722';
  const line = profile.tokens?.line || '#273144';
  return [
    '<svg class="hero-svg" viewBox="0 0 520 180" role="img" aria-label="Website workflow preview">',
    `<defs><linearGradient id="ws-g" x1="0" x2="1"><stop offset="0" stop-color="${escapeHtml(accent)}"/><stop offset="1" stop-color="${escapeHtml(accent2)}"/></linearGradient></defs>`,
    `<rect x="1" y="1" width="518" height="178" rx="18" fill="${escapeHtml(panel)}" stroke="${escapeHtml(line)}"/>`,
    '<path class="flow" d="M90 92H210C245 92 245 48 280 48H430M90 92H210C245 92 245 136 280 136H430" fill="none" stroke="url(#ws-g)" stroke-width="4" stroke-linecap="round"/>',
    `<circle class="pulse" cx="90" cy="92" r="32" fill="${escapeHtml(accent)}" opacity=".75"/>`,
    `<circle class="pulse" cx="280" cy="48" r="24" fill="${escapeHtml(accent2)}" opacity=".75"/>`,
    `<circle class="pulse" cx="280" cy="136" r="24" fill="${escapeHtml(accent)}" opacity=".65"/>`,
    `<rect x="388" y="30" width="74" height="36" rx="8" fill="${escapeHtml(panel)}" stroke="${escapeHtml(accent)}"/>`,
    `<rect x="388" y="118" width="74" height="36" rx="8" fill="${escapeHtml(panel)}" stroke="${escapeHtml(accent2)}"/>`,
    '</svg>',
  ].join('');
}

function splitItems(value, fallback = []) {
  const items = String(value || '')
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6);
  return Array.from(new Set([...items, ...fallback])).slice(0, 6).filter(Boolean).length
    ? Array.from(new Set([...items, ...fallback])).slice(0, 6)
    : ['Главная услуга', 'Консультация', 'Заявка'];
}

async function capturePublicPage(sourceUrl) {
  return withBrowserContext({ viewport: { width: 1440, height: 1400 }, deviceScaleFactor: 1 }, async (context) => {
    const page = await context.newPage();
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
  });
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

  const html = await generatedPreviewHtml(lead);
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
          strategy: 'coder_template_preview',
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
      mode: 'coder_template_preview',
      status: 'deployed',
      publishedUrl: publicUrl,
      deployedUrl: publicUrl,
      publicUrl,
      projectSlug: slug,
      projectName: options.projectName || lead.name || '',
      deploymentStrategy: 'coder_template_preview',
      deploymentWarning: options.reason || '',
      clientSendAllowed: true,
      github,
      deployedAt: new Date().toISOString(),
    },
    pipelineStage: 'deployed',
    stageStatus: 'template_preview_deployed',
    artifactStatus: 'deployed',
    lane: 'Видео',
    owner: 'Filmer',
    status: 'in_progress',
  });
  await store.addEvent(lead.id, 'project.template_preview_deployed', `Coder generated template preview: ${publicUrl}`);
  await crmAddEvent({
    entityType: lead.a1DealId ? 'deal' : 'lead',
    entityId: lead.a1DealId || lead.a1LeadId || lead.id,
    eventType: 'project.template_preview_deployed',
    text: `Coder generated template preview: ${publicUrl}`,
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
    const hasTextContent = typeof file.content === 'string';
    const hasBinaryContent = file.binary && typeof file.contentBase64 === 'string';
    if (!hasTextContent && !hasBinaryContent) continue;
    if (!isPublishableSourceFile(file.path)) continue;
    const target = safeProjectPath(root, file.path);
    if (!target) throw new Error(`Unsafe project file path: ${file.path}`);
    await mkdir(path.dirname(target), { recursive: true });
    if (hasBinaryContent) {
      await writeFile(target, Buffer.from(file.contentBase64, 'base64'));
    } else {
      await writeFile(target, file.content, 'utf8');
    }
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
  const visualRepair = await ensureVisualMediaBlock(sourceRoot, lead);
  if (visualRepair.ok) repairs.push(visualRepair);
  const mapRepair = await ensureRequestedYandexMapBlock(sourceRoot, lead);
  if (mapRepair.ok) repairs.push(mapRepair);
  const addressTextRepair = await ensureExactAddressText(sourceRoot, lead);
  if (addressTextRepair.ok) repairs.push(addressTextRepair);
  const externalImageRepair = await materializeExternalImageLiterals(sourceRoot, lead);
  if (externalImageRepair.ok) repairs.push(externalImageRepair);
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
  let ordinal = 0;
  for (const match of matches) {
    ordinal += 1;
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
    const replacementUrl = await imageRepairUrlV2(lead, `${path.basename(missingPath)} ${path.basename(importer)} ${content.slice(0, 300)}`, ordinal);
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
  if (!config.OPENAI_IMAGE_GENERATION_ENABLED) {
    return { ok: false, reason: 'remote_image_replacement_disabled' };
  }
  const files = await listSourceCodeFiles(path.join(sourceRoot, 'src'));
  const repaired = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8').catch(() => '');
    if (!content.includes('images.unsplash.com') && !content.includes('image.pollinations.ai') && !content.includes('webstudio-')) continue;
    let ordinal = 0;
    let next = content;
    const matches = [
      ...content.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*["'](?:https:\/\/images\.unsplash\.com|https:\/\/image\.pollinations\.ai)\/[^"']+["'];/g),
      ...content.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*new URL\("[^"]*webstudio-[^"]+",\s*import\.meta\.url\)\.href;/g),
    ];
    for (const match of matches) {
      const [statement, variableName] = match;
      const url = await imageRepairUrlV2(lead, `${variableName} ${path.basename(file)}`, ordinal);
      const asset = await materializeRepairImage(sourceRoot, file, variableName, url);
      ordinal += 1;
      repaired.push({ file: path.relative(sourceRoot, file), variableName, strategy: asset.ok ? 'generated_local_image_asset' : 'generated_remote_image_url', url: asset.url });
      next = next.replace(statement, `const ${variableName} = ${asset.expression};`);
    }
    if (next !== content) await writeFile(file, next, 'utf8');
  }
  return repaired.length ? { ok: true, repaired } : { ok: false, reason: 'no_duplicate_remote_image_constants' };
}

async function materializeExternalImageLiterals(sourceRoot, lead = {}) {
  const files = (await listSourceCodeFiles(path.join(sourceRoot, 'src'))).filter((file) => /\.(tsx|ts|jsx|js)$/.test(file));
  const repaired = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8').catch(() => '');
    if (!content.includes('images.unsplash.com') && !content.includes('image.pollinations.ai')) continue;
    let ordinal = 0;
    let next = content;
    const matches = [...content.matchAll(/(["'])(https:\/\/(?:images\.unsplash\.com|image\.pollinations\.ai)\/[^"']+)\1/g)];
    for (const match of matches) {
      const [literal, , url] = match;
      const asset = await materializeRepairImage(sourceRoot, file, `external-${ordinal}`, url, url);
      let finalAsset = asset;
      if (!asset.ok) {
        const context = `${path.basename(file)} external image ${ordinal} ${content.slice(Math.max(0, match.index - 120), match.index + 120)}`;
        const fallbackUrl = await imageRepairUrlV2(lead, context, ordinal);
        finalAsset = await materializeRepairImage(sourceRoot, file, `external-${ordinal}`, fallbackUrl, url);
      }
      ordinal += 1;
      repaired.push({
        file: path.relative(sourceRoot, file),
        strategy: finalAsset.ok && finalAsset.url === url ? 'materialize_existing_external_image_url' : finalAsset.ok ? 'materialize_external_image_fallback_url' : 'external_image_left_remote',
        sourceUrl: url,
        url: finalAsset.url,
      });
      const prefix = content.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0);
      const replacement = /\.(tsx|jsx)$/.test(file) && /\b(?:src|poster)\s*=\s*$/.test(prefix)
        ? `{${finalAsset.expression}}`
        : finalAsset.expression;
      next = next.replace(literal, replacement);
    }
    if (next !== content) await writeFile(file, next, 'utf8');
  }
  return repaired.length ? { ok: true, repaired } : { ok: false, reason: 'no_external_image_literals' };
}

async function ensureVisualMediaBlock(sourceRoot, lead = {}) {
  const srcRoot = path.join(sourceRoot, 'src');
  const files = await listSourceCodeFiles(srcRoot);
  const sourceFiles = files.filter((file) => /\.(tsx|ts|jsx|js|html)$/.test(file));
  const hasImage = sourceFiles.some((file) => {
    const content = readFileSyncSafe(file);
    return /<img\b|<picture\b|backgroundImage\s*:|background-image\s*:|image\.pollinations\.ai|images\.unsplash\.com/i.test(content);
  });
  if (hasImage) return { ok: false, reason: 'visual_media_already_present' };
  const target = await findRevisionTargetFile(sourceRoot);
  if (!target) return { ok: false, reason: 'no_visual_target_file' };
  const content = await readFile(target, 'utf8').catch(() => '');
  if (!content || content.includes('webstudio-visual-hero')) return { ok: false, reason: 'visual_block_already_present' };
  const block = await visualMediaBlockForFile(target, lead);
  const next = injectVisualMediaBlock(content, block, target);
  if (next === content) return { ok: false, reason: 'could_not_inject_visual_block' };
  await writeFile(target, next, 'utf8');
  return { ok: true, strategy: 'injected_visual_media_block', file: path.relative(sourceRoot, target) };
}

function readFileSyncSafe(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function visualMediaBlockForFile(filePath, lead = {}) {
  const imageUrl = await imageRepairUrlV2(lead, 'hero cover banner first visual media block', 0);
  const title = lead.name || 'Web Studio preview';
  if (filePath.endsWith('.html')) {
    return [
      '<section class="webstudio-visual-hero" style="padding:32px 24px;background:#0b0f17;color:#f8fafc">',
      '<div style="max-width:1120px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,.55fr);gap:22px;align-items:center">',
      `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}" style="width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:16px;display:block">`,
      animatedHeroSvg(),
      '</div>',
      '</section>',
    ].join('\n');
  }
  return [
    '      <section className="webstudio-visual-hero" style={{ padding: "32px 24px", background: "#0b0f17", color: "#f8fafc" }}>',
    '        <div style={{ maxWidth: "1120px", margin: "0 auto", display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(260px,.55fr)", gap: "22px", alignItems: "center" }}>',
    `          <img src="${escapeHtml(imageUrl)}" alt={${JSON.stringify(title)}} style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: "16px", display: "block" }} />`,
    '          <svg viewBox="0 0 520 180" role="img" aria-label="Website workflow preview" style={{ width: "100%", height: "auto", display: "block" }}>',
    '            <defs><linearGradient id="ws-react-g" x1="0" x2="1"><stop offset="0" stopColor="#55d6be" /><stop offset="1" stopColor="#ffcf5a" /></linearGradient></defs>',
    '            <rect x="1" y="1" width="518" height="178" rx="18" fill="#121722" stroke="#273144" />',
    '            <path d="M90 92H210C245 92 245 48 280 48H430M90 92H210C245 92 245 136 280 136H430" fill="none" stroke="url(#ws-react-g)" strokeWidth="4" strokeLinecap="round" strokeDasharray="10 12" />',
    '            <circle cx="90" cy="92" r="32" fill="#55d6be" opacity=".75" />',
    '            <circle cx="280" cy="48" r="24" fill="#ffcf5a" opacity=".75" />',
    '            <circle cx="280" cy="136" r="24" fill="#55d6be" opacity=".65" />',
    '            <rect x="388" y="30" width="74" height="36" rx="8" fill="#0b0f17" stroke="#55d6be" />',
    '            <rect x="388" y="118" width="74" height="36" rx="8" fill="#0b0f17" stroke="#ffcf5a" />',
    '          </svg>',
    '        </div>',
    '      </section>',
  ].join('\n');
}

function injectVisualMediaBlock(content, block, filePath) {
  const clean = String(content || '').replace(/\s*<section\s+class(?:Name)?=["']webstudio-visual-hero["'][\s\S]*?<\/section>\s*/g, '\n');
  const mainOpen = clean.match(/<main[^>]*>/i);
  if (mainOpen?.index !== undefined) {
    const insertAt = mainOpen.index + mainOpen[0].length;
    return `${clean.slice(0, insertAt)}\n${block}\n${clean.slice(insertAt)}`;
  }
  if (filePath.endsWith('.html') && clean.includes('<body')) {
    return clean.replace(/(<body[^>]*>)/i, `$1\n${block}`);
  }
  const fragmentMatches = [...clean.matchAll(/return\s*\(\s*<>/g)];
  const returnOpen = fragmentMatches.at(-1);
  if (returnOpen?.index !== undefined) {
    const insertAt = returnOpen.index + returnOpen[0].length;
    return `${clean.slice(0, insertAt)}\n${block}\n${clean.slice(insertAt)}`;
  }
  const rootMatches = [...clean.matchAll(/return\s*\(\s*(<(?:div|section)[^>]*>)/g)];
  const rootOpen = rootMatches.at(-1);
  if (rootOpen?.index !== undefined) {
    const insertAt = rootOpen.index + rootOpen[0].length;
    return `${clean.slice(0, insertAt)}\n${block}\n${clean.slice(insertAt)}`;
  }
  return clean;
}

async function ensureRequestedYandexMapBlock(sourceRoot, lead = {}) {
  const requestText = [
    lead.revision?.text,
    lead.customerBrief?.notes,
    lead.customerBrief?.contacts,
    lead.address ? `Адрес: ${normalizeLeadAddress(lead)}` : '',
  ].filter(Boolean).join('\n');
  const mapUrl = yandexMapUrl(requestText, lead);
  if (!mapUrl) return { ok: false, reason: 'no_requested_yandex_map' };
  const target = await findRevisionTargetFile(sourceRoot);
  if (!target) return { ok: false, reason: 'no_map_target_file' };
  const content = await readFile(target, 'utf8').catch(() => '');
  if (!content || /yandex\.ru\/map-widget/i.test(content)) return { ok: false, reason: 'yandex_map_already_present' };
  const address = extractExplicitMapAddress(requestText) || normalizeLeadAddress(lead);
  const contact = lead.customerBrief?.contacts || lead.phone || lead.contacts?.emails?.[0] || '';
  const text = ['Адрес на карте', address ? `Адрес: ${address}` : '', contact ? `Контакты: ${contact}` : ''].filter(Boolean).join('. ');
  const block = revisionBlockForFile(target, text, lead);
  const next = injectRevisionBlock(content, block, target);
  if (next === content) return { ok: false, reason: 'could_not_inject_yandex_map' };
  await writeFile(target, next, 'utf8');
  return { ok: true, strategy: 'injected_requested_yandex_map', file: path.relative(sourceRoot, target), mapUrl };
}

async function ensureExactAddressText(sourceRoot, lead = {}) {
  const address = normalizeLeadAddress(lead);
  if (!address) return { ok: false, reason: 'no_known_address' };
  const city = String(lead.city || address.split(',')[0] || '').trim();
  if (!city) return { ok: false, reason: 'no_known_city' };
  const files = await listSourceCodeFiles(path.join(sourceRoot, 'src'));
  const repaired = [];
  for (const file of files.filter((item) => /\.(tsx|jsx|ts|js)$/.test(item))) {
    const content = await readFile(file, 'utf8').catch(() => '');
    const duplicatedCityAddress = new RegExp(`${escapeRegExp(city)}\\s*·\\s*${escapeRegExp(city)},\\s*`, 'g');
    let next = content
      .replace(/\?{3,}\s*·\s*([^"`<\n]+)/g, `${city} · $1`)
      .replace(duplicatedCityAddress, `${city} · `)
      .replace(/Санкт-Петербург\s*·\s*ул\.[^"`<\n]+/g, address.replace(',', ' ·'))
      .replace(/Санкт-Петербург/g, city)
      .replace(/СПб/g, city)
      .replace(/СПБ/g, city);
    if (next !== content) {
      await writeFile(file, next, 'utf8');
      repaired.push(path.relative(sourceRoot, file));
    }
  }
  return repaired.length ? { ok: true, strategy: 'normalized_known_address_text', files: repaired } : { ok: false, reason: 'no_address_text_replacements' };
}

async function materializeRepairImage(sourceRoot, importerFile, variableName, url, fallbackUrl = url) {
  const baseName = `webstudio-${variableName.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`;
  const urls = [...new Set([url, fallbackUrl].filter(Boolean))];
  let lastError = '';
  for (const candidate of urls) {
    const local = await copyLocalGeneratedImage(sourceRoot, importerFile, baseName, candidate);
    if (local.ok) return local;
    const result = await fetchRepairImage(sourceRoot, importerFile, baseName, candidate);
    if (result.ok) return result;
    lastError = result.error || lastError;
  }
  const localFallback = await createGeneratedVisualAsset(sourceRoot, importerFile, baseName, fallbackUrl || url);
  if (localFallback.ok) return { ...localFallback, error: lastError, strategy: 'generated_svg_visual_fallback' };
  return { ok: false, url: fallbackUrl || url, error: lastError, expression: `"${fallbackUrl || url}"` };
}

async function copyLocalGeneratedImage(sourceRoot, importerFile, baseName, url) {
  const localPath = localImagePath(url);
  if (!localPath) return { ok: false };
  try {
    const body = await readFile(localPath);
    if (body.length < 1024) throw new Error('image_local_empty_body');
    const ext = path.extname(localPath) || '.png';
    const assetPath = path.join(sourceRoot, 'src', 'assets', `${baseName}${ext}`);
    await mkdir(path.dirname(assetPath), { recursive: true });
    await writeFile(assetPath, body);
    const relative = path.relative(path.dirname(importerFile), assetPath).replace(/\\/g, '/');
    const importPath = relative.startsWith('.') ? relative : `./${relative}`;
    return { ok: true, url, expression: `new URL("${importPath}", import.meta.url).href`, strategy: 'copied_local_generated_image' };
  } catch (error) {
    return { ok: false, url, error: error.message };
  }
}

async function fetchRepairImage(sourceRoot, importerFile, baseName, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.startsWith('image/')) throw new Error(`image_fetch_failed_${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length < 1024) throw new Error('image_fetch_empty_body');
    const ext = imageExtension(contentType);
    const assetPath = path.join(sourceRoot, 'src', 'assets', `${baseName}${ext}`);
    await mkdir(path.dirname(assetPath), { recursive: true });
    await writeFile(assetPath, body);
    const relative = path.relative(path.dirname(importerFile), assetPath).replace(/\\/g, '/');
    const importPath = relative.startsWith('.') ? relative : `./${relative}`;
    return { ok: true, url, expression: `new URL("${importPath}", import.meta.url).href` };
  } catch (error) {
    return { ok: false, url, error: error.message };
  }
}

async function createGeneratedVisualAsset(sourceRoot, importerFile, baseName, sourceUrl = '') {
  try {
    const assetPath = path.join(sourceRoot, 'src', 'assets', `${baseName}.svg`);
    await mkdir(path.dirname(assetPath), { recursive: true });
    const hue = Math.abs(stableImageSeed({ id: baseName }, sourceUrl, 0)) % 360;
    const accent = `hsl(${hue} 78% 58%)`;
    const accent2 = `hsl(${(hue + 72) % 360} 82% 62%)`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000" role="img" aria-label="Web Studio visual"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#08111f"/><stop offset="1" stop-color="#101827"/></linearGradient><filter id="soft"><feGaussianBlur stdDeviation="18"/></filter></defs><rect width="1600" height="1000" fill="url(#g)"/><circle cx="1220" cy="220" r="260" fill="${accent}" opacity=".24" filter="url(#soft)"/><circle cx="330" cy="760" r="260" fill="${accent2}" opacity=".18" filter="url(#soft)"/><rect x="170" y="180" width="1260" height="640" rx="44" fill="#111827" stroke="#273244" stroke-width="4"/><rect x="250" y="270" width="520" height="64" rx="18" fill="${accent}" opacity=".72"/><rect x="250" y="380" width="860" height="34" rx="17" fill="#e5e7eb" opacity=".20"/><rect x="250" y="446" width="690" height="34" rx="17" fill="#e5e7eb" opacity=".14"/><g fill="none" stroke="${accent2}" stroke-width="7" stroke-linecap="round" stroke-dasharray="22 24"><path d="M330 650H590C660 650 660 560 730 560H1180"/><path d="M330 650H590C660 650 660 740 730 740H1180"/></g><g fill="#0b1020" stroke="#3b465c" stroke-width="4"><rect x="1110" y="480" width="210" height="120" rx="24"/><rect x="1110" y="680" width="210" height="120" rx="24"/></g><circle cx="330" cy="650" r="54" fill="${accent}" opacity=".82"/><circle cx="730" cy="560" r="42" fill="${accent2}" opacity=".78"/><circle cx="730" cy="740" r="42" fill="${accent}" opacity=".65"/></svg>`;
    await writeFile(assetPath, svg, 'utf8');
    const relative = path.relative(path.dirname(importerFile), assetPath).replace(/\\/g, '/');
    const importPath = relative.startsWith('.') ? relative : `./${relative}`;
    return { ok: true, url: sourceUrl, expression: `new URL("${importPath}", import.meta.url).href` };
  } catch (error) {
    return { ok: false, url: sourceUrl, error: error.message };
  }
}

function imageExtension(contentType = '') {
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('png')) return '.png';
  return '.jpg';
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

async function imageRepairUrlV2(lead = {}, context = '', ordinal = 0) {
  const key = imageRepairContextKey(lead, context);
  const roleKey = String(context || '').toLowerCase();
  const seed = stableImageSeed(lead, context, ordinal);
  const paperPackaging = [
    ['production|factory|manufactur|machine|roll|workshop|stanok|proizvod|ceh|цех|станок|производ', 'clean paper drinking straw production line, rolls of kraft paper, cutting and packing equipment, stacks of paper tubes, sustainable packaging factory, realistic industrial commercial photo, no people, no office desk, no mountains, no road, no computer', 11],
    ['variety|catalog|assort|product|range|straws-variety|services|feature|colors|diameter|ассортимент|каталог|цвет|диаметр', 'studio tabletop product catalog photo of eco paper cocktail straws in different colors and diameters, kraft boxes, clean seamless light background, horeca sustainable packaging assortment, commercial product photography, no landscape, no horizon, no mountains, no road, no people, no office desk', 12],
    ['delivery|box|warehouse|wholesale|order|request|contact|zayavka|price|payment|опт|короб|склад|доставка|заявк|цена', 'wholesale boxes of eco paper drinking straws ready for delivery to cafes and coffee shops, kraft packaging labels, clean warehouse shelf, sustainable horeca supplies, realistic commercial photo, no people, no office desk, no mountains, no road', 13],
    ['detail|close|material|quality|eco|leaf|kraft|bio|качество|материал|крафт|эко', 'close-up macro of biodegradable kraft paper drinking straws, paper texture and recyclable packaging detail, clean product photo for sustainable horeca supplier, realistic, no plastic, no people, no office desk, no mountains, no road', 14],
    ['hero|cover|banner|first|hero-straws|main-image|главн', 'premium commercial product photo of eco paper drinking straws for cafes, kraft paper straws arranged with recyclable packaging, clean bright background, sustainable horeca supplier brand, realistic, no plastic straws, no people, no office desk, no mountains, no road', 15],
  ];
  const photoStudio = [
    ['loft|brick|industrial', 'loft photography studio hall, exposed brick wall, large industrial windows, seamless paper backdrops, softbox lighting, wooden floor, realistic interior photo, no mountains, no road, no landscape, no office desk', 21],
    ['cyc|cyclorama|white|light', 'white cyclorama photography studio hall, clean curved wall, bright daylight, professional studio lights, minimal rental studio interior, realistic photo, no bedroom, no mountains, no road, no office desk', 22],
    ['cozy|warm|family', 'cozy warm photography studio hall for family portraits, neutral sofa, textured wall, soft curtains, warm studio lights, realistic interior photo, no wedding couple, no mountains, no road, no office desk', 23],
    ['dark|black|contrast', 'dark gray photography studio rental hall, charcoal backdrop, dramatic portrait lighting, two softbox lights, empty studio interior, realistic architectural photo, no office desk, no computer, no people, no mountains, no road', 24],
    ['detail|camera|equipment', 'close detail of professional photography studio equipment, camera on tripod, softbox lights, backdrops, premium studio rental mood, realistic photo, no office desk, no mountains, no road', 25],
    ['hero|cover|banner|studio|first|главн', 'premium commercial photography studio interior, large cyclorama wall, professional softboxes and camera stands, elegant rental studio atmosphere, realistic architectural photography, no people, no mountains, no road, no office desk', 26],
  ];
  const beauty = [
    ['interior|room|work', 'beauty salon treatment room, mirrors, styling chairs, warm lighting, clean premium interior, realistic photo, no office desk, no mountains, no road', 31],
    ['detail|service', 'beauty salon service detail, professional cosmetics and tools on clean counter, elegant spa mood, realistic close-up photo, no computer, no mountains, no road', 32],
    ['hero|cover|banner|first|главн', 'modern beauty salon interior, reception and styling chairs, soft natural light, premium calm atmosphere, realistic architectural photography, no office desk, no mountains, no road', 33],
  ];
  const aiStudio = [
    ['hero|cover|banner|first|главн', 'premium dark AI automation studio workspace, CRM pipeline dashboard on large monitor, neural network workflow diagrams, clean high-end technology office, realistic commercial photo, no people faces, no mountains, no road, no photography studio lights', 36],
    ['crm|api|integration|pipeline|ворон|интеграц', 'close-up of CRM automation dashboard, API integration nodes, sales pipeline analytics on screen, dark premium SaaS interface, realistic technology photo, no mountains, no road, no photography studio', 37],
    ['bot|chat|support|sales|продаж|поддерж', 'AI chatbot conversation dashboard for sales and support, messenger automation interface, clean dark control room mood, realistic technology workspace photo, no people faces, no mountains, no road', 38],
    ['process|workflow|agent|операцион|автоматизац', 'AI agent workflow map on a large screen, connected business process blocks, automation operations center, premium dark technology interior, realistic photo, no mountains, no road, no photography studio', 39],
  ];
  const construction = [
    ['detail|tool', 'close-up of construction tools, measuring tape, level and materials on renovation site, clean realistic commercial photo, no mountains, no road', 41],
    ['interior|finish', 'finished renovated apartment interior, fresh walls, modern flooring, clean daylight, realistic interior photography, no people, no mountains, no road', 42],
    ['hero|cover|banner|first|главн', 'professional home renovation crew working in modern apartment interior, clean construction site, tools and finished walls, realistic photo, no office desk, no mountains, no road', 43],
  ];
  const generic = [
    ['detail|team', 'professional local business workspace detail, documents and service tools, realistic commercial photo, no mountains, no road', 51],
    ['interior|office', 'clean modern service business office interior, warm light, realistic architectural photo, no mountains, no road', 52],
    ['hero|cover|banner|first|главн', 'modern local business interior, clean reception area, premium commercial photography, realistic, no mountains, no road', 53],
  ];
  const set = /paper\s*straw|straw|drinking\s*straw|cocktail\s*straw|kraft|horeca|packag|eco|biodegrad|трубоч|коктейл|бумажн|крафт|упаков|эко|биоразлага/.test(key)
    ? paperPackaging
    : /\bai\b|ии|нейро|neuro|chatbot|bot|бот|crm|api|a1|automation|автоматизац|интеграц|операцион/.test(key)
    ? aiStudio
    : /фото|photo|photography|photographer|фотограф|фотостуди/.test(key)
    ? photoStudio
    : /beauty|salon|крас|салон/.test(key)
      ? beauty
      : /ремонт|стро|кров|дом/.test(key)
        ? construction
        : generic;
  const matched = set.find(([pattern]) => new RegExp(pattern, 'i').test(roleKey)) || set[Math.abs(Number(ordinal) || 0) % set.length];
  const [, prompt, seedDelta] = matched;
  const brief = lead.customerBrief || {};
  const variation = [
    lead.name,
    lead.city,
    lead.niche,
    brief.businessName,
    brief.services,
    brief.style,
    String(context || '').slice(0, 180),
    `visual slot ${ordinal}`,
  ].filter(Boolean).join(', ');
  return generateNicheImageUrl(`${prompt}. Specific business context: ${variation}. Use a distinct composition for this visual slot; do not repeat the same image across sections.`, { seed: seed + seedDelta, niche: lead.niche || '' });
}

function imageRepairContextKey(lead = {}, context = '') {
  const brief = lead.customerBrief || {};
  return [
    lead.name,
    lead.niche,
    lead.city,
    brief.businessName,
    brief.goal,
    brief.services,
    brief.style,
    brief.materials,
    brief.summary,
    context,
  ].filter(Boolean).join(' ').toLowerCase();
}

function stableImageSeed(lead = {}, context = '', ordinal = 0) {
  const input = `${lead.id || lead.name || 'lead'}|${context || ''}|${ordinal || 0}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 100000 + (Math.abs(hash) % 800000);
}

function generatedImageUrl(prompt, seed) {
  return generateNicheImageUrl(prompt, { seed });
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

export async function applySimpleRevisionToSourceProject(store, leadId, { text = '', renderVideo = false } = {}) {
  let lead = store.getLead(leadId);
  if (!lead) return { ok: false, error: 'Lead not found' };
  const sourceRoot = lead.mockup?.sourceRoot;
  const slug = lead.mockup?.projectSlug;
  if (!sourceRoot || !slug) return { ok: false, error: 'Lead has no saved source project to revise' };

  const sourceBase = path.resolve(config.DATA_DIR, 'sources');
  const resolvedSource = path.resolve(sourceRoot);
  if (!resolvedSource.startsWith(sourceBase + path.sep)) return { ok: false, error: 'Unsafe source project path' };

  const target = await findRevisionTargetFile(resolvedSource);
  if (!target) return { ok: false, error: 'No supported source file for simple revision' };
  const previous = await readFile(target, 'utf8');
  const block = revisionBlockForFile(target, text, lead);
  const next = injectRevisionBlock(previous, block, target);
  if (next !== previous) await writeFile(target, next, 'utf8');

  const publicRoot = path.resolve(config.DATA_DIR, 'projects', slug);
  const publicUrl = projectUrl(slug);
  const routerPatch = await patchBrowserRouterBasename(resolvedSource);
  const build = await repairAndBuildSourceProject(resolvedSource, publicRoot, `/projects/${slug}/`, lead);
  const files = await collectSourceFiles(resolvedSource);
  const repoName = lead.mockup?.github?.repo || `${config.GITHUB_REPO_PREFIX}${slug}`.slice(0, 100).replace(/-+$/g, '');
  const github = await publishFilesToGitHub({
    repoName,
    description: `Web Studio landing for ${lead.name}`,
    files,
    metadata: { leadId: lead.id, businessName: lead.name, publicUrl, revisionText: text },
  }).catch((error) => ({ ok: false, error: error.message }));

  if (!build.ok) {
    await writeFile(path.join(publicRoot, 'index.html'), buildFailedHtml({ title: lead.name || 'Web Studio project', build }), 'utf8');
    lead = await store.updateLead(lead.id, {
      revision: {
        ...(lead.revision ?? {}),
        status: 'failed',
        failedAt: new Date().toISOString(),
        error: build.error || build.strategy || 'Revision build failed',
      },
      qualityGate: {
        ok: false,
        checkedAt: new Date().toISOString(),
        url: publicUrl,
        issues: [`revision_${build.strategy}`, 'build_failed_stub_page'],
        warnings: [],
      },
      status: 'needs_review',
      lane: 'Lovable',
      owner: 'Orchestrator',
    });
    await store.addEvent(lead.id, 'customer.revision_failed', `Coder revision failed: ${build.error || build.strategy}`);
    return { ok: false, error: build.error || build.strategy || 'Revision build failed', publicUrl, slug, github, build, lead };
  }

  lead = await store.updateLead(lead.id, {
    mockup: {
      ...compactStoredMockup(lead.mockup),
      ok: true,
      status: 'deployed',
      publishedUrl: publicUrl,
      deployedUrl: publicUrl,
      publicUrl,
      projectSlug: slug,
      sourceRoot: resolvedSource,
      deploymentStrategy: build.strategy,
      deploymentWarning: '',
      clientSendAllowed: true,
      routerPatch,
      github,
      revisedAt: new Date().toISOString(),
    },
    revision: {
      ...(lead.revision ?? {}),
      status: 'applied',
      appliedAt: new Date().toISOString(),
      appliedBy: 'coder',
      github,
      publicUrl,
    },
    pipelineStage: 'production',
    stageStatus: 'revision_applied',
    artifactStatus: 'deployed',
    lane: 'Ответы',
    owner: 'Coder',
    status: 'revision_applied',
  });
  await store.addEvent(lead.id, 'customer.revision_applied', `Coder applied customer revision: ${publicUrl}`);
  await crmAddEvent({
    entityType: lead.a1DealId ? 'deal' : 'lead',
    entityId: lead.a1DealId || lead.a1LeadId || lead.id,
    eventType: 'customer.revision_applied',
    text: `Coder applied customer revision: ${publicUrl}`,
    payload: { webstudioLeadId: lead.id, publicUrl, slug, github, build, text },
    idempotencyKey: `webstudio:${lead.id}:customer.revision_applied:${Date.now()}`,
  });
  await syncA1CrmLead(lead, 'customer_revision_applied');
  return { ok: true, publicUrl, slug, github, build, lead, videoQueued: renderVideo === false };
}

async function findRevisionTargetFile(sourceRoot) {
  const candidates = ['src/pages/Index.tsx', 'src/pages/Index.jsx', 'src/pages/Home.tsx', 'src/pages/Home.jsx', 'src/App.tsx', 'src/App.jsx', 'src/App.ts', 'src/App.js', 'index.html'];
  for (const relative of candidates) {
    const filePath = path.join(sourceRoot, relative);
    try {
      await readFile(filePath, 'utf8');
      return filePath;
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

function revisionBlockForFile(filePath, text, lead = {}) {
  const isHtml = filePath.endsWith('.html');
  const imageUrls = extractImageUrls(text);
  const mapUrl = yandexMapUrl(text, lead);
  if (isHtml) {
    return [
      '<section class="webstudio-revision-block" style="padding:72px 24px;background:#f8fafc;color:#111827">',
      '<div style="max-width:1120px;margin:0 auto">',
      '<p style="margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#64748b">Обновление сайта</p>',
      `<h2 style="margin:0 0 16px;font-size:32px;line-height:1.1">${escapeHtml(revisionTitle(text))}</h2>`,
      `<p style="margin:0 0 24px;max-width:760px;font-size:18px;line-height:1.55;color:#334155">${escapeHtml(text)}</p>`,
      ...imageUrls.map((url) => `<img src="${escapeHtml(url)}" alt="Материал клиента" style="width:100%;max-width:760px;border-radius:12px;margin:12px 0;display:block">`),
      mapUrl ? `<iframe title="Яндекс Карта" src="${escapeHtml(mapUrl)}" loading="lazy" style="width:100%;height:360px;border:0;border-radius:12px"></iframe>` : '',
      '</div>',
      '</section>',
    ].join('\n');
  }
  return [
    '      <section className="webstudio-revision-block" style={{ padding: "72px 24px", background: "#f8fafc", color: "#111827" }}>',
    '        <div style={{ maxWidth: "1120px", margin: "0 auto" }}>',
    '          <p style={{ margin: "0 0 10px", fontSize: "13px", textTransform: "uppercase", letterSpacing: ".08em", color: "#64748b" }}>Обновление сайта</p>',
    `          <h2 style={{ margin: "0 0 16px", fontSize: "32px", lineHeight: 1.1 }}>{${JSON.stringify(revisionTitle(text))}}</h2>`,
    `          <p style={{ margin: "0 0 24px", maxWidth: "760px", fontSize: "18px", lineHeight: 1.55, color: "#334155" }}>{${JSON.stringify(String(text || ''))}}</p>`,
    ...imageUrls.map((url) => `          <img src="${escapeHtml(url)}" alt="Материал клиента" style={{ width: "100%", maxWidth: "760px", borderRadius: "12px", margin: "12px 0", display: "block" }} />`),
    mapUrl ? `          <iframe title="Яндекс Карта" src="${escapeHtml(mapUrl)}" loading="lazy" style={{ width: "100%", height: "360px", border: 0, borderRadius: "12px" }} />` : '',
    '        </div>',
    '      </section>',
  ].join('\n');
}

function injectRevisionBlock(content, block, filePath) {
  const clean = stripExistingRevisionBlocks(content, filePath);
  if (filePath.endsWith('.html')) {
    if (clean.includes('</body>')) return clean.replace('</body>', `${block}\n</body>`);
    return `${clean}\n${block}`;
  }
  const mainIndex = clean.lastIndexOf('</main>');
  if (mainIndex >= 0) return `${clean.slice(0, mainIndex)}${block}\n${clean.slice(mainIndex)}`;
  const divIndex = clean.lastIndexOf('</div>');
  if (divIndex >= 0) return `${clean.slice(0, divIndex)}${block}\n${clean.slice(divIndex)}`;
  return clean;
}

function stripExistingRevisionBlocks(content, filePath) {
  const isHtml = filePath.endsWith('.html');
  const pattern = isHtml
    ? /\s*<section\s+class=["']webstudio-revision-block["'][\s\S]*?<\/section>\s*/g
    : /\s*<section\s+className=["']webstudio-revision-block["'][\s\S]*?<\/section>\s*/g;
  return String(content || '').replace(pattern, '\n');
}

function revisionTitle(text) {
  const value = String(text || '').toLowerCase();
  if (/карт|адрес|map|яндекс/.test(value)) return 'Как нас найти';
  if (/фото|изображ|картин|галере/.test(value)) return 'Новые материалы';
  if (/контакт|телефон|почт|email|telegram|whatsapp/.test(value)) return 'Контакты и связь';
  if (/блок|раздел|секц/.test(value)) return 'Новый раздел';
  return 'Обновление по задаче клиента';
}

function yandexMapUrl(text, lead = {}) {
  const value = String(text || '');
  if (!/(карт|map|yandex|яндекс|адрес|точк|координат)/i.test(value)) return '';
  const coordinates = extractMapCoordinates(value);
  if (coordinates) {
    const { lat, lon } = coordinates;
    return `https://yandex.ru/map-widget/v1/?ll=${encodeURIComponent(`${lon},${lat}`)}&z=16&pt=${encodeURIComponent(`${lon},${lat},pm2rdm`)}`;
  }
  const explicitAddress = extractExplicitMapAddress(value);
  const leadAddress = normalizeLeadAddress(lead);
  const query = explicitAddress || leadAddress;
  if (!query) return '';
  return `https://yandex.ru/map-widget/v1/?text=${encodeURIComponent(query)}&z=16`;
}

function normalizeLeadAddress(lead = {}) {
  const address = String(lead.address || '').trim();
  if (!address) return '';
  const city = String(lead.city || '').trim();
  if (!city || address.toLowerCase().includes(city.toLowerCase())) return address;
  return `${city}, ${address}`;
}

function extractExplicitMapAddress(value) {
  const text = String(value || '');
  const patterns = [
    /(?:адрес|address)(?:\s+[\p{L}\d_-]+){0,4}\s*[:\-–]\s*([^\n;]+)/iu,
    /(?:адрес|address)\s+([^\n;]+)/iu,
    /(?:по адресу|находимся по адресу|точка на карте)\s+([^\n;]+)/iu,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const address = match?.[1]
      ?.replace(/\s+(?:контакты|телефон|phone|email|telegram|whatsapp|почта)\s*:.*$/iu, '')
      .replace(/[.。]+$/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    if (address && /[,\d]/.test(address) && !/(виджет|карт|map|yandex|яндекс)$/i.test(address)) return address;
  }
  return '';
}

function extractMapCoordinates(value) {
  const match = String(value || '').match(/(?:координаты|coords?|geo|lat\/lon|lat\s*,?\s*lon)?\s*(-?\d{1,2}(?:[.,]\d{3,}))\s*[,; ]\s*(-?\d{1,3}(?:[.,]\d{3,}))/i);
  if (!match) return null;
  const lat = Number.parseFloat(match[1].replace(',', '.'));
  const lon = Number.parseFloat(match[2].replace(',', '.'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function extractImageUrls(text) {
  return [...String(text || '').matchAll(/https?:\/\/\S+\.(?:png|jpe?g|webp|gif)(?:\?\S*)?/gi)].map((match) => match[0].replace(/[),.]+$/, '')).slice(0, 6);
}

async function collectSourceFiles(sourceRoot) {
  const files = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(sourceRoot, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'build', '.git'].includes(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!isPublishableSourceFile(relative)) continue;
      files.push({ path: relative, content: await readFile(full, 'utf8') });
    }
  }
  await walk(sourceRoot);
  return files;
}

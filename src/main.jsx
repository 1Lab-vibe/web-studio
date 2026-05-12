import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  CreditCard,
  Film,
  FileText,
  Gauge,
  Globe2,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Mail,
  MapPinned,
  MessageSquareText,
  MonitorSmartphone,
  PauseCircle,
  PenLine,
  PhoneCall,
  Radar,
  RefreshCcw,
  Search,
  Send,
  ShieldCheck,
  Smartphone,
  Sparkles,
  UserRound,
  Wand2,
  X,
} from 'lucide-react';
import './styles.css';

const lanes = ['Разведка', 'Диагноз', 'Lovable', 'Видео', 'Проверка', 'Отправка', 'Ответы'];

function apiFetch(url, options = {}) {
  return fetch(url, {
    cache: 'no-store',
    ...options,
    headers: {
      'Cache-Control': 'no-cache',
      ...(options.headers ?? {}),
    },
  });
}

async function jsonOrThrow(response, label) {
  if (!response.ok) {
    const error = new Error(`${label} failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}
const agentMeta = {
  Scout: { role: 'ищет лиды в Яндекс/Google Maps', icon: Radar, tone: 'red' },
  Diagnoser: { role: 'готовит диагноз, hero angle и pitch', icon: ClipboardCheck, tone: 'blue' },
  Builder: { role: 'создает top-5 мокапов через Lovable', icon: Wand2, tone: 'teal' },
  Coder: { role: 'деплоит GitHub repo и делает простые правки сайта', icon: Bot, tone: 'black' },
  Filmer: { role: 'готовит скриншоты и вертикальное видео', icon: Film, tone: 'amber' },
  Checker: { role: 'проверяет персонализацию и AI-маркеры', icon: ShieldCheck, tone: 'teal' },
  Pitcher: { role: 'отправляет сообщение в правильный канал', icon: Send, tone: 'blue' },
  Mobile: { role: 'ведет положительные ответы и созвоны', icon: Smartphone, tone: 'black' },
};

function formatRub(value) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return 'нет оценки';
  return `${amount.toLocaleString('ru-RU')} ₽`;
}

function primaryEmail(lead) {
  const emails = Array.isArray(lead?.contacts?.emails) ? lead.contacts.emails.filter(Boolean) : [];
  const emailChannel = Array.isArray(lead?.contacts?.channels)
    ? lead.contacts.channels.find((channel) => channel?.type === 'email' && channel?.value)
    : null;
  return emails[0] || emailChannel?.value || '';
}

function emailCandidates(lead) {
  const emails = Array.isArray(lead?.contacts?.emails) ? lead.contacts.emails.filter(Boolean) : [];
  const channelEmails = Array.isArray(lead?.contacts?.channels)
    ? lead.contacts.channels.filter((channel) => channel?.type === 'email' && channel?.value).map((channel) => channel.value)
    : [];
  return Array.from(new Set([...emails, ...channelEmails]));
}

function outboundPreview(lead) {
  const siteUrl = absoluteUrl(lead?.mockup?.publishedUrl || lead?.mockup?.deployedUrl || lead?.mockup?.publicUrl || '');
  const videoUrl = absoluteUrl(lead?.video?.videoUrl || '');
  const botLink = lead?.customerBotLink || '';
  const owner = lead?.ownerName || lead?.contactName || '';
  const greeting = owner ? `${owner}, здравствуйте.` : 'Здравствуйте.';
  const business = lead?.name || 'ваша компания';
  const niche = lead?.niche || 'ваш бизнес';
  const angle = lead?.angle || `сделать сайт, который быстро объясняет ценность ${business} и ведет клиента к заявке`;
  const diagnosis = lead?.diagnosis || 'Сейчас часть клиентов может уходить к тем, кого проще найти, понять и быстро оставить заявку онлайн.';
  const simplePrice = 30000;
  const fullPrice = Math.max(simplePrice, Number(lead?.deal || 0));
  const offer = `По стоимости: разработка начинается от ${formatRub(simplePrice)} за простой сайт-визитку. Вариант с полным функционалом и дополнительными модулями под вашу задачу агент предварительно оценил в ${formatRub(fullPrice)}. Финальную стоимость фиксируем после согласованного превью и ТЗ.`;
  const body = [
    greeting,
    '',
    `Мы посмотрели, как ${business} сейчас можно усилить в интернете, и собрали не абстрактное предложение, а готовое превью сайта под ${niche}.`,
    '',
    `Идея первого экрана: ${angle}`,
    `Почему это может дать заявки: ${diagnosis}`,
    '',
    siteUrl ? `Посмотрите превью: ${siteUrl}` : '',
    videoUrl ? `Короткое видео-превью: ${videoUrl}` : '',
    '',
    `Если направление нравится, мы быстро заменим тексты, фотографии, цены, контакты и форму заявки под вас. ${offer}`,
    botLink ? `Правки и ТЗ можно дать прямо в Telegram-боте: ${botLink}` : '',
    '',
    'Если не актуально, просто ответьте “не интересно”, больше не будем отвлекать.',
    '',
    'С уважением,',
    'студия 1Lab, Иван',
    'Telegram: @Van_true777',
    'Телефон: 8-905-777-76-72',
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
  return {
    to: primaryEmail(lead) || 'email не найден',
    subject: owner ? `${owner}, показали, как может продавать сайт ${business}` : `Показали, как может продавать сайт ${business}`,
    body,
    attachments: [
      siteUrl ? `Превью сайта: ${siteUrl}` : '',
      videoUrl ? `Видео-превью: ${videoUrl}` : '',
    ].filter(Boolean),
  };
}

function absoluteUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return origin ? `${origin}${url.startsWith('/') ? '' : '/'}${url}` : url;
}

function scoringSummary(lead) {
  const scoring = lead?.scoring || {};
  const parts = [
    `priority ${scoring.priority ?? lead?.priority ?? 0}`,
    `deal ${formatRub(scoring.deal ?? lead?.deal)}`,
    `reply ${scoring.replyRate ?? lead?.replyRate ?? 0}%`,
    `siteGap ${scoring.siteGap ?? 0}`,
    `niche ${scoring.nicheWeight ?? 0}`,
    `contacts ${scoring.contactScore ?? 0}`,
  ];
  return parts.join(' · ');
}

function formatTime(value) {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'n/a';
  return date.toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

function shortId(value) {
  return value ? String(value).slice(0, 8) : 'global';
}

function App() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const syncPath = () => setPath(window.location.pathname);
    window.addEventListener('popstate', syncPath);
    return () => window.removeEventListener('popstate', syncPath);
  }, []);

  if (path.startsWith('/admin_cabinet')) return <AdminApp />;
  if (path.startsWith('/cabinet')) return <CustomerCabinet />;
  return <PublicSite />;
}

const publicPortfolioItems = [
  {
    title: 'Lucky Studio',
    type: 'фотостудия',
    image: '/portfolio/lucky.png',
    href: '/projects/fotostudiya-lucky-3b4dbf14/',
    text: 'Атмосферная подача залов, быстрый запрос бронирования и понятный первый экран для съемок.',
  },
  {
    title: '1Lab AI Studio',
    type: 'AI-продукты',
    image: '/portfolio/ai.png',
    href: '/projects/1lab-ai-studio-724a381c/',
    text: 'Темный технологичный сайт для сложного B2B-продукта с акцентом на сценарии внедрения.',
  },
  {
    title: 'Nika Estate',
    type: 'недвижимость',
    image: '/portfolio/estate.png',
    href: '/projects/nika-estate-moskva-ad1bf1ef/',
    text: 'Премиальная витрина объектов, доверие к экспертизе и быстрый переход к заявке.',
  },
  {
    title: 'Karimoff Clinic',
    type: 'стоматология',
    image: '/portfolio/dental.png',
    href: '/projects/stomatologiya-karimoff-clinic-e37a7b5a/',
    text: 'Медицинский лендинг с упором на запись, услуги, отзывы и спокойную визуальную подачу.',
  },
  {
    title: 'Ремстрой',
    type: 'ремонт',
    image: '/portfolio/renovation.png',
    href: '/projects/remstroy-fd4d3152/',
    text: 'Практичный сайт услуг: понятный оффер, сроки, гарантии, контакты и заявка на смету.',
  },
];

const publicTestimonials = [
  {
    quote: 'Понравилось, что сначала видно живое превью, а не абстрактное ТЗ. Проще понять, что именно покупаем.',
    name: 'Марина',
    role: 'локальный сервис',
  },
  {
    quote: 'Правки можно описать обычными словами. Не нужно разбираться в админке и объяснять разработчику каждую мелочь.',
    name: 'Алексей',
    role: 'услуги для бизнеса',
  },
  {
    quote: 'Сайт выглядит как готовый продукт: первый экран, форма заявки, контакты и мобильная версия сразу в одном месте.',
    name: 'Елена',
    role: 'частная клиника',
  },
];

function PublicSite() {
  return (
    <main className="public-shell studio-site">
      <header className="public-nav">
        <a className="public-brand" href="/">
          <span className="public-brand-mark">1L</span>
          <span>
            1Lab Web Studio
            <small>сайты, превью и личный кабинет</small>
          </span>
        </a>
        <nav>
          <a href="#portfolio">Работы</a>
          <a href="#cabinet">Кабинет</a>
          <a href="#process">Процесс</a>
          <a href="#pricing">Стоимость</a>
          <a href="#contacts">Контакты</a>
        </nav>
        <div className="public-nav-actions">
          <a className="public-link" href="#documents">Документы</a>
          <a className="public-button small" href="/cabinet">Личный кабинет</a>
        </div>
      </header>

      <section className="public-hero">
        <div className="hero-copy">
          <h1>Сайт, который приводит заявки</h1>
          <p>
            Не просто красивый экран: сначала показываем рабочее превью до оплаты, затем доводим оффер, форму заявки, доверие, контакты и мобильную версию.
            После запуска сайт можно развивать через кабинет или Telegram.
          </p>
          <div className="hero-actions">
            <a className="public-button" href="/cabinet">Получить превью сайта</a>
            <a className="public-ghost" href="#portfolio">Смотреть примеры</a>
          </div>
          <div className="hero-proof">
            <span><CheckCircle2 size={16} /> оплата после согласованного превью</span>
            <span><MonitorSmartphone size={16} /> мобильная версия сразу</span>
            <span><MessageSquareText size={16} /> правки текстом или через кабинет</span>
          </div>
          <div className="hero-metrics" aria-label="Преимущества 1Lab Web Studio">
            <div>
              <strong>30 000 ₽</strong>
              <span>старт сайта-визитки</span>
            </div>
            <div>
              <strong>2</strong>
              <span>правки включены</span>
            </div>
            <div>
              <strong>24/7</strong>
              <span>кабинет проекта</span>
            </div>
          </div>
        </div>
        <div className="hero-product" aria-label="Визуал 1Lab Web Studio">
          <div className="hero-image-shell">
            <img src="/hero/1lab-webstudio-hero.png" alt="1Lab Web Studio: рабочее превью сайта и кабинет проекта" />
            <div className="hero-visual-card top">
              <small>из идеи в ссылку</small>
              <strong>Превью сайта</strong>
              <span>первый экран, заявка, доверие</span>
            </div>
            <div className="hero-visual-card bottom">
              <small>после запуска</small>
              <strong>Правки диалогом</strong>
              <span>контент, блоки, карта, формы</span>
            </div>
          </div>
        </div>
      </section>

      <section className="portfolio-section" id="portfolio">
        <div className="section-title wide">
          <span className="section-eyebrow">Наши работы</span>
          <h2>Показываем не макет в вакууме, а рабочую ссылку под конкретный бизнес</h2>
          <p>Для каждого проекта собираем первый экран, структуру заявки, доверие, контакты и мобильный сценарий. Ниже реальные превью из нашего контура публикации.</p>
        </div>
        <div className="portfolio-grid">
          {publicPortfolioItems.map((item, index) => (
            <a className={`portfolio-card portfolio-card-${index + 1}`} href={item.href} key={item.title} target="_blank" rel="noreferrer">
              <img src={item.image} alt={`Превью сайта ${item.title}`} loading={index === 0 ? 'eager' : 'lazy'} />
              <div>
                <span>{item.type}</span>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </div>
            </a>
          ))}
        </div>
      </section>

      <section className="cabinet-showcase" id="cabinet">
        <div className="cabinet-copy">
          <span className="section-eyebrow">Личный кабинет</span>
          <h2>После запуска сайт не превращается в закрытую коробку</h2>
          <p>
            Владелец видит проекты, превью, оплату, документы и историю задач. Новую правку можно написать обычным текстом: обновить контакты, добавить зал,
            поменять фото, подключить карту с точкой, вставить новый блок или подготовить отдельную посадочную страницу.
          </p>
          <div className="cabinet-actions">
            <a className="public-button" href="/cabinet">Открыть кабинет</a>
            <a className="public-ghost" href="#pricing">Посмотреть старт</a>
          </div>
        </div>
        <div className="showcase-panel">
          <div className="showcase-header">
            <strong>Проект клиента</strong>
            <span>в работе</span>
          </div>
          <div className="showcase-row">
            <MonitorSmartphone size={20} />
            <span>Превью сайта</span>
            <strong>готово</strong>
          </div>
          <div className="showcase-row">
            <PenLine size={20} />
            <span>Правка</span>
            <strong>заменить hero-фото</strong>
          </div>
          <div className="showcase-row">
            <MapPinned size={20} />
            <span>Карта</span>
            <strong>точка на адресе</strong>
          </div>
          <div className="showcase-row">
            <CreditCard size={20} />
            <span>Оплата</span>
            <strong>после превью</strong>
          </div>
        </div>
      </section>

      <section className="public-band process-band" id="process">
        <div className="section-title">
          <span className="section-eyebrow">Процесс</span>
          <h2>От идеи до публикации без потери контекста</h2>
          <p>Сначала показываем направление, затем доводим контент, правки, оплату и домен до рабочего состояния.</p>
        </div>
        <div className="process-grid">
          {[
            ['01', 'Бриф и согласия', 'Клиент регистрируется, подтверждает email и явно принимает документы.'],
            ['02', 'Превью сайта', 'Собираем первый вариант с реальными текстами, hero, формой заявки и мобильной версией.'],
            ['03', 'Согласование', 'Клиент пишет правки в кабинете или Telegram, а система сохраняет историю и статус.'],
            ['04', 'Оплата и домен', 'После согласованного превью формируется оплата, затем сайт публикуется на домене клиента.'],
          ].map(([num, title, text]) => (
            <article className="process-step" key={num}>
              <span>{num}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="testimonials-section">
        <div className="section-title">
          <span className="section-eyebrow">Отзывы</span>
          <h2>Что ценят клиенты после первого демо</h2>
        </div>
        <div className="testimonial-grid">
          {publicTestimonials.map((item) => (
            <article className="testimonial-card" key={item.name}>
              <p>«{item.quote}»</p>
              <div>
                <strong>{item.name}</strong>
                <span>{item.role}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="pricing-section" id="pricing">
        <div className="pricing-copy">
          <span className="section-eyebrow">Стоимость</span>
          <h2>От 30 000 ₽ за сайт-визитку, дальше по объему задач</h2>
          <p>
            Стартовый проект закрывает понятный первый экран, структуру, форму заявки, контакты и адаптивную версию. Полный сайт с дополнительными модулями,
            интеграциями и контентом оцениваем после брифа и первого превью.
          </p>
        </div>
        <div className="pricing-card">
          <strong>В старт входит</strong>
          <ul>
            <li>первый экран с сильным оффером;</li>
            <li>структура услуг и блок доверия;</li>
            <li>форма заявки и контакты;</li>
            <li>адаптация под мобильные устройства;</li>
            <li>личный кабинет для дальнейших правок;</li>
            <li>публикация на домене клиента после настройки DNS.</li>
          </ul>
          <a className="public-button" href="/cabinet">Начать с превью</a>
        </div>
      </section>

      <section className="documents-section" id="documents">
        <div>
          <span className="section-eyebrow">Юридический блок</span>
          <h2>Документы открыты до регистрации</h2>
          <p>Перед работой клиент отдельно принимает согласие на обработку персональных данных и отдельно решает, разрешать ли маркетинговые сообщения.</p>
        </div>
        <div className="document-links">
          <a href="/privacy"><ShieldCheck size={18} /> Политика ПД</a>
          <a href="/personal-data-consent"><FileText size={18} /> Согласие ПД</a>
          <a href="/marketing-consent"><Mail size={18} /> Маркетинговое согласие</a>
          <a href="/offer"><ClipboardCheck size={18} /> Оферта</a>
          <a href="/disclaimer"><LockKeyhole size={18} /> Дисклеймер</a>
        </div>
      </section>

      <section className="contacts-section" id="contacts">
        <div className="contacts-copy">
          <span className="section-eyebrow">Контакты</span>
          <h2>Можно начать через кабинет, Telegram или прямой контакт</h2>
          <p>Для проекта сайта достаточно описать бизнес и задачу. Если удобнее обсудить вручную, напишите в Telegram или позвоните.</p>
          <div className="contacts-actions">
            <a className="public-button" href="https://t.me/a1_web_studio_bot" target="_blank" rel="noreferrer">
              <Send size={18} /> Открыть Telegram-бота
            </a>
            <a className="public-ghost" href="https://t.me/Van_true777" target="_blank" rel="noreferrer">
              <MessageSquareText size={18} /> Написать Ивану
            </a>
          </div>
        </div>
        <div className="contacts-card">
          <div>
            <Mail size={19} />
            <span>Почта</span>
            <a href="mailto:1lab@1true.ru">1lab@1true.ru</a>
          </div>
          <div>
            <PhoneCall size={19} />
            <span>Телефон</span>
            <a href="tel:+79057777672">8-905-777-76-72</a>
          </div>
          <div>
            <Send size={19} />
            <span>Telegram</span>
            <a href="https://t.me/Van_true777" target="_blank" rel="noreferrer">@Van_true777</a>
          </div>
          <div>
            <FileText size={19} />
            <span>Реквизиты</span>
            <strong>ИП Трушков Иван Алексеевич · ИНН 500804863530</strong>
          </div>
        </div>
      </section>

      <section className="final-cta">
        <div>
          <span className="section-eyebrow">Старт проекта</span>
          <h2>Покажем первый вариант сайта, чтобы решение было предметным</h2>
          <p>Зарегистрируйтесь, подтвердите email и опишите бизнес. Дальше кабинет проведет по брифу, превью, оплате и правкам.</p>
        </div>
        <a className="public-button" href="/cabinet">Перейти в кабинет</a>
      </section>

      <footer className="public-footer">
        <span>© 1Lab Web Studio</span>
        <nav>
          <a href="/privacy">Политика ПД</a>
          <a href="/personal-data-consent">Согласие ПД</a>
          <a href="/marketing-consent">Маркетинг</a>
          <a href="/offer">Оферта</a>
          <a href="/disclaimer">Дисклеймер</a>
          <a href="#contacts">Контакты</a>
        </nav>
      </footer>
    </main>
  );
}

function CustomerCabinet() {
  const [session, setSession] = useState({ loading: true, authenticated: false, projects: [] });
  const [adminSession, setAdminSession] = useState({ authenticated: false });
  const [activeProjectId, setActiveProjectId] = useState('');
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProject, setNewProject] = useState({ businessName: '', phone: '', goal: '' });
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const loadSession = async () => {
    const response = await apiFetch('/api/customer/session', { credentials: 'include' });
    const data = await response.json();
    setSession({ loading: false, authenticated: Boolean(data.authenticated), email: data.email || '', projects: data.projects || [] });
    setActiveProjectId((current) => current || data.projects?.[0]?.id || '');
  };

  const loadAdminSession = async () => {
    try {
      const response = await apiFetch('/api/auth/session', { credentials: 'include' });
      const data = await response.json().catch(() => ({}));
      setAdminSession({ authenticated: Boolean(data.authenticated), user: data.user || '' });
    } catch {
      setAdminSession({ authenticated: false });
    }
  };

  useEffect(() => {
    loadSession().catch(() => setSession({ loading: false, authenticated: false, projects: [] }));
    loadAdminSession();
  }, []);

  const runCustomerAction = async (label, request, successText) => {
    setBusy(label);
    setNotice('');
    try {
      const response = await request();
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.error || 'Не удалось выполнить действие');
      setNotice(result.warning || successText);
      await loadSession();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy('');
    }
  };

  const logout = async () => {
    await apiFetch('/api/customer/logout', { method: 'POST', credentials: 'include' });
    setSession({ loading: false, authenticated: false, projects: [] });
  };

  const createProject = async (event) => {
    event.preventDefault();
    setBusy('newProject');
    setNotice('');
    try {
      const response = await apiFetch('/api/customer/projects', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newProject),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.error || 'Не удалось создать проект');
      setNotice('Новый сайт создан. Теперь можно утвердить ТЗ и собрать превью.');
      setNewProject({ businessName: '', phone: '', goal: '' });
      setShowNewProject(false);
      await loadSession();
      if (result.project?.id) setActiveProjectId(result.project.id);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy('');
    }
  };

  if (session.loading) return <main className="customer-shell loading" />;
  if (!session.authenticated) {
    const initialAuthMode =
      typeof window !== 'undefined' && (window.location.pathname.startsWith('/cabinet/login') || new URLSearchParams(window.location.search).get('mode') === 'login')
        ? 'login'
        : 'register';
    return (
      <main className="customer-shell">
        <CustomerHeader />
        <section className="customer-auth-layout">
          <div>
            <h1>Личный кабинет 1Lab</h1>
            <p>Зарегистрируйтесь по email, подтвердите код и ведите проект сайта через понятный диалог: бриф, превью, оплата и правки.</p>
            <div className="cabinet-benefits">
              <span><CheckCircle2 size={16} /> превью в одном месте</span>
              <span><CheckCircle2 size={16} /> оплата после готового направления</span>
              <span><CheckCircle2 size={16} /> история правок и статусов</span>
            </div>
          </div>
          <CustomerRegistration initialMode={initialAuthMode} onVerified={loadSession} />
        </section>
      </main>
    );
  }

  const activeProject = session.projects.find((project) => project.id === activeProjectId) || session.projects[0] || null;
  const normalizedSessionEmail = String(session.email || '').trim().toLowerCase();
  const normalizedAdminUser = String(adminSession.user || '').trim().toLowerCase();
  const showAdminLink = Boolean(adminSession.authenticated && normalizedSessionEmail === '1lab@1true.ru' && normalizedAdminUser === '1lab@1true.ru');
  const activeOffer = activeProject?.paymentOffer || {};
  const paymentStatus = String(activeProject?.payment?.status || '').toLowerCase();
  const paymentPending = ['manual_invoice_requested', 'requested', 'invoice_requested'].includes(paymentStatus);
  const paymentLabel = paymentPending ? 'Счет запрошен' : 'Получить счет';
  return (
    <main className="customer-shell">
      <CustomerHeader email={session.email} onLogout={logout} showAdmin={showAdminLink} />
      {notice && <div className="customer-notice">{notice}</div>}
      <section className="customer-dashboard">
        <aside className="project-list">
          <div className="project-list-head">
            <LayoutDashboard size={18} />
            <strong>Мои сайты</strong>
          </div>
          <button className="new-project-button" type="button" onClick={() => setShowNewProject((current) => !current)}>
            <strong>+ Новый сайт</strong>
            <span>создать проект в кабинете</span>
          </button>
          {session.projects.length ? (
            session.projects.map((project) => (
              <button className={project.id === activeProject?.id ? 'active' : ''} type="button" key={project.id} onClick={() => setActiveProjectId(project.id)}>
                <strong>{project.businessName || project.name}</strong>
                <span>{project.stageStatus || project.status || 'в работе'}</span>
              </button>
            ))
          ) : (
            <div className="empty-customer">Проект появится после регистрации заявки.</div>
          )}
        </aside>

        <section className="project-workspace">
          {showNewProject && (
            <form className="dialog-panel new-project-panel" onSubmit={createProject}>
              <strong>Новый сайт</strong>
              <p>Опишите бизнес и задачу. Проект появится в списке, а после утверждения ТЗ мы соберем первое превью.</p>
              <label>
                <span>Название бизнеса</span>
                <input value={newProject.businessName} onChange={(event) => setNewProject((current) => ({ ...current, businessName: event.target.value }))} required />
              </label>
              <label>
                <span>Телефон для связи</span>
                <input value={newProject.phone} onChange={(event) => setNewProject((current) => ({ ...current, phone: event.target.value }))} />
              </label>
              <label>
                <span>Что нужно сделать</span>
                <textarea value={newProject.goal} onChange={(event) => setNewProject((current) => ({ ...current, goal: event.target.value }))} placeholder="Например: сайт для студии, услуги, портфолио, форма заявки, карта, подключить домен..." required />
              </label>
              <button type="submit" disabled={busy === 'newProject' || !newProject.businessName.trim() || !newProject.goal.trim()}>Создать сайт</button>
            </form>
          )}
          {activeProject ? (
            <>
              <div className="project-hero-card">
                <div>
                  <small>Проект</small>
                  <h1>{activeProject.businessName || activeProject.name}</h1>
                  <p>Статус: {activeProject.stageStatus || activeProject.status || 'в работе'}</p>
                </div>
                <div className="project-actions">
                  {activeProject.previewUrl ? <a className="public-button small" href={activeProject.previewUrl} target="_blank" rel="noreferrer">Открыть превью</a> : <span className="ghost-status">Превью готовится</span>}
                  {activeProject.paymentUrl ? <a className="public-button small dark" href={activeProject.paymentUrl} target="_blank" rel="noreferrer">Оплатить</a> : (
                    <button
                      type="button"
                      disabled={Boolean(busy) || !activeProject.previewUrl || paymentPending}
                      onClick={() => runCustomerAction('payment', () => apiFetch(`/api/customer/projects/${activeProject.id}/payment`, { method: 'POST', credentials: 'include' }), 'Запросили ссылку на оплату')}
                    >
                      {paymentLabel}
                    </button>
                  )}
                </div>
              </div>

              <div className="payment-offer-card">
                <div>
                  <CreditCard size={21} />
                  <div>
                    <strong>{activeOffer.title || 'Разработка сайта-визитки 1Lab Web Studio'}</strong>
                    <p>{activeOffer.description || 'Первый экран, структура услуг, контакты, форма заявки, адаптивная версия и публикация после согласования.'}</p>
                    {activeOffer.fullEstimateRub > activeOffer.amountRub && (
                      <small>Расширенный сайт с дополнительными модулями предварительно оценивается от {formatRub(activeOffer.fullEstimateRub)}. Первый счет формируется за стартовый этап.</small>
                    )}
                    {activeProject.payment?.customerMessage && <small>{activeProject.payment.customerMessage}</small>}
                  </div>
                </div>
                <div className="payment-offer-price">
                  <span>Сумма счета</span>
                  <strong>{formatRub(activeOffer.amountRub || 30000)}</strong>
                </div>
              </div>

              <div className="preview-panel">
                {activeProject.previewUrl ? (
                  <iframe title="Превью сайта" src={activeProject.previewUrl} />
                ) : (
                  <div className="preview-empty">
                    <MonitorSmartphone size={34} />
                    <strong>Превью появится здесь</strong>
                    <span>Утвердите ТЗ, и сборка сайта запустится автоматически.</span>
                  </div>
                )}
              </div>

              <div className="cabinet-grid">
                <form
                  className="dialog-panel"
                  onSubmit={(event) => {
                    event.preventDefault();
                    runCustomerAction(
                      'brief',
                      () =>
                        apiFetch(`/api/customer/projects/${activeProject.id}/brief`, {
                          method: 'POST',
                          credentials: 'include',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ text: message, approved: true }),
                        }),
                      'ТЗ отправлено и поставлено в работу',
                    );
                    setMessage('');
                  }}
                >
                  <strong>Собрать или обновить ТЗ</strong>
                  <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Напишите, какой сайт нужен, какие разделы, стиль, примеры, контакты и материалы..." />
                  <button type="submit" disabled={Boolean(busy) || !message.trim()}>Утвердить ТЗ и собрать превью</button>
                </form>

                <form
                  className="dialog-panel"
                  onSubmit={(event) => {
                    event.preventDefault();
                    runCustomerAction(
                      'revision',
                      () =>
                        apiFetch(`/api/customer/projects/${activeProject.id}/revision`, {
                          method: 'POST',
                          credentials: 'include',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ text: revision }),
                        }),
                      'Правка поставлена в очередь',
                    );
                    setRevision('');
                  }}
                >
                  <strong>Правки по сайту</strong>
                  <textarea value={revision} onChange={(event) => setRevision(event.target.value)} placeholder="Например: заменить фото, добавить карту, изменить телефон, добавить блок с тарифами..." />
                  <button type="submit" disabled={Boolean(busy) || !revision.trim()}>Отправить правку</button>
                  <small>Правки запускаются после оплаты проекта. До оплаты можно уточнять ТЗ.</small>
                </form>
              </div>
            </>
          ) : (
            <div className="preview-empty">
              <UserRound size={34} />
              <strong>Проектов пока нет</strong>
              <span>Нажмите “Новый сайт”, чтобы создать проект и описать задачу.</span>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

function CustomerHeader({ email, onLogout, showAdmin = false }) {
  return (
    <header className="customer-header">
      <a className="public-brand" href="/">
        <span className="public-brand-mark">1L</span>
        <span>1Lab Web Studio</span>
      </a>
      <nav>
        <a href="/legal">Документы</a>
        {showAdmin && <a href="/admin_cabinet">Админка</a>}
        {email ? <button type="button" onClick={onLogout}>{email} · выйти</button> : <a href="/cabinet/login">Войти</a>}
      </nav>
    </header>
  );
}

function AuthSwitch({ mode, onChange }) {
  return (
    <div className="auth-switch" aria-label="Режим входа">
      <button className={mode === 'register' ? 'active' : ''} type="button" onClick={() => onChange('register')}>
        Новый проект
      </button>
      <button className={mode === 'login' ? 'active' : ''} type="button" onClick={() => onChange('login')}>
        Войти
      </button>
    </div>
  );
}

function CustomerRegistration({ onVerified, initialMode = 'register' }) {
  const initialEmail =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('email') || ''
      : '';
  const [mode, setMode] = useState(initialMode === 'login' ? 'login' : 'register');
  const [form, setForm] = useState({ name: '', businessName: '', email: '', phone: '', goal: '', personalDataConsent: false, marketingConsent: false });
  const [phase, setPhase] = useState('form');
  const [leadId, setLeadId] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  useEffect(() => {
    if (initialEmail) setForm((current) => ({ ...current, email: initialEmail }));
  }, [initialEmail]);

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setPhase('form');
    setLeadId('');
    setCode('');
    setError('');
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', nextMode === 'login' ? '/cabinet/login' : '/cabinet');
    }
  };

  const register = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch('/api/customer/register', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.error || 'Не удалось зарегистрироваться');
      if (result.emailSent === false) throw new Error(result.emailError || 'Заявка создана, но код на email не отправился. Попробуйте еще раз позже.');
      setLeadId(result.leadId);
      setPhase('code');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const requestLoginCode = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch('/api/customer/login-code', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.error || 'Не удалось отправить код входа');
      if (result.emailSent === false) throw new Error(result.emailError || 'Код входа не отправился. Попробуйте еще раз позже.');
      setLeadId(result.leadId);
      setPhase('code');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch('/api/customer/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId, email: form.email, code, mode }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.error || 'Код не подошел');
      await onVerified?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const resendCode = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch('/api/customer/resend-code', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId, email: form.email, mode }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false || result.emailSent === false) throw new Error(result.error || 'Не удалось отправить код заново');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'code') {
    return (
      <form className="customer-form" onSubmit={verify}>
        <AuthSwitch mode={mode} onChange={switchMode} />
        <strong>{mode === 'login' ? 'Вход по email-коду' : 'Подтвердите email'}</strong>
        <p>Мы отправили 6-значный код на {form.email}. Код действует 15 минут.</p>
        <label>
          <span>Код из письма</span>
          <input inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} />
        </label>
        {error && <p className="auth-error">{error}</p>}
        <button type="submit" disabled={busy || code.length < 4}>Войти в кабинет</button>
        <button type="button" className="text-button" disabled={busy} onClick={resendCode}>
          Отправить код заново
        </button>
        <button type="button" className="text-button" disabled={busy} onClick={() => setPhase('form')}>
          Изменить email
        </button>
      </form>
    );
  }

  if (mode === 'login') {
    return (
      <form className="customer-form" onSubmit={requestLoginCode}>
        <AuthSwitch mode={mode} onChange={switchMode} />
        <strong>Войти по email-коду</strong>
        <p className="auth-helper">Пароля нет: если забыли доступ или заходите с нового устройства, отправим одноразовый код на email проекта.</p>
        <label>
          <span>Email проекта</span>
          <input type="email" autoComplete="email" value={form.email} onChange={(event) => update('email', event.target.value)} required />
        </label>
        {error && <p className="auth-error">{error}</p>}
        <button type="submit" disabled={busy || !form.email.trim()}>Получить код входа</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => switchMode('register')}>
          Создать новый проект
        </button>
      </form>
    );
  }

  return (
    <form className="customer-form" onSubmit={register}>
      <AuthSwitch mode={mode} onChange={switchMode} />
      <strong>Регистрация проекта</strong>
      <label>
        <span>Ваше имя</span>
        <input value={form.name} onChange={(event) => update('name', event.target.value)} required />
      </label>
      <label>
        <span>Название бизнеса</span>
        <input value={form.businessName} onChange={(event) => update('businessName', event.target.value)} required />
      </label>
      <label>
        <span>Email</span>
        <input type="email" value={form.email} onChange={(event) => update('email', event.target.value)} required />
      </label>
      <label>
        <span>Телефон</span>
        <input value={form.phone} onChange={(event) => update('phone', event.target.value)} />
      </label>
      <label>
        <span>Коротко о задаче</span>
        <textarea value={form.goal} onChange={(event) => update('goal', event.target.value)} placeholder="Например: сайт для студии, услуги, портфолио, форма заявки, карта..." />
      </label>
      <label className="checkline">
        <input type="checkbox" checked={form.personalDataConsent} onChange={(event) => update('personalDataConsent', event.target.checked)} />
        <span>Я принимаю <a href="/personal-data-consent" target="_blank" rel="noreferrer">согласие на обработку ПД</a> и <a href="/privacy" target="_blank" rel="noreferrer">политику</a></span>
      </label>
      <label className="checkline">
        <input type="checkbox" checked={form.marketingConsent} onChange={(event) => update('marketingConsent', event.target.checked)} />
        <span>Согласен получать информационные и маркетинговые сообщения о проекте и услугах</span>
      </label>
      {error && <p className="auth-error">{error}</p>}
      <button type="submit" disabled={busy || !form.personalDataConsent}>Получить код и войти</button>
      <button type="button" className="text-button" disabled={busy} onClick={() => switchMode('login')}>
        Уже есть кабинет или забыли доступ? Войти по коду
      </button>
    </form>
  );
}

function AdminApp() {
  const [auth, setAuth] = useState({ loading: true, authenticated: false, authEnabled: true, user: null });
  const [backend, setBackend] = useState({
    status: 'offline',
    integrations: {},
    leads: [],
    metrics: {},
    events: [],
    approvals: [],
    topActions: [],
    outreachQueue: [],
    jobs: [],
    orchestratorRuns: [],
    autonomy: {},
  });
  const [city, setCity] = useState('Все города');
  const [activeLeadId, setActiveLeadId] = useState(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  const loadAuth = async () => {
    try {
      const response = await apiFetch('/api/auth/session', { credentials: 'include' });
      const session = await response.json();
      setAuth({
        loading: false,
        authenticated: Boolean(session.authenticated),
        authEnabled: Boolean(session.authEnabled),
        user: session.user,
      });
    } catch {
      setAuth({ loading: false, authenticated: false, authEnabled: true, user: null });
    }
  };

  const loadBackend = async () => {
    try {
      const [healthResponse, stateResponse, leadsResponse] = await Promise.all([
        apiFetch('/api/health', { credentials: 'include' }),
        apiFetch('/api/state', { credentials: 'include' }),
        apiFetch('/api/leads', { credentials: 'include' }),
      ]);
      if ([stateResponse, leadsResponse].some((response) => response.status === 401)) {
        setAuth((current) => ({ ...current, authenticated: false }));
        return;
      }
      const [health, state, leadData] = await Promise.all([
        jsonOrThrow(healthResponse, 'health'),
        jsonOrThrow(stateResponse, 'state'),
        jsonOrThrow(leadsResponse, 'leads'),
      ]);
      const leads = Array.isArray(leadData.data) ? leadData.data : [];
      const baseBackend = {
        status: health.ok ? 'online' : 'degraded',
        integrations: health.integrations ?? {},
        leads,
        metrics: state.data?.metrics ?? {},
        autonomy: { enabled: Boolean(health.autonomyEnabled), ...(health.autonomy ?? {}) },
      };
      setBackend((current) => ({ ...current, ...baseBackend }));
      setActiveLeadId((current) => current || leads[0]?.id || null);

      const optional = await Promise.allSettled([
        apiFetch('/api/events', { credentials: 'include', signal: AbortSignal.timeout(12000) }).then((response) => jsonOrThrow(response, 'events')),
        apiFetch('/api/approvals', { credentials: 'include', signal: AbortSignal.timeout(12000) }).then((response) => jsonOrThrow(response, 'approvals')),
        apiFetch('/api/orchestrator/top-actions?limit=8', { credentials: 'include', signal: AbortSignal.timeout(12000) }).then((response) => jsonOrThrow(response, 'top-actions')),
        apiFetch('/api/outreach-queue', { credentials: 'include', signal: AbortSignal.timeout(12000) }).then((response) => jsonOrThrow(response, 'outreach-queue')),
        apiFetch('/api/jobs?limit=250', { credentials: 'include', signal: AbortSignal.timeout(12000) }).then((response) => jsonOrThrow(response, 'jobs')),
        apiFetch('/api/orchestrator/runs?limit=10', { credentials: 'include', signal: AbortSignal.timeout(12000) }).then((response) => jsonOrThrow(response, 'runs')),
      ]);
      const [eventData, approvalData, actionData, queueData, jobsData, runsData] = optional.map((result) => (result.status === 'fulfilled' ? result.value : null));
      const authExpired = optional.some((result) => result.status === 'rejected' && result.reason?.status === 401);
      if (authExpired) {
        setAuth((current) => ({ ...current, authenticated: false }));
        return;
      }
      optional
        .filter((result) => result.status === 'rejected')
        .forEach((result) => console.warn('Optional backend block failed', result.reason));
      setBackend((current) => ({
        ...current,
        events: Array.isArray(eventData?.data) ? eventData.data : current.events,
        approvals: Array.isArray(approvalData?.data) ? approvalData.data : current.approvals,
        topActions: Array.isArray(actionData?.data) ? actionData.data : current.topActions,
        outreachQueue: Array.isArray(queueData?.data) ? queueData.data : current.outreachQueue,
        jobs: Array.isArray(jobsData?.data) ? jobsData.data : current.jobs,
        orchestratorRuns: Array.isArray(runsData?.data) ? runsData.data : current.orchestratorRuns,
      }));
    } catch (error) {
      console.error('Backend load failed', error);
      setBackend((current) => ({ ...current, status: 'offline' }));
    }
  };

  useEffect(() => {
    loadAuth();
  }, []);

  useEffect(() => {
    if (!auth.loading && !auth.authEnabled) setAuth((current) => ({ ...current, authenticated: true }));
    if (!auth.loading && (auth.authenticated || !auth.authEnabled)) loadBackend();
  }, [auth.loading, auth.authenticated, auth.authEnabled]);

  useEffect(() => {
    if (auth.loading || (!auth.authenticated && auth.authEnabled)) return undefined;
    const timer = window.setInterval(() => {
      loadBackend();
    }, 15000);
    const refreshOnFocus = () => loadBackend();
    const refreshOnVisibility = () => {
      if (document.visibilityState === 'visible') loadBackend();
    };
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnVisibility);
    };
  }, [auth.loading, auth.authenticated, auth.authEnabled]);

  const handleLogin = async (login, password) => {
    const response = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ login, password }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      if (response.status === 429 && result.blockedUntil) {
        throw new Error(`Слишком много попыток. Вход заблокирован до ${new Date(result.blockedUntil).toLocaleString('ru-RU')}`);
      }
      throw new Error(result.error || 'Не получилось войти');
    }
    await loadAuth();
  };

  const handleLogout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setAuth({ loading: false, authenticated: false, authEnabled: true, user: null });
  };

  const runAction = async (label, request, successText) => {
    setBusy(label);
    setNotice('');
    try {
      const response = await request();
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setAuth((current) => ({ ...current, authenticated: false }));
        return;
      }
      if (!response.ok || result.ok === false) throw new Error(result.error || result.reason || 'Действие не выполнено');
      setNotice(successText || 'Готово');
      await loadBackend();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy('');
    }
  };

  const runBackendAction = (action) =>
    runAction(action, () => apiFetch(`/api/orchestrator/${action}`, { method: 'POST', credentials: 'include' }), `${action} выполнен`);

  const advanceCurrentLane = (lane) =>
    runAction(
      'advance-lane',
      () =>
        apiFetch('/api/orchestrator/advance-lane', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ lane, limit: 50 }),
        }),
      `Стадия ${lane} передана дальше`,
    );

  const advanceLead = (leadId) =>
    runAction('advance', () => apiFetch(`/api/leads/${leadId}/advance`, { method: 'POST', credentials: 'include' }), 'Лид передан дальше');

  const deployLead = (leadId) =>
    runAction('coder-deploy', () => apiFetch(`/api/leads/${leadId}/coder/deploy`, { method: 'POST', credentials: 'include' }), 'Coder задеплоил проект');

  const decideApproval = (approvalId, decision) =>
    runAction(
      decision,
      () => apiFetch(`/api/approvals/${approvalId}/${decision}`, { method: 'POST', credentials: 'include' }),
      decision === 'approved' ? 'Approval одобрен' : 'Approval отклонен',
    );

  const cities = useMemo(() => ['Все города', ...Array.from(new Set(backend.leads.map((lead) => lead.city).filter(Boolean))).sort()], [backend.leads]);
  const visibleLeads = useMemo(
    () => backend.leads.filter((lead) => city === 'Все города' || lead.city === city),
    [backend.leads, city],
  );
  const scoredVisibleLeads = useMemo(
    () => [...visibleLeads].sort((a, b) => (b.fitScore ?? b.priority ?? 0) - (a.fitScore ?? a.priority ?? 0)),
    [visibleLeads],
  );
  const activeLead = backend.leads.find((lead) => lead.id === activeLeadId) || scoredVisibleLeads[0] || backend.leads[0] || null;
  const activeEvents = activeLead ? backend.events.filter((event) => event.leadId === activeLead.id) : [];
  const activeApproval = activeLead
    ? backend.approvals.find((approval) => approval.leadId === activeLead.id && approval.status === 'pending')
    : null;

  if (auth.loading) return <main className="auth-screen" />;
  if (!auth.authenticated) return <LoginScreen onLogin={handleLogin} />;

  return (
    <main className="app-shell">
      <TopBar
        city={city}
        cities={cities}
        setCity={setCity}
        backend={backend}
        user={auth.user}
        onLogout={handleLogout}
      />
      {notice && <div className="notice-line">{notice}</div>}
      <div className="workspace">
        <aside className="sidebar">
          <OrchestratorPanel metrics={backend.metrics} leads={backend.leads} />
          <AgentList activeAgent={activeLead?.owner} leads={backend.leads} />
          <RuleStack metrics={backend.metrics} />
        </aside>

        <section className="main-column">
          <SourcePanel leads={backend.leads} metrics={backend.metrics} />
          <BackendActions backend={backend} busy={busy} onRun={runBackendAction} onAdvanceLane={advanceCurrentLane} />
          <AutonomyMonitor backend={backend} />
          <TopNextActions actions={backend.topActions} onSelect={setActiveLeadId} />
          <FunnelBoard leads={scoredVisibleLeads} activeLeadId={activeLead?.id} onSelect={setActiveLeadId} />
          <ControlDeck metrics={backend.metrics} approvals={backend.approvals} outreachQueue={backend.outreachQueue} mockupLimit={backend.autonomy?.dailyMockupLimit ?? 10} />
        </section>

        <aside className="inspector">
          <LeadInspector
            lead={activeLead}
            approval={activeApproval}
            jobs={backend.jobs}
            busy={busy}
            onAdvance={advanceLead}
            onDeploy={deployLead}
            onDecision={decideApproval}
          />
          <Timeline lead={activeLead} events={activeEvents} />
        </aside>
      </div>
    </main>
  );
}

function LoginScreen({ onLogin }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await onLogin(login, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <span className="brand-mark">AO</span>
          <div>
            <strong>Agency Orchestrator RU</strong>
            <span>Вход в рабочую панель</span>
          </div>
        </div>
        <label>
          <span>Логин</span>
          <input autoComplete="username" value={login} onChange={(event) => setLogin(event.target.value)} />
        </label>
        <label>
          <span>Пароль</span>
          <input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error && <p className="auth-error">{error}</p>}
        <button type="submit" disabled={submitting}>
          <LockKeyhole size={16} />
          {submitting ? 'Проверка' : 'Войти'}
        </button>
        <div className="legal-links">
          <a href="/privacy" target="_blank" rel="noreferrer">Политика ПД</a>
          <a href="/personal-data-consent" target="_blank" rel="noreferrer">Согласие ПД</a>
          <a href="/marketing-consent" target="_blank" rel="noreferrer">Рассылки</a>
          <a href="/offer" target="_blank" rel="noreferrer">Оферта</a>
          <a href="/disclaimer" target="_blank" rel="noreferrer">Дисклеймер</a>
        </div>
      </form>
    </main>
  );
}

function TopBar({ city, cities, setCity, backend, user, onLogout }) {
  const mockupsToday = Number(backend.metrics.mockupsToday ?? 0);
  const mockupLimit = Number(backend.autonomy?.dailyMockupLimit ?? 10);
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">AO</span>
        <div>
          <strong>Agency Orchestrator RU</strong>
          <span>автономная фабрика сайтов для локального бизнеса</span>
        </div>
      </div>
      <nav className="top-actions" aria-label="Основные фильтры">
        <label className="searchbox">
          <Search size={16} />
          <select value={city} onChange={(event) => setCity(event.target.value)}>
            {cities.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <div className="model-chip">
          <Sparkles size={16} />
          OpenAI
        </div>
        <div className="metric-chip">
          <Gauge size={16} />
          Lovable {mockupsToday}/{mockupLimit}
        </div>
        <div className={`api-chip ${backend.status}`}>
          <Activity size={16} />
          API {backend.status}
        </div>
        <a className="legal-chip" href="/legal" target="_blank" rel="noreferrer">
          Документы
        </a>
        <button className="logout-button" type="button" onClick={onLogout} title="Выйти">
          <LogOut size={16} />
          {user || 'Выйти'}
        </button>
      </nav>
    </header>
  );
}

function BackendActions({ backend, busy, onRun, onAdvanceLane }) {
  const integrations = backend.integrations;
  return (
    <section className="backend-strip">
      <div>
        <div className="panel-title inline">
          <Bot size={18} />
          <span>Backend orchestration</span>
        </div>
        <p>
          OpenAI: {integrations.openai ? 'есть' : 'нет'} · Яндекс: {integrations.yandexMaps ? 'есть' : 'нет'} · Google:{' '}
          {integrations.googleMaps ? 'fallback есть' : 'fallback нет'} · Telegram: {integrations.telegram ? 'подключен' : 'нет'}
        </p>
      </div>
      <div className="backend-actions">
        <button type="button" disabled={Boolean(busy)} onClick={() => onRun('scout')}>
          <Search size={16} />
          Scout
        </button>
        <button type="button" disabled={Boolean(busy)} onClick={() => onRun('tick')}>
          <RefreshCcw size={16} />
          Tick
        </button>
        <button type="button" disabled={Boolean(busy)} onClick={() => onAdvanceLane('Диагноз')}>
          <ArrowRight size={16} />
          Диагноз дальше
        </button>
      </div>
    </section>
  );
}

function OrchestratorPanel({ metrics, leads }) {
  const active = leads.filter((lead) => !['done', 'paused'].includes(lead.status)).length;
  return (
    <section className="panel orchestrator-card">
      <div className="panel-title">
        <Bot size={18} />
        <span>Оркестратор</span>
      </div>
      <p>Владеет write-действиями, держит lock на лида и передает агентам только ограниченные задачи.</p>
      <div className="mini-stats">
        <span>{leads.length} лидов</span>
        <span>{active} активных</span>
        <span>{metrics.scannedToday ?? 0} найдено сегодня</span>
      </div>
      <div className="lockline">
        <LockKeyhole size={16} />1 лид = 1 активный агент
      </div>
    </section>
  );
}

function AgentList({ activeAgent, leads }) {
  return (
    <section className="panel">
      <div className="panel-title">
        <Activity size={18} />
        <span>Агенты</span>
      </div>
      <div className="agent-list">
        {Object.entries(agentMeta).map(([name, meta]) => {
          const Icon = meta.icon;
          const count = leads.filter((lead) => lead.owner === name).length;
          return (
            <div className={`agent-row ${activeAgent === name ? 'active' : ''}`} key={name}>
              <span className={`agent-icon ${meta.tone}`}>
                <Icon size={16} />
              </span>
              <div>
                <strong>{name}</strong>
                <small>{meta.role}</small>
              </div>
              <em>{count}</em>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RuleStack({ metrics }) {
  return (
    <section className="panel rules">
      <div className="panel-title">
        <ShieldCheck size={18} />
        <span>Границы автономии</span>
      </div>
      <div className="rule">
        <CheckCircle2 size={16} />
        Человек нужен при сделке выше 300 000 ₽
      </div>
      <div className="rule warning">
        <PauseCircle size={16} />
        Ниша ставится на паузу при reply rate ниже 12%
      </div>
      <div className="rule">
        <Globe2 size={16} />
        Google search сегодня: {metrics.googleSearchesToday ?? 0}
      </div>
    </section>
  );
}

function SourcePanel({ leads, metrics }) {
  const byCity = useMemo(() => {
    const counts = new Map();
    for (const lead of leads) counts.set(lead.city || 'Без города', (counts.get(lead.city || 'Без города') ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [leads]);
  return (
    <section className="source-strip">
      <div>
        <div className="panel-title inline">
          <MapPinned size={18} />
          <span>Разведка по картам</span>
        </div>
        <p>Фильтр: 5+ лет, до 50 отзывов, рейтинг от 4.4, нет сайта или слабый сайт. Яндекс основной, Google fallback.</p>
      </div>
      <div className="source-grid">
        {byCity.length ? byCity.map(([name, count]) => <span key={name}>{name} · {count}</span>) : <span>Лидов пока нет</span>}
        <span>Google · {metrics.googleSearchesToday ?? 0}</span>
      </div>
    </section>
  );
}

function FunnelBoard({ leads, activeLeadId, onSelect }) {
  const [laneLimits, setLaneLimits] = useState(() => Object.fromEntries(lanes.map((lane) => [lane, 10])));
  const sortedLeads = useMemo(
    () => [...leads].sort((a, b) => (b.fitScore ?? b.priority ?? 0) - (a.fitScore ?? a.priority ?? 0)),
    [leads],
  );
  const hiddenCount = lanes.reduce((total, lane) => {
    const laneTotal = sortedLeads.filter((lead) => lead.lane === lane).length;
    return total + Math.max(0, laneTotal - (laneLimits[lane] ?? 10));
  }, 0);
  const setLaneLimit = (lane, next) => setLaneLimits((current) => ({ ...current, [lane]: next }));
  return (
    <>
      <section className="funnel" aria-label="Воронка лидов">
        {lanes.map((lane) => {
          const allLaneLeads = sortedLeads.filter((lead) => lead.lane === lane);
          const laneLimit = laneLimits[lane] ?? 10;
          const laneTop = allLaneLeads.slice(0, laneLimit);
          const activeInLane = allLaneLeads.find((lead) => lead.id === activeLeadId);
          const laneLeads = activeInLane && !laneTop.some((lead) => lead.id === activeInLane.id) ? [...laneTop, activeInLane] : laneTop;
          const laneTotal = allLaneLeads.length;
          const laneHidden = Math.max(0, laneTotal - laneLimit);
          return (
            <div className="lane" key={lane}>
              <div className="lane-header">
                <span>{lane}</span>
                <small>{laneLeads.length}/{laneTotal}</small>
              </div>
              <div className="lead-stack">
                {laneLeads.length ? (
                  laneLeads.map((lead) => {
                    const emails = emailCandidates(lead);
                    return (
                      <button className={`lead-card ${activeLeadId === lead.id ? 'selected' : ''}`} key={lead.id} onClick={() => onSelect(lead.id)} type="button">
                        <span className="lead-head">
                          <strong>{lead.name}</strong>
                          <em>{lead.fitScore ?? lead.priority ?? 0}</em>
                        </span>
                        <span className="lead-meta">{lead.city} · {lead.niche}</span>
                        <span className="lead-facts">
                          <small>{lead.rating || 0}★</small>
                          <small>{lead.reviews ?? 0} отзывов</small>
                          <small>{lead.source === 'google_places' ? 'Google' : 'Яндекс'}</small>
                          <small>fit {lead.fitScore ?? lead.priority ?? 0}</small>
                          <small>{emails.length ? `${emails.length} email` : 'no email'}</small>
                        </span>
                        <span className="lead-foot">
                          <span>{lead.site || 'сайт не определен'}</span>
                          <span className={lead.status === 'waiting_approval' ? 'pause' : 'ok'}>{lead.owner}</span>
                        </span>
                        {lead.mockup?.buildUrl && <span className="lead-build">Lovable build ready</span>}
                      </button>
                    );
                  })
                ) : (
                  <div className="empty-lane">Нет лидов</div>
                )}
              </div>
              {laneHidden > 0 && (
                <div className="lane-controls">
                  <button type="button" onClick={() => setLaneLimit(lane, Math.min(laneTotal, laneLimit + 10))}>Еще 10</button>
                  <button type="button" onClick={() => setLaneLimit(lane, laneTotal)}>Все</button>
                </div>
              )}
            </div>
          );
        })}
      </section>
      {hiddenCount > 0 && (
        <div className="funnel-controls">
          <span>Скрыто {hiddenCount} лидов, в каждой колонке показаны топ-10 по FitScore. Активный лид показывается всегда.</span>
          <button type="button" onClick={() => setLaneLimits(Object.fromEntries(lanes.map((lane) => [lane, (laneLimits[lane] ?? 10) + 10])))}>Везде еще 10</button>
          <button type="button" onClick={() => setLaneLimits(Object.fromEntries(lanes.map((lane) => [lane, sortedLeads.filter((lead) => lead.lane === lane).length])))}>Показать все</button>
        </div>
      )}
    </>
  );
}

function Funnel({ leads, activeLeadId, onSelect }) {
  return (
    <section className="funnel" aria-label="Воронка лидов">
      {lanes.map((lane) => {
        const laneLeads = leads.filter((lead) => lead.lane === lane);
        return (
          <div className="lane" key={lane}>
            <div className="lane-header">
              <span>{lane}</span>
              <small>{laneLeads.length}</small>
            </div>
            <div className="lead-stack">
              {laneLeads.length ? (
                laneLeads.map((lead) => (
                  <button className={`lead-card ${activeLeadId === lead.id ? 'selected' : ''}`} key={lead.id} onClick={() => onSelect(lead.id)} type="button">
                    <span className="lead-head">
                      <strong>{lead.name}</strong>
                      <em>{lead.priority ?? 50}</em>
                    </span>
                    <span className="lead-meta">{lead.city} · {lead.niche}</span>
                    <span className="lead-facts">
                      <small>{lead.rating || 0}★</small>
                      <small>{lead.reviews ?? 0} отзывов</small>
                      <small>{lead.source === 'google_places' ? 'Google' : 'Яндекс'}</small>
                      <small>fit {lead.fitScore ?? lead.priority ?? 0}</small>
                      <small>{primaryEmail(lead) ? 'email' : 'no email'}</small>
                    </span>
                    <span className="lead-foot">
                      <span>{lead.site || 'сайт не определен'}</span>
                      <span className={lead.status === 'waiting_approval' ? 'pause' : 'ok'}>{lead.owner}</span>
                    </span>
                    {lead.mockup?.buildUrl && <span className="lead-build">Lovable build ready</span>}
                  </button>
                ))
              ) : (
                <div className="empty-lane">Нет лидов</div>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function TopNextActions({ actions, onSelect }) {
  return (
    <section className="top-next">
      <div className="panel-title inline">
        <Sparkles size={18} />
        <span>Top next actions</span>
      </div>
      <div className="action-list">
        {actions?.length ? (
          actions.map((item) => (
            <button
              type="button"
              key={`${item.lead.id}:${item.action}`}
              onClick={() => onSelect(item.lead.id)}
            >
              <span>
                <strong>{item.label}</strong>
                <small>{item.lead.name} · {item.lead.city} · fit {item.lead.fitScore ?? item.score}</small>
              </span>
              <ArrowRight size={16} />
            </button>
          ))
        ) : (
          <div className="empty-lane">Нет рекомендуемых действий</div>
        )}
      </div>
    </section>
  );
}

function AutonomyMonitor({ backend }) {
  const jobs = backend.jobs ?? [];
  const runs = backend.orchestratorRuns ?? [];
  const running = jobs.filter((job) => job.status === 'running');
  const failed = jobs.filter((job) => ['failed', 'dead'].includes(job.status));
  const queued = jobs.filter((job) => job.status === 'queued');
  const lastRun = runs[0] || null;
  const today = backend.metrics ?? {};
  return (
    <section className="autonomy-monitor">
      <div className="panel-title inline">
        <Gauge size={18} />
        <span>Autonomy Monitor</span>
      </div>
      <div className="monitor-grid">
        <div>
          <small>Автономия</small>
          <strong>{backend.autonomy?.enabled ? 'включена' : 'выключена'}</strong>
          <span>cron {backend.autonomy?.cron || 'n/a'}</span>
        </div>
        <div>
          <small>Последний tick</small>
          <strong>{lastRun ? `${Math.round((lastRun.durationMs || 0) / 1000)}с` : 'нет'}</strong>
          <span>{lastRun ? formatTime(lastRun.createdAt) : 'еще не запускался'}</span>
        </div>
        <div>
          <small>Jobs</small>
          <strong>{running.length} run · {queued.length} queue</strong>
          <span>{failed.length} failed/dead</span>
        </div>
        <div>
          <small>Сегодня</small>
          <strong>{today.scannedToday ?? 0} scanned</strong>
          <span>{today.mockupsToday ?? 0} scout built · {today.customerMockupsToday ?? 0} customer · {today.sentToday ?? 0} sent</span>
        </div>
      </div>
      {running.length > 0 && (
        <div className="job-line">
          {running.slice(0, 3).map((job) => (
            <span key={job.id}>{job.type} · {shortId(job.leadId)}</span>
          ))}
        </div>
      )}
      {failed.length > 0 && (
        <div className="job-errors">
          {failed.slice(0, 3).map((job) => (
            <span key={job.id}>{job.type}: {job.lastError || job.status}</span>
          ))}
        </div>
      )}
    </section>
  );
}

function ControlDeck({ metrics, approvals, outreachQueue = [], mockupLimit = 10 }) {
  const mockupsToday = Number(metrics.mockupsToday ?? 0);
  const usedPct = Math.min(100, (mockupsToday / Math.max(1, Number(mockupLimit) || 10)) * 100);
  const pending = approvals.filter((approval) => approval.status === 'pending').length;
  const queued = outreachQueue.filter((item) => item.status === 'queued').length;
  return (
    <section className="control-deck">
      <div className="quota-card">
        <div className="panel-title inline">
          <Wand2 size={18} />
          <span>Lovable MCP quota</span>
        </div>
        <div className="progress"><span style={{ width: `${usedPct}%` }} /></div>
        <strong>{mockupsToday}/{mockupLimit} мокапов сегодня</strong>
      </div>
      <div className="pause-card">
        <div className="panel-title inline">
          <PauseCircle size={18} />
          <span>Approval queue</span>
        </div>
        <div className="mini-stats">
          <span>{pending} ждут</span>
          <span>{approvals.length} всего</span>
          <span>{queued} queued</span>
        </div>
      </div>
      <div className="handoff-card">
        <div className="panel-title inline">
          <PhoneCall size={18} />
          <span>Mobile handoff</span>
        </div>
        <p>Положительные ответы и созвоны уходят Mobile-агенту, approvals доступны здесь и в Telegram.</p>
      </div>
    </section>
  );
}

function LeadInspector({ lead, approval, jobs = [], busy, onAdvance, onDeploy, onDecision }) {
  if (!lead) {
    return (
      <section className="panel lead-inspector empty-state">
        <MapPinned size={22} />
        <strong>Лидов пока нет</strong>
        <p>Запусти Scout, чтобы заполнить воронку реальными организациями.</p>
      </section>
    );
  }
  const email = primaryEmail(lead);
  const emails = emailCandidates(lead);
  const leadJobs = jobs.filter((job) => job.leadId === lead.id);
  const currentJob = leadJobs.find((job) => job.status === 'running') || leadJobs.find((job) => job.status === 'queued') || leadJobs.find((job) => ['failed', 'dead'].includes(job.status));
  return (
    <section className="panel lead-inspector">
      <div className="inspector-head">
        <div>
          <strong>{lead.name}</strong>
          <span>{lead.city} · {lead.niche}</span>
        </div>
        <span className="score">{lead.fitScore ?? lead.priority ?? 50}</span>
      </div>

      {lead.mockup?.buildUrl && (
        <a className="lovable-link primary" href={`/api/leads/${lead.id}/lovable/open`} target="_blank" rel="noreferrer">
          <Wand2 size={16} />
          Открыть Lovable Build URL
        </a>
      )}
      {lead.mockup?.deployedUrl && (
        <a className="lovable-link primary" href={lead.mockup.deployedUrl} target="_blank" rel="noreferrer">
          <Globe2 size={16} />
          Открыть деплой Web Studio
        </a>
      )}
      {(lead.mockup?.githubUrl || lead.mockup?.github?.repoUrl) && (
        <a className="lovable-link primary" href={lead.mockup.githubUrl || lead.mockup.github.repoUrl} target="_blank" rel="noreferrer">
          <Globe2 size={16} />
          Открыть GitHub проекта
        </a>
      )}
      {lead.mockup?.sourceUrl && (
        <a className="lovable-link primary" href={lead.mockup.sourceUrl} target="_blank" rel="noreferrer">
          <Globe2 size={16} />
          Открыть исходники
        </a>
      )}
      {lead.video?.videoUrl && (
        <a className="lovable-link primary" href={lead.video.videoUrl} target="_blank" rel="noreferrer">
          <Film size={16} />
          Открыть видео Filmer
        </a>
      )}

      <div className="fact-grid">
        <Fact label="FitScore" value={lead.fitScore ?? lead.priority ?? 0} />
        <Fact label="Оценка сайта" value={formatRub(lead.deal)} />
        <Fact label="Email" value={email || 'не найден'} />
        <Fact label="Рейтинг" value={`${lead.rating || 0}★`} />
        <Fact label="Отзывы" value={lead.reviews ?? 0} />
        <Fact label="Источник" value={lead.source === 'google_places' ? 'Google' : 'Яндекс'} />
        <Fact label="Сайт" value={lead.site || 'не определен'} />
      </div>

      <div className="fact-grid compact">
        <Fact label="Pipeline" value={lead.pipelineStage || lead.lane || 'n/a'} />
        <Fact label="Job" value={currentJob ? `${currentJob.type} · ${currentJob.status}` : 'нет активной'} />
        <Fact label="Quality" value={lead.qualityGate?.ok ? 'passed' : lead.qualityGate?.issues?.join(', ') || 'не проверено'} />
        <Fact label="Outbound" value={lead.outboundStatus || lead.pitch?.channel || 'не готов'} />
      </div>

      {approval && (
        <div className="approval-stack">
          <div className="gate alert">
            <LockKeyhole size={16} />
            {approval.message}
          </div>
          <div className="action-grid">
            <button type="button" disabled={Boolean(busy)} onClick={() => onDecision(approval.id, 'rejected')}>
              <X size={16} /> Отклонить
            </button>
            <button type="button" disabled={Boolean(busy)} onClick={() => onDecision(approval.id, 'approved')}>
              <Check size={16} /> Одобрить
            </button>
          </div>
        </div>
      )}

      <TextBlock title="Адрес" text={lead.address || 'Нет адреса'} />
      <TextBlock title="Телефон" text={lead.phone || 'Нет телефона'} />
      <TextBlock title="Диагноз" text={lead.diagnosis || 'Еще не подготовлен. Передай лида дальше, чтобы Diagnoser сформировал диагноз.'} />
      <TextBlock title="Hero angle" text={lead.angle || 'Еще не подготовлен'} />
      <TextBlock title={`Сообщение · ${lead.channel || 'канал не выбран'}`} text={lead.message || 'Еще не подготовлено'} />
      <EmailPreview lead={lead} />
      <TextBlock title="Telegram после письма" text={lead.telegramFollowup?.text || 'Сформируется после постановки письма в A1.'} />
      <TextBlock title="Email кандидаты" text={emails.length ? emails.join('\n') : 'не найдены'} />
      {lead.mockup?.handoffPrompt && <TextBlock title="Lovable handoff prompt" text={lead.mockup.handoffPrompt} />}
      {lead.mockup?.buildOpenedAt && <TextBlock title="Lovable open log" text={`Last opened: ${lead.mockup.buildOpenedAt}`} />}
      <TextBlock title="Скоринг" text={scoringSummary(lead)} />
      <div className="action-grid">
        <button type="button" disabled={Boolean(busy)}>
          <MessageSquareText size={16} /> Checker eval
        </button>
        {(lead.mockup?.url || lead.mockup?.publishedUrl) && lead.mockup?.status !== 'deployed' && (
          <button type="button" disabled={Boolean(busy)} onClick={() => onDeploy(lead.id)}>
            <Globe2 size={16} /> Coder deploy
          </button>
        )}
        <button type="button" disabled={Boolean(busy) || lead.status === 'waiting_approval'} onClick={() => onAdvance(lead.id)}>
          <ArrowRight size={16} /> Передать дальше
        </button>
      </div>
    </section>
  );
}

function Fact({ label, value }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TextBlock({ title, text }) {
  return (
    <div className="text-block">
      <span>{title}</span>
      <p>{text}</p>
    </div>
  );
}

function EmailPreview({ lead }) {
  const preview = outboundPreview(lead);
  return (
    <div className="email-preview">
      <span>Превью письма Pitcher</span>
      <div className="email-row">
        <small>Кому</small>
        <strong>{preview.to}</strong>
      </div>
      <div className="email-row">
        <small>Тема</small>
        <strong>{preview.subject}</strong>
      </div>
      <p>{preview.body || 'Сообщение еще не подготовлено'}</p>
      <div className="email-attachments">
        <small>Ссылки</small>
        {preview.attachments.length ? preview.attachments.map((item) => <code key={item}>{item}</code>) : <code>нет</code>}
      </div>
    </div>
  );
}

function Timeline({ lead, events }) {
  return (
    <section className="panel timeline">
      <div className="panel-title">
        <Clock3 size={18} />
        <span>Журнал лида</span>
      </div>
      {lead && events.length ? (
        events.map((event) => (
          <div className="timeline-row" key={event.id}>
            <span className="dot current" />
            <Mail size={15} />
            <div>
              <strong>{event.type}</strong>
              <small>{event.message}</small>
              <small>{new Date(event.createdAt).toLocaleString('ru-RU')}</small>
            </div>
          </div>
        ))
      ) : (
        <div className="empty-lane">Событий пока нет</div>
      )}
    </section>
  );
}

createRoot(document.getElementById('root')).render(<App />);


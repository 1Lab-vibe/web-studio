import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowRight,
  Bot,
  CalendarCheck,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  Film,
  Gauge,
  Globe2,
  LockKeyhole,
  LogOut,
  Mail,
  MapPinned,
  MessageSquareText,
  PauseCircle,
  PhoneCall,
  Radar,
  Search,
  Send,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Wand2,
} from 'lucide-react';
import './styles.css';

const agents = [
  {
    name: 'Orchestrator',
    role: 'владеет записью и всеми write-операциями',
    status: 'Контролирует',
    icon: Bot,
    tone: 'black',
  },
  {
    name: 'Scout',
    role: 'читает Яндекс Карты и ищет узкие ниши',
    status: '18 лидов',
    icon: Radar,
    tone: 'red',
  },
  {
    name: 'Diagnoser',
    role: 'диагноз, hero angle, тон и короткий pitch',
    status: '9 готово',
    icon: ClipboardCheck,
    tone: 'blue',
  },
  {
    name: 'Builder',
    role: 'создает top-5 мокапов в Lovable через MCP',
    status: '3 мокапа',
    icon: Wand2,
    tone: 'teal',
  },
  {
    name: 'Filmer',
    role: '5 скриншотов и видео 10 сек 1080x1920',
    status: '2 видео',
    icon: Film,
    tone: 'amber',
  },
  {
    name: 'Checker',
    role: 'evals: персонализация, AI-маркеры, buzzwords',
    status: '11 проверок',
    icon: ShieldCheck,
    tone: 'teal',
  },
  {
    name: 'Pitcher',
    role: 'email, SMS, IG DM или LinkedIn по нише',
    status: '7 отправок',
    icon: Send,
    tone: 'blue',
  },
  {
    name: 'Mobile',
    role: 'iPhone, ответы в реальном времени и Calendly MCP',
    status: '2 созвона',
    icon: Smartphone,
    tone: 'black',
  },
];

const leads = [
  {
    id: 1,
    name: 'Кровля Север',
    city: 'Москва',
    niche: 'кровельщики',
    rating: 4.8,
    reviews: 23,
    years: 8,
    site: 'нет сайта',
    owner: 'Diagnoser',
    priority: 94,
    lane: 'Диагноз',
    channel: 'Email',
    deal: 2800,
    replyRate: 16,
    diagnosis:
      'Компания выглядит надежной по отзывам, но теряет заявки без сайта: клиент не видит гарантий, фото объектов и быстрый расчет. Нужна посадочная под срочный ремонт кровли с доказательствами и формой заявки.',
    angle: 'Срочный ремонт кровли за 24 часа с фото работ и понятной гарантией.',
    tone: 'спокойный, инженерный, без рекламного шума',
    message:
      'Здравствуйте. У вас сильные отзывы в Яндекс Картах, но нет страницы, где видно объекты, гарантии и быстрый расчет. Я подготовил короткий вариант посадочной под заявки на ремонт кровли. Могу прислать превью?',
  },
  {
    id: 2,
    name: 'Студия Laki Nail',
    city: 'Казань',
    niche: 'салон красоты',
    rating: 4.7,
    reviews: 41,
    years: 6,
    site: 'Taplink 2018',
    owner: 'Builder',
    priority: 88,
    lane: 'Lovable',
    channel: 'IG DM',
    deal: 1900,
    replyRate: 21,
    diagnosis:
      'У салона есть доверие и живые отзывы, но старый Taplink не продает атмосферу, мастеров и свободные окна. Посадочная должна показать стиль, цены, портфолио и запись в один клик.',
    angle: 'Запись на маникюр через визуальную страницу с портфолио мастеров.',
    tone: 'легкий, визуальный, уверенный',
    message:
      'Добрый день. У вас хорошие отзывы, но текущая ссылка не показывает стиль салона и свободные окна. Я сделал идею страницы, где портфолио и запись видны сразу. Прислать короткое превью?',
  },
  {
    id: 3,
    name: 'Юг Климат Сервис',
    city: 'Краснодар',
    niche: 'кондиционеры',
    rating: 4.9,
    reviews: 17,
    years: 7,
    site: 'сайт 2015',
    owner: 'Filmer',
    priority: 91,
    lane: 'Видео',
    channel: 'SMS',
    deal: 3400,
    replyRate: 15,
    diagnosis:
      'Сильный рейтинг не поддержан современным сайтом: старая страница не объясняет скорость выезда, цены и сервисные гарантии. Новый лендинг должен быстро конвертировать сезонный спрос.',
    angle: 'Монтаж и обслуживание кондиционеров без ожидания в сезон.',
    tone: 'деловой, быстрый, практичный',
    message:
      'Здравствуйте. Видно, что у вас сильный рейтинг, но сайт выглядит старым и теряет сезонные заявки. Я собрал короткий макет страницы под монтаж кондиционеров. Могу отправить видео-превью?',
  },
  {
    id: 4,
    name: 'ДомПраво',
    city: 'Екатеринбург',
    niche: 'риелторы',
    rating: 4.6,
    reviews: 29,
    years: 9,
    site: 'нет сайта',
    owner: 'Pitcher',
    priority: 83,
    lane: 'Отправка',
    channel: 'LinkedIn',
    deal: 2600,
    replyRate: 13,
    diagnosis:
      'Экспертность видна только в карточке, а не в отдельной упаковке услуг. Для дорогих сделок нужен сайт с кейсами, географией объектов и понятным первым шагом.',
    angle: 'Личная страница риелтора, которая переводит доверие из карт в заявку.',
    tone: 'профессиональный, спокойный',
    message:
      'Здравствуйте. Ваша карточка в Яндекс Картах выглядит убедительно, но без сайта сложно показать кейсы и процесс сделки. Я подготовил вариант страницы для заявок на консультацию. Прислать?',
  },
  {
    id: 5,
    name: 'Стоматология Форма',
    city: 'Москва',
    niche: 'стоматология',
    rating: 4.5,
    reviews: 36,
    years: 11,
    site: 'сайт 2014',
    owner: 'Checker',
    priority: 79,
    lane: 'Проверка',
    channel: 'Email',
    deal: 4200,
    replyRate: 10,
    diagnosis:
      'Сайт выглядит старше доверия клиники и не раскрывает врачей, цены и первичный прием. Для медицинской ниши нужно убрать шум и дать пациенту ясный путь к записи.',
    angle: 'Чистая страница клиники с врачами, ценами и записью без звонка.',
    tone: 'бережный, точный, без давления',
    message:
      'Здравствуйте. У клиники хорошие отзывы, но сайт визуально устарел и может снижать доверие перед записью. Я подготовил аккуратный вариант страницы для первичного приема. Могу показать?',
  },
  {
    id: 6,
    name: 'Мастер Пол',
    city: 'Казань',
    niche: 'ремонт полов',
    rating: 4.8,
    reviews: 14,
    years: 5,
    site: 'нет сайта',
    owner: 'Scout',
    priority: 76,
    lane: 'Разведка',
    channel: 'SMS',
    deal: 1700,
    replyRate: 18,
    diagnosis:
      'Карточка выглядит живой, но без сайта сложно показать материалы, этапы и расчет стоимости. Для мастера нужен простой лендинг с фото до/после и быстрым запросом замера.',
    angle: 'Ремонт полов с расчетом замера и понятными этапами работ.',
    tone: 'прямой, мастеровой, конкретный',
    message:
      'Здравствуйте. Нашел вас в Яндекс Картах: отзывы хорошие, но нет страницы с работами и расчетом. Я сделал идею короткой страницы под заявки на замер. Прислать ссылку?',
  },
];

const lanes = ['Разведка', 'Диагноз', 'Lovable', 'Видео', 'Проверка', 'Отправка'];
const cities = ['Все города', 'Москва', 'Казань', 'Екатеринбург', 'Краснодар'];

function App() {
  const [auth, setAuth] = useState({ loading: true, authenticated: false, authEnabled: true, user: null });
  const [city, setCity] = useState('Все города');
  const [activeLeadId, setActiveLeadId] = useState(1);
  const [pausedNiches, setPausedNiches] = useState(['стоматология']);
  const [mockupsToday, setMockupsToday] = useState(3);
  const [backend, setBackend] = useState({ status: 'offline', integrations: {}, leads: [] });

  const loadAuth = async () => {
    try {
      const response = await fetch('/api/auth/session', { credentials: 'include' });
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
      const [healthResponse, leadsResponse] = await Promise.all([
        fetch('/api/health', { credentials: 'include' }),
        fetch('/api/leads', { credentials: 'include' }),
      ]);
      if (leadsResponse.status === 401) {
        setAuth((current) => ({ ...current, authenticated: false }));
        return;
      }
      const health = await healthResponse.json();
      const leadData = await leadsResponse.json();
      setBackend({
        status: health.ok ? 'online' : 'degraded',
        integrations: health.integrations ?? {},
        leads: Array.isArray(leadData.data) ? leadData.data : [],
      });
    } catch {
      setBackend((current) => ({ ...current, status: 'offline' }));
    }
  };

  useEffect(() => {
    loadAuth();
  }, []);

  useEffect(() => {
    if (!auth.loading && !auth.authEnabled) {
      setAuth((current) => ({ ...current, authenticated: true }));
      loadBackend();
    }
    if (!auth.loading && auth.authenticated) {
      loadBackend();
    }
  }, [auth.loading, auth.authEnabled, auth.authenticated]);

  const handleLogin = async (login, password) => {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ login, password }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      if (response.status === 429 && result.blockedUntil) {
        const until = new Date(result.blockedUntil).toLocaleString('ru-RU');
        throw new Error(`Слишком много попыток. Вход заблокирован до ${until}`);
      }
      throw new Error(result.error || 'Не получилось войти');
    }
    await loadAuth();
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setAuth({ loading: false, authenticated: false, authEnabled: true, user: null });
    setBackend({ status: 'offline', integrations: {}, leads: [] });
  };

  const runBackendAction = async (action) => {
    const response = await fetch(`/api/orchestrator/${action}`, { method: 'POST', credentials: 'include' });
    if (response.status === 401) {
      setAuth((current) => ({ ...current, authenticated: false }));
      return;
    }
    await loadBackend();
  };

  const visibleLeads = backend.leads.length ? backend.leads : leads;
  const filteredLeads = useMemo(
    () => visibleLeads.filter((lead) => city === 'Все города' || lead.city === city),
    [city, visibleLeads],
  );
  const activeLead = visibleLeads.find((lead) => lead.id === activeLeadId) || visibleLeads[0] || leads[0];
  const activeAgent = agents.find((agent) => agent.name === activeLead.owner);
  const needsApproval = (activeLead.deal ?? 0) > 300000;
  const nichePaused = pausedNiches.includes(activeLead.niche) || activeLead.replyRate < 12;

  const togglePause = (niche) => {
    setPausedNiches((current) =>
      current.includes(niche) ? current.filter((item) => item !== niche) : [...current, niche],
    );
  };

  if (auth.loading) {
    return <main className="auth-screen" />;
  }

  if (!auth.authenticated) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <main className="app-shell">
      <TopBar
        city={city}
        setCity={setCity}
        mockupsToday={mockupsToday}
        backend={backend}
        user={auth.user}
        onLogout={handleLogout}
      />
      <div className="workspace">
        <aside className="sidebar">
          <OrchestratorPanel />
          <AgentList activeAgent={activeAgent?.name} />
          <RuleStack />
        </aside>

        <section className="main-column">
          <SourcePanel />
          <BackendActions backend={backend} onRun={runBackendAction} />
          <Funnel
            leads={filteredLeads}
            activeLeadId={activeLeadId}
            onSelect={setActiveLeadId}
            pausedNiches={pausedNiches}
          />
          <ControlDeck
            mockupsToday={mockupsToday}
            setMockupsToday={setMockupsToday}
            pausedNiches={pausedNiches}
            onTogglePause={togglePause}
          />
        </section>

        <aside className="inspector">
          <LeadInspector lead={activeLead} needsApproval={needsApproval} nichePaused={nichePaused} />
          <Timeline lead={activeLead} />
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
          <input
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && <p className="auth-error">{error}</p>}
        <button type="submit" disabled={submitting}>
          <LockKeyhole size={16} />
          {submitting ? 'Проверка' : 'Войти'}
        </button>
      </form>
    </main>
  );
}

function TopBar({ city, setCity, mockupsToday, backend, user, onLogout }) {
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
          OpenAI GPT-5.4
        </div>
        <div className="metric-chip">
          <Gauge size={16} />
          top-5 Lovable: {mockupsToday}/5
        </div>
        <div className={`api-chip ${backend.status}`}>
          <Activity size={16} />
          API {backend.status}
        </div>
        <button className="logout-button" type="button" onClick={onLogout} title="Выйти">
          <LogOut size={16} />
          {user || 'Выйти'}
        </button>
      </nav>
    </header>
  );
}

function BackendActions({ backend, onRun }) {
  return (
    <section className="backend-strip">
      <div>
        <div className="panel-title inline">
          <Bot size={18} />
          <span>Backend orchestration</span>
        </div>
        <p>
          API {backend.status}. OpenAI: {backend.integrations.openai ? 'ключ есть' : 'нет ключа'} · Яндекс:{' '}
          {backend.integrations.yandexMaps ? 'ключ есть' : 'нет ключа'} · Telegram:{' '}
          {backend.integrations.telegram ? 'подключен' : 'не подключен'} · Google:{' '}
          {backend.integrations.googleMaps ? 'fallback есть' : 'fallback нет'}
        </p>
      </div>
      <div className="backend-actions">
        <button type="button" onClick={() => onRun('scout')}>
          <Search size={16} />
          Scout
        </button>
        <button type="button" onClick={() => onRun('tick')}>
          <Activity size={16} />
          Tick
        </button>
      </div>
    </section>
  );
}

function OrchestratorPanel() {
  return (
    <section className="panel orchestrator-card">
      <div className="panel-title">
        <Bot size={18} />
        <span>Оркестратор</span>
      </div>
      <p>
        Владеет всеми write-действиями, выдает эксклюзивный lock на лида и передает агентам только
        read-only задачи.
      </p>
      <div className="lockline">
        <LockKeyhole size={16} />
        1 лид = 1 активный агент
      </div>
    </section>
  );
}

function AgentList({ activeAgent }) {
  return (
    <section className="panel">
      <div className="panel-title">
        <Activity size={18} />
        <span>Агенты</span>
      </div>
      <div className="agent-list">
        {agents.slice(1).map((agent) => {
          const Icon = agent.icon;
          return (
            <div className={`agent-row ${activeAgent === agent.name ? 'active' : ''}`} key={agent.name}>
              <span className={`agent-icon ${agent.tone}`}>
                <Icon size={16} />
              </span>
              <div>
                <strong>{agent.name}</strong>
                <small>{agent.role}</small>
              </div>
              <em>{agent.status}</em>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RuleStack() {
  return (
    <section className="panel rules">
      <div className="panel-title">
        <ShieldCheck size={18} />
        <span>Границы автономии</span>
      </div>
      <div className="rule">
        <CheckCircle2 size={16} />
        Человек нужен только при сделке выше 300 000 ₽
      </div>
      <div className="rule warning">
        <PauseCircle size={16} />
        Ниша ставится на паузу при reply rate ниже 12%
      </div>
      <div className="rule">
        <Globe2 size={16} />
        Источник лидов: Яндекс Карты
      </div>
    </section>
  );
}

function SourcePanel() {
  return (
    <section className="source-strip">
      <div>
        <div className="panel-title inline">
          <MapPinned size={18} />
          <span>Разведка по Яндекс Картам</span>
        </div>
        <p>5+ лет на карте, меньше 50 отзывов, рейтинг 4.4+, нет сайта или сайт старше 2018.</p>
      </div>
      <div className="source-grid">
        <span>Москва · 42</span>
        <span>Казань · 18</span>
        <span>Екатеринбург · 15</span>
        <span>Краснодар · 21</span>
      </div>
    </section>
  );
}

function Funnel({ leads, activeLeadId, onSelect, pausedNiches }) {
  return (
    <section className="funnel" aria-label="Воронка лидов">
      {lanes.map((lane) => (
        <div className="lane" key={lane}>
          <div className="lane-header">
            <span>{lane}</span>
            <small>{leads.filter((lead) => lead.lane === lane).length}</small>
          </div>
          <div className="lead-stack">
            {leads
              .filter((lead) => lead.lane === lane)
              .map((lead) => (
                <button
                  className={`lead-card ${activeLeadId === lead.id ? 'selected' : ''}`}
                  key={lead.id}
                  onClick={() => onSelect(lead.id)}
                  type="button"
                >
                  <span className="lead-head">
                    <strong>{lead.name}</strong>
                    <em>{lead.priority}</em>
                  </span>
                  <span className="lead-meta">
                    {lead.city} · {lead.niche}
                  </span>
                  <span className="lead-facts">
                    <small>{lead.rating}★</small>
                    <small>{lead.reviews} отзывов</small>
                    <small>{lead.years} лет</small>
                  </span>
                  <span className="lead-foot">
                    <span>{lead.site}</span>
                    <span className={pausedNiches.includes(lead.niche) || lead.replyRate < 12 ? 'pause' : 'ok'}>
                      {lead.owner}
                    </span>
                  </span>
                </button>
              ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function ControlDeck({ mockupsToday, setMockupsToday, pausedNiches, onTogglePause }) {
  const usedPct = Math.min(100, (mockupsToday / 5) * 100);
  return (
    <section className="control-deck">
      <div className="quota-card">
        <div className="panel-title inline">
          <Wand2 size={18} />
          <span>Lovable MCP quota</span>
        </div>
        <div className="progress">
          <span style={{ width: `${usedPct}%` }} />
        </div>
        <div className="stepper">
          <button type="button" onClick={() => setMockupsToday(Math.max(0, mockupsToday - 1))}>
            -
          </button>
          <strong>{mockupsToday}/5 мокапов сегодня</strong>
          <button type="button" onClick={() => setMockupsToday(Math.min(5, mockupsToday + 1))}>
            +
          </button>
        </div>
      </div>
      <div className="pause-card">
        <div className="panel-title inline">
          <PauseCircle size={18} />
          <span>Пауза ниш</span>
        </div>
        <div className="toggle-list">
          {['стоматология', 'кровельщики', 'салон красоты'].map((niche) => (
            <label key={niche}>
              <input
                type="checkbox"
                checked={pausedNiches.includes(niche)}
                onChange={() => onTogglePause(niche)}
              />
              <span>{niche}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="handoff-card">
        <div className="panel-title inline">
          <CalendarCheck size={18} />
          <span>Mobile handoff</span>
        </div>
        <p>Положительные ответы уходят на iPhone-агента, который бронирует Zoom в Calendly через MCP.</p>
      </div>
    </section>
  );
}

function LeadInspector({ lead, needsApproval, nichePaused }) {
  const deal = lead.deal ?? 0;
  const replyRate = lead.replyRate ?? 0;
  return (
    <section className="panel lead-inspector">
      <div className="inspector-head">
        <div>
          <strong>{lead.name}</strong>
          <span>
            {lead.city} · {lead.niche}
          </span>
        </div>
        <span className="score">{lead.priority}</span>
      </div>

      <div className="fact-grid">
        <Fact label="Рейтинг" value={`${lead.rating}★`} />
        <Fact label="Отзывы" value={lead.reviews} />
        <Fact label="На карте" value={`${lead.years} лет`} />
        <Fact label="Сайт" value={lead.site} />
      </div>

      <div className="approval-stack">
        <div className={needsApproval ? 'gate alert' : 'gate'}>
          <LockKeyhole size={16} />
          Сделка {deal.toLocaleString('ru-RU')} ₽ {needsApproval ? 'требует approval' : 'в лимите'}
        </div>
        <div className={nichePaused ? 'gate alert' : 'gate'}>
          <Gauge size={16} />
          Reply rate {replyRate}% {nichePaused ? 'пауза' : 'норма'}
        </div>
      </div>

      <TextBlock title="Диагноз 50 слов" text={lead.diagnosis} />
      <TextBlock title="Hero angle" text={lead.angle} />
      <TextBlock title="Тон" text={lead.tone} />
      <TextBlock title={`Сообщение · ${lead.channel}`} text={lead.message} />

      <div className="action-grid">
        <button type="button">
          <MessageSquareText size={16} />
          Checker eval
        </button>
        <button type="button">
          <ArrowRight size={16} />
          Передать дальше
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

function Timeline({ lead }) {
  const steps = [
    ['Scout', 'Яндекс Карты: карточка подходит под фильтр', MapPinned],
    ['Diagnoser', 'Сформирован диагноз и угол первого экрана', ClipboardCheck],
    ['Builder', 'Lovable MCP мокап готовится только для top-5', Wand2],
    ['Filmer', '5 скриншотов и вертикальное видео 10 секунд', Film],
    ['Pitcher', `Канал выбран: ${lead.channel}`, Mail],
    ['Mobile', 'Положительный ответ передается на iPhone', PhoneCall],
  ];
  return (
    <section className="panel timeline">
      <div className="panel-title">
        <Clock3 size={18} />
        <span>Журнал лида</span>
      </div>
      {steps.map(([agent, text, Icon], index) => (
        <div className="timeline-row" key={agent}>
          <span className={lead.owner === agent ? 'dot current' : 'dot'} />
          <Icon size={15} />
          <div>
            <strong>{agent}</strong>
            <small>{text}</small>
          </div>
          {index < steps.length - 1 && <ChevronRight size={14} />}
        </div>
      ))}
    </section>
  );
}

createRoot(document.getElementById('root')).render(<App />);

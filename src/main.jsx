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
  RefreshCcw,
  Search,
  Send,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import './styles.css';

const lanes = ['Разведка', 'Диагноз', 'Lovable', 'Видео', 'Проверка', 'Отправка', 'Ответы'];
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

function App() {
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
  });
  const [city, setCity] = useState('Все города');
  const [activeLeadId, setActiveLeadId] = useState(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

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
      const [healthResponse, stateResponse, leadsResponse, eventsResponse, approvalsResponse, actionsResponse, queueResponse] = await Promise.all([
        fetch('/api/health', { credentials: 'include' }),
        fetch('/api/state', { credentials: 'include' }),
        fetch('/api/leads', { credentials: 'include' }),
        fetch('/api/events', { credentials: 'include' }),
        fetch('/api/approvals', { credentials: 'include' }),
        fetch('/api/orchestrator/top-actions?limit=8', { credentials: 'include' }),
        fetch('/api/outreach-queue', { credentials: 'include' }),
      ]);
      if ([stateResponse, leadsResponse, eventsResponse, approvalsResponse, actionsResponse, queueResponse].some((response) => response.status === 401)) {
        setAuth((current) => ({ ...current, authenticated: false }));
        return;
      }
      const [health, state, leadData, eventData, approvalData, actionData, queueData] = await Promise.all([
        healthResponse.json(),
        stateResponse.json(),
        leadsResponse.json(),
        eventsResponse.json(),
        approvalsResponse.json(),
        actionsResponse.json(),
        queueResponse.json(),
      ]);
      const leads = Array.isArray(leadData.data) ? leadData.data : [];
      setBackend({
        status: health.ok ? 'online' : 'degraded',
        integrations: health.integrations ?? {},
        leads,
        metrics: state.data?.metrics ?? {},
        events: Array.isArray(eventData.data) ? eventData.data : [],
        approvals: Array.isArray(approvalData.data) ? approvalData.data : [],
        topActions: Array.isArray(actionData.data) ? actionData.data : [],
        outreachQueue: Array.isArray(queueData.data) ? queueData.data : [],
      });
      setActiveLeadId((current) => current || leads[0]?.id || null);
    } catch {
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
        throw new Error(`Слишком много попыток. Вход заблокирован до ${new Date(result.blockedUntil).toLocaleString('ru-RU')}`);
      }
      throw new Error(result.error || 'Не получилось войти');
    }
    await loadAuth();
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
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
    runAction(action, () => fetch(`/api/orchestrator/${action}`, { method: 'POST', credentials: 'include' }), `${action} выполнен`);

  const advanceCurrentLane = (lane) =>
    runAction(
      'advance-lane',
      () =>
        fetch('/api/orchestrator/advance-lane', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ lane, limit: 50 }),
        }),
      `Стадия ${lane} передана дальше`,
    );

  const advanceLead = (leadId) =>
    runAction('advance', () => fetch(`/api/leads/${leadId}/advance`, { method: 'POST', credentials: 'include' }), 'Лид передан дальше');

  const decideApproval = (approvalId, decision) =>
    runAction(
      decision,
      () => fetch(`/api/approvals/${approvalId}/${decision}`, { method: 'POST', credentials: 'include' }),
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
          <TopNextActions actions={backend.topActions} onSelect={setActiveLeadId} />
          <FunnelBoard leads={scoredVisibleLeads} activeLeadId={activeLead?.id} onSelect={setActiveLeadId} />
          <ControlDeck metrics={backend.metrics} approvals={backend.approvals} outreachQueue={backend.outreachQueue} />
        </section>

        <aside className="inspector">
          <LeadInspector
            lead={activeLead}
            approval={activeApproval}
            busy={busy}
            onAdvance={advanceLead}
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
      </form>
    </main>
  );
}

function TopBar({ city, cities, setCity, backend, user, onLogout }) {
  const mockupsToday = Number(backend.metrics.mockupsToday ?? 0);
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
          Lovable {mockupsToday}/5
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
  const [limit, setLimit] = useState(10);
  const sortedLeads = useMemo(
    () => [...leads].sort((a, b) => (b.fitScore ?? b.priority ?? 0) - (a.fitScore ?? a.priority ?? 0)),
    [leads],
  );
  const visibleLeads = useMemo(() => {
    const top = sortedLeads.slice(0, limit);
    const active = sortedLeads.find((lead) => lead.id === activeLeadId);
    if (active && !top.some((lead) => lead.id === active.id)) return [...top, active];
    return top;
  }, [activeLeadId, limit, sortedLeads]);
  const hiddenCount = Math.max(0, sortedLeads.length - new Set(visibleLeads.map((lead) => lead.id)).size);
  return (
    <>
      <section className="funnel" aria-label="Воронка лидов">
        {lanes.map((lane) => {
          const laneLeads = visibleLeads.filter((lead) => lead.lane === lane);
          const laneTotal = sortedLeads.filter((lead) => lead.lane === lane).length;
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
                  <div className="empty-lane">Нет лидов в top {Math.min(limit, sortedLeads.length)}</div>
                )}
              </div>
            </div>
          );
        })}
      </section>
      {hiddenCount > 0 && (
        <div className="funnel-controls">
          <span>Скрыто {hiddenCount} из {sortedLeads.length}, сортировка по FitScore. Активный лид показывается всегда.</span>
          <button type="button" onClick={() => setLimit((current) => Math.min(sortedLeads.length, current + 10))}>Показать еще 10</button>
          <button type="button" onClick={() => setLimit(sortedLeads.length)}>Показать все</button>
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

function ControlDeck({ metrics, approvals, outreachQueue = [] }) {
  const mockupsToday = Number(metrics.mockupsToday ?? 0);
  const usedPct = Math.min(100, (mockupsToday / 5) * 100);
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
        <strong>{mockupsToday}/5 мокапов сегодня</strong>
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

function LeadInspector({ lead, approval, busy, onAdvance, onDecision }) {
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
      {lead.mockup?.url && (
        <a className="lovable-link primary" href={lead.mockup.url} target="_blank" rel="noreferrer">
          <Globe2 size={16} />
          Открыть Lovable preview
        </a>
      )}
      {lead.mockup?.publishedUrl && (
        <a className="lovable-link primary" href={lead.mockup.publishedUrl} target="_blank" rel="noreferrer">
          <Globe2 size={16} />
          Открыть публичный сайт
        </a>
      )}
      {lead.mockup?.githubUrl && (
        <a className="lovable-link primary" href={lead.mockup.githubUrl} target="_blank" rel="noreferrer">
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
      <TextBlock title="Email кандидаты" text={emails.length ? emails.join('\n') : 'не найдены'} />
      {lead.mockup?.handoffPrompt && <TextBlock title="Lovable handoff prompt" text={lead.mockup.handoffPrompt} />}
      {lead.mockup?.buildOpenedAt && <TextBlock title="Lovable open log" text={`Last opened: ${lead.mockup.buildOpenedAt}`} />}
      <TextBlock title="Скоринг" text={scoringSummary(lead)} />
      <div className="action-grid">
        <button type="button" disabled={Boolean(busy)}>
          <MessageSquareText size={16} /> Checker eval
        </button>
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

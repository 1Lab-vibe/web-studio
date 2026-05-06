import crypto from 'node:crypto';
import { config } from './config.js';
import { sendTelegram } from './services/telegram.js';

const COOKIE_NAME = 'web_studio_session';
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 7 * DAY_MS;
const HOUR_MS = 60 * 60 * 1000;
const SECURITY_COOLDOWN_MS = 7 * DAY_MS;
const MAX_FAILURES_PER_STEP = 3;
const BLOCK_DURATIONS_MS = [HOUR_MS, 8 * HOUR_MS, DAY_MS];

function authEnabled() {
  return Boolean(config.WEB_AUTH_LOGIN && config.WEB_AUTH_PASSWORD);
}

function sessionSecret() {
  return config.WEB_AUTH_SESSION_SECRET || config.WEB_STUDIO_MCP_TOKEN || 'web-studio-dev-session-secret';
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function requestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return forwarded[0] || req.ip || req.socket?.remoteAddress || 'unknown';
}

function passwordMask(password) {
  const value = String(password ?? '');
  if (!value) return '[empty]';
  if (value.length <= 2) return '*'.repeat(value.length);
  return `${value[0]}${'*'.repeat(Math.min(value.length - 2, 10))}${value.at(-1)} (${value.length} chars)`;
}

function clientKey(req) {
  return requestIp(req);
}

function normalizedClient(client, now) {
  const current = {
    failureCount: 0,
    penaltyLevel: 0,
    blockedUntil: 0,
    lastFailureAt: 0,
    ...client,
  };
  if (current.lastFailureAt && now - current.lastFailureAt >= SECURITY_COOLDOWN_MS) {
    return { ...current, failureCount: 0, penaltyLevel: 0, blockedUntil: 0 };
  }
  return current;
}

function blockDurationForLevel(level) {
  return BLOCK_DURATIONS_MS[Math.min(Math.max(level, 0), BLOCK_DURATIONS_MS.length - 1)];
}

function attemptMeta(req, login, password, status, extra = {}) {
  return {
    status,
    ip: requestIp(req),
    login,
    passwordMask: passwordMask(password),
    userAgent: req.get('user-agent') || 'unknown',
    path: req.originalUrl,
    ...extra,
  };
}

async function notifyFailedLogin(meta) {
  const until = meta.blockedUntil ? `\nБлокировка до: <code>${escapeHtml(new Date(meta.blockedUntil).toISOString())}</code>` : '';
  await sendTelegram(
    [
      'Неудачная попытка входа в Web Studio',
      `IP: <code>${escapeHtml(meta.ip)}</code>`,
      `Логин: <code>${escapeHtml(meta.login || '[empty]')}</code>`,
      `Пароль: <code>${escapeHtml(meta.passwordMask)}</code>`,
      `Статус: <code>${escapeHtml(meta.status)}</code>${until}`,
      `UA: <code>${escapeHtml(meta.userAgent).slice(0, 180)}</code>`,
    ].join('\n'),
  ).catch((error) => console.error('Telegram auth alert failed', error));
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function createSession() {
  const payload = JSON.stringify({
    sub: config.WEB_AUTH_LOGIN,
    exp: Date.now() + SESSION_TTL_MS,
  });
  const encoded = Buffer.from(payload).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

function verifySession(req) {
  if (!authEnabled()) return true;
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token || !token.includes('.')) return false;
  const [encoded, signature] = token.split('.');
  if (!safeEqual(signature, sign(encoded))) return false;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload.sub === config.WEB_AUTH_LOGIN && Number(payload.exp) > Date.now();
  } catch {
    return false;
  }
}

function setSessionCookie(res) {
  const secure = config.NODE_ENV === 'production';
  res.cookie(COOKIE_NAME, createSession(), {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    path: '/',
  });
}

function publicApiPath(req) {
  const pathname = new URL(req.originalUrl, 'http://localhost').pathname;
  if (pathname === '/api/health') return true;
  if (pathname.startsWith('/api/auth/')) return true;
  if (pathname === '/api/telegram/webhook') return true;
  if (pathname === '/api/a1/webhook') return true;
  return false;
}

export function registerAuth(app, store) {
  app.get('/api/auth/session', (req, res) => {
    res.json({
      ok: true,
      authEnabled: authEnabled(),
      authenticated: verifySession(req),
      user: verifySession(req) ? config.WEB_AUTH_LOGIN || 'local' : null,
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    if (!authEnabled()) {
      return res.json({ ok: true, authEnabled: false, authenticated: true });
    }

    const login = String(req.body?.login ?? '');
    const password = String(req.body?.password ?? '');
    const now = Date.now();
    const key = clientKey(req);
    const current = normalizedClient(store.getAuthClient(key), now);

    if (current.blockedUntil > now) {
      const meta = attemptMeta(req, login, password, 'blocked', {
        failureCount: current.failureCount,
        penaltyLevel: current.penaltyLevel,
        blockedUntil: current.blockedUntil,
      });
      await store.addAuthAttempt(meta);
      await notifyFailedLogin(meta);
      return res.status(429).json({
        ok: false,
        error: 'Too many login attempts',
        blockedUntil: new Date(current.blockedUntil).toISOString(),
      });
    }

    if (!safeEqual(login, config.WEB_AUTH_LOGIN) || !safeEqual(password, config.WEB_AUTH_PASSWORD)) {
      const failureCount = current.failureCount + 1;
      const shouldBlock = failureCount >= MAX_FAILURES_PER_STEP;
      const penaltyLevel = shouldBlock ? current.penaltyLevel + 1 : current.penaltyLevel;
      const blockedUntil = shouldBlock ? now + blockDurationForLevel(penaltyLevel - 1) : 0;
      const nextClient = {
        failureCount: shouldBlock ? 0 : failureCount,
        penaltyLevel,
        blockedUntil,
        lastFailureAt: now,
        lastIp: requestIp(req),
      };
      await store.setAuthClient(key, nextClient);

      const meta = attemptMeta(req, login, password, shouldBlock ? 'failed_blocked' : 'failed', {
        failureCount,
        penaltyLevel,
        blockedUntil,
      });
      await store.addAuthAttempt(meta);
      await notifyFailedLogin(meta);
      if (shouldBlock) {
        return res.status(429).json({
          ok: false,
          error: 'Too many login attempts',
          blockedUntil: new Date(blockedUntil).toISOString(),
        });
      }
      return res.status(401).json({ ok: false, error: 'Invalid login or password' });
    }

    await store.setAuthClient(key, { ...current, failureCount: 0, blockedUntil: 0, lastSuccessAt: now });
    await store.addAuthAttempt(attemptMeta(req, login, password, 'success'));
    setSessionCookie(res);
    return res.json({ ok: true, authEnabled: true, authenticated: true, user: config.WEB_AUTH_LOGIN });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.use('/api', (req, res, next) => {
    if (publicApiPath(req) || verifySession(req)) return next();
    return res.status(401).json({ ok: false, error: 'Authentication required' });
  });
}

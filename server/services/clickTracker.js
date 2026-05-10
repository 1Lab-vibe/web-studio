import { createHmac, timingSafeEqual } from 'node:crypto';
import { config, hasSecret } from '../config.js';

const TOKEN_VERSION = 'v1';

function trackingSecret() {
  return config.CLICK_TRACKING_SECRET || config.WEB_AUTH_SESSION_SECRET || config.WEB_STUDIO_MCP_TOKEN || 'webstudio-default-tracking-secret';
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value || '').length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function signPayload(payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const body = base64UrlEncode(json);
  const sig = createHmac('sha256', trackingSecret()).update(body).digest();
  return `${TOKEN_VERSION}.${body}.${base64UrlEncode(sig).slice(0, 22)}`;
}

export function buildTrackingToken({ leadId, kind, target, variantId = '', stage = 0 }) {
  if (!leadId || !target) return '';
  return signPayload({
    v: TOKEN_VERSION,
    l: leadId,
    k: kind || 'link',
    t: target,
    s: variantId || '',
    f: Number(stage) || 0,
    i: Date.now(),
  });
}

export function parseTrackingToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const [, body, signature] = parts;
  const expected = createHmac('sha256', trackingSecret()).update(body).digest();
  const expectedShort = base64UrlEncode(expected).slice(0, 22);
  if (signature.length !== expectedShort.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedShort))) return null;
  try {
    const json = JSON.parse(base64UrlDecode(body).toString('utf8'));
    return {
      leadId: json.l,
      kind: json.k,
      target: json.t,
      variantId: json.s,
      stage: json.f,
      issuedAt: json.i,
    };
  } catch {
    return null;
  }
}

export function appendUtm(target, { variantId = '', kind = 'link', stage = 0 } = {}) {
  if (!target) return target;
  try {
    const url = new URL(target);
    if (!url.searchParams.has('utm_source')) url.searchParams.set('utm_source', '1lab_email');
    if (!url.searchParams.has('utm_medium')) url.searchParams.set('utm_medium', stage > 0 ? `cold_followup_${stage}` : 'cold_outbound');
    if (!url.searchParams.has('utm_campaign')) url.searchParams.set('utm_campaign', 'webstudio_scout');
    if (kind && !url.searchParams.has('utm_content')) url.searchParams.set('utm_content', kind);
    if (variantId && !url.searchParams.has('utm_term')) url.searchParams.set('utm_term', variantId);
    return url.toString();
  } catch {
    return target;
  }
}

export function trackingUrl({ leadId, kind, target, variantId = '', stage = 0 }) {
  if (!target) return '';
  if (!hasSecret(config.PUBLIC_BASE_URL)) return appendUtm(target, { variantId, kind, stage });
  if (!config.CLICK_TRACKING_ENABLED) return appendUtm(target, { variantId, kind, stage });
  const finalTarget = appendUtm(target, { variantId, kind, stage });
  const token = buildTrackingToken({ leadId, kind, target: finalTarget, variantId, stage });
  if (!token) return finalTarget;
  const base = String(config.PUBLIC_BASE_URL).replace(/\/$/, '');
  return `${base}/p/${token}`;
}

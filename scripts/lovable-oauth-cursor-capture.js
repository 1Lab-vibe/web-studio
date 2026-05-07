import 'dotenv/config';
import { chromium } from 'playwright';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const clientId = '6d465f583e1e4ce5801b1616f735670c';
const redirectUri = 'cursor://anysphere.cursor-mcp/oauth/callback';
const tokenEndpoint = 'https://lovable.dev/oauth/token';
const authEndpoint = 'https://lovable.dev/oauth/authorize';
const mcpUrl = 'https://mcp.lovable.dev/';
const dataDir = path.resolve(process.env.DATA_DIR || './data');
const tokenPath = path.join(dataDir, 'lovable-oauth.json');
const pendingPath = path.join(dataDir, 'lovable-oauth-pending.json');
const userDataDir = path.join(dataDir, 'lovable-oauth-chrome-profile');
const scopes = [
  'offline',
  'projects:read',
  'projects:write',
  'projects:create',
  'workspaces:read',
  'workspaces:write',
].join(' ');

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function codeChallenge(verifier) {
  return base64url(createHash('sha256').update(verifier).digest());
}

function authUrl({ verifier, state }) {
  const url = new URL(authEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('code_challenge', codeChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('resource', mcpUrl);
  return url.toString();
}

function extractCode(location, expectedState) {
  if (!location?.startsWith(redirectUri)) return null;
  const url = new URL(location);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || state !== expectedState) return null;
  return code;
}

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    resource: mcpUrl,
  });
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Token exchange failed: ${response.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function testMcp(accessToken) {
  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'web-studio-cursor-oauth', version: '1' },
    },
  };
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${accessToken}`,
  };
  const init = await fetch('https://mcp.lovable.dev', { method: 'POST', headers, body: JSON.stringify(initBody) });
  const sessionId = init.headers.get('mcp-session-id') || '';
  await init.text();
  const list = await fetch('https://mcp.lovable.dev', {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const text = await list.text();
  const payload = text.split('\n').find((line) => line.startsWith('data: '))?.slice(6) || text;
  const json = JSON.parse(payload);
  return (json.result?.tools || []).map((tool) => tool.name).sort();
}

async function main() {
  await mkdir(dataDir, { recursive: true });
  const verifier = base64url(randomBytes(48));
  const state = base64url(randomBytes(24));
  const url = authUrl({ verifier, state });
  let resolveCode;
  const codePromise = new Promise((resolve) => {
    resolveCode = resolve;
  });

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    args: ['--disable-features=BlockInsecurePrivateNetworkRequests'],
  });
  const page = await context.newPage();

  page.on('response', async (response) => {
    const location = response.headers().location || '';
    const code = extractCode(location, state);
    if (code) resolveCode(code);
  });
  page.on('requestfailed', (request) => {
    const code = extractCode(request.url(), state);
    if (code) resolveCode(code);
  });
  page.on('framenavigated', (frame) => {
    const code = extractCode(frame.url(), state);
    if (code) resolveCode(code);
  });

  console.log('Opening Lovable OAuth in Chrome. Log in and click Allow.');
  console.log('If Chrome asks to open Cursor, cancel it; the script should already have captured the code.');
  console.log(url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const code = await Promise.race([
    codePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for cursor:// callback')), 5 * 60_000)),
  ]);
  const token = await exchangeCode(code, verifier);
  const saved = {
    client: {
      client_id: clientId,
      token_endpoint_auth_method: 'none',
      redirect_uri: redirectUri,
    },
    ...token,
    savedAt: new Date().toISOString(),
    mcpUrl: 'https://mcp.lovable.dev',
    source: 'cursor-oauth-capture',
  };
  await writeFile(tokenPath, JSON.stringify(saved, null, 2), 'utf8');
  const tools = await testMcp(token.access_token);
  console.log(JSON.stringify({ ok: true, savedTo: tokenPath, toolCount: tools.length, hasDeploy: tools.includes('deploy_project') }, null, 2));
  await context.close();
}

async function manualStart() {
  await mkdir(dataDir, { recursive: true });
  const verifier = base64url(randomBytes(48));
  const state = base64url(randomBytes(24));
  const url = authUrl({ verifier, state });
  await writeFile(pendingPath, JSON.stringify({ verifier, state, createdAt: new Date().toISOString() }, null, 2), 'utf8');
  console.log(url);
  console.error(`Saved verifier/state to ${pendingPath}`);
}

async function manualFinish(callbackUrl) {
  if (!callbackUrl) throw new Error('Pass callback URL: node scripts/lovable-oauth-cursor-capture.js manual-finish "cursor://..."');
  const pending = JSON.parse(await readFile(pendingPath, 'utf8'));
  const code = extractCode(callbackUrl, pending.state);
  if (!code) throw new Error('Callback URL has no code or state does not match');
  const token = await exchangeCode(code, pending.verifier);
  const saved = {
    client: {
      client_id: clientId,
      token_endpoint_auth_method: 'none',
      redirect_uri: redirectUri,
    },
    ...token,
    savedAt: new Date().toISOString(),
    mcpUrl: 'https://mcp.lovable.dev',
    source: 'cursor-oauth-manual',
  };
  await writeFile(tokenPath, JSON.stringify(saved, null, 2), 'utf8');
  const tools = await testMcp(token.access_token);
  console.log(JSON.stringify({ ok: true, savedTo: tokenPath, toolCount: tools.length, hasDeploy: tools.includes('deploy_project') }, null, 2));
}

const mode = process.argv[2] || 'capture';
const arg = process.argv[3] || '';

(mode === 'manual-start' ? manualStart() : mode === 'manual-finish' ? manualFinish(arg) : main()).catch((error) => {
  console.error(error.message);
  process.exit(1);
});

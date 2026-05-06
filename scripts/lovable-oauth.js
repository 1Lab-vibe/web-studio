import 'dotenv/config';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const mode = process.argv[2] || 'auth';
const dataDir = path.resolve(process.env.DATA_DIR || './data');
const tokenPath = path.join(dataDir, 'lovable-oauth.json');
const metadataUrl = 'https://lovable.dev/oauth/.well-known/oauth-authorization-server';
const mcpUrl = 'https://mcp.lovable.dev';
const redirectPort = Number(process.env.LOVABLE_OAUTH_PORT || 8789);
const redirectUri = process.env.LOVABLE_OAUTH_REDIRECT_URI || `http://127.0.0.1:${redirectPort}/oauth/callback`;
const clientMetadataUrl =
  process.env.LOVABLE_OAUTH_CLIENT_ID ||
  'https://webstudio.1true.ru/oauth/lovable-client-metadata.json';
const scopes = [
  'offline',
  'projects:create',
  'projects:read',
  'projects:write',
  'workspaces:read',
  'workspaces:write',
].join(' ');

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function codeChallenge(verifier) {
  return base64url(createHash('sha256').update(verifier).digest());
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function metadata() {
  const response = await fetch(metadataUrl);
  if (!response.ok) throw new Error(`OAuth metadata failed: ${response.status}`);
  return response.json();
}

async function registerClient(meta) {
  if (clientMetadataUrl) {
    return {
      client_id: clientMetadataUrl,
      token_endpoint_auth_method: 'none',
    };
  }
  const response = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Web Studio Lovable OAuth',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: scopes,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Client registration failed: ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function waitForCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', redirectUri);
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404).end('Not found');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (error) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`Lovable OAuth error: ${error}`);
        server.close();
        reject(new Error(`Lovable OAuth error: ${error}`));
        return;
      }
      if (!code || state !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Invalid OAuth callback');
        server.close();
        reject(new Error('Invalid OAuth callback'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<h1>Lovable OAuth connected</h1><p>You can close this tab.</p>');
      server.close();
      resolve(code);
    });
    server.on('error', reject);
    server.listen(redirectPort, '127.0.0.1', () => {
      console.log(`Waiting for Lovable OAuth callback on ${redirectUri}`);
    });
  });
}

async function exchangeCode(meta, client, code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: mcpUrl,
  });
  if (client.client_secret && client.token_endpoint_auth_method !== 'none') {
    body.set('client_secret', client.client_secret);
  }
  const response = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Token exchange failed: ${response.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function refreshToken(meta, saved) {
  if (!saved.refresh_token) return saved;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: saved.refresh_token,
    client_id: saved.client.client_id,
    resource: mcpUrl,
  });
  if (saved.client.client_secret && saved.client.token_endpoint_auth_method !== 'none') {
    body.set('client_secret', saved.client.client_secret);
  }
  const response = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) return saved;
  const token = await response.json();
  return {
    ...saved,
    ...token,
    refresh_token: token.refresh_token || saved.refresh_token,
    updatedAt: new Date().toISOString(),
  };
}

async function saveToken(client, token) {
  await mkdir(dataDir, { recursive: true });
  const payload = {
    client,
    ...token,
    savedAt: new Date().toISOString(),
    mcpUrl,
    scopes,
  };
  await writeFile(tokenPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

async function loadSavedToken() {
  const saved = JSON.parse(await readFile(tokenPath, 'utf8'));
  const meta = await metadata();
  const refreshed = await refreshToken(meta, saved);
  if (refreshed !== saved) await writeFile(tokenPath, JSON.stringify(refreshed, null, 2), 'utf8');
  return refreshed;
}

async function mcpRequest(method, params, accessToken, sessionId = '') {
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params }),
  });
  const text = await response.text();
  const payload = text.split('\n').find((line) => line.startsWith('data: '))?.slice(6) || text;
  return { response, json: JSON.parse(payload) };
}

async function testMcp(saved) {
  const init = await mcpRequest(
    'initialize',
    { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'web-studio-oauth-test', version: '1' } },
    saved.access_token,
  );
  const sessionId = init.response.headers.get('mcp-session-id') || '';
  if (init.response.status >= 400) {
    console.log(JSON.stringify({ ok: false, status: init.response.status, result: init.json }, null, 2));
    return;
  }
  const tools = await mcpRequest('tools/list', {}, saved.access_token, sessionId);
  const names = tools.json.result?.tools?.map((tool) => tool.name).sort() || [];
  console.log(JSON.stringify({ ok: true, tools: names }, null, 2));
}

async function authFlow() {
  const meta = await metadata();
  const client = await registerClient(meta);
  const verifier = base64url(randomBytes(48));
  const state = base64url(randomBytes(24));
  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', scopes);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge(verifier));
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('resource', mcpUrl);

  console.log('Opening Lovable OAuth in browser...');
  console.log(`If it does not open, visit:\n${authUrl.toString()}`);
  const codePromise = waitForCode(state);
  openBrowser(authUrl.toString());
  const code = await codePromise;
  const token = await exchangeCode(meta, client, code, verifier);
  const saved = await saveToken(client, token);
  console.log(`Saved Lovable OAuth token to ${tokenPath}`);
  await testMcp(saved);
}

if (mode === 'auth') {
  await authFlow();
} else if (mode === 'test') {
  await testMcp(await loadSavedToken());
} else {
  console.log('Usage:');
  console.log('  node scripts/lovable-oauth.js auth');
  console.log('  node scripts/lovable-oauth.js test');
}

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, hasSecret } from '../config.js';

const execFileAsync = promisify(execFile);

function isPublishableSourceFile(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const base = normalized.split('/').pop()?.toLowerCase() || '';
  if (base === '.env' || base.startsWith('.env.')) return false;
  if (/(^|\/)(node_modules|dist|build|\.git)\//.test(normalized)) return false;
  return true;
}

function textFiles(files) {
  return files.filter((file) => !file.binary && typeof file.content === 'string' && isPublishableSourceFile(file.path));
}

function githubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${config.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'web-studio-orchestrator',
  };
}

function encodeContent(content) {
  return Buffer.from(String(content ?? ''), 'utf8').toString('base64');
}

async function githubJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...githubHeaders(),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  return { response, data };
}

async function getRepo(owner, repo) {
  const { response, data } = await githubJson(`https://api.github.com/repos/${owner}/${repo}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub get repo failed: ${response.status} ${data.message || ''}`);
  return data;
}

async function createRepo(owner, repo, description) {
  const body = JSON.stringify({
    name: repo,
    description,
    private: Boolean(config.GITHUB_PRIVATE),
    auto_init: true,
  });
  let result = await githubJson(`https://api.github.com/orgs/${owner}/repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (result.response.status === 404 || result.response.status === 403) {
    result = await githubJson('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  }
  if (!result.response.ok && result.response.status !== 422) {
    throw new Error(`GitHub create repo failed: ${result.response.status} ${result.data.message || ''}`);
  }
  return result.data;
}

async function getFileSha(owner, repo, filePath) {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  const { response, data } = await githubJson(`https://api.github.com/repos/${owner}/${repo}/contents/${encoded}`);
  if (response.status === 404) return '';
  if (!response.ok) throw new Error(`GitHub get file failed: ${response.status} ${data.message || ''}`);
  return data.sha || '';
}

async function putFile(owner, repo, filePath, content, message) {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  const sha = await getFileSha(owner, repo, filePath);
  const body = {
    message,
    content: encodeContent(content),
  };
  if (sha) body.sha = sha;
  const { response, data } = await githubJson(`https://api.github.com/repos/${owner}/${repo}/contents/${encoded}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub put file failed for ${filePath}: ${response.status} ${data.message || ''}`);
  return data;
}

async function publishWithApi({ repoName, description, files, metadata }) {
  const owner = config.GITHUB_OWNER;
  const repo = repoName;
  const existing = await getRepo(owner, repo);
  const created = existing || (await createRepo(owner, repo, description));
  const targetOwner = created.owner?.login || owner;
  const commitMessage = `Publish Web Studio project ${metadata.leadId || ''}`.trim();
  const publishable = textFiles(files);
  for (const file of publishable) {
    await putFile(targetOwner, repo, file.path, file.content, commitMessage);
  }
  await putFile(
    targetOwner,
    repo,
    'webstudio-project.json',
    JSON.stringify({ ...metadata, publishedToGitHubAt: new Date().toISOString() }, null, 2),
    commitMessage,
  );
  return {
    ok: true,
    mode: 'api',
    owner: targetOwner,
    repo,
    repoUrl: created.html_url || `https://github.com/${targetOwner}/${repo}`,
    filesUploaded: publishable.length + 1,
    created: !existing,
  };
}

function sshRemote(owner, repo) {
  const host = config.GITHUB_SSH_HOST || 'github.com';
  if (host === 'github.com') return `git@github.com:${owner}/${repo}.git`;
  return `${host}:${owner}/${repo}.git`;
}

async function git(args, options) {
  return execFileAsync('git', args, {
    ...options,
    timeout: 120000,
    maxBuffer: 1024 * 1024 * 10,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

async function writeFilesToRepo(root, files, metadata) {
  for (const file of textFiles(files)) {
    const target = path.resolve(root, file.path);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error(`Unsafe GitHub file path: ${file.path}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
  await writeFile(path.join(root, 'webstudio-project.json'), JSON.stringify({ ...metadata, publishedToGitHubAt: new Date().toISOString() }, null, 2), 'utf8');
}

async function publishWithSsh({ repoName, files, metadata }) {
  const owner = config.GITHUB_OWNER;
  const repo = repoName;
  const remote = sshRemote(owner, repo);
  try {
    await git(['ls-remote', remote, 'HEAD']);
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      mode: 'ssh',
      reason: `GitHub repository does not exist or SSH cannot access it: ${remote}`,
      code: 'repo_create_required',
      detail: error.stderr || error.message,
      owner,
      repo,
      remote,
      repoUrl: `https://github.com/${owner}/${repo}`,
    };
  }

  const root = path.resolve(config.DATA_DIR, 'github-publish', repo);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await git(['clone', '--depth', '1', remote, root]);
  await writeFilesToRepo(root, files, metadata);
  await git(['config', 'user.name', 'Web Studio Orchestrator'], { cwd: root });
  await git(['config', 'user.email', 'webstudio@1true.ru'], { cwd: root });
  await git(['add', '.'], { cwd: root });
  const status = await git(['status', '--porcelain'], { cwd: root });
  if (!status.stdout.trim()) {
    return { ok: true, skipped: false, mode: 'ssh', owner, repo, remote, repoUrl: `https://github.com/${owner}/${repo}`, filesUploaded: 0, unchanged: true };
  }
  await git(['commit', '-m', `Publish Web Studio project ${metadata.leadId || ''}`.trim()], { cwd: root });
  await git(['push', 'origin', 'HEAD'], { cwd: root });
  return {
    ok: true,
    mode: 'ssh',
    owner,
    repo,
    remote,
    repoUrl: `https://github.com/${owner}/${repo}`,
    filesUploaded: textFiles(files).length + 1,
    created: false,
  };
}

export async function publishFilesToGitHub({ repoName, description, files, metadata = {} }) {
  if (config.GITHUB_PUBLISH_MODE === 'off') {
    return { ok: false, skipped: true, reason: 'GITHUB_PUBLISH_MODE=off' };
  }
  if (config.GITHUB_PUBLISH_MODE !== 'ssh' && hasSecret(config.GITHUB_TOKEN)) {
    return publishWithApi({ repoName, description, files, metadata });
  }
  if (config.GITHUB_PUBLISH_MODE === 'api') {
    return { ok: false, skipped: true, reason: 'GITHUB_TOKEN is not configured' };
  }
  return publishWithSsh({ repoName, files, metadata });
}

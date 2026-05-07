import { config, hasSecret } from '../config.js';

function isPublishableSourceFile(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const base = normalized.split('/').pop()?.toLowerCase() || '';
  if (base === '.env' || base.startsWith('.env.')) return false;
  if (/(^|\/)(node_modules|dist|build|\.git)\//.test(normalized)) return false;
  return true;
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

export async function publishFilesToGitHub({ repoName, description, files, metadata = {} }) {
  if (!hasSecret(config.GITHUB_TOKEN)) {
    return { ok: false, skipped: true, reason: 'GITHUB_TOKEN is not configured' };
  }
  const owner = config.GITHUB_OWNER;
  const repo = repoName;
  const existing = await getRepo(owner, repo);
  const created = existing || (await createRepo(owner, repo, description));
  const targetOwner = created.owner?.login || owner;
  const textFiles = files.filter((file) => !file.binary && typeof file.content === 'string' && isPublishableSourceFile(file.path));
  const commitMessage = `Publish Web Studio project ${metadata.leadId || ''}`.trim();
  for (const file of textFiles) {
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
    owner: targetOwner,
    repo,
    repoUrl: created.html_url || `https://github.com/${targetOwner}/${repo}`,
    filesUploaded: textFiles.length + 1,
    created: !existing,
  };
}

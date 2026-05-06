import { landingPrompt } from '../mcp.js';

export function lovableBuildUrl(prompt) {
  return `https://lovable.dev/?autosubmit=true#prompt=${encodeURIComponent(prompt)}`;
}

export async function prepareLovableMockup(lead) {
  const prompt = landingPrompt(lead);
  return {
    ok: false,
    skipped: true,
    mode: 'lovable_personal_mcp',
    status: 'waiting_lovable_project',
    reason: 'Lovable connects to this app through personal MCP. Create the project inside Lovable, then call attach_lovable_repo or attach_lovable_url.',
    prompt,
    buildUrl: lovableBuildUrl(prompt),
    updatedAt: new Date().toISOString(),
  };
}

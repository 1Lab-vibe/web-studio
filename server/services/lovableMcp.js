import { landingPrompt } from '../mcp.js';

export async function prepareLovableMockup(lead) {
  return {
    ok: false,
    skipped: true,
    mode: 'lovable_personal_mcp',
    status: 'waiting_lovable_project',
    reason: 'Lovable connects to this app through personal MCP. Create the project inside Lovable, then call attach_lovable_url.',
    prompt: landingPrompt(lead),
    updatedAt: new Date().toISOString(),
  };
}

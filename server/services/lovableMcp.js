import { landingPrompt } from '../mcp.js';
import { createAndMaybeDeployLovableProject, lovableOfficialConfigured } from './lovableOfficialMcp.js';

export function lovableBuildUrl(prompt) {
  return `https://lovable.dev/?autosubmit=true#prompt=${encodeURIComponent(prompt)}`;
}

export async function prepareLovableMockup(lead) {
  const prompt = landingPrompt(lead);
  if (lovableOfficialConfigured()) {
    const result = await createAndMaybeDeployLovableProject({ lead, prompt });
    if (result.ok) {
      return {
        ok: Boolean(result.publishedUrl || result.previewUrl),
        skipped: false,
        mode: 'lovable_official_mcp',
        status: result.publishedUrl ? 'public_url_attached' : 'waiting_lovable_project',
        projectId: result.projectId,
        editorUrl: result.editorUrl || '',
        previewUrl: result.previewUrl || '',
        url: result.publishedUrl || result.previewUrl || '',
        publishedUrl: result.publishedUrl || '',
        handoffStatus: result.publishedUrl ? 'url_received' : 'preview_received',
        reason: result.publishedUrl
          ? 'Lovable official MCP created and deployed the project.'
          : 'Lovable official MCP created the project. Deployment is disabled or did not return a public URL.',
        prompt,
        raw: result,
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      ok: false,
      skipped: false,
      mode: 'lovable_official_mcp',
      status: 'failed',
      reason: result.reason || result.error || 'Lovable official MCP failed',
      prompt,
      raw: result,
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    ok: false,
    skipped: true,
    mode: 'lovable_personal_mcp',
    status: 'waiting_lovable_project',
    reason: 'Lovable connects to this app through personal MCP. Create the project inside Lovable, then call attach_lovable_url with a public preview/published URL.',
    prompt,
    buildUrl: lovableBuildUrl(prompt),
    updatedAt: new Date().toISOString(),
  };
}

# Lovable Integration

This project supports two Lovable paths.

## 1. Official Lovable MCP server

Use this for autonomous create/publish without clicking the Lovable UI.

Lovable endpoint:

```text
https://mcp.lovable.dev
```

Required:

- Lovable Pro or Business plan.
- Workspace API key from Lovable workspace settings. It starts with `lov_`.
- Workspace ID from `list_workspaces`.

Web Studio env:

```text
LOVABLE_API_KEY=lov_...
LOVABLE_WORKSPACE_ID=...
LOVABLE_OFFICIAL_MCP_URL=https://mcp.lovable.dev
LOVABLE_AUTO_DEPLOY=true
```

OAuth fallback:

```text
LOVABLE_OAUTH_TOKEN_PATH=/app/data/lovable-oauth.json
LOVABLE_WORKSPACE_ID=...
LOVABLE_AUTO_DEPLOY=true
```

Generate the OAuth token locally through the Cursor-registered Lovable client:

```bash
node scripts/lovable-oauth-cursor-capture.js manual-start
node scripts/lovable-oauth-cursor-capture.js manual-finish "cursor://anysphere.cursor-mcp/oauth/callback?code=..."
```

When configured, Web Studio calls:

1. `create_project` with the lead landing prompt.
2. `deploy_project` when `LOVABLE_AUTO_DEPLOY=true`.
3. `get_project`, `list_files`, and `read_file` to export the generated source from the latest commit.
4. Coder writes the source to `DATA_DIR/sources/<slug>`, runs `npm install && npm run build`, and publishes the build under `/projects/<slug>`.
5. If `GITHUB_TOKEN` is configured, Coder also creates or updates a GitHub repository and uploads the same exported source.

GitHub publishing env:

```text
GITHUB_TOKEN=github_pat_...
GITHUB_OWNER=1Lab-vibe
GITHUB_REPO_PREFIX=webstudio-
GITHUB_PRIVATE=false
```

If `GITHUB_TOKEN` is empty, the public `/projects/<slug>` deploy still runs; GitHub is recorded as skipped.

Smoke endpoint:

```text
GET /api/lovable/tools
```

## 2. Web Studio MCP connector inside Lovable

Use this when the Lovable account supports custom MCP servers.

Public endpoint:

```text
https://webstudio.1true.ru/mcp
```

Recommended auth:

```text
Authorization: Bearer <WEB_STUDIO_MCP_TOKEN>
```

Lovable setup:

1. Open Lovable settings.
2. Go to `Connectors`.
3. Add a personal MCP server.
4. Use `https://webstudio.1true.ru/mcp`.
5. Add the bearer token from production `.env`.

Exposed tools:

- `list_top_leads`
- `get_landing_brief`
- `get_lovable_prompt`
- `get_lovable_handoff_request`
- `attach_lovable_repo`
- `attach_lovable_url`
- `deploy_static_project`

Lovable can read lead context and then write the result back in three ways:

- `attach_lovable_url` when Lovable has only a public preview or published URL. Web Studio Coder then deploys a local snapshot/fallback under `/projects/<slug>` and Filmer renders media from our own domain.
- `deploy_static_project` when Lovable can export static files directly.
- `attach_lovable_repo` only when there is a real public GitHub repository URL. Do not pass `lovable.code.storage` internal remotes; Web Studio cannot read them.

## 3. Browser automation fallback

Use this while the account is not paid or does not expose API/MCP automation.

Preferred flow for Google OAuth is real Chrome over CDP. This avoids Google rejecting Playwright's bundled browser.

Open real Chrome with a dedicated Lovable automation profile and remote debugging:

```bash
npm run lovable:chrome
```

Log in to Lovable through Google in that Chrome window. Then capture the session:

```bash
npm run lovable:capture
```

Then create from a lead:

```bash
LOVABLE_USE_CDP=true npm run lovable:create -- <leadId>
```

The older Playwright-launched login mode still exists, but Google OAuth can reject it:

```bash
npm run lovable:login
```

By default the fallback uses system Chrome:

```text
LOVABLE_BROWSER_CHANNEL=chrome
```

To reuse your already authorized local Chrome profile:

```text
LOVABLE_USE_CHROME_PROFILE=true
LOVABLE_CHROME_PROFILE=Default
```

The dedicated profile lives in `./data/lovable-chrome-profile`. It is separate from your normal Chrome profile and is gitignored.

The fallback opens Lovable, inserts the generated prompt, and tries `Ctrl+Enter`. If Lovable changes its UI or blocks automation, submit with the visible button manually. This is intentionally a fallback, not the production path.

## Domain

One domain is enough:

```text
webstudio.1true.ru
webstudio.1true.ru/mcp
```

Use `ws-mcp.1true.ru` only if your proxy/CDN cannot route long-lived Streamable HTTP/SSE requests under `/mcp`.

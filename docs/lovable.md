# Lovable Integration

This project supports two Lovable paths.

## 1. Proper MCP connector

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
- `attach_lovable_url`

Lovable can read lead context and then write the created Lovable URL back through `attach_lovable_url`.

## 2. Browser automation fallback

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

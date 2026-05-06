# Deploy Notes

Recommended public URL:

```text
https://webstudio.1true.ru
https://webstudio.1true.ru/mcp
```

Use a separate `ws-mcp.1true.ru` only if your proxy/CDN cannot keep Streamable HTTP/SSE connections stable under `/mcp`.

## Reverse Proxy

The backend listens on `127.0.0.1:8787`.

Proxy these paths to the backend:

- `/api/*`
- `/mcp`

Serve the Vite build for everything else:

- `dist/index.html`
- `dist/assets/*`

Nginx sketch:

```nginx
server {
  server_name webstudio.1true.ru;

  root /var/www/web-studio/dist;
  index index.html;

  location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /mcp {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location / {
    try_files $uri /index.html;
  }
}
```

Production `.env` minimum:

```text
NODE_ENV=production
PORT=8787
PUBLIC_BASE_URL=https://webstudio.1true.ru
WEB_ORIGIN=https://webstudio.1true.ru
WEB_STUDIO_MCP_TOKEN=<long random token>
OPENAI_API_KEY=<key>
YANDEX_MAPS_API_KEY=<key>
LEAD_SOURCE_PROVIDER=yandex
GOOGLE_MAPS_API_KEY=<optional fallback key>
GOOGLE_DAILY_SEARCH_LIMIT=100
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<chat id>
A1_API_URL=<A1 API URL>
A1_MCP_URL=<A1 MCP URL>
LOVABLE_API_KEY=<lov_ workspace api key, optional for official Lovable MCP>
LOVABLE_WORKSPACE_ID=<workspace id, optional>
LOVABLE_AUTO_DEPLOY=true
```

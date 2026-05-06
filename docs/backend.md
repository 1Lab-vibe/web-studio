# Web Studio Backend

Backend runs a local orchestrator for the Russian solo-agency workflow.

## Flow

1. `Scout` reads Yandex Maps Organization Search API.
2. `Diagnoser` uses OpenAI Responses API for diagnosis, hero angle, tone and cold message.
3. `Builder` can call Lovable through an MCP endpoint for top daily leads.
4. `Filmer`, `Checker`, `Pitcher`, `Mobile` are represented as lead stages and A1 tasks.
5. The orchestrator owns writes, keeps a per-lead lock, and asks a human only for configured gates.

## Run

```bash
npm install
npm run dev:api
npm run dev
```

API: `http://127.0.0.1:8787/api/health`

## Environment

Copy `.env.example` to `.env` and fill keys locally. `.env` is gitignored.

- `OPENAI_API_KEY` for real diagnosis generation.
- `YANDEX_MAPS_API_KEY` for Organization Search API.
- `A1_API_URL` and optionally `A1_API_KEY` for `POST /v1/agents/tasks`.
- `A1_MCP_URL` and `A1_MCP_API_KEY` for A1 MCP tool calls.
- `LOVABLE_MCP_URL` and `LOVABLE_MCP_API_KEY` for Lovable MCP.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for human approval notifications.

## Main Endpoints

- `GET /api/state`
- `GET /api/leads`
- `POST /api/leads`
- `POST /api/orchestrator/scout`
- `POST /api/orchestrator/tick`
- `POST /api/leads/:id/advance`
- `GET /api/approvals`
- `POST /api/approvals/:id/approved`
- `POST /api/telegram/webhook`

Yandex Organization Search license terms can restrict storing or modifying returned organization data. Keep production usage aligned with your Yandex license.

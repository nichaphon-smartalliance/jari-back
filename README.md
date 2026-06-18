# jari-back

Backend for **Jari** — **Bun + Hono + TypeScript**, PostgreSQL (Bun's built-in `SQL`), syncing from
Jira REST v3 and calling the AI Center gateway. See `../docs/04-architecture.md`.

## Run

```bash
bun install
cp .env.example .env     # fill in Jira creds (see ../docs/02-jira-integration.md)
bun run dev              # hot-reload, http://localhost:4000
bun run typecheck        # tsc --noEmit
```

Server boots even if Postgres is down (schema init is non-fatal); DB-backed endpoints then error
per request instead of crashing boot.

## Architecture

```
routes/*  (thin Hono handlers, return c.json)
  → services/aggregate.ts   read DB → domain types (DashboardData, Issue, Worklog, DailyData)
  → services/jiraSync.ts     Jira → upsert Postgres   (POST /sync)
  → services/jira.ts         Jira REST v3 client + ADF helpers (read & write)
  → services/ai.ts           AI Center /chat client (fallback chain)
  → services/workspaces.ts   JIRA_WORKSPACE_N_* env parsing
db/{client,schema}.ts        Bun SQL + 3 tables (workspaces, issues, worklogs)
types.ts                     shared domain types — identical to jari-front/types/app/jira
```

Response shapes match the frontend's domain types exactly, so the frontend swaps its mock services
for `fetch` against this API with no shape changes. Jira's `statusCategory`
(`new`/`indeterminate`/`done`) is mapped to `todo`/`inprogress`/`done` on output.

## Endpoints

| Method & path | Feature | Notes |
|---|---|---|
| `GET /health` | — | liveness |
| `GET /workspaces` | — | configured Jira workspaces |
| `POST /sync` · `/sync/issues` · `/sync/worklogs` · `GET /sync/status` | data | Jira → Postgres |
| `GET /dashboard` | #1 | KPIs, trend, workload, project health, sprint |
| `GET /issues` · `/sprint` · `/worklogs` | #1 | filtered issue/worklog reads |
| `POST /stories` · `/subtasks` | #2 | create in Jira (`description` → ADF) |
| `POST /issues/:key/done` | #3 | find "Done" transition, apply, mirror locally |
| `GET /worklog/candidates?accountId=` | #4 | Done sub-tasks with no worklog |
| `POST /worklog` | #4 | create Jira worklog (`started` sent as `+0700`) |
| `GET /daily?date=YYYY-MM-DD` | #5 | per-person 8h roll-up |
| `POST /ai/rewrite` · `/ai/suggest-subtasks` · `/ai/plan-worklogs` | #6 | AI Center |

## Auth (local user table)

Login is backed by an `app_users` table (username + argon2id password hash + `jira_account_id`).
A successful login returns an HMAC-signed token (set `AUTH_SECRET` in `.env`). The token's
`accountId` is what `/work`, `/worklog`, etc. use as "me".

| Method & path | Notes |
|---|---|
| `POST /auth/login` | `{username,password}` → `{token, user:{username,accountId,displayName}}` |
| `GET /auth/me` | `Authorization: Bearer <token>` → `{user}` (validates token) |

Create/seed a login account (dev). Find Jira account ids with `curl http://localhost:4000/users`
after a sync:

```bash
bun run seed:user <username> <password> <jiraAccountId> "<Display Name>"
```

## Notes / TODO when wiring the frontend

- `GET /issues?status=` expects a Jira category key (`new`/`indeterminate`/`done`), not the mapped
  value — adjust if the frontend sends the simplified category.
- "current user" for `/work` and `/worklog` is passed as `?accountId=`; replace with real auth.
- Writes go straight to Jira; consider a targeted re-sync of the affected issue afterwards.

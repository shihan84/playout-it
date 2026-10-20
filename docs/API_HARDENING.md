# API Abuse Protection & Request Hardening

Implemented on `security/api-abuse-hardening`. Covers authentication rate
limiting, request body limits, JWT secret validation, and dependency audit
status.

## Authentication rate limiting

`src/server/middleware/rateLimit.ts` (`express-rate-limit` v8):

| Endpoint | Default limit | Env override |
|---|---|---|
| `POST /api/auth/login` | 30 req / IP / 15 min | `AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS` |

- Exceeding the limit returns **HTTP 429** `{"error": "Too many requests, ..."}`
  with `RateLimit` response headers (`standardHeaders: 'draft-8'`).
- The window **expires** — no permanent lockout of legitimate users.
- Login failures for unknown users and wrong passwords return the identical
  `401 {"error": "Invalid credentials"}` — no account enumeration.
- Other endpoints (`/me`, `/logout`) are unaffected.

### Proxy / client-IP handling

The app does **not** set `trust proxy`, so `req.ip` is the direct socket peer
and `X-Forwarded-For` is **never trusted** — spoofed XFF cannot bypass the
limit (regression-tested). If a trusted reverse proxy is added later, set
`app.set('trust proxy', <n>)` to the exact number of trusted hops — **never
`true`** — or every client could claim any IP.

### Multi-instance deployments

The default store is **in-memory per process**. The app is single-process by
design (SQLite `better-sqlite3`), so this is correct today. If it is ever run
as multiple instances behind a load balancer, limits apply per instance —
switch to a shared store (e.g. `rate-limit-redis`) for global enforcement.

## Request body limits (`server.ts`)

| Scope | Parser | Limit | Oversized result |
|---|---|---|---|
| `/api/auth/*` | `express.json` | **2 kb** | HTTP 413 |
| all other routes | `express.json` | **5 MB** | HTTP 413 |
| forms | `express.urlencoded` | **1 MB** | HTTP 413 |

- Replaces the previous `limit: '1000gb'` (effectively unbounded — memory-DoS).
- 5 MB covers the largest legitimate JSON payloads (VOD/playlist path lists,
  settings, bulk operations). Media uploads go through **multer** multipart
  endpoints with their own file-size limits — no JSON route needs more.
- Malformed JSON now returns **400** instead of 500 (error-handler fix).

## JWT secret validation (`src/server/config/index.ts`)

Production startup (`NODE_ENV=production`) throws unless `JWT_SECRET` is:

- set,
- at least 32 characters, and
- not a placeholder/common value (exact-match denylist: the bundled dev
  fallback `your-secret-key-change-in-production`, `secret`, `changeme`,
  `jwt-secret`, `password`, `test-secret`).

Development/test mode is unchanged — the dev fallback still works when
`NODE_ENV != production`, and test secrets like the integration-suite value
(56 chars, non-denylisted) pass in production mode.

## Dependency audit

`npm audit` → **0 vulnerabilities** after two non-breaking fixes:

| Advisory | Package | Path | Severity | Resolution |
|---|---|---|---|---|
| GHSA-q8mj / x5fp / 4mjr | `qs` ≤6.15.3 | `express@4` (`~6.14.0` pin) | moderate | `overrides: { "qs": "^6.16.0" }` → 6.16.1 |
| GHSA-g7r4 | `esbuild` 0.27.3–0.28.0 | `tsx` nested dep | low | `tsx` 4.21.0 → **4.23.15** (esbuild → 0.28.2) |

The `qs` override is required because express 4 pins `~6.14.0`; overriding to
6.16 is API-compatible for express's usage (query string + `extended` urlencoded
parsing). Upgrading to express 5 would remove the need for the override — an
owner decision, out of scope here.

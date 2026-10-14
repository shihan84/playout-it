# IBS Manager — Engineering Handoff

Date: 2026-10-14
Scope: Flussonic Media Server management dashboard (React SPA + Express + SQLite)

---

## 1. What This Project Is

A single-tenant dashboard for managing one or more **Flussonic Media Server** instances:

- Stream CRUD + live status monitoring (watchdog polling)
- VOD storage + file management (direct & chunked uploads)
- Per-stream fallback video playlists (`playlist.txt` appended to stream inputs)
- Multi-user access (admin / client roles, per-stream assignment)
- IP blocking synced to Flussonic `auth_backends/blacklist`
- Telegram alerts (global watchdog notifications + per-user/per-stream alerts + bot webhook)
- Server metrics, sessions, SSL via Let's Encrypt + nginx
- WebSocket `/ws` broadcast (`STREAMS_UPDATE`) for live UI refresh
- Deploy target: Raspberry Pi (PM2/systemd + optional nginx), single bundled Node process

---

## 2. Recent Major Change: Backend Modularization

The backend was a single **~3,250-line `server.ts`**. It is now a **feature-based modular backend**. `server.ts` is a ~122-line composition root.

```
server.ts                          # composition root (middleware, routers, WS upgrade, start)
src/server/
├── config/index.ts                # env config: port, dbPath, jwtSecret, ssl*, telegramBotToken, saltRounds
├── db/
│   ├── index.ts                   # better-sqlite3 open, WAL, FK pragma, corruption recovery, init
│   ├── schema.ts                  # CREATE TABLE statements
│   └── migrations.ts              # ALTER TABLEs, backfills, default admin, settings defaults
├── middleware/auth.ts             # authenticateToken, requireAdmin, requireStreamAccess, AuthRequest
├── websocket/index.ts             # WebSocketServer (noServer), wss export, broadcastStreamsUpdate
├── services/
│   ├── flussonic.ts               # flussonicRequest, getServerAuthHeader (see §5)
│   ├── telegram.ts                # sendTelegramMessage, sendTelegramNotification
│   ├── playlist.ts                # updatePlaylistFile, updateVodPlaylistFile (stream input fallback)
│   ├── sync.ts                    # syncServerStreams, syncServerVods, syncVodFilesFromRemote
│   └── watchdog.ts                # checkStreams loop, startWatchdog, auto-sync interval
├── routes/
│   ├── auth.ts                    # POST /api/auth/login, /logout, GET /me
│   ├── users.ts                   # GET/POST/PUT/DELETE /api/users, stream assignments
│   ├── servers.ts                 # GET/POST/DELETE /api/servers, /:id/status, /:id/sync, /sync-all
│   ├── streams.ts                 # /api/streams CRUD + :id/details + videos + playlist.txt + vod-files
│   ├── myStreams.ts               # GET /api/my-streams (per-user view)
│   ├── vods.ts                    # /api/vods CRUD + files + playlist + chunked upload + sync
│   ├── blockedIps.ts              # /api/blocked-ips*, /api/servers/:id/sessions, /api/sessions/block-ip
│   ├── telegramAlerts.ts          # /api/telegram-alerts CRUD + /send + /:id/history
│   ├── telegramWebhook.ts         # POST /api/telegram/webhook (/start, /help)
│   ├── metrics.ts                 # GET /api/servers/:id/metrics (mounted oddly, see §8)
│   ├── settings.ts                # GET/POST /api/settings, POST /api/settings/test-telegram
│   └── ssl.ts                     # GET /api/ssl/status, POST /install, /renew (certbot)
└── utils/
    ├── streams.ts                 # parseStream (JSON column decoding)
    └── sslNginx.ts                # updateNginxConfig (writes nginx SSL block)
```

### Router mounting (in `server.ts`)

```ts
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/servers', serversRoutes);
app.use('/api/streams', streamsRoutes);
app.use('/api/my-streams', myStreamsRoutes);   // NOTE: separate mount — do NOT move into streams.ts
app.use('/api/vods', vodsRoutes);
app.use('/api', blockedIpsRoutes);             // router defines /blocked-ips, /servers/:id/sessions, /sessions/block-ip
app.use('/api/telegram-alerts', telegramAlertsRoutes);
app.use('/api/telegram/webhook', telegramWebhookRoutes);  // separate mount — webhook lives at /api/telegram/webhook
app.use('/api/settings', settingsRoutes);
app.use('/api/servers/:id/metrics', metricsRoutes);       // router defines GET /:id → /api/servers/:id/metrics/:id ⚠ see §8
app.use('/api/ssl', sslRoutes);
app.post('/api/watchdog/restart', ...)         // restarts watchdog intervals
```

### Behavior preserved

All API paths, methods, auth rules, response shapes, WebSocket `/ws`, Vite dev middleware, prod static serving, optional native HTTPS, PM2/systemd deployment, and SQLite migrations are unchanged.

Verified: `npm run lint` (tsc) and `npm run build` (vite + esbuild → `dist/server.cjs`) both pass. Full API smoke test performed (see §7).

---

## 3. Recent Major Change: Server Auth Model

Flussonic v3 uses HTTP Basic auth with **username + password**. Previously the app stored a single `api_key` and guessed `flussonic:<key>` then retried `admin:<key>`.

**Now:**

- `servers` table has `username` + `password` columns (migration backfills from `api_key`:
  - `api_key` containing `:` → split into username/password
  - otherwise → `username='flussonic'`, `password=api_key`)
- `api_key` column is kept populated as `"user:pass"` for backward compatibility.
- `services/flussonic.ts` exports `getServerAuthHeader(server)`:
  - `username`+`password` present → `Basic user:pass`
  - else legacy `api_key` logic (`user:pass` or `flussonic:key`, with `admin:key` 401/403 retry only when no explicit creds)
- `POST /api/servers` accepts `username` + `password` (preferred) or legacy `api_key`.
- Frontend `Servers.tsx` add-form uses Username + Password fields.

### Credential-scrubbing rules

- `streams.ts` details/vod-files routes JOIN `api_key, username, password` then `delete` all three before responding.
- `GET /api/servers` returns full rows including `api_key`, `username`, `password` to admins (unchanged from before, but now leaks the password too — consider masking).

---

## 4. Commands

```bash
npm run dev      # tsx server.ts  (NO auto-restart on backend changes — restart manually!)
npm run lint     # tsc --noEmit
npm run build    # vite build && esbuild server.ts → dist/server.cjs
npm start        # node dist/server.cjs
```

**Important:** `tsx` does not watch/restart on backend file changes in this setup (no `--watch`). After editing `server.ts` or `src/server/**`, kill and restart the dev process. Vite HMR only reloads the frontend.

### Env vars (`.env`, loaded via dotenv in config)

`PORT` (3000), `DATABASE_PATH` (flussonic.db), `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`, `SSL_ENABLED`, `SSL_KEY_PATH`, `SSL_CERT_PATH`, `NODE_ENV`.

Defaults: JWT secret fallback `'your-secret-key-change-in-production'`; default admin `admin`/`admin123` auto-created by migrations.

---

## 5. Key Internals

### Flussonic client (`services/flussonic.ts`)

```ts
flussonicRequest(method, url, server, data?, timeout=30000, extraHeaders?)
```
- Auth: `getServerAuthHeader(server)` (username/password → Basic; legacy api_key fallback).
- On 401/403 with legacy key-only → retries `admin:<key>`.
- `maxContentLength/maxBodyLength: Infinity` for large VOD uploads.

Endpoints used: `/flussonic/api/v3/config`, `/streams`, `/streams/:name`, `/vods`, `/vods/:name`, `/vods/:name/storages/0/files(/:file)`, `/auth_backends/blacklist(/:ip)`, `/sessions`.

### Watchdog (`services/watchdog.ts`)

- `checkStreams()` groups local streams by server → `GET /flussonic/api/v3/streams` per server → updates `status`, `input_status`, `source_type`, `uptime`, `push_status` in DB → consolidated Telegram notification on changes → per-alert POST to `/api/telegram-alerts/send` when a stream goes offline → `broadcastStreamsUpdate()` if anything changed.
- `startWatchdog()` sets two intervals from `settings`: `watchdog_interval` (default 5s) and auto-sync (`auto_sync_enabled`, `auto_sync_interval`).
- `/api/watchdog/restart` re-reads settings and restarts timers.
- Guarded by `isChecking` flag (no concurrent runs).

### Playlist fallback (`services/playlist.ts`)

- `updatePlaylistFile(stream)`: regenerates `playlist.txt` from `videos` table (sorted by `sort_order`), uploads to `vods/{streamName}/storages/0/files/playlist.txt`, then rewrites the stream's Flussonic inputs to keep primary inputs and append `playlist:///{streamName}/playlist.txt` as the last (fallback) input.
- `updateVodPlaylistFile(vod)`: same idea for standalone VOD locations (`vod_files` table, `{vodName}/` filename prefixing).

### Sync (`services/sync.ts`)

- `syncServerStreams(server)` / `syncServerVods(server)`: pull `/streams` & `/vods`, add missing rows, delete stale rows. Tolerant of multiple Flussonic response shapes (array / `{streams|vods}` / keyed object).
- `syncVodFilesFromRemote(vod, server)`: reconciles `vod_files` with `vods/:name/storages/0/files` listing.
- Auto-sync runs in `startWatchdog()`; also triggered by `POST /api/servers/:id/sync` and `/sync-all`.

### WebSocket (`websocket/index.ts`)

- `WebSocketServer({ noServer: true })` exported as `wss`; `server.ts` handles `upgrade` only for `/ws`.
- `broadcastStreamsUpdate()` sends `{ type: 'STREAMS_UPDATE', data: streams }` to all clients; frontend also polls every 30s as fallback.

---

## 6. Database

SQLite (`flussonic.db` by default), WAL mode, foreign keys ON. On corruption: deletes db + `-wal` + `-shm` and recreates (destructive recovery).

Tables: `servers`, `streams`, `vods`, `videos`, `vod_files`, `settings`, `users`, `user_stream_assignments`, `blocked_ips`, `telegram_alerts`, `telegram_alert_history`.

Migrations are append-only, wrapped in try/catch (idempotent). Latest addition: `servers.username`, `servers.password` + api_key backfill.

**Sensitive data in DB (plaintext):** Flussonic `api_key`/`username`/`password`, `settings.telegram_bot_token`, `settings.telegram_chat_id`. Default admin password is `admin123`.

---

## 7. Verified Functionality (smoke-tested)

| Endpoint | Result |
|---|---|
| `POST /api/auth/login`, `GET /me`, `POST /logout` | 200 (JWT via cookie + body) |
| `GET /api/servers` | 200 (per-server live config probe, offline on unreachable) |
| `POST /api/servers` (username+password & legacy api_key) | 200, auto-sync attempt |
| `GET /api/servers/:id/status`, `DELETE` | 200/404 correct |
| `GET /api/streams`, `/my-streams`, `/:id/details`, `/videos`, `/playlist.txt`, `/vod-files` | 200/404 correct; graceful `flussonic_error` when unreachable |
| `GET /api/vods` + file/playlist/sync routes | 200 |
| `GET/POST/PUT/DELETE /api/users` | 200 |
| `GET/POST/DELETE /api/blocked-ips` | 200 |
| `GET/POST/DELETE /api/telegram-alerts`, `/:id/history` | 200 |
| `GET/POST /api/settings` | 200 (settings persist) |
| `GET /api/ssl/status` | 200 (`not_configured`) |
| `POST /api/watchdog/restart` | 200 |
| SPA routes `/`, `/login`, all pages | 200 |

---

## 8. Known Issues / Loose Ends

1. **`/api/servers/:id/metrics` mount is doubled**: `server.ts` mounts `metricsRoutes` at `/api/servers/:id/metrics` and the router defines `GET /:id`, so the real path is `/api/servers/:id/metrics/:id`. The frontend calls `/api/servers/${id}/metrics`. **Check/fix**: mount at `/api` or rename router path to `/`. (Not yet verified — may currently 404/fall through.)
2. **`GET /api/servers` exposes `password`/`api_key`** to admins — consider masking (`password: '***'`).
3. **Several VOD file routes lack auth middleware** (`/:id/files`, `init-chunked`, `chunk`, `complete-chunked`, `confirm-upload`, `upload-info`, `files/:filename` DELETE, `files/sync`, `/:id/sync`, `playlist/*`) — matches original behavior; `upload-info` leaks Basic auth headers to any caller.
4. **Watchdog calls its own HTTP API** for telegram alerts (`axios.post http://localhost:${port}/api/telegram-alerts/send`) — works but is brittle; could call the service directly.
5. **`no tests`** — verification is lint + build + smoke only.
6. **Heavy `any`** throughout server code.
7. **Secrets in repo**: `deploy-windows.ps1` (SSH creds), `DEPLOYMENT.md` (Pi password) — pre-existing.
8. **Default admin `admin/admin123`** auto-created; insecure `JWT_SECRET` fallback.
9. **Flussonic write failures are swallowed** (`.catch(console.warn)`) by design — stream/VOD creation tolerates unreachable servers.
10. Frontend `bundle` ~991 kB (chunk-size warning only, cosmetic).
11. **`check-*.cjs`/`check-stream.js`** debug scripts and `DEPLOYMENT.md` are untracked leftovers — decide whether to keep or gitignore.
12. tsx dev has **no watch restart** for backend — restart manually after edits.

---

## 9. How To Continue (suggested next steps)

- Fix the metrics mount (§8.1) — likely: `app.use('/api/servers', metricsRoutes)` won't work since `serversRoutes` already owns it; instead mount `metricsRoutes` at `/api/servers-metrics` or change router path to `/:id/metrics` and mount under `/api/servers` before `serversRoutes`… verify actual route resolution order.
- Mask credentials in `GET /api/servers` response.
- Add auth to public VOD routes if desired.
- Deploy to Raspberry Pi: `scripts/setup-raspbian.sh` → `scripts/deploy-raspbian.sh` (PM2, 512MB limit, Node 20, rebuild better-sqlite3 native module). Nginx proxies `/` and `/ws`, `client_max_body_size 1000G`.
- If touching auth/storage again, consider hashing Flussonic creds or at least documenting plaintext storage.

---

## 10. Quick Reference — files to touch for common tasks

| Task | File(s) |
|---|---|
| New API route group | `src/server/routes/<x>.ts` + mount in `server.ts` |
| Flussonic call | `services/flussonic.ts` (`flussonicRequest`) |
| Server creds | `db/migrations.ts` + `services/flussonic.ts` + `routes/servers.ts` + `Servers.tsx` |
| Stream status logic | `services/watchdog.ts` |
| Playlist/fallback | `services/playlist.ts` |
| Real-time push | `websocket/index.ts` (`broadcastStreamsUpdate`) |
| Auth/roles | `middleware/auth.ts` |
| New DB column | `db/schema.ts` + `db/migrations.ts` |
| SSL/nginx | `routes/ssl.ts` + `utils/sslNginx.ts` |

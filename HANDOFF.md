# IBS Manager — Engineering Handoff

Date: 2026-10-14
Repo: `git@github.com:shihan84/playout-it.git` (branch `main`, latest `7930785`)
Scope: Flussonic Media Server management dashboard (React SPA + Express + SQLite)

---

## 1. What This Project Is

A single-tenant dashboard for managing one or more **Flussonic Media Server** instances:

- Stream CRUD + live status monitoring (watchdog polling)
- VOD storage + file management (direct & chunked uploads)
- Per-stream fallback video playlists (`playlist.txt` appended as last stream input)
- Multi-user access (admin / client roles, per-stream assignment)
- IP blocking synced to Flussonic `auth_backends/blacklist`
- Telegram alerts (global watchdog notifications + per-user/per-stream alerts + bot webhook)
- Server metrics, sessions, SSL via Let's Encrypt + nginx
- WebSocket `/ws` broadcast (`STREAMS_UPDATE`) for live UI refresh
- Deploy target: Raspberry Pi (PM2/systemd + optional nginx), single bundled Node process

---

## 2. Architecture (post-modularization)

`server.ts` was a ~3,250-line monolith. It is now a **~122-line composition root**; all logic lives under `src/server/`.

```
server.ts                          # composition root: middleware, router mounts, /ws upgrade, start
src/server/
├── config/index.ts                # env: port, dbPath, jwtSecret, ssl*, telegramBotToken, saltRounds
├── db/
│   ├── index.ts                   # better-sqlite3 open, WAL, FK pragma, corruption recovery, init
│   ├── schema.ts                  # CREATE TABLE statements
│   └── migrations.ts              # ALTER TABLEs, backfills, default admin, settings defaults
├── middleware/auth.ts             # authenticateToken, requireAdmin, requireStreamAccess, AuthRequest
├── websocket/index.ts             # WebSocketServer (noServer), wss, broadcastStreamsUpdate
├── services/
│   ├── flussonic.ts               # flussonicRequest, getServerAuthHeader (Basic auth resolution)
│   ├── telegram.ts                # sendTelegramMessage, sendTelegramNotification
│   ├── playlist.ts                # updatePlaylistFile, updateVodPlaylistFile
│   ├── sync.ts                    # syncServerStreams, syncServerVods, syncVodFilesFromRemote
│   └── watchdog.ts                # checkStreams loop, startWatchdog, auto-sync interval
├── routes/
│   ├── auth.ts                    # POST /api/auth/login, /logout, GET /me
│   ├── users.ts                   # /api/users CRUD, stream assignments
│   ├── servers.ts                 # /api/servers CRUD, /:id/status, /:id/sync, /sync-all
│   ├── streams.ts                 # /api/streams CRUD, /:id/details, videos, playlist.txt, vod-files
│   ├── myStreams.ts               # GET /api/my-streams (per-user view)
│   ├── vods.ts                    # /api/vods CRUD, files, playlist, chunked upload, sync
│   ├── blockedIps.ts              # /api/blocked-ips, /api/servers/:id/sessions, /api/sessions/block-ip
│   ├── telegramAlerts.ts          # /api/telegram-alerts CRUD, /send, /:id/history
│   ├── telegramWebhook.ts         # POST /api/telegram/webhook (/start, /help)
│   ├── metrics.ts                 # GET /api/servers/:id/metrics (see §8 caveat)
│   ├── settings.ts                # GET/POST /api/settings, POST /api/settings/test-telegram
│   └── ssl.ts                     # GET /api/ssl/status, POST /install, /renew (certbot)
└── utils/
    ├── streams.ts                 # parseStream (JSON column decoding)
    └── sslNginx.ts                # updateNginxConfig (writes nginx SSL block)
```

### Router mounts (`server.ts`)

```ts
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/servers', serversRoutes);
app.use('/api/streams', streamsRoutes);
app.use('/api/my-streams', myStreamsRoutes);            // separate mount — do NOT move into streams.ts
app.use('/api/vods', vodsRoutes);
app.use('/api', blockedIpsRoutes);                      // router defines /blocked-ips, /servers/:id/sessions, /sessions/block-ip
app.use('/api/telegram-alerts', telegramAlertsRoutes);
app.use('/api/telegram/webhook', telegramWebhookRoutes); // webhook lives at /api/telegram/webhook
app.use('/api/settings', settingsRoutes);
app.use('/api/servers/:id/metrics', metricsRoutes);      // ⚠ see §8.1
app.use('/api/ssl', sslRoutes);
app.post('/api/watchdog/restart', ...);                  // restarts watchdog timers
```

All API paths, methods, auth rules, response shapes, WebSocket behavior, Vite dev middleware, prod static serving, optional HTTPS, and SQLite migrations are preserved.

---

## 3. Flussonic Server Auth (current model)

Flussonic v3 uses HTTP **Basic auth** with `username` + `password`.

- `servers` table columns: `name`, `url`, `api_key` (legacy, kept populated as `user:pass`), `username`, `password`.
- **Migration** (`db/migrations.ts`): adds `username`/`password` columns and backfills —
  `api_key` containing `:` splits into user/pass; otherwise `username='flussonic'`, `password=api_key`.
- **`getServerAuthHeader(server)`** (`services/flussonic.ts`):
  - `username` + `password` set → `Basic user:pass`
  - else legacy `api_key` (`user:pass` verbatim, or `flussonic:key`); on 401/403 retries `admin:key` only when no explicit creds.
- `POST /api/servers` accepts `username` + `password` (preferred) or legacy `api_key`.
- Frontend `Servers.tsx` add-form uses **Username** + **Password** fields.
- `streams.ts` details/vod-files JOIN credentials, pass to `flussonicRequest`, then `delete` them before responding.

---

## 4. Commands

```bash
npm run dev      # tsx server.ts  (does NOT auto-restart on backend edits — restart manually)
npm run lint     # tsc --noEmit
npm run build    # vite build && esbuild → dist/server.cjs
npm start        # node dist/server.cjs
```

### Env vars (`.env`)

`PORT` (3000), `DATABASE_PATH` (flussonic.db), `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`, `SSL_ENABLED`, `SSL_KEY_PATH`, `SSL_CERT_PATH`, `NODE_ENV`.

Defaults: `JWT_SECRET` falls back to `'your-secret-key-change-in-production'`; default admin `admin`/`admin123` is auto-created — **change both in production**.

---

## 5. Key Internals

### Flussonic client — `services/flussonic.ts`

```ts
flussonicRequest(method, url, server, data?, timeout=30000, extraHeaders?)
```

Endpoints used: `/flussonic/api/v3/config`, `/streams`, `/streams/:name`, `/vods`, `/vods/:name`, `/vods/:name/storages/0/files(/:file)`, `/auth_backends/blacklist(/:ip)`, `/sessions`. Unlimited body limits for large VOD uploads.

### Watchdog — `services/watchdog.ts`

- `checkStreams()`: groups streams by server → `GET /flussonic/api/v3/streams` → updates `status`, `input_status`, `source_type`, `uptime`, `push_status` → consolidated Telegram notifications on transitions → per-alert POST `/api/telegram-alerts/send` on offline → `broadcastStreamsUpdate()` when DB changed.
- `startWatchdog()`: two intervals driven by `settings` — `watchdog_interval` (default 5s) and auto-sync (`auto_sync_enabled`, `auto_sync_interval` default 60s).
- `POST /api/watchdog/restart` restarts timers after settings change.
- `isChecking` flag prevents concurrent runs.

### Playlist fallback — `services/playlist.ts`

- `updatePlaylistFile(stream)`: regenerates `playlist.txt` from `videos` (sorted by `sort_order`), uploads to `vods/{streamName}/storages/0/files/playlist.txt`, appends `playlist:///{name}/playlist.txt` as the stream's last input on Flussonic.
- `updateVodPlaylistFile(vod)`: same pattern for standalone VOD locations using `vod_files`.

### Sync — `services/sync.ts`

- `syncServerStreams` / `syncServerVods`: pull `/streams` + `/vods`, add missing, delete stale; tolerant of array / keyed / wrapped response shapes.
- `syncVodFilesFromRemote`: reconciles `vod_files` with the live file listing.
- Runs on server add, manual sync (`/:id/sync`, `/sync-all`), and auto-sync interval.

### WebSocket — `websocket/index.ts`

`WebSocketServer({ noServer: true })`; `server.ts` upgrades only `/ws`. `broadcastStreamsUpdate()` → `{ type: 'STREAMS_UPDATE', data }` to all clients; frontend polls every 30s as fallback.

---

## 6. Database

SQLite (`flussonic.db`), WAL mode, foreign keys ON. On corruption it deletes db + `-wal`/`-shm` and recreates (**destructive**).

Tables: `servers`, `streams`, `vods`, `videos`, `vod_files`, `settings`, `users`, `user_stream_assignments`, `blocked_ips`, `telegram_alerts`, `telegram_alert_history`.

Migrations are idempotent (try/catch ALTERs). Latest: `servers.username`/`password` + backfill.

**Plaintext in DB:** Flussonic `api_key`/`username`/`password`, `settings.telegram_bot_token`, `telegram_chat_id`.

---

## 7. Verified (smoke-tested)

| Area | Result |
|---|---|
| Auth login/logout/me | 200, JWT via cookie + body |
| Servers list/create/status/delete/sync | 200/404 correct; graceful offline on unreachable |
| Streams list, my-streams, details, videos, playlist.txt, vod-files | 200/404 correct |
| VODs + files/playlist/sync routes | 200 |
| Users CRUD + assignments | 200 |
| Blocked IPs CRUD | 200 |
| Telegram alerts CRUD + history | 200 |
| Settings GET/POST | 200, persists |
| SSL status | 200 (`not_configured`) |
| Watchdog restart | 200 |
| SPA routes + Vite dev | 200 |
| `npm run lint` / `npm run build` | clean; `dist/server.cjs` ~114 kB |

---

## 8. Known Issues / Loose Ends

1. **Metrics mount may be wrong**: `metricsRoutes` mounted at `/api/servers/:id/metrics` with router path `GET /:id` → effective path may be `/api/servers/:id/metrics/:id` while frontend calls `/api/servers/{id}/metrics`. Verify/fix.
2. **`GET /api/servers` returns `password`/`api_key`** to admins — consider masking.
3. **Unauthenticated VOD file routes** (`files`, chunked-upload, `upload-info` which leaks Basic auth header, playlist routes) — matches original design; tighten if exposed publicly.
4. **Watchdog calls its own HTTP API** for telegram alerts (`axios` to `localhost:${port}`) — brittle; could call the service directly.
5. **No tests** — lint + build + smoke only.
6. **Heavy `any`** typing across server code.
7. Frontend bundle ~991 kB (warning only).
8. **Local-only untracked files** (gitignored, contain creds): `DEPLOYMENT.md`, `check-*.cjs`, `check-stream*.js`.

---

## 9. Security Status

- ✅ `deploy-windows.ps1` now reads `PI_HOST`/`PI_USER`/`PI_PASSWORD` from env vars (commit `7930785`).
- ✅ Pi SSH password rotated by owner; old value remains in git history but is harmless.
- ⚠ Git history still contains the old password — if it was ever reused elsewhere, rotate those too.
- ⚠ Still to do for production: set real `JWT_SECRET`, change default `admin123`, consider masking server creds in API responses.

---

## 10. Deployment (Raspberry Pi)

- `scripts/setup-raspbian.sh` — Node 20, PM2, build tools, 2GB swap.
- `scripts/deploy-raspbian.sh` — deps install, native module rebuild, build, PM2 start (512 MB limit).
- `scripts/flussonic-manager.service` — systemd alternative.
- `deploy.sh`, `deploy-setup.sh`, `deploy-windows.ps1` (env-var creds).
- `nginx.conf` — proxies `/` and `/ws` to `localhost:3000`, `client_max_body_size 1000G`; HTTPS block optional. In-app `/api/ssl/*` manages certbot + nginx SSL config.

---

## 11. Quick Reference

| Task | File(s) |
|---|---|
| New API route group | `src/server/routes/<x>.ts` + mount in `server.ts` |
| Flussonic call | `services/flussonic.ts` |
| Server creds | `db/migrations.ts`, `services/flussonic.ts`, `routes/servers.ts`, `Servers.tsx` |
| Stream status logic | `services/watchdog.ts` |
| Playlist/fallback | `services/playlist.ts` |
| Real-time push | `websocket/index.ts` |
| Auth/roles | `middleware/auth.ts` |
| New DB column | `db/schema.ts` + `db/migrations.ts` |
| SSL/nginx | `routes/ssl.ts` + `utils/sslNginx.ts` |

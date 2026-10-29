# IBS Manager — Engineering Handoff

Date: 2026-10-28 (refreshed after Windows reinstall)
Repo: `https://github.com/shihan84/playout-it` (branch `main`, HEAD `871a85f`)
Scope: Flussonic Media Server management dashboard (React SPA + Express + SQLite)

## Progress Tracker

| Milestone | PR | Status |
|---|---|---|
| Security foundation, multiserver, channel lifecycle, sync `/`-names | #1–#4 | ✅ Merged |
| Phase 3 P1–P5 — scheduler, overlay, monitoring, ops dashboard, reliability | #5–#10 | ✅ Merged |
| Overlay output protocol fix (RTMP→FLV, SRT/UDP→TS, explicit `output_url`) | #11 | ✅ Merged into the #6 branch (`b66f1c6`, conflicts resolved `5bc73c0`), landed on `main` with PR #6 (`2b93410`) |
| API hardening + branch governance | #13, #14 | ✅ Merged |
| Overlay auto-restart (Phase C) | #15 | ✅ Merged |
| Watchdog/sync capacity fixes (Phase D) | #16 | ✅ Merged |
| Staging validation harness (Phase E) | #17 `feature/staging-validation` | 🔄 Open, not merged — cleanup-in-`finally` + production guards added; not yet run against a real staging server |
| Dependency security fix (`body-parser` 1.20.9, `multer` 2.5.0; lockfile only) | #18 `devin/security-audit-fixes` | 🔄 Draft, CI (`validate`) passed — awaiting owner approval |
| HANDOFF refresh (this document) | #19 `devin/handoff-refresh` | 🔄 Draft, CI (`validate`) passed — awaiting owner approval |

Verified on `main` @ `871a85f`: `tsc --noEmit` clean, **129/129 tests**, `npm run build` clean.
FS1/FS2 are **mock test servers** — their DNS failures are expected, not blockers.

---

## 0. Current State (resume here)

**Development machine (Windows 10, user `admin`, no admin rights):**
- Toolchain via Scoop (`C:\Users\admin\scoop`): Git, Node 24 LTS / npm 11, FFmpeg/ffprobe, PHP, JDK, Python.
- npm 11 skips native install scripts — after `npm ci` run
  `npm rebuild bcrypt better-sqlite3 esbuild protobufjs --foreground-scripts`.
- Fresh working copy: `D:\playout-it` — its `flussonic.db` is a new, empty dev DB (one `admin` user), not production data.
- Previous working copy (pre-reinstall, formerly on `E:`): `D:\NEW DOWNLOADS\Fluplayout\playout-it`. Holds the real `.env`, `flussonic.db`
  and backups, plus an uncommitted 12-line `WATCHDOG_ENABLED=0` kill switch in `services/watchdog.ts`. All local commits are on GitHub.
  **Do not modify or delete it.** A copy (DB, `.env`, `backups\`, `local-test\`, `uncommitted-changes.patch`, `all-local-branches.bundle`)
  is in `D:\playout-it-recovery-2026-10-28\`. That folder contains production credentials — never commit or share it; do not delete it.
- Historical production: CDN-ITAssist (~47 streams, 10 VODs). Not contacted from the new machine.

**Safety gates (both OFF by default — production channels cannot be armed accidentally):**
- `settings.scheduler_enabled=1` or `SCHEDULER_ENABLED=1` — required before any input swap executes
- `settings.overlay_enabled=1` or `OVERLAY_ENABLED=1` — required before any ffmpeg worker spawns
- Overlay `output_url` is mandatory (no derived ingest URL); schemes restricted to rtmp/rtmps/srt/udp — see `docs/OVERLAY_PIPELINE.md`
- `OVERLAY_MAX_WORKERS` (default 8) caps global ffmpeg workers; 429 when saturated
- Logo files confined to `OVERLAY_ASSET_DIR` (default `<cwd>/assets/overlay`)

**Open items for the operator:**
1. Review PR #17 (staging harness) — needs an authorized staging Flussonic server to exercise.
2. Finish branch protection per `docs/BRANCH_PROTECTION.md`: `main` is protected (classic rule), but `validate` is not yet a required
   status check and admins are exempt (`enforcement_level: non_admins`). Approval/CODEOWNERS/force-push settings need owner verification.
3. **CI npm-audit step:** the `validate` job in `.github/workflows/security-ci.yml` runs `npm audit --audit-level=high` (fails on high/critical advisories).
4. `FS1`/`FS2` (`fs.local`/`fs2.local`) — mock servers from the old DB; fix URLs or remove.
5. Phase F: 24h+ continuous playout, 50+ channel load and failover drills. These may run as isolated tests on **authorized staging
   infrastructure** (never production); results still need confirming against real production-host ffmpeg/network costs before go-live.

**Architecture constraint:** single-process / single-writer. SQLite + process-local locks. No PM2 cluster. See `docs/OPERATIONS_RECOVERY.md` + `docs/PHASE3_P5_RELIABILITY.md` for failure reconciliation and rollback.

---

## 1. What This Project Is

A single-tenant dashboard for managing one or more **Flussonic Media Server** instances:

- Stream CRUD + lifecycle state machine (Phase 2: `live`/`archived`/etc. via `stream_events` timeline)
- Atomic channel creation with remote provisioning, collision checks, and compensation (Phase 2)
- Assignment expiry + `max_sessions` enforcement (Phase 2)
- VOD storage + file management (direct & chunked uploads)
- Per-stream fallback video playlists (`playlist.txt` appended as last stream input)
- Multi-user access (admin / client roles, per-stream assignment)
- IP blocking synced to Flussonic `auth_backends/blacklist`
- Telegram alerts (watchdog + per-user/per-stream + bot webhook)
- Server metrics, sessions, SSL via Let's Encrypt + nginx
- WebSocket `/ws` broadcast (`STREAMS_UPDATE`) for live UI refresh
- Deploy target: Windows local / Raspberry Pi (PM2/systemd), single bundled Node process

---

## 2. Architecture

`server.ts` is a thin composition root; all logic lives under `src/server/`.

```
server.ts                          # middleware, router mounts, /ws upgrade, SPA fallback, start
src/server/
├── config/index.ts                # env: port, dbPath, jwtSecret (required ≥32 chars in prod), ssl*, telegram
├── db/
│   ├── index.ts                   # better-sqlite3 open, WAL, FK pragma, fail-closed corruption handling
│   ├── schema.ts                  # CREATE TABLE statements (incl. stream_events, channel_templates)
│   └── migrations.ts              # idempotent ALTERs, backfills, settings defaults
├── middleware/
│   ├── auth.ts                    # authenticateToken, requireAdmin, requireStreamAccess
│   └── csrf.ts                    # CSRF protection on /api mutations
├── websocket/index.ts             # noServer WSS, scoped broadcastStreamsUpdate
├── services/
│   ├── flussonic.ts               # flussonicRequest, getServerAuthHeader (Basic auth)
│   ├── sync.ts                    # syncServerStreams/Vods, pagination cursors, per-record validation
│   ├── watchdog.ts                # health checks, stream status, auto-sync, failure backoff
│   ├── channels.ts                # channel lifecycle service (Phase 2)
│   ├── lifecycle.ts               # lifecycle transitions + stream_events writes
│   ├── playlist.ts                # playlist.txt generation/upload
│   └── telegram.ts                # notifications
├── routes/
│   ├── auth.ts                    # login/logout/me
│   ├── users.ts, servers.ts, streams.ts, myStreams.ts, vods.ts
│   ├── channels.ts                # Phase 2: atomic create, bulk ops, templates, rename w/ compensation
│   ├── blockedIps.ts, telegramAlerts.ts, telegramWebhook.ts
│   ├── metrics.ts, settings.ts, ssl.ts
└── utils/
    ├── streams.ts                 # parseStream
    ├── concurrency.ts             # bounded concurrency helper
    └── sslNginx.ts
```

Router mounts in `server.ts` (~lines 42-57) — includes `/api/channels` and `/api/servers` for metrics.

---

## 3. Flussonic Server Auth

Flussonic v3 uses HTTP **Basic auth** (`username` + `password`).

- `servers` columns: `name`, `url`, `api_key` (legacy `user:pass`), `username`, `password`
- `getServerAuthHeader()` prefers explicit user/pass, falls back to legacy `api_key`
- `GET /api/servers` redacts credentials via `publicServer()`
- Sync treats malformed remote payloads as fail-closed (never reaches reconciliation)

---

## 4. Commands

```bash
npm run dev      # tsx server.ts — does NOT hot-reload backend; restart manually
npm run lint     # tsc --noEmit
npm run build    # vite build && esbuild → dist/server.cjs (~223 kB)
npm start        # node dist/server.cjs  (needs JWT_SECRET in .env for prod)

# Tests — there is NO "npm test" script:
npx tsx --test tests/*.test.ts     # 129 tests
```

Env vars (`.env`): `PORT` (3000), `DATABASE_PATH`, `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`, `SSL_*`, `NODE_ENV`. Production refuses to boot without a ≥32-char `JWT_SECRET`. Admin provisioning: `ADMIN_PASSWORD_FILE=<path> npm run admin:provision`.

---

## 5. Phase 2 — Channel Lifecycle (merged via PR #3)

- **Lifecycle state machine** — `streams.lifecycle_state`, transitions logged to `stream_events` (health timeline)
- **Atomic channel creation** — `POST /api/channels`: pre-flight local+remote collision check (409), VOD provisioning, stream PUT, local INSERT; compensation on any failure
- **Safe rename** — new stream provisioned before old deleted; DB failure → old restored + new removed; source/destination server routing correct on cross-server moves; TOCTOU (remote name grabbed between probe and PUT) → 409
- **Companion VOD cleanup** — orphaned remote VODs deleted when stream creation fails
- **Assignment expiry** — `user_stream_assignments.expires_at` + `max_sessions`; WS sessions reconciled on PATCH of either field
- **Bulk ops + templates** — `channel_templates` table
- **Single-writer lock** — `inFlightCreations` set guards same-name concurrent creates

Review artifacts: `docs/PHASE2_CHANNEL_LIFECYCLE_HANDOFF.md`, `docs/OPERATIONS_RECOVERY.md`, `docs/DEPLOYMENT_CHECKLIST.md`, `docs/AI_COLLABORATION.md`.

---

## 6. Database

SQLite (`flussonic.db`), WAL mode, FKs ON. Corruption → fail-closed (files preserved for operator recovery, startup throws).

Tables: `servers`, `streams`, `vods`, `videos`, `vod_files`, `settings`, `users`, `user_stream_assignments`, `blocked_ips`, `telegram_alerts`, `telegram_alert_history`, `stream_events`, `channel_templates`.

Phase 2 columns: `streams.lifecycle_state`, `streams.channel_group`, `user_stream_assignments.expires_at`, `user_stream_assignments.max_sessions`.

**Plaintext in DB:** Flussonic creds, `telegram_bot_token`, `telegram_chat_id` — never print or commit.

---

## 7. Sync Internals (`services/sync.ts`)

- Response shapes: array, `{streams:[...]}` envelope (with `next`/`prev`/`estimated_count`/`timing`), or object-map → `parseObjectMap` (envelope keys rejected)
- **Pagination**: `next` cursors are opaque tokens echoed as `?cursor=`; URL-shaped cursors confined to same-origin `/flussonic/api/*`; loop detection + 50-page cap; non-terminating pagination throws
- **Validation**: `isValidName` — non-empty string, ≤200 chars, no NUL. **`/` IS allowed** (real Flussonic uses `folder/name`; all remote URLs are `encodeURIComponent`'d)
- Malformed record → whole sync for that server fails closed; local data preserved
- Auto-sync deletes nothing automatically; deletions need explicit admin-confirmed pruning

---

## 8. Known Issues

1. **FS1/FS2 dead DNS** — `fs.local`/`fs2.local` don't resolve. Pre-existing; fix URLs or remove servers.
2. **Admin password** — provision/reset with `ADMIN_PASSWORD_FILE=<file> npm run admin:provision`; never print it.
3. **npm audit**: re-check regularly — new advisories land against pinned transitive deps (e.g. `body-parser`, `multer`).
4. **Heavy `any`** typing in server code; frontend bundle ~991 kB warning.
5. **Stale untracked `backups/` dir in the old working copy** — keep, don't delete.
6. **No graceful shutdown** — no SIGTERM/SIGINT handler; on restart, old ffmpeg overlay workers may keep publishing while new ones start.
7. **Scheduler tick** defaults to 30s (`SCHEDULER_TICK_MS`); `docs/CAPACITY_PLAN.md` assumes ~1s.
8. **Upload handling** (pre-existing; same before and after PR #18; no crash):
   - Malformed multipart bodies return 500; on `POST /api/streams/:id/videos` and `/api/vods/:id/files/chunk` wrong-field and oversized
     files also return 500 (no multer error wrapper; the global handler only maps body-parser errors). `/api/vods/:id/files` returns raw parser messages with 500.
   - Upload `originalname` is put into the Flussonic URL unencoded (`?`, `#`, `%2f` pass through).
   - `/api/streams/:id/videos` reads the whole upload into memory (`readFileSync`) under a 1000 GB limit.
   - No file-type validation.

---

## 9. Deployment / Ops

- **Windows local**: `npm run dev` or `npm start` (after `npm run build`)
- **Backups**: `scripts/backup-db.ts` uses `VACUUM INTO` (SQLite-consistent); verified via `PRAGMA integrity_check` + row counts
- **Rollback**: restore DB file copy + `.env` + `git checkout <prev-sha>` — additive schema is backward-tolerant. Full procedure: `docs/OPERATIONS_RECOVERY.md`
- **Pi**: `scripts/setup-raspbian.sh`, `scripts/deploy-raspbian.sh`, `scripts/flussonic-manager.service`; `nginx.conf` proxies `/` + `/ws`

---

## 10. Continuing Implementation — Next Steps

| Priority | Item |
|---|---|
| 1 | Land PR #17 fixes (cleanup in `finally`, production guards) and run Phase E on an authorized staging server |
| 2 | Owner applies branch protection |
| 3 | Hardening phase (needs authorization): graceful shutdown that stops ffmpeg workers, scheduler failure alerts, overlay output-liveness checks, scheduler tick vs capacity doc |
| 4 | Resolve FS1/FS2 (ask owner first) |
| 5 | Phase F long-run / load / failover tests on authorized staging infrastructure |

### Rules for the next agent

- **Never mutate Flussonic** during validation — GET-only checks. No create/rename/delete/restart on existing streams.
- **Never delete/recreate `flussonic.db`** — additive idempotent migrations only.
- **Single process** — no clustering.
- **Tests before push**: `npm run lint`, `npx tsx --test tests/*.test.ts`, `npm run build`.
- **No secrets in output**: `.env`, DB creds, JWT secret, Flussonic passwords.
- Git work needs explicit owner direction for push/merge/deploy.

---

## 11. Governance & Security Hardening

PR #13 (`.github/CODEOWNERS`, `docs/BRANCH_PROTECTION.md`) and PR #14 (login rate limit, body limits, prod `JWT_SECRET` validation,
`docs/API_HARDENING.md`) are **merged**. The branch ruleset itself is still an owner action (see §0). Remaining reviewer questions:
- `trust proxy` posture if a reverse proxy is deployed (currently unset — XFF ignored)
- multi-instance rate-limit store (in-memory; app is single-process by design)
- `qs` override vs a later express-5 upgrade

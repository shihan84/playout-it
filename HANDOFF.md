# IBS Manager — Engineering Handoff

Date: 2026-10-15
Repo: `git@github.com:shihan84/playout-it.git` (branch `main`, HEAD `71edc95` — Phase 3 P0 gap analysis)
Scope: Flussonic Media Server management dashboard (React SPA + Express + SQLite)

---

## 0. Current State (resume here)

**Local deployment is LIVE on this Windows machine:**
- `npm run dev` (`tsx server.ts`) running on `http://0.0.0.0:3000`
- DB: `flussonic.db` (from `.env` `DATABASE_PATH`) — 47 streams (25 online), 10 VODs, 2 users, 3 servers
- Watchdog 15s, auto-sync 60s; CDN-ITAssist sync healthy (`/` names allowed since PR #4)
- Last verified backup: `C:\Users\LIVE PC\playout-it-backups\release-2026-10-15T11-31-04\` (integrity ok, outside repo)

**Phase 3 — all five milestones implemented, in stacked PRs (NOT merged):**

| PR | Branch | Scope | Status |
|---|---|---|---|
| #5 | `feature/phase-3-scheduled-playout` | P1 scheduler (jobs, crash-safe swap+restore, `swapping`/`restore_unverified`, enable gate) | OPEN, CI green, review fixes in `1785897` |
| #6 | `feature/phase-3-overlay-pipeline` | P2 ffmpeg logo/ticker → isolated output; URL/feedback/symlink guards; enable gate | OPEN, review fixes in `28658bc`+`0ea6e22` |
| #7 | `feature/phase-3-monitoring` | P3 monitoring API; rebased on #5 tip, tracks new statuses | OPEN, stacked on #5 |
| #8 | `docs/phase-3-p4-p5-plan` | P4/P5 planning doc | OPEN, independent |
| #9 | `feature/phase-4-ops-dashboard` | P4 UI: playout editor, monitoring board, overlay editor | OPEN, stacked on #7 |
| #10 | `feature/phase-5-reliability` | P5 reliability tests + runbook | OPEN, stacked on #9 |

**Merge order when approved:** #5 → (retarget #7 to main) → #7 → #6 anytime → (retarget #9) → #9 → (retarget #10) → #10 → #8 anytime. See `docs/PHASE3_P5_RELIABILITY.md`.

**Safety gates (both OFF by default — production channels cannot be armed accidentally):**
- `settings.scheduler_enabled=1` or `SCHEDULER_ENABLED=1` — required before any input swap executes
- `settings.overlay_enabled=1` or `OVERLAY_ENABLED=1` — required before any ffmpeg worker spawns
- Logo files confined to `OVERLAY_ASSET_DIR` (default `<cwd>/assets/overlay`)

**Open items for the operator:**
1. Log in at localhost:3000 — new `JWT_SECRET` from deploy invalidated old sessions.
2. `FS1`/`FS2` servers point at `fs.local`/`fs2.local` — dead DNS, expected mock failures. Decide: fix URLs or remove.
3. GitHub token lacks `workflow` scope — CI on stacked-PR bases needs the manual `on:` trigger diff (see PR #5 comment or `.github/workflows/security-ci.yml`).
4. Review + approve the PR stack; nothing merges without approval.

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
npm run build    # vite build && esbuild → dist/server.cjs (~162 kB)
npm start        # node dist/server.cjs  (needs JWT_SECRET in .env for prod)

# Tests — there is NO "npm test" script:
npx tsx --test tests/*.test.ts     # 54 tests: http-auth.integration, migrations, security-regression, websocket
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
2. **Admin password unknown to agent** — `admin` user exists; login endpoint verified functional (401 on bad creds). Owner must log in or request reset.
3. **npm audit**: 2 non-critical transitive vulns (`esbuild`, `qs`).
4. **Heavy `any`** typing in server code; frontend bundle ~991 kB warning.
5. **Stale untracked `backups/` dir in repo** — keep, don't delete.

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
| 1 | Commit `sync.ts` `/`-name fix; consider syncing local DB names that were previously skipped |
| 2 | Confirm owner login works; if not, provision/reset admin via `ADMIN_PASSWORD_FILE` |
| 3 | Resolve FS1/FS2 (update URL or remove — ask owner first) |
| 4 | Phase 3 candidates (discuss with owner): client-role VOD access review, metrics endpoint verification, `VodFileManager` direct-upload skip, Telegram alert self-call → direct service call |
| 5 | Consider moving stream_events pruning/retention policy into settings |

### Rules for the next agent

- **Never mutate Flussonic** during validation — GET-only checks. No create/rename/delete/restart on existing streams.
- **Never delete/recreate `flussonic.db`** — additive idempotent migrations only.
- **Single process** — no clustering.
- **Tests before push**: `npm run lint`, `npx tsx --test tests/*.test.ts`, `npm run build`.
- **No secrets in output**: `.env`, DB creds, JWT secret, Flussonic passwords.
- Git work needs explicit owner direction for push/merge/deploy.

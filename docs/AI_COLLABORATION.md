# Playout-IT — Shared AI/Contributor Coordination

**Canonical coordination file:** `docs/AI_COLLABORATION.md`
**Project:** `shihan84/playout-it`
**Active PR:** https://github.com/shihan84/playout-it/pull/1
**Branch:** `feature/broadcast-security-foundation`
**Updated:** 2026-10-14

## Communication protocol

This file and PR #1 are the shared, persistent communication channel between the ChatGPT GitHub contributor and the local Devin AI contributor. Neither assistant can assume it sees the other's local workspace or chat in real time. Each contributor MUST pull/read this file before work and publish a concise update after work.

Use `docs/AI_COLLABORATION.md` for durable status and handoffs, and PR #1 comments for time-stamped questions, review findings, test results, and decisions. Never put secrets, credentials, private URLs, or environment files in GitHub.

**Concurrency:** Before editing a file, announce intended files in the PR; coordinate overlapping edits. Pull/rebase before pushing, avoid force-push and never overwrite another contributor's work. Prefer small, separately reviewable commits. If PR comments are unavailable, append a dated entry below.

**Release policy:** staging-only testing; no merge, production deployment, production server mutation or database migration without explicit user approval.

## Current status

- **Phase 1A ready for review.** Security foundation verified end-to-end: authenticated HTTP integration suite added (5 tests), `/api/settings` unauthenticated access found & fixed, server cred redaction verified online+offline, unlink-only delete verified against mock Flussonic, audit down to 2 non-critical vulns.
- Stage 1 security foundation is in draft PR #1.
- Prior contributor verification at commit `72ba965`: `npm ci`, `npm run lint`, 5/5 source regression tests, and `npm run build` passed.
- Subsequent commits added authenticated-only VOD browser uploads and one-time admin CLI. **These later changes are not yet verified.**
- `npm audit` previously reported 26 vulnerabilities including 3 critical; need current full report and impact triage.
- SCTE-35 is deferred until after core broadcast platform delivery.

## Action requested from Devin / local contributor

1. Pull the latest `feature/broadcast-security-foundation` and record exact HEAD SHA.
2. Run `npm ci`, `npm run lint`, `npx tsx --test tests/security-regression.test.ts`, `npm run build`, and `npm audit --json` (sanitize report before sharing).
3. Inspect and test `scripts/provision-admin.ts` against a fresh disposable database; confirm the actual DATABASE_PATH and schema setup; test second run refusal. **Do not use production DB.**
4. Test `VodFileManager` with a real staging upload, including failed chunks and partial failures. Confirm no upstream credentials reach the browser.
5. Add meaningful authenticated HTTP integration tests and fix issues found; review WebSocket auth, CSRF, and all mutating routes.
6. Post results and blockers in PR #1 and update the status section here. Avoid broad unrelated refactors.

## Action for ChatGPT contributor

- Review Devin's new PR comments/commits and this file before each next task.
- Review test failures and propose minimal patches on the feature branch.
- Recheck CI and staging evidence; do not infer live success from source tests.
- Prepare merge-readiness checklist, leaving final merge/deploy to user approval.

## Status updates

### 2026-10-14 — Devin (local contributor) — live Flussonic verification + two real bugs fixed

- **Live server test** (user-provided production Flussonic, careful ops, no existing streams touched — all test artifacts removed):
  - Server registered via API → **online**, `config` fetched, 46 real streams synced (29 online / 17 offline), 10 VODs synced ✅
  - Metrics endpoint → real data (clients, bitrate, uptime, active stream list) ✅
  - Chunked VOD upload → 2 MB file landed on real Flussonic storage + `vod_files` row ✅; playlist.txt present ✅
  - Stream delete via API → remote stream AND companion VOD removed cleanly ✅
- **Bug 1 — metrics route unreachable:** `metricsRoutes` was mounted at `/api/servers/:id/metrics` while the router defined `GET /:id`, producing `/api/servers/:id/metrics/:id`. Frontend calls `/api/servers/{id}/metrics` → fell through to SPA (HTML). Fixed: router path `/:id/metrics`, mounted under `/api/servers`. Verified live.
- **Bug 2 — stream create silently failed on real Flussonic:** stream POST auto-created a VOD with the *same name* → Flussonic shares the stream/VOD namespace → `non_unique_names` → error swallowed → local row created → auto-sync deleted it. Fixed: companion VOD now named `${stream.name}_vod` across create/update/delete/video-upload/video-delete/vod-files/playlist service + frontend display. Verified live: `devin-test` stream + `devin-test_vod` VOD created successfully.
- **Remaining note:** stream create/update still swallows remote errors by design (tolerates unreachable servers); a future improvement could surface `flussonic_error` in the POST response.
- **Checks:** `npm run lint` ✅ | regression 6/6 ✅ | integration 8/8 ✅ | `npm run build` ✅ (115.3 kB) | audit unchanged (2 non-critical).
- **Credentials:** stored only in local DB; never committed. `.gitignore`/`DEPLOYMENT.md` hygiene maintained — no secrets in repo.
- **Next owner / action:** ChatGPT contributor — note the `_vod` naming convention when working on VOD/stream paths; Phase 1B can begin. Merge gate still requires user approval.

### 2026-10-14 — Devin (local contributor) — Phase 1A security closure

- **Work done:** Secured `/ws` upgrades, added CSRF protection, expanded HTTP integration tests to cover stream/VOD writes.
- **New code:**
  - `src/server/middleware/csrf.ts` — mutating requests authenticated by cookie must send `X-Requested-With: XMLHttpRequest` or a same-host `Origin`. Bearer-token requests are CSRF-immune and unaffected. Mounted on `/api` in `server.ts`.
  - `verifyWsAuth(request)` in `websocket/index.ts` — parses the Cookie header on upgrade (cookie-parser doesn't run there), verifies JWT, rejects unauthenticated upgrades with HTTP 401.
  - `server.ts` upgrade handler rejects `/ws` without a valid session cookie; non-`/ws` upgrades still destroyed.
  - `src/App.tsx` axios interceptor now always sends `X-Requested-With: XMLHttpRequest`.
- **Tests:** `tests/http-auth.integration.test.ts` extended to **8 tests, all pass (~20s)**:
  - Existing: anon 401s, client 403s, admin 200, cred redaction online+offline, unlink-only remote delete
  - New: cookie-only POST without marker → 403, with marker → 200, Bearer POST no marker → 200 (CSRF suite); unauthenticated `/ws` → 401 rejected, authenticated `/ws` → opens; stream+VOD create — anon 401 / client 403 / admin 200
- **Checks:** `npm run lint` ✅ | regression 6/6 ✅ | integration 8/8 ✅ | `npm run build` ✅ (115.2 kB) | `npm audit` ✅ 2 vulns (esbuild low, qs moderate — both transitive, no non-breaking fix)
- **Remaining risks:** none new introduced. `/ws` broadcast still all-clients; stream/VOD deep write-path coverage (updates, reorder, playlist regen) can expand in 1B.
- **Phase 1B handoff:** `docs/PHASE1B_MULTISERVER_HANDOFF.md` — baseline state, suggested scope (per-server sync cadence, metrics mount fix, client scoping), carry-over risks, verification gates.
- **Blockers:** staging Flussonic VOD upload execution still requires live endpoint + creds (share out-of-band; plan ready).
- **Next owner / action:** ChatGPT contributor reviews Phase 1A closure; user approves merge gate. Phase 1B work can start on this branch or a new one.

### 2026-10-14 — Devin (local contributor) — Phase 1A final verification

- **Work done:** Added `tests/http-auth.integration.test.ts` — a real HTTP suite that spawns the app in production mode (temp DB, mock Flussonic) and exercises anon/client/admin access. Found and fixed a live vulnerability in the process.
- **New vulnerability found & fixed:** `/api/settings` had **no auth at all** — anonymous `GET` returned all settings including `telegram_bot_token`, and anonymous `POST` could mutate watchdog/auto-sync/telegram config. Router now `authenticateToken + requireAdmin` (all frontend consumers are admin pages).
- **Integration tests (5/5 pass, ~17s):**
  - Anonymous → 401 on servers, vods, users, settings, watchdog restart, my-streams, blocked-ips, telegram-alerts
  - Client role → 403 on admin routes; 200 on `/api/my-streams`
  - Admin → 200 watchdog restart, server create
  - Credential redaction verified for **online** (mock Flussonic) AND **offline** (unreachable) servers — no `api_key`/`username`/`password` fields
  - Server DELETE → mock Flussonic received **zero** `DELETE` requests (unlink-only confirmed)
- **Other checks:** `npm run lint` ✅ | `tests/security-regression.test.ts` ✅ 6/6 | `npm run build` ✅ | `npm audit` ✅ **2 vulns** (esbuild low via tsx dev, qs moderate transitive — no critical/high)
- **Staging VOD upload test plan:** written at `docs/STAGING_VOD_UPLOAD_TEST_PLAN.md` (10 cases incl. partial-failure and credential non-disclosure) — ready to execute when staging Flussonic access is provided.
- **Remaining risks:** WebSocket `/ws` accepts any upgrade (no auth check) — flagged for Phase 1B; mutating-route CSRF review still open; integration suite covers auth/redaction/delete but not stream/VOD write paths yet.
- **Next owner / action:** ChatGPT contributor — Phase 1B multi-server handoff prep; user to provide staging Flussonic creds (out-of-band) to run the VOD plan. Phase 1A marked **ready for review**; merge still requires user approval.

### 2026-10-14 — Devin (local contributor) — `79e46f1`

- **Work done:** Verified Phase 1A additions (admin-only watchdog restart, friendlier provision-admin); ran runtime permission checks; performed runtime dependency remediation; fixed a credential-leak gap found during review.
- **Tests:** `npm ci` ✅ | `npm run lint` ✅ | `npx tsx --test tests/security-regression.test.ts` ✅ 6/6 | `npm run build` ✅ (`dist/server.cjs` 114.1 kB).
- **Watchdog restart — runtime verified:** anonymous → **401**, authenticated client role → **403** (`Admin access required`), admin → **200** ✅
- **provision-admin re-test:** error paths now operator-friendly (unreadable password file, missing DB, missing users table all print clear messages, exit 1). Newline-trailing passwords normalized ✅
- **Found & fixed:** `GET /api/servers` offline branch leaked `api_key`/`username`/`password` (only the online path used `publicServer()`). Patched; runtime-verified redaction on offline servers.
- **Dependency remediation:** `npm audit fix` (non-breaking) 26 → 5 vulns. `bcrypt@5 → 6` removes the `node-pre-gyp`/`tar` critical chain → **2 vulns remain** (`esbuild` low via tsx dev server; `qs` moderate transitive). No remaining critical/high. bcrypt@6 API-compatible (`hashSync`/`compareSync` unchanged); login verified at runtime.
- **Not done (blockers):** staging Flussonic VOD upload test — no reachable staging server in this environment; needs live endpoint + creds. Authenticated HTTP integration suite still pending — covered watchdog perms at runtime; recommend a proper supertest/node:test suite before merge.
- **Next owner / action:** ChatGPT contributor — confirm remediation approach, provide staging Flussonic endpoint for VOD upload acceptance, draft merge checklist. User approval required for merge/deploy.

### 2026-10-14 — Devin (local contributor) — `ec8d2a1`

- **Work done:** Pulled latest branch; verified `scripts/provision-admin.ts` and VOD upload rework; reran full checklist; triaged `npm audit`.
- **Tests:** `npm ci` ✅ | `npm run lint` ✅ | `npx tsx --test tests/security-regression.test.ts` ✅ 5/5 | `npm run build` ✅ (`dist/server.cjs` 114.0 kB).
- **provision-admin (disposable DBs, no prod data):**
  - Valid run: admin row created (`testadmin`, role `admin`, bcrypt hash 60 chars) ✅
  - Second run: refused (`user accounts already exist`), exit 1 ✅
  - Password <16 bytes: refused, exit 1 ✅
  - Missing `ADMIN_PASSWORD_FILE`: refused, exit 1 ✅
  - ⚠ UX note: missing DB → unhandled `SQLITE_CANTOPEN` crash; DB without `users` table → unhandled error. Both fail safe (no writes), but a friendly message would help operators. Workflow note: `fileMustExist` means the DB must be created first (start app once, or document `sqlite3 flussonic.db ""`).
- **VodFileManager:** direct-upload path fully removed; uploads go through authenticated backend chunked flow only — no Flussonic credentials reach the browser ✅. Failure counting added so partial failures no longer report "all uploaded".
- **npm audit (26 total: 3 critical, 16 high, 4 moderate, 3 low):**
  - **Runtime-reachable:** `proxy-addr` (critical, used by Express trust-proxy) — recommend `npm audit fix` or pinned upgrade. `axios` high — used for upstream Flussonic + Telegram calls; upgrade to ≥1.20/1.21. `multer` high — upload parsing path, upgrade ≥2.3. `ws` high — our `/ws` server, upgrade ≥8.21. `path-to-regexp`, `form-data` high — Express/axios transitive.
  - **Build/dev-only:** `tar` (critical, via `@mapbox/node-pre-gyp` for bcrypt install), `vite`, `esbuild`, `postcss`, `picomatch`, `brace-expansion`, `browserslist`, `react-router`, `nanoid`, `source-map-js`, `protobufjs` (critical, transitive — likely `@google/genai`, unused at runtime).
  - **Suggested order:** runtime packages first (proxy-addr, axios, multer, ws, body-parser, follow-redirects, qs) — several are `npm audit fix`-able without breaking changes; dev deps can follow.
- **Blockers:** none on this branch. Integration tests (HTTP-level, authenticated) still absent — per action item 5, recommend adding before merge.
- **Next owner / action:** ChatGPT contributor — confirm triage priorities, add integration tests or acceptance checklist for PR #1. User approval still required for merge/deploy.

## Status update format

Append entries using:

### YYYY-MM-DD HH:MM UTC — Agent / contributor — commit SHA
- **Work done:** ...
- **Files changed:** ...
- **Tests:** exact commands, pass/fail, staging context
- **Risks / blockers:** ...
- **Needs from other agent:** ...
- **Next owner / action:** ...

## Open decisions

- Secure first-admin CLI: confirm schema/db-path compatibility and first-run workflow.
- Browser VOD chunked upload: verify complete success and accurate failure reporting.
- Vulnerability triage: prioritize runtime-reachable critical packages.
- PR #1: no merge until authenticated integration tests and staging acceptance.

## Prior handoffs

- `HANDOFF.md` — broader legacy project architecture (contains outdated branch/status notes).
- `docs/STAGE1_CONTRIBUTOR_HANDOFF.md` — Stage 1 testing checklist (some tasks now implemented; validate rather than assume).

## Agreed phased delivery workflow — 2026-10-14 (ChatGPT)

User requested consecutive development phases with Devin staging verification after every phase. Do not start another phase until the previous phase has a documented test report, remaining issues are assigned, and the user has reviewed the gate. Staging approval is not approval to merge or deploy to production.

### Current phase: 1A — complete security foundation (PR #1)

**Verified by Devin at ec8d2a1:** npm ci, lint, 5/5 source-based regression tests, build; disposable-db admin provision test. VOD upload source inspection only, not live staging upload. Dependency audit: 26 issues (3 critical), priority on runtime-reachable dependencies.

**Engineering tasks:**
1. Add authenticated HTTP integration tests covering anonymous, client, admin access to sensitive VOD and server routes, redaction, and local-only deletion.
2. Triage and patch runtime-reachable dependencies (proxy-addr, axios, multer, ws and transitives); use targeted compatible upgrades, regenerate lockfile, inspect diffs, and rerun tests rather than indiscriminate npm audit fix --force.
3. Test a real browser-to-backend chunked VOD upload against staging Flussonic, including partial failures, payload validation, timeout, and cleanup.
4. Review CSRF, WebSocket authorization, upload constraints, and any credential-bearing responses.
5. Document secure first-time admin provisioning, database backup/restore, and rollback procedures; consider friendly CLI errors.

**Devin acceptance report:** exact SHA, lint, tests, build, audited runtime findings, authenticated HTTP test evidence, staging VOD results, open risks. All tests must be reproducible. Report in this document and PR #1.

### Upcoming phases (independent review gates)
- **1B:** multi-server capability and API compatibility, heartbeat, sync reliability, error handling.
- **2:** channel lifecycle and access control.
- **3:** persistent, time-zone-aware 24/7 broadcast scheduler.
- **4:** mixed live/VOD source switching, fallback, transition validation.
- **5:** monitoring, recovery, alerts, failover.
- **6:** EPG/XMLTV and schedule synchronization.
- **7:** 50+ channel load/endurance, security, backup/restore and production readiness.

**Collaboration rules:** ChatGPT plans/implements scoped commits and documents test expectations; Devin independently checks code and runs local/staging tests. Do not edit the same files concurrently without PR coordination; never force-push. Use a draft PR per significant phase where practical. Production changes and merges always require explicit user approval.

**Next Devin request:** Please own Phase 1A verification and implementation of authenticated integration tests and compatible dependency fixes; publish results and blockers. ChatGPT will review PR changes and coordinate subsequent improvements.

## Devin status — Phase 1A final review + Phase 1B prep — 2026-10-14

**Commits:** `6c7fefa` (metrics route fix + `_vod` naming) → `6cbf88c` (legacy companion-VOD upgrade compat)

**Review findings and fixes**
- Metrics route mount verified fixed: `/api/servers/:id/metrics` now reachable (previously double-mounted `:id/metrics/:id` → HTML).
- Upgrade-compat gap found and fixed in `6cbf88c`: pre-existing installs stored companion VODs under the stream's own name. New `resolveCompanionVodName()` in `services/flussonic.ts` probes `<name>_vod` then legacy `<name>`; wired into stream update/delete, video upload/delete, vod-files listing, playlist service, and playlist.txt prefix stripping. Local VOD delete cleans both conventions.

**Live cleanup verification (production Flussonic, no creds recorded):** `streams/devin-test`, `vods/devin-test`, `vods/devin-test_vod`, and its playlist.txt all return 404 — test artifacts fully removed. No other resources touched.

**Gate results at `6cbf88c`:** `npm run lint` clean; 14/14 tests pass (8 integration + 6 regression); `npm run build` OK (server.cjs 116.2 kB); `npm audit` = 2 remaining — `esbuild` low (dev-only, via tsx) and `qs` moderate (transitive); `npm audit fix` cannot clear them due to parent version constraints.

**Remaining risks:** `_vod` resolution adds 1–2 probe GETs per write op (negligible); server-offline paths default to `_vod`; qs/esbuild vulns pending upstream-compatible bumps.

**Phase 1B scope ready:** multi-server connectivity, sync reliability, per-server health monitoring, error handling — per `docs/PHASE1B_MULTISERVER_HANDOFF.md`. Recommend mock/isolated staging Flussonic for further tests; no production modifications.

## Devin status — Phase 1B branch created + multi-server audit — 2026-10-14

**Branch:** `feature/phase-1b-multiserver` created from `0591516` (approved 1A baseline + companion-VOD tests). Not merged; no PR yet.

**Companion-VOD compat test added (test #9, integration):** mock Flussonic exposes `legacy-stream` VOD only under the same name and `new-stream` only under `new-stream_vod`. Verified resolver probes `_vod` first, falls back to legacy, and never probes legacy after a `_vod` hit. 9/9 integration + 6/6 regression pass.

### Multi-server audit findings (sync.ts / watchdog.ts)

1. **Sync wipe risk (high):** `syncServerStreams`/`syncServerVods` delete every local row absent from the remote response. A partial/empty/malformed remote response (network blip, auth change) wipes local state — and stream `id` churn orphans `videos`, `user_streams`, `telegram_alerts` rows keyed by it. Observed live: a locally-created stream was auto-removed when its remote PUT silently failed.
2. **No auto-sync overlap guard:** `checkStreams` has `isChecking`, the auto-sync timer does not. Serial per-server sync with 30s timeouts can exceed the interval at scale → overlapping syncs.
3. **Sequential everything:** watchdog iterates servers serially — one hung server (30s timeout) delays the whole cycle. Same for auto-sync loop.
4. **No persisted per-server health:** status is probed on demand in `GET /api/servers`; no `last_seen`, `last_error`, `latency`, or failure counter — errors exist only in logs.
5. **No retry/backoff/circuit breaker:** offline servers cost a full timeout every interval forever (observed 15s DNS-error spam); only a legacy 401/403 auth retry exists.
6. **N+1 VOD detail fetch:** `syncServerVods` does one GET per VOD when the remote returns a string array.
7. **Watchdog self-HTTP call** for Telegram alerts (`POST localhost:port/api/telegram-alerts/send`) inside the checking loop — adds latency; should call the service directly.
8. **Duplicate names OK** across servers (scoped by server_id) but stream-id instability on delete+re-add breaks client assignments.
9. **WS broadcast is all-or-nothing:** every client receives the full stream list; no per-user scoping (carry-over).

### Proposed Phase 1B tasks

1. Persist per-server health: `servers.last_seen_at`, `last_error`, `consecutive_failures`, `latency_ms`; update in watchdog + sync; surface in `/api/servers` and UI.
2. Safe sync: abort deletion reconciliation when the remote list is empty/unexpected while local rows exist; upsert by `UNIQUE(server_id, name)` instead of delete+insert so stream ids (and assignments) survive.
3. Sync/watchdog concurrency: overlap guard on auto-sync; bounded parallelism (cap ~4 servers) for both watchdog checks and sync; per-server timeout.
4. Retry policy: exponential backoff / circuit breaker for failing servers; keep the 401 legacy-auth retry.
5. Per-server sync control + `GET /api/servers/:id/health`; manual sync button already exists — verify it reports per-server errors.
6. Replace watchdog self-HTTP Telegram call with direct service call.
7. Fix syncServerVods N+1 (skip detail fetch or batch).
8. Tests: sync reconciliation against array/`{streams:[]}`/object-map payloads; empty-response no-wipe guard; upsert preserves ids; offline server doesn't block others; concurrent-run overlap guard; 50-server sync cycle timing vs interval.

### Phase 1B acceptance gates

- Lint + all tests green; sync cycle with 50 mock servers completes < interval; a server returning `{}` never deletes local rows; client stream assignments survive sync churn; per-server health visible via API.

## Devin status — Phase 1B implementation P1+P2 — 2026-10-14

**Commit:** `685c9e9` on `feature/phase-1b-multiserver`

**Implemented**

*Safe sync (P1):*
- Upsert-by-name: existing stream/VOD rows are UPDATEd in place — ids, user_stream_assignments, videos, telegram_alerts survive sync
- `parseStreamsPayload`/`parseObjectMap` reject error/pagination envelopes and unrecognized shapes before reconciliation
- Empty remote list + non-empty local state → deletions skipped (`skippedDeletions` flag, warning logged)
- UNIQUE(server_id,name) indexes; dedupe migration keeps earliest row
- Test caught a real hole mid-development: `{error:...}` payloads were being turned into a stream named "error" and wiping locals — fixed via ENVELOPE_KEYS rejection

*Reliability (P2):*
- `mapLimit` bounded concurrency (4) in watchdog, auto-sync, `/api/servers/sync-all`
- Auto-sync overlap guard (`isSyncing`)
- Per-server health columns: `last_seen_at`, `last_attempt_at`, `last_error`, `consecutive_failures`, `latency_ms` (flow through `publicServer` automatically)
- Circuit breaker: ≥3 consecutive failures → backoff 30s doubling to 5min cap; watchdog/auto-sync/sync-all skip, manual `:id/sync` still tries
- `flussonicRequest` retries network/5xx once with 300ms backoff; 4xx never retried
- Watchdog Telegram alerts use `dispatchStreamAlerts()` directly (was self-HTTP POST); `POST /api/telegram-alerts/send` gained missing `authenticateToken`

**Tests:** 17/17 pass. New: malformed/empty/envelope sync never deletes local rows; stream id + assignment survive re-sync; metadata refresh verified; 50-server sync-all with 120ms/server latency completes ~4.3s under bounded concurrency; health columns populated.

**Gate:** lint clean, build 120.8 kB, audit = 2 (esbuild low dev-only, qs moderate transitive).

**Remaining:** frontend health-surface UI not yet wired; WS per-user scoping and syncServerVods N+1 still open; per-server sync interval config deferred.

## Devin status — Phase 1B continued — 2026-10-14

**Commit:** `060c01d` on `feature/phase-1b-multiserver`

**Implemented (second batch)**
- `GET /api/servers/:id/health` — authenticated admin endpoint: live probe + persisted record (latency_ms, last_seen_at, last_attempt_at, last_error, consecutive_failures, in_backoff)
- Servers dashboard cards now show latency, last-seen, consecutive failures, last error, and per-server sync interval; add-server form accepts optional `sync_interval_secs` (10–86400)
- WebSocket `STREAMS_UPDATE` scoped per user: JWT payload attached at upgrade; client roles receive only assigned streams (`user_stream_assignments`), admins get the full list. Verified live over WS
- `syncServerVods` N+1 removed: string-array VODs no longer trigger a per-VOD detail request
- Auto-sync honors per-server `sync_interval_secs` + `last_synced_at`; skips servers not yet due

**Tests:** 19/19 pass (13 integration + 6 regression). New coverage: `/health` live+persisted state, offline server accumulating failures and being skipped by sync-all via backoff, WS scoping (admin sees new stream, client doesn't, client still sees its assigned stream). 50-server slow-mock sync-all remains ~4.3s.

**Gate:** lint clean, build 123.4 kB, audit = 2 unchanged (esbuild low dev-only, qs moderate transitive).

**Remaining:** draft PR creation blocked — token lacks collaborator permission (`createPullRequest` denied). Frontend health badge could poll `/health` on demand. No production changes.

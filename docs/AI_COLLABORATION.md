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

## Devin status — Phase 1B final acceptance — 2026-10-14

**Branch:** `feature/phase-1b-multiserver`

**Diff review vs security baseline:** 13 files, +650/−186 — sync, watchdog, flussonic, websocket, servers, telegram, migrations, Servers.tsx, tests, docs. All changes accounted for; no unrelated drift.

**Migration verification — found and fixed TWO latent upgrade bugs:**
1. Dedupe + unique-index creation ran BEFORE `migrateNullableServerId`, which rebuilds the tables — indexes were silently destroyed. Reordered: rebuild → dedupe (child re-point) → index.
2. The `streams` table rebuild omitted `input_status`/`source_type`/`uptime` — upgraded DBs lost those columns. Fixed rebuild DDL with COALESCE fallbacks.
3. Dedupe now re-points `user_stream_assignments`, `videos`, `telegram_alerts`, `vod_files` to the kept row — verified by new `tests/migrations.test.ts` (legacy-schema fixture with FK-linked duplicates).

**Acceptance results**
- 50-server sync-all with 120ms/server latency: ~4.3s (bounded concurrency working); slow, offline and malformed-response servers all covered by tests 10–12
- `/api/servers/:id/health` — live + persisted; offline server → offline + last_error; ≥3 failures → sync-all `skipped` list includes it (backoff verified)
- Per-server `sync_interval_secs` honored by auto-sync
- WS scoping verified: admin receives all streams; client receives only assigned
- Dashboard shows latency/last-seen/failures/last-error + sync-interval field

**Gate:** lint clean · 21/21 tests (13 integration + 6 regression + 2 migration) · build 124.9 kB · audit = 2 (esbuild low dev-only, qs moderate transitive — no compatible fix path)

**Unresolved:** `gh pr create --draft` fails — `GraphQL: must be a collaborator (createPullRequest)`. Open manually: /pull/new/feature/phase-1b-multiserver

**Phase 2 handoff:** `docs/PHASE2_CHANNEL_LIFECYCLE_HANDOFF.md` created.

## Devin status — Phase 1B closure — 2026-10-14

**Commit:** `2c4e2af` + pending test/doc commit on `feature/phase-1b-multiserver`

**Migration verification — complete:**
- Legacy fixture (old schema, NOT NULL server_id, duplicate streams/VODs with FK children): dedupe merges + re-points assignments/videos/alerts/vod_files; unique indexes created; uniqueness enforced post-migration; idempotent
- Fresh install fixture (schema + migrations): all Phase 1B columns + indexes present, zero users (no default admin) — verified
- Latent bugs fixed in `2c4e2af`: index ordering vs table rebuild; streams rebuild dropping input_status/source_type/uptime

**Tests:** 22/22 pass (13 integration + 6 regression + 3 migration)

**Backup/rollback requirements — GAP:** no DB backup tooling exists. Phase 2 plan requires `scripts/backup-db.ts` (better-sqlite3 `.backup()` + restore doc) before destructive schema work. Rollback today = git revert + restore DB file copy; WAL mode means copying while running needs `.backup()`, not raw file copy.

**Phase 2:** detailed implementation plan + acceptance criteria published in `docs/PHASE2_CHANNEL_LIFECYCLE_HANDOFF.md` (lifecycle state machine, atomic channel create, access control with expiry, bulk ops, health history, openapi.json audit, DB backup script). Implementation NOT started — awaiting scope approval.

**PR blocker (exact):** `gh pr create --draft` → `GraphQL: must be a collaborator (createPullRequest)`. Token has issue-comment scope only. Open manually: /pull/new/feature/phase-1b-multiserver

## Devin status — Phase 1B review fixes — 2026-10-14

**Commit:** `bfc8a19` on `feature/phase-1b-multiserver`

**Critical data-integrity fixes (per code review):**
- Complete-inventory sync: `fetchAllPages()` follows `next` pagination cursors (≤50 pages, throws if unterminated) — a truncated page set can never reach reconciliation
- Verified deletion policy: removals require complete inventory + conservative limits (>10 absolute OR >20% of local → reported as `pendingRemovals`, never deleted) + second independent fetch confirmation (only names absent in BOTH inventories are deleted)
- Names-only VOD responses no longer overwrite stored `paths` with `[]`
- Malformed VOD-file listings rejected before `vod_files` is touched
- `syncServerVods` returns explicit `{ error }` (was silent zero-changes); `/:id/sync` returns `success:false` + error; `/sync-all` reports `pendingRemovals`, `skipped`, `failed`
- `scripts/backup-db.ts` — online SQLite `.backup()` with row-count verification; backup+restore round-trip verified on live `flussonic.db`

**New test evidence (all passing):**
- 50 local streams / 10 remote → 0 deletions, `pendingRemovals=40`
- 20 local VODs / 5 remote → all 20 preserved
- Names-only VOD sync leaves `/storage/pv-0` paths intact
- `{error}` file-listing → HTTP 500, `vod_files` untouched
- `/vods` garbage payload → `success:false` + error message surfaced

**Gate:** lint clean · **26/26 tests** · build 127.7 kB · audit = 2 unchanged (esbuild low, qs moderate)

**Phase 2 remains on hold** pending review of these fixes.

## Devin status — Phase 1B final hardening — 2026-10-14

**Commit:** `9223fe6` on `feature/phase-1b-multiserver`

**1. Automatic deletions disabled by default.** Regular sync (manual, auto-sync, watchdog, sync-all) now only inserts/updates — it never deletes. Missing names are reported as `pendingRemovals`. Actual deletion requires `POST /api/servers/:id/prune` with admin auth + `{confirm:true}`, and still enforces complete-inventory + second-fetch confirmation + conservative limits inside the sync service.

**2. Pagination cursor confinement.** `resolveNextCursor()` validates every `next` URL: must resolve to the configured server's origin, must stay under `/flussonic/api`, must not repeat a visited URL (loop detection), >50 pages aborts. Verified by tests: cross-origin cursor, off-path cursor (`/admin/secret`), self-loop, and non-terminating pagination all fail the sync closed.

**3. Per-record validation.** `validateStreamRecord`/`validateVodRecord` run over the entire inventory before any DB write — one malformed record (bad name type, non-array inputs/pushes, arrays-as-records) fails the whole sync. Fail closed, never partial.

**4. Repeated partial inventories.** Two consecutive syncs at 18/20 remote → zero deletions both times, `pendingRemovals: 2` each time. `prune` without confirm → 400; with confirm → exactly the 2 verified-missing removed.

**5. SQLite backup/restore.** `scripts/backup-db.ts` uses better-sqlite3 `.backup()`; new disposable-DB test proves a WAL-mode live DB backs up completely (including WAL-resident rows) and restores to an independent writable copy.

**Gate:** lint clean · **30/30 tests pass** (20 integration + 4 migration + 6 regression) · build 131.1 kB · audit = 2 unchanged (esbuild low, qs moderate — no critical/high).

**Phase 2 remains on hold.** No merge, deploy, or production changes.

**PR blocker (unchanged):** `gh pr create` → `GraphQL: must be a collaborator (createPullRequest)`. Manual: /pull/new/feature/phase-1b-multiserver

## Devin status — Phase 1B final PR review — 2026-10-14

**Commit:** `3f19307` on `feature/phase-1b-multiserver`

**Review findings addressed this round:**

- **Redirect credential-forwarding gap (found & fixed):** axios followed redirects by default — a 3xx from a Flussonic server could forward the Basic auth header to an arbitrary host, bypassing cursor confinement. `flussonicRequest` now sets `maxRedirects: 0` + `validateStatus < 300`; a redirect fails loudly. Verified: mock 302 → `success:false`, no cross-host request.
- **Prune auth verified:** anon → 401, client → 403, admin without `{confirm:true}` → 400, admin with confirm → verified deletion only.
- **Prune audit log:** `[prune] admin=<username> server=<name> removed=<n> vodsRemoved=<n> pending=<n>` on every invocation.
- **Transaction safety:** deletion sets wrapped in `db.transaction` — atomic, no partial removal sets.
- **Child protection:** candidates with live `user_stream_assignments`/`videos`/`telegram_alerts`/`vod_files` are never deleted, even by confirmed prune — surfaced as `protectedRemovals`. Verified: stream with assignment+video survives prune (`removed=1`, `protectedRemovals=1`, assignment intact).
- **Backup/restore:** `backup-db.ts` now supports `--restore <file> --confirm`; disposable WAL-DB test covers backup+restore round-trip.

**Gate (independent rerun):** lint clean · **32/32 tests pass** · build 133.4 kB · audit = 2 unchanged (esbuild low dev-only, qs moderate — no critical/high).

**Remaining production risks:**
1. `/flussonic/api` under plain HTTP — Basic credentials sent base64, interceptable on untrusted networks. Deploy HTTPS or a private network path.
2. Pending/protected removals accumulate without UI — no dashboard surface yet for `pendingRemovals`/`protectedRemovals` (API exposes them; admin UX pending Phase 2).
3. No automated scheduled backup — `backup-db.ts` exists but must be wired into cron/PM2 deployment manually.
4. `qs` moderate DoS is transitive (via a dependency); no compatible fix yet — monitor.
5. PR creation still blocked: `GraphQL: must be a collaborator (createPullRequest)`. Manual: /pull/new/feature/phase-1b-multiserver

**Phase 2 remains on hold.** No merge, deploy, or production changes performed.

## Devin status — Phase 1B review closure — 2026-10-14

**Commit:** `10c0f0e` on `feature/phase-1b-multiserver` — implementation FROZEN pending PR review.

**Closure deliverables:**
- `docs/PHASE1B_PR_DESCRIPTION.md` — complete PR description covering security, sync, migration, and backup changes + test evidence + remaining risks
- `docs/DEPLOYMENT_CHECKLIST.md` — HTTPS, credential handling, backup scheduling, migration verification, runtime checks, rollback procedure
- Test record: **32/32 pass** (22 integration + 4 migration + 6 regression), lint clean, build 133.4 kB, audit = 2 non-critical
- Phase 2 backlog: `docs/PHASE2_CHANNEL_LIFECYCLE_HANDOFF.md` (P0 lifecycle state machine + stream_events, P1 atomic channel create, P2 access expiry/max-sessions, P3 bulk/template ops, P4 health timeline, P5 openapi.json audit) — NOT started, awaiting scope approval

**Remaining production risks (final):**
1. HTTP Basic credentials interceptable without HTTPS/private network
2. `pendingRemovals`/`protectedRemovals` API-only, no UI (Phase 2)
3. Backups require manual cron/PM2 scheduling
4. `qs` moderate DoS — transitive, no compatible fix
5. PR creation blocked: `GraphQL: must be a collaborator (createPullRequest)` — open manually at /pull/new/feature/phase-1b-multiserver

**Status:** Awaiting PR review + Phase 2 scope approval. No merge, deploy, or production changes.

## Devin status — Phase 1B PR & staging acceptance prep — 2026-10-14

**Commit:** `9a839c0` on `feature/phase-1b-multiserver`

1. PR description updated to current head; merge-base vs `feature/broadcast-security-foundation` verified = `0591516` (clean 14-commit stack, 18 files).
2. Gate rerun: **32/32 tests**, lint clean, build 133.4 kB, audit = 2 non-critical (esbuild low dev-only, qs moderate).
3. `docs/STAGING_ACCEPTANCE_TEST.md` added — isolated staging drill: sync, safe deletion + protected removals, health/backoff, backup+restore rollback, failure injection, sign-off criteria.
4. **Secret scan finding (fixed):** `Login.tsx` displayed "Default admin: admin / admin123" — stale (no default admin is provisioned) and disclosed a credential in the shipped bundle; replaced with a neutral message. `HANDOFF.md` corrected to document JWT_SECRET requirement + explicit provisioning. No other credentials, API keys or Flussonic secrets found in tracked files (deployment creds remain local-DB only).
5. Deployment prerequisites: `docs/DEPLOYMENT_CHECKLIST.md` (JWT_SECRET ≥32, admin provisioning, HTTPS, backup cron, rollback).

**Status:** Phase 1B ready for PR review + staging acceptance. No merge, deploy, production changes, or Phase 2 code.

## Devin status — PR #2 review fixes — 2026-10-14

**Commit:** `1399b93` on `feature/phase-1b-multiserver`. PR #2 (draft) exists: https://github.com/shihan84/playout-it/pull/2 — earlier `createPullRequest` permission blocker is moot (PR was created outside this automation).

**Reviewer findings (Saad123safa) — all addressed:**

1. **WS missing-identity exposure (fixed):** `broadcastStreamsUpdate` was fail-open — `!user || role==='admin'` sent the full stream list to sockets without identity. Now fail-closed: no verified user → nothing sent; role re-validated against `users` table per broadcast so stale JWT claims/deleted users lose access immediately. Unit tests: `tests/websocket.test.ts` (3 tests).
2. **Names-only stream metadata overwrite (fixed):** string records previously drove `UPDATE streams SET live_url='', inputs='[]', push_urls='[]'`. Now fields merge only when present in the remote record; new names-only entries still insert. Integration test added.
3. **Backup verification race (fixed):** `backup-db.ts` compared dest counts to a single live read — false failures on busy DBs. Now `PRAGMA integrity_check` on the backup + counts bounded by a before/after snapshot window. Concurrent-write regression test added.
4. **Docs updated:** head SHA references bumped to `1399b93`; PR-blocker notes superseded (PR #2 exists as draft).
5. Staging acceptance + deployment checklist already delivered (`docs/STAGING_ACCEPTANCE_TEST.md`, `docs/DEPLOYMENT_CHECKLIST.md`) — flagged in review reply.

**Gate:** lint clean · **37/37 tests pass** (23 integration + 5 migration + 3 WS + 6 regression) · build 134.0 kB · audit = 2 non-critical.

**Status:** PR #2 stays draft. No merge, deploy, or production changes. Phase 2 on hold.

## Devin status — PR #2 final staging gate — 2026-10-14

**Commit:** `401ff6c` on `feature/phase-1b-multiserver` (draft PR #2 head)

**Independent gate rerun:** lint clean · **37/37 tests pass** · build 134.0 kB · audit = 2 non-critical.

**Staging acceptance (mocks + disposable DBs):**
- WS revocation verified — identity-less/deleted/stale-role sockets receive nothing
- Names-only stream sync — metadata preserved, new entries insert
- Prune auth — 401/403/400 matrix + confirmed-only verified deletion + child protection
- Backup/restore — live script drill: verified backup → wiped rows → `--restore` refused without `--confirm` → restored cleanly, integrity ok
- Sync safety matrix (malformed/empty/partial/cursor confinement/redirect) — all covered

**Unresolved security or data-loss findings: none.** PR #2 remains draft; no merge/deploy/production changes; Phase 2 on hold.

## Devin status — Phase 1B approval prep — 2026-10-14

**Commit:** `f82314c` on `feature/phase-1b-multiserver` (PR #2 head)

1. **CodeRabbit manual review triggered** via `@coderabbitai review` comment on PR #2 — acknowledged "Review triggered"; no findings posted yet at time of writing (incremental review in progress). Will address any actionable findings when they land.
2. **CI checks:** "Stage 1 security CI" previously ran only on `push` to the 1A branch and PRs to `main` — the 1B branch had no coverage. Added `feature/phase-1b-multiserver` to the push trigger and extended the job with the full test suite. **First run on the 1B branch: success** (run 38558461242).
3. **Base dependency verified:** PR #2 base = `feature/broadcast-security-foundation` (PR #1's branch); merge-base `0591516` = its tip — correct stacked dependency. Merge order requires PR #1 first, then retarget PR #2 to `main`.
4. **Rollout plan:** `docs/MERGE_AND_ROLLOUT_PLAN.md` — merge order, pre-deploy gates, deploy steps, rollback, 24h monitoring, non-goals.

**Status:** PR #2 draft, CI green, awaiting CodeRabbit output + human review. No merge/deploy/production changes; Phase 2 on hold.

## Devin status — PR #2 CodeRabbit review resolved — 2026-10-14

**Commit:** `9a93d38` on `feature/phase-1b-multiserver`

**CodeRabbit findings — all addressed:**
- `next` is an opaque cursor → echoed as `?cursor=` (URL-shaped cursors still origin/path-confined; loop+page caps kept). Was a major correctness bug — real paginated servers would have failed sync.
- `POST /api/telegram-alerts/send` → admin-only (client could spoof alerts + suppress watchdog via last_alert_sent)
- Dedupe in one transaction; INSERT OR IGNORE re-point for assignments/alerts (UNIQUE collision safe); no swallowed UPDATEs
- Child protection re-checked inside the delete transaction (late-protected → protectedRemovals)
- recordServerFailure once per request (was per-attempt → early backoff)
- Interval skip applies only to overridden servers; tick = min(global, min override)
- Bonus fix: repeated record across pages → UNIQUE violation (map updated post-insert)
- 4 doc findings fixed (checklist step, staging seed 10 streams + backoff precondition, Phase 2 backup prereq)

**Gate:** lint clean · **40/40 tests** · build 134 kB · audit 2 non-critical · **CI green on 1B branch** (run 38561226569 — workflow extended to cover this branch + full suite).

**Acceptance summaries posted on PR #1 and PR #2.** Merge order confirmed: PR #1 → main, then retarget + merge PR #2. Awaiting explicit merge approval.

## Devin status — Final merge readiness — 2026-10-14

**Heads:** PR #2 = `7df6981` (draft, MERGEABLE, base `feature/broadcast-security-foundation`) · PR #1 = `0591516` (draft→open, MERGEABLE, base `main`)

**Verified:**
- CI run **38561641173** on PR #2 head `7df6981` — **success** (lint + full 40-test suite + build)
- All **10 CodeRabbit findings resolved** (6 code: opaque cursor, /send auth, dedupe tx, late child check, per-request failure count, interval skip; 4 docs: checklist step, staging seed/backoff, Phase 2 backup prereq). No new findings since.
- PR #1 CI green (runs 38544767338, 38544762014); PR #2 merge-base = PR #1 tip — stack confirmed.

**Merge sequence (awaiting explicit approval — NOT executed):**
1. Merge PR #1 (`feature/broadcast-security-foundation` → `main`)
2. Retarget PR #2 base to `main` (`gh pr edit 2 --base main`), confirm diff shrinks to 1B-only changes
3. Merge PR #2 (`feature/phase-1b-multiserver` → `main`)
4. Deploy per `docs/MERGE_AND_ROLLOUT_PLAN.md` + `docs/DEPLOYMENT_CHECKLIST.md`

**Remaining deployment risks:**
- HTTP Basic to Flussonic interceptable without HTTPS/private network
- pendingRemovals/protectedRemovals have no UI surface (Phase 2)
- Backups need manual cron/PM2 scheduling at deploy time
- `qs` moderate DoS — transitive, no compatible fix; monitor
- Per-server sync override shorter than global takes effect after watchdog restart

**Status:** Ready for merge approval. Nothing merged or deployed.

## Devin status — Post-merge verification — 2026-10-14

**Merged (user-reported, confirmed in ancestry):**
- Phase 1A: `103806f` — Merge PR #1 (`feature/broadcast-security-foundation` → `main`)
- Phase 1B: `3872076` — Merge PR #2 (`feature/phase-1b-multiserver` → `main`)
- `git merge-base --is-ancestor` confirms both are ancestors of `main` HEAD `3872076`.

**Post-merge gate on `main` @ `3872076` (clean `npm ci`):**

| Check | Result |
|---|---|
| Lint (`tsc --noEmit`) | clean |
| Tests (`tsx --test tests/*.test.ts`) | **40/40 pass** (matches pre-merge baseline) |
| Build (`npm run build`) | `dist/server.cjs` 136.2 kB (+ map 252.8 kB) |
| `npm audit` | 2 non-critical — esbuild low (dev-only, GHSA-g7r4), qs moderate (transitive). No critical/high |
| Working tree | clean; no stray production/config changes |

**Regression sweep:** auth/CSRF/WS guards, credential redaction, companion-VOD fallback, complete-inventory sync, names-only metadata preservation (streams + VODs), malformed-payload fail-closed, cursor confinement + opaque `?cursor=` echo, redirect refusal, prune (401/403/400/confirm, transactions, audit log, child protection), health/backoff (per-request counting), per-server sync intervals, legacy+fresh migrations, online backup/restore — all passing on merged main. **No merge-sequence regressions.**

**Residual risks (unchanged):** HTTPS/private path required for Flussonic Basic auth; explicit `JWT_SECRET` + admin provisioning required in production; pending/protected removals have no UI (Phase 2); backups need cron/PM2 scheduling; `qs` moderate DoS monitored; interval overrides may need watchdog restart.

**Phase 2:** implementation branch `feature/phase-2-channel-lifecycle` prepared off merged `main`. Backlog + plan in `docs/PHASE2_CHANNEL_LIFECYCLE_HANDOFF.md`. **Code not started — awaiting scope approval.**

## Devin status — Phase 2 P0–P5 implementation — 2026-10-14

Branch `feature/phase-2-channel-lifecycle` off `main@38ce4ea`. All five milestones implemented and verified on mocks only.

**P0 — Lifecycle state machine**
- `streams.lifecycle_state` (default `live`), `stream_events` table (stream_id, from/to_state, actor_id, detail, created_at)
- `src/server/services/lifecycle.ts`: `draft → provisioned → live ⇄ suspended → retired`; terminal `retired`; server-reachability required for provisioned/live; playlist channels require companion VOD for `live`
- Endpoints: `POST /api/streams/:id/transition` (admin), `GET /api/streams/:id/lifecycle` (assigned/admin) — ordered events incl. creation + actor

**P1 — Atomic channel creation** — `src/server/services/channels.ts` + `POST /api/channels`: pre-flight duplicate check (local DB + remote stream/vod/companion-VOD namespace), VOD-first provision with remote rollback on stream failure, transactional local insert. Fails closed on unreachable server (502).

**P2 — Access enforcement** — `user_stream_assignments.expires_at` + `max_sessions`. Expiry enforced in `requireStreamAccess` (403 expired), `/api/streams`, `/api/my-streams`, WS scoping. `max_sessions` caps concurrent WS sockets (min over active assignments; close code 4409). `POST /api/users/:userId/streams` accepts both fields; `PATCH /api/users/:userId/streams/:streamId` updates them.

**P3 — Bulk ops + templates** — `channel_templates` table + GET/POST/DELETE `/api/channels/templates`; `POST /api/channels/bulk` actions create/transition/delete, `template_id` expansion, bounded concurrency (4), ≤100 items, per-item results.

**P4 — Health timeline** — watchdog records real status transitions into `stream_events` (actor NULL, `watchdog:` detail); unreachable-server offline marks recorded. Unknown baselines skipped to avoid noise.

**P5 — OpenAPI audit** — `docs/FLUSSONIC_API_COMPATIBILITY.md`. Fixed: `stats.input_alive` not in spec → `stats.inputs[].active` fallback; `client_count` → `online_clients` preference. Documented: `storage` singular fallback is legacy-only; VOD file-list `next` pagination now followed (was single-page only); `config_on_disk` undocumented but optional.

**Gate on branch:** lint ✅ · **50/50 tests** ✅ · build 158.3 kB ✅ · audit 2 non-critical ✅

### Contract alignment fixes (post-rebase onto f4ae2e1)
- Added `streams.channel_group TEXT` (nullable) — schema + migration + verified in legacy + fresh fixture tests
- Concurrent conflicting transitions guarded: state re-read inside `db.transaction()` → 409 on race
- Explicit tests: `provisioned→retired` ✅, `suspended→retired` ✅, same-state dup → 409, missing stream → 404
- No remote side effects on suspend/retire: verified zero remote requests during `live→suspended→retired`

### PR #3 review findings (contributor review at 4f0869b)
1. **max_sessions semantics** — documented as dashboard (WS) session cap, not Flussonic playback sessions. `flussonic_sessions` field added to stream details for visibility. Flussonic playback limits must be configured on Flussonic directly.
2. **Legacy POST/PUT /api/streams hardened** — remote Flussonic PUT failures now return 502; local rows are never created/updated on failure. POST also rolls back the companion VOD row + remote VOD when stream PUT fails. Regression tests verify no phantom records.
3. **VOD file pagination** — `syncVodFilesFromRemote` now uses `fetchAllPages()` to follow `next` cursors. Previously only fetched a single page. Test verifies multi-page file collection.
4. **Concurrent duplicate-name channel creation** — in-memory lock set serializes creations per server+name. Second concurrent request gets 409. Compensation never deletes preexisting resources (only rolls back what the current request created). UNIQUE index is the final safety net.
5. **50-channel bulk test** — 50-item batch against mock Flussonic: all 50 succeed, 50 streams + 50 companion VODs verified in DB.

### PR #3 follow-up review (contributor review at abea75f + CodeRabbit)
1. **Safe rename ordering** — legacy PUT `/api/streams/:id` now provisions the new remote stream *before* deleting the old one. Failed rename preserves the original remote stream. Regression test verifies old remote stream survives a failed rename.
2. **Single-writer deployment constraint** — `inFlightCreations` is process-local; documented in `DEPLOYMENT_CHECKLIST.md` and inline. SQLite itself requires single-writer, so this is consistent. UNIQUE index is the final safety net for any residual race.
3. **CodeRabbit: rename ordering** — identical to finding 1; already fixed.
4. **CodeRabbit: VOD file pagination limit** — increased from default 50 pages to 500 for file listings so large VOD libraries complete pagination.
5. **CodeRabbit: max_sessions enforcement on existing WS** — `enforceMaxSessions()` now called after assignment create/update; closes excess sockets immediately with code 4409.

### Final acceptance (PR #3)
1. **Rename + DB failure compensation** — if the local DB UPDATE fails after a successful remote rename (e.g. UNIQUE constraint), compensation re-creates the old remote stream and deletes the new one. Regression test triggers UNIQUE violation and verifies compensation PUT/DELETE requests + local row preservation.
2. **All 3 CodeRabbit threads resolved** — verified via GraphQL `isResolved: true` on all review threads.
3. **Migration + backup/restore drill** — legacy DB (no lifecycle columns) migrated: `lifecycle_state` defaults to `live`, `channel_group` nullable, `stream_events`/`channel_templates`/`expires_at`/`max_sessions` added. VACUUM INTO backup, integrity check ok, file-copy restore produces identical data.
4. **Single-process constraint** documented in `docs/DEPLOYMENT_CHECKLIST.md` (architecture section) and inline in `src/server/services/channels.ts`.

### Channel safety fix (blocking review at 51db15f)
1. **Pre-flight duplicate check** — `PUT /api/streams/:id` now checks both local DB (`SELECT ... WHERE server_id = ? AND name = ? AND id != ?`) and remote Flussonic (`GET /streams/{name}` → 404 required) before any remote changes. Returns 409 on collision.
2. **No overwrite of preexisting channels** — pre-flight ensures the target name is free; compensation only deletes streams the current request created (confirmed by the successful pre-flight probe).
3. **Cross-server move** — uses correct source server credentials for old-stream cleanup/restoration, destination server for new-stream creation.
4. **Compensation safety** — if DB update fails after remote rename, restores old stream on the source server and deletes new stream on the destination server. Compensation failures are logged but best-effort (non-fatal).
5. **Mock Flussonic stream inventory** — `remoteStreams` set tracks PUTs/DELETEs for realistic individual-stream GET probes (404 when absent, 200 when present).

### Final safety verification (PR #3, commit 77fdebe+)
1. **TOCTOU race handling** — if Flussonic returns 409/422 on the stream PUT (someone created it between our probe and PUT), treated as collision rather than generic failure. Companion VOD is preserved in this case (may belong to the other process).
2. **Companion VOD orphan prevention** — if stream PUT fails after VOD provisioning succeeds, the VOD is deleted remotely and its local row removed.
3. **Cross-server move** — two mocked Flussonic servers; verified PUT goes to destination, DELETE to source. Local `server_id` updated correctly.
4. **Compensation logging** — failures now include stream name, server name, and recovery instructions (e.g. "manual cleanup needed: delete stream 'X' on server 'Y'").
5. **Second mock Flussonic** — `remoteStreams2` set on port 36200 for cross-server move tests.

**Final gate:** lint ✅ · **54/54 tests** ✅ · build 162.4 kB ✅ · audit 2 non-critical ✅

- `channel_group` stored and queryable via `/lifecycle` endpoint

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

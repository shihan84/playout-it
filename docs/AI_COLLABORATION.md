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

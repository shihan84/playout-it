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

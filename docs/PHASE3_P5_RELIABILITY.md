# Phase 3 P5 — Reliability & Release Readiness

Status: implemented (tests) + documented. Mock-only; no real Flussonic channels
are touched by any test.

## Test coverage matrix

| Area | Where | Coverage |
|---|---|---|
| Mocked Flussonic integration | `tests/http-auth.integration.test.ts` | Full API surface against in-process HTTP mock; stateful remote inputs |
| Scheduler execution | integration + `tests/reliability.test.ts` | Due-job claim → swap → restore; missed/stale recovery |
| Crash recovery | integration + reliability | `swapping` reconciliation: PUT-not-landed → `failed`; landed mid-window → adopted `running`; ambiguous → `restore_unverified`; unreachable remote → `restore_unverified` |
| Missing restoration data | integration | `restore_unverified` + operator event, never silent success |
| Failure injection | integration + reliability | Restore PUT failure → `restore_failed` + stream event; swap PUT failure → `failed`, remote unchanged |
| Concurrency | integration + reliability | Atomic `swapping` claim: two racing ticks → exactly one remote PUT; mid-flight cancel → 409; service-level overlap 409 |
| Scheduler enable gate | reliability | Disabled → zero remote calls even with due jobs; env opt-in verified |
| Overlay isolation | `tests/overlay.test.ts` | output==input URL, output_url variants targeting source, feedback into source inputs, A↔B profile cycles — all 409 |
| Overlay assets | `tests/overlay.test.ts` | `..`/`..\` traversal + outside-absolute rejected; symlink escape rejected; missing file rejected |
| Overlay enable gate | `tests/overlay.test.ts` | Disabled → 409 before any spawn |
| Authorization | integration | JWT required, admin-only mutations, CSRF marker, WS auth, role re-validation |
| Migrations / backup | dedicated test file | Idempotent migrations, FK dedupe, SQLite online backup restorable, corruption never deletes files |

## Operational safety gates

| Gate | Default | Enable |
|---|---|---|
| Scheduler input swaps | OFF | `settings.scheduler_enabled = '1'` or env `SCHEDULER_ENABLED=1` |
| Overlay ffmpeg workers | OFF | `settings.overlay_enabled = '1'` or env `OVERLAY_ENABLED=1` |
| Logo assets | `<cwd>/assets/overlay` | env `OVERLAY_ASSET_DIR` (must contain the logo files) |
| Scheduler tick | 30 s | env `SCHEDULER_TICK_MS` (tests use 400) |
| ffmpeg path | `ffmpeg` on PATH | env `FFMPEG_PATH` / `FFPROBE_PATH` |

Deployment constraint: **one Node process** — SQLite single-writer plus
process-local creation locks and overlay worker handles.

## Windows deployment notes

- Node 22 + `npm ci`; `npm run build` produces `dist/server.cjs` + frontend.
- `npm run dev` (tsx) for local; production uses the built bundle.
- `DATABASE_PATH` env or `.env` sets the SQLite file; WAL mode enabled.
- Backups: `scripts/backup-db.ts` performs a SQLite online backup (safe while
  the app runs); verify with `PRAGMA integrity_check` on the copy.
- ffmpeg for overlays: install a full build (gyan.dev), ensure `ffmpeg` +
  `ffprobe` resolve on PATH, arm `overlay_enabled` only after an isolated
  test-stream run is verified.

## Rollback

1. Stop the app (no other service shares the DB).
2. Restore the DB copy over `flussonic.db` (config restores alongside).
3. `git checkout <previous-sha> && npm ci && npm run build`; restart.
4. Phase 3 schema is additive — older builds tolerate the new tables/columns.
5. Jobs interrupted mid-flight are reconciled on boot:
   `swapping` → remote-state comparison → resume / fail / `restore_unverified`.

## Merge order (current PR stack)

1. **#5** `feature/phase-3-scheduled-playout` → `main`
2. **#7** `feature/phase-3-monitoring` → retarget to `main`, then merge
3. **#6** `feature/phase-3-overlay-pipeline` → `main` (independent; any order after review)
4. **#9** `feature/phase-4-ops-dashboard` → retarget to `main` after #5 + #7
5. **#10** `feature/phase-5-reliability` → retarget after #9 (or merge into #9's base)
6. **#8** docs plan — independent, merge anytime

## Remaining risks before production arming

- Input-swap playout causes a brief stream restart on Flussonic at job
  boundaries — inherent to API-level switching; document to operators.
- Overlay publish URL (`/flussonic/publish/<name>`) needs one validation
  against a real Flussonic before arming overlays on CDN-ITAssist.
- No global cap on concurrent overlay workers — per-stream limit is 1; add a
  global cap if many channels get overlays (Pi CPU bound).

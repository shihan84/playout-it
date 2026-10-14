# Phase 2 — Channel Lifecycle Management (handoff)

Baseline: `feature/phase-1b-multiserver` @ `2c4e2af`.
Phase 1A = `feature/broadcast-security-foundation` (PR #1, draft). Phase 1B PR pending — token lacks `createPullRequest`; open manually at /pull/new/feature/phase-1b-multiserver.

## Baseline entering Phase 2

- Safe sync: upsert-by-name preserves ids/assignments; malformed/empty/envelope payloads never delete local rows; UNIQUE(server_id,name) enforced; dedupe re-points FK children.
- Per-server health persisted + `GET /api/servers/:id/health`; dashboard health indicators; per-server `sync_interval_secs`.
- Bounded concurrency (mapLimit=4), auto-sync overlap guard, circuit-breaker backoff, single network/5xx retry.
- WS `STREAMS_UPDATE` scoped per user via assignments.
- Companion VOD naming: `<stream>_vod` with legacy same-name fallback (`resolveCompanionVodName`).
- Tests: 22 (13 integration + 6 regression + 3 migration).

## Known gaps carried in

- **DB backup tooling exists** (`scripts/backup-db.ts` — online `.backup()` + `--restore --confirm`). Phase 2 prerequisite reduced to: verify a restore drill before destructive schema work and schedule backups in deployment.
- Frontend bundle ~1 MB; WS scoping re-queries assignments per broadcast; `/health` not polled by UI (card shows persisted values only).

## Phase 2 implementation plan

### P0 — Schema & lifecycle core
- Migration: `streams.lifecycle_state TEXT DEFAULT 'live'`, `streams.channel_group TEXT`, `channels_meta` optional table if richer metadata needed.
- State machine: `draft → provisioned → live ⇄ suspended → retired`; transitions validated server-side (server online for provision/live; companion VOD exists for playlist channels).
- Endpoint: `POST /api/streams/:id/transition { to }` (admin); `GET /api/streams/:id/lifecycle` history table `stream_events(id, stream_id, from_state, to_state, actor_id, created_at)`.

### P1 — Channel entity
- "Channel" = stream + companion VOD + inputs + pushes. Create flow already provisions both; formalize `POST /api/channels` wrapping stream+VOD+playlist setup atomically (rollback remote VOD if stream PUT fails — currently orphaned VODs possible).
- Pre-flight duplicate-name check against Flussonic shared namespace (streams+vods) to avoid `non_unique_names`.

### P2 — Access control
- Extend `user_stream_assignments`: `expires_at`, `max_sessions`. Enforce in `requireStreamAccess` and WS scoping.
- Optional per-channel IP allow/deny joining `blocked_ips`.

### P3 — Bulk & template ops
- `POST /api/channels/bulk` — create/enable/disable/restart N channels on a server; bounded concurrency, per-item result report.
- Channel templates (saved input/push/VOD presets) → one-click multi-server provisioning.

### P4 — Health history
- `stream_events` also records watchdog transitions (status/input/source changes) for a per-channel timeline view.

### P5 — API compat audit
- Validate payloads against `openapi.json` (inputs, pushes, stats fields, vod storages) — document any drift.

## Acceptance criteria (proposed)

1. All lifecycle transitions enforce rules + are persisted with actor + timestamp.
2. Channel create is atomic: partial remote failure leaves no orphan VOD/stream.
3. Duplicate channel names rejected pre-flight with clear error.
4. Assignment expiry enforced server-side (tested past-expiry → 403).
5. Bulk op on 50-channel mock completes with per-item success/failure report; no single failure aborts the batch.
6. Stream events timeline endpoint returns ordered transitions.
7. All existing 22 tests still pass; new coverage for each criterion.
8. `scripts/backup-db.ts` exists and verified (backup + restore round-trip on disposable DB).

## Gates

Same protocol: lint, `npx tsx --test tests/*.test.ts`, build, audit; record in `docs/AI_COLLABORATION.md`; mock/staging servers only; no merge/deploy without approval.

# Phase 2 implementation authorization and P0 execution contract

Authorized by project owner on 2026-10-14: develop P0–P5 on `feature/phase-2-channel-lifecycle`. This authorization **does not** permit merging, deployment, or production Flussonic operations.

Baseline: merged `main` at `38ce4ea`; reported clean `npm ci`, lint, 40/40 tests, build, and no critical/high audit findings. Reverify before edits.

## Order and independent review gates
1. **P0 lifecycle core**: migration adds `streams.lifecycle_state` (existing streams default to `live`) and nullable `channel_group`; `stream_events` with actor, timestamp, from/to states. Admin-only validated transition API; scoped lifecycle history; transactional state+event persistence. No remote side effects on draft/suspend/retire until behavior is specified and tested. Include migration rollback/legacy fixture and forbidden-transition tests.
2. **P1 channel creation**: design remote stream/VOD compensation with failure injection, namespace preflight, and local transaction; never swallow remote PUT errors. Avoid deleting preexisting remote resources during compensation.
3. **P2 access**: assignment expiry and session limits enforced at HTTP authorization, list queries, and WebSocket broadcasts, with concurrency/race tests.
4. **P3 bulk**: bounded concurrency, idempotency and per-item error reporting, 50-channel mock.
5. **P4 timeline**: watchdog event ingestion, retention and pagination.
6. **P5 API drift**: check `openapi.json` paths and payloads against deployed API base path; report discrepancies, don't assume compatibility.

## P0 definition of done
- Schema changes are additive and idempotent; existing IDs, assignments and live status remain intact.
- Valid transitions: draft→provisioned→live⇄suspended→retired; explicit decision on whether suspended→retired and provisioned→retired are allowed, with tests.
- Reject invalid state, invalid stream ID, non-admin, and concurrent conflicting transitions.
- Never expose server credentials in API responses or logs.
- Tests, lint, build and audit recorded in `docs/AI_COLLABORATION.md`.
- Contributor/Devin review after P0, before beginning P1; no merge/deploy without explicit approval.

## Operational boundaries
Use disposable SQLite databases and mocked Flussonic only. Back up and restore a disposable database before destructive migration testing. Coordinate branch writes to avoid conflicts. Existing `docs/PHASE2_CHANNEL_LIFECYCLE_HANDOFF.md` is design input, not evidence that implementation exists.

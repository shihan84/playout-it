# Phase 2 — Channel Lifecycle Management (handoff)

Baseline: `feature/phase-1b-multiserver` @ `93d4d53` (+ migration fixes pending commit at time of writing).
Phase 1A = `feature/broadcast-security-foundation` (PR #1, draft). Phase 1B PR pending (token lacks `createPullRequest` — open manually).

## Baseline entering Phase 2

- Safe sync: upsert-by-name preserves ids/assignments; malformed/empty payloads never delete local rows; UNIQUE(server_id,name) enforced.
- Per-server health persisted (`last_seen_at`, `last_error`, `consecutive_failures`, `latency_ms`, `sync_interval_secs`, `last_synced_at`); `GET /api/servers/:id/health`.
- Bounded concurrency (mapLimit=4), auto-sync overlap guard, per-server intervals, circuit-breaker backoff, network/5xx retry.
- WS `STREAMS_UPDATE` scoped per user via assignments.
- Tests: 21 (13 integration + 6 regression + 2 migration).

## Suggested Phase 2 scope

1. **Channel lifecycle states** — draft → provisioned → live → suspended → retired; persisted `lifecycle_state` on streams; transitions enforce prerequisites (server online, VOD exists).
2. **Channel create/clone/bulk ops** — template-driven creation across multiple servers; duplicate-name detection pre-flight (non_unique_names is handled today only via failure).
3. **Access control per channel** — extend `user_stream_assignments` with per-channel expiry, max sessions, allowed IPs (tie into blocked_ips).
4. **Playout composition** — inputs + `playlist://` fallback already work; formalize "channel = stream + companion VOD + inputs + pushes" as a first-class entity.
5. **Channel health history** — persist watchdog state transitions for timeline UI (currently only latest status).
6. **Bulk lifecycle actions** — enable/disable/restart groups of channels per server.
7. **API compat check** — verify create/update/delete behavior against `openapi.json` for v3 schemas (inputs, pushes, stats fields).

## Carry-over risks

- `vod-files`/`videos` probe adds ≤2 remote GETs per op.
- WS scoping re-queries assignments per broadcast per client (fine at current scale; cache if needed).
- Frontend bundle ~1 MB (code-split later).
- Telegram alert dispatch is synchronous per alert inside watchdog (rate-limited already).

## Gates

Same protocol: lint, `npx tsx --test tests/*.test.ts`, build, audit; record in `docs/AI_COLLABORATION.md`; no merge/deploy without approval.

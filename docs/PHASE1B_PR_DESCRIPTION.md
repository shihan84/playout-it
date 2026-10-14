# Phase 1B — Multi-Flussonic Server Management

Branch: `feature/phase-1b-multiserver` (head: `10c0f0e`)
Base: `feature/broadcast-security-foundation`

## Summary

Hardens multi-server management end-to-end: safe synchronization, per-server
health, bounded concurrency, verified deletions, and DB backup tooling.

### Synchronization safety

- **No automatic deletion.** Sync (manual, auto, watchdog, sync-all) only
  inserts/updates. Missing names surface as `pendingRemovals`. Deletion
  requires `POST /api/servers/:id/prune` with admin auth + `{confirm:true}`,
  and still enforces complete-inventory + second-fetch confirmation +
  conservative limits (>10 absolute or >20% of local → never deleted).
- **Child protection.** Rows with live `user_stream_assignments`/`videos`/
  `telegram_alerts`/`vod_files` are never deleted, even by confirmed prune —
  reported as `protectedRemovals`.
- **Complete-inventory guarantee.** `fetchAllPages` follows `next` cursors
  confined to the server origin + `/flussonic/api` path, with loop detection
  and a 50-page cap. Truncated inventories can never reach reconciliation.
- **Fail-closed validation.** Envelope keys (`error`, `next`, `stats`, …)
  rejected as resource maps; every stream/VOD record validated before any
  DB write — one malformed record fails the entire sync.
- **Explicit failures.** Sync returns `success:false` + error instead of
  silent zero-changes; names-only VOD responses never overwrite stored paths.
- **ID-preserving upserts.** Stream/VOD ids, assignments, videos and alerts
  survive every sync cycle (`UNIQUE(server_id, name)` + update-in-place).

### Security hardening

- `flussonicRequest`: `maxRedirects: 0` + `validateStatus < 300` — 3xx
  responses can no longer forward Basic credentials to arbitrary hosts.
- `POST /api/telegram-alerts/send` was missing auth — now authenticated;
  watchdog calls the service directly.
- WS `/ws` stream updates scoped to `user_stream_assignments` for non-admins.
- Prune audit log: admin username + server + counts on every invocation.

### Reliability

- Bounded concurrency (`mapLimit`, limit 4) in watchdog, auto-sync, sync-all.
- Sync overlap guard; per-server `sync_interval_secs` + `last_synced_at`.
- Persistent health: `last_seen_at`, `last_attempt_at`, `last_error`,
  `consecutive_failures`, `latency_ms`; circuit-breaker backoff 30s→5min.
- `GET /api/servers/:id/health` — live probe + persisted record.
- Dashboard shows latency, last-seen, failure count, last error, interval.

### Migrations

- FK-safe dedupe: children re-pointed to kept rows before duplicate removal.
- Table rebuild preserves `input_status`/`source_type`/`uptime` (was dropped).
- Migration ordering fixed: rebuild → dedupe → unique indexes (was dropping
  indexes). Verified on legacy-schema and fresh-install fixtures; idempotent.

### Backup

- `scripts/backup-db.ts` — online `.backup()` (WAL-safe) with row-count
  verification; `--restore <file> --confirm` restores via the backup API.

## Test evidence

**32/32 tests pass** (22 integration + 4 migration + 6 regression).
Lint clean, build 133.4 kB, audit: 2 non-critical (esbuild low dev-only,
qs moderate — no critical/high).

Highlights: sync never wipes on `{error}`/`{}`/garbage/partial inventories
(50→10, 20→5, repeated); stream ids + assignments survive re-sync; 50 mock
servers incl. slow/offline sync in ~4.3s; cursor confinement rejects
cross-origin/off-path/loop/endless; redirect never followed; prune auth
matrix + child protection; WAL backup→restore round-trip.

## Test plan

- [ ] Deploy to staging; register a staging Flussonic server
- [ ] Verify sync adds streams/VODs, health endpoint reports latency
- [ ] Sync twice with a reduced remote inventory → `pendingRemovals`, no deletions
- [ ] `POST /api/servers/:id/prune` `{confirm:true}` → only verified-missing,
      child-free rows removed; audit log line emitted
- [ ] `npx tsx scripts/backup-db.ts` → verified backup; `--restore --confirm` round-trip
- [ ] Schedule `backup-db.ts` via cron/PM2 before production cutover

## Remaining risks

1. Basic auth over plain HTTP interceptable — use HTTPS/private network.
2. `pendingRemovals`/`protectedRemovals` have API surface only — no UI yet.
3. Backup not scheduled automatically — wire cron/PM2 at deploy.
4. `qs` moderate DoS — transitive, no compatible fix; monitor.
5. Phase 2 backlog defined in `docs/PHASE2_CHANNEL_LIFECYCLE_HANDOFF.md` —
   not started, awaiting scope approval.

Generated with [Devin](https://devin.ai)

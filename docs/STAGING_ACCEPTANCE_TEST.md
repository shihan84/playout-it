# Phase 1B — Staging Acceptance Test

Run against an **isolated staging** deployment (not production). Requires: a
staging Flussonic server with credentials, a fresh app install, and this
branch's build (`feature/phase-1b-multiserver` @ `b3d3807`).

## 0. Setup

- [ ] Deploy per `docs/DEPLOYMENT_CHECKLIST.md` (JWT_SECRET, admin provisioned, HTTPS)
- [ ] Register staging Flussonic server via UI/API — confirm it reports `online`
- [ ] Take baseline backup: `npx tsx scripts/backup-db.ts`

## 1. Sync acceptance

- [ ] Create 3 test streams + 1 test VOD on staging Flussonic (names prefixed `stg-`)
- [ ] `POST /api/servers/:id/sync` → `added: 4`; rows visible in `GET /api/streams`/`/api/vods`
- [ ] Re-sync → `added: 0`, `removed: 0`, stream ids unchanged
- [ ] Assign a stream to a client user → re-sync → assignment survives

## 2. Safe-deletion acceptance

- [ ] Delete `stg-a` remotely → sync → `pendingRemovals: 1`, local row intact
- [ ] `POST /api/servers/:id/prune` `{}` → HTTP 400
- [ ] `prune` `{confirm:true}` → `removed: 1`; `[prune]` audit line in logs
- [ ] Assign `stg-b` to a client, delete it remotely → sync → `pendingRemovals: 1`,
      `protectedRemovals: 1`; prune with confirm → `removed: 0`, `protectedRemovals: 1`

## 3. Health & reliability

- [ ] `GET /api/servers/:id/health` → `status: online`, `latency_ms` populated
- [ ] Stop staging Flussonic → health → `offline`, `last_error`, failures increment
- [ ] `POST /api/servers/sync-all` while staging is down → server appears in `skipped` (backoff)
- [ ] Restart Flussonic → health recovers, `consecutive_failures` resets to 0

## 4. Backup & rollback drill

- [ ] `npx tsx scripts/backup-db.ts` → `Backup verified:` line
- [ ] Stop app → `npx tsx scripts/backup-db.ts --restore backups/<file>.db --confirm` → restart
- [ ] Login + `GET /api/streams` unchanged → rollback path proven
- [ ] Cron entry installed and observed firing: `0 * * * * cd <dir> && npx tsx scripts/backup-db.ts`

## 5. Failure-injection (mock optional)

- [ ] Point a server row at an unreachable URL → sync reports `success:false`, local rows preserved
- [ ] Malformed payload (proxy returning `{error:...}`) → no deletions, error surfaced

## Sign-off

All boxes checked + logs attached = staging acceptance passed.
Rollback at any point = restore backup + redeploy prior build (schema is additive).

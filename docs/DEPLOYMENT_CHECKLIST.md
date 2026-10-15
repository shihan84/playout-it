# Deployment Checklist — Phase 2

Run every item before pointing the app at production Flussonic servers.

## Architecture constraint: single-writer process

IBS Manager uses SQLite (single-writer by design) and in-memory locks for
concurrent channel-creation serialization. **Run exactly one application
process** — do NOT use PM2 cluster mode, multiple containers, or any
multi-worker topology. If horizontal scaling is needed in the future, SQLite
must be replaced with a networked database and the in-memory channel-creation
lock must be replaced with a distributed claim (database advisory lock or
similar).

## Pre-deploy

- [ ] `JWT_SECRET` set to a random ≥32-char value (`openssl rand -hex 32`)
- [ ] Latest backup taken: `npx tsx scripts/backup-db.ts`
- [ ] `npm ci && npm run lint && npx tsx --test tests/*.test.ts && npm run build`
- [ ] `npm audit` — confirm no critical/high findings

## HTTPS / transport

- [ ] App served behind Nginx TLS (or trusted private network) — JWT cookie
      and Basic credentials are otherwise interceptable
- [ ] Flussonic URLs use `https://` where reachable over untrusted networks
- [ ] `Secure` cookie flag active (already set when `NODE_ENV=production`)

## Credentials

- [ ] Admin provisioned: `ADMIN_PASSWORD_FILE=<path> npm run admin:provision`
      (no default admin is ever created; delete the password file after)
- [ ] Flussonic credentials entered via UI/API only — never committed
- [ ] Old credentials in git history treated as compromised and rotated

## Database

- [ ] Backup scheduled: cron `0 * * * * cd <dir> && npx tsx scripts/backup-db.ts`
      (or PM2 cron) writing to `backups/`
- [ ] Retention policy for `backups/` (e.g. keep 14 days)
- [ ] Restore drill verified once:
      `npx tsx scripts/backup-db.ts --restore backups/<file>.db --confirm`
      (stop app first, restart after)

## Migration safety

- [ ] First boot runs migrations automatically; verify log lines
      "Migrating streams table..." appear once
- [ ] If a table rebuild ran, confirm `idx_streams_server_name` and
      `idx_vods_server_name` exist: `sqlite3 flussonic.db ".indexes streams"`

## Runtime verification

- [ ] `GET /api/servers` returns server rows without `api_key`/`username`/`password`
- [ ] `GET /api/servers/:id/health` reports live status + latency
- [ ] Remove one disposable stream on the remote, then sync — it reports `pendingRemovals: 1` and the local row remains (an unchanged inventory correctly reports 0)
- [ ] Prune requires `{confirm:true}` and emits `[prune]` audit log
- [ ] Watchdog: offline server accumulates `consecutive_failures`, backs off

## Rollback

- [ ] Keep previous `dist/` + a pre-upgrade DB backup
- [ ] Rollback = restore backup (`--restore --confirm`), redeploy prior build,
      restart PM2 — schema is additive so the old build tolerates new columns

## Post-deploy

- [ ] Monitor `last_error`/`consecutive_failures` on the dashboard for 24h
- [ ] Watch PM2 logs for `[prune]`/`skipping deletions` warnings

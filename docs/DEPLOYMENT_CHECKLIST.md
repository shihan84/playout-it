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
- [ ] Every setting in `.env.example` reviewed and set in `.env`
- [ ] Latest backup taken: `npm run db:backup`
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

- [ ] Built-in backups on: the app writes a verified copy every
      `BACKUP_INTERVAL_HOURS` (default 24) to `BACKUP_DIR` (default `backups/`
      next to the DB) and keeps the newest `BACKUP_KEEP` (default 14). Look for
      `Database backup verified:` in the log about a minute after start; failures
      are logged and sent to Telegram.
- [ ] `BACKUP_DIR` is copied off the machine (rsync/cloud) — a backup on the
      same disk doesn't survive a disk failure
- [ ] Restore drill passes: `npm run db:restore-drill` (restores the newest
      backup into a scratch file and checks integrity, foreign keys and that an
      admin exists; never touches the live DB). Repeat monthly.
- [ ] Real restore, when needed: stop the app, then
      `npx tsx scripts/backup-db.ts --restore backups/<file>.db --confirm`, restart

## Migration safety

- [ ] First boot runs migrations automatically; verify log lines
      "Migrating streams table..." appear once
- [ ] If a table rebuild ran, confirm `idx_streams_server_name` and
      `idx_vods_server_name` exist: `sqlite3 flussonic.db ".indexes streams"`

## Runtime verification

- [ ] `GET /healthz` returns 200 `{"status":"ok"}` and `GET /readyz` returns 200
      `{"status":"ready"}` (503 while shutting down or if the DB is unusable);
      point the uptime monitor / load balancer at `/readyz`
- [ ] `GET /api/servers` returns server rows without `api_key`/`username`/`password`
- [ ] `GET /api/servers/:id/health` reports live status + latency
- [ ] Remove one disposable stream on the remote, then sync — it reports `pendingRemovals: 1` and the local row remains (an unchanged inventory correctly reports 0)
- [ ] Prune requires `{confirm:true}` and emits `[prune]` audit log
- [ ] Watchdog: offline server accumulates `consecutive_failures`, backs off

## Rollback

- [ ] Keep previous `dist/` + a pre-upgrade DB backup
- [ ] Rollback = restore backup (`--restore --confirm`), redeploy prior build,
      restart the service — schema is additive so the old build tolerates new columns

## Post-deploy

- [ ] Monitor `last_error`/`consecutive_failures` on the dashboard for 24h
- [ ] Watch the logs (`journalctl -u flussonic-manager` or `pm2 logs`) for
      `[prune]`/`skipping deletions` warnings and `Database backup failed`

## Running as a service

- **Linux (recommended):** systemd unit in `scripts/flussonic-manager.service`
  (reads `.env`, restarts on failure, gives the app time for a clean shutdown).
  PM2 via `deploy.sh` also works; use one or the other, never both.
- **Windows:** register `node dist\server.cjs` as a service with
  [NSSM](https://nssm.cc): `nssm install playout-it "C:\Program Files\nodejs\node.exe" dist\server.cjs`,
  then `nssm set playout-it AppDirectory <repo dir>` and
  `nssm set playout-it AppEnvironmentExtra NODE_ENV=production`. The app reads
  the rest from `.env` in that directory. Logs: `nssm set playout-it AppStdout <file>`.

# Merge Order & Production Rollout Plan

**Status: awaiting explicit approval. Nothing here is to be executed without it.**

## Merge order

1. **PR #1** — `feature/broadcast-security-foundation` → `main`
   - Gate: review approval + green "Stage 1 security CI" (already passing)
   - Breaking change for operators: production now requires `JWT_SECRET`
     (≥32 chars) and explicit admin provisioning — no default admin.
2. **PR #2** — `feature/phase-1b-multiserver` → retarget to `main` after PR #1
   merges (current base is PR #1's branch; retarget before merge), then merge.
   - Gate: reviewer sign-off + CI green on the 1B branch.
3. **Phase 2** — new branch from updated `main`, only after scope approval.

## Pre-deploy (on the target host)

- [ ] Follow `docs/DEPLOYMENT_CHECKLIST.md` in full
- [ ] `JWT_SECRET` ≥32 chars in `.env`; `NODE_ENV=production`
- [ ] Backup before upgrade: `npx tsx scripts/backup-db.ts`
- [ ] Provision admin if fresh DB: `ADMIN_PASSWORD_FILE=<f> npm run admin:provision`
- [ ] Ensure HTTPS (Nginx) fronts the app before adding server credentials

## Deploy

- [ ] `npm ci && npm run build`
- [ ] `pm2 restart` the app; watch first-boot logs for migration lines
- [ ] Smoke: login, `GET /api/servers` (no credential fields), health endpoint,
      one manual sync per server — confirm `pendingRemovals` reporting works

## Rollback

- [ ] Stop app → `npx tsx scripts/backup-db.ts --restore backups/<pre-upgrade>.db --confirm`
      → redeploy previous build → restart. Schema is additive; old builds
      tolerate the new columns.

## Post-deploy (first 24h)

- [ ] Watch `consecutive_failures`/`last_error` on the Servers dashboard
- [ ] Watch PM2 logs for `[prune]`/`skipping deletions`/`Rejected` warnings
- [ ] Confirm backup cron is firing and `backups/` is filling

## Explicit non-goals

- No automatic pruning is ever enabled — deletions require admin-confirmed
  `POST /api/servers/:id/prune` `{confirm:true}`.
- No production Flussonic changes; test streams only on staging.

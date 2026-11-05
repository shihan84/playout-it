# Phase E — Staging Validation

Validate Playout-IT against an **explicitly authorized staging Flussonic
server** before any production arming. Requires: staging URL + credentials,
ffmpeg on the test host, and a non-production app instance (separate
`DATABASE_PATH`).

## 1. Automated harness — `scripts/staging-validate.ts`

Set the connection once per shell. The password is read without echo and
never written to disk or shell history:

```bash
export STAGING_URL=https://stage.example:8443
export STAGING_USER=admin
read -rsp 'Staging Flussonic password: ' STAGING_PASS && echo && export STAGING_PASS
export PRODUCTION_HOSTS=prod1.example,prod2.example   # your real production hosts
```

```bash
# Read-only (safe — GET only):
npx tsx scripts/staging-validate.ts

# Full lifecycle (disposable stream e2e-val-<ts>, cleaned up in `finally`,
# also on crash, Ctrl+C or SIGTERM). Requires confirming the staging hostname:
STAGING_CONFIRM_HOST=stage.example npx tsx scripts/staging-validate.ts --write

# With a real publish test (synthetic ffmpeg source). {stream} is replaced by
# the disposable stream name, which is switched to a publish:// input first:
STAGING_CONFIRM_HOST=stage.example npx tsx scripts/staging-validate.ts --write \
  '--publish=rtmp://stage.example/{stream}'
```

Plain `http://` staging URLs are refused (Basic auth would travel in clear
text) unless `STAGING_ALLOW_HTTP=1` is set on a trusted network.

**Production guards:**

| Guard | Mode | Behavior |
|---|---|---|
| `PRODUCTION_HOSTS=a.example,b.example` | all | refuse to run against listed hosts, by name or resolved IP |
| `https://` `STAGING_URL` | all | plain http refused unless `STAGING_ALLOW_HTTP=1` |
| `STAGING_TIMEOUT_MS` (default 15000) | all | every request times out instead of hanging |
| existing `e2e-val-<ts>` | `--write` | refuse to write if the disposable stream name already exists |
| `STAGING_CONFIRM_HOST` | `--write` | must equal the `STAGING_URL` hostname |
| `STAGING_MAX_STREAMS` (default 20) | `--write` | refuse to write if the server already has more streams, counted across all pages (treated as production); an incomplete count also refuses |
| `--publish` target | `--write` | must equal the `STAGING_URL` hostname and contain `{stream}` (publishes only into the disposable stream) |
| Ctrl+C / SIGTERM | `--write` | waits for the in-flight request, sends no further writes, deletes the stream; a second signal exits immediately |

If cleanup fails, the harness prints the disposable stream name — delete it
manually in the Flussonic UI.

Validates: v3 auth, `/streams` + `/vods` inventory, PUT→GET→DELETE roundtrip,
the exact input-swap the scheduler performs (each step verified by GET), and optional real ingest
(`--publish` runs the same muxer selection as the overlay pipeline:
rtmp→flv, srt/udp→mpegts).

**Gate:** all checks must pass before proceeding. A lifecycle failure means
the app cannot safely manage that Flussonic version — stop here.

## 2. App-level staging checklist

Run the app against a **disposable database** pointed at staging:

```bash
DATABASE_PATH=staging-test.db JWT_SECRET=<strong> \
  SCHEDULER_ENABLED=1 OVERLAY_ENABLED=1 OVERLAY_AUTO_RESTART_ENABLED=1 \
  OVERLAY_ASSET_DIR=./assets/overlay npx tsx server.ts
```

- [ ] Add staging server → auto-sync imports streams/VODs
- [ ] `last_error` shows classified diagnostics if staging is unreachable
- [ ] Create a schedule on a **disposable** stream → verify remote input swap
      in the Flussonic UI/API at the window boundary
- [ ] Stop the app mid-swap → restart → job reconciles (`restore_unverified`
      or resume — never silent)
- [ ] Create an overlay profile with `output_url` → the staging ingest
      endpoint verified in step 1 → start job → confirm the output stream
      appears in Flussonic with logo/ticker
- [ ] Kill the ffmpeg process → auto-restart reschedules within backoff;
      watch `overlay_jobs.restart_count`/`next_retry_at`
- [ ] Worker limit: `OVERLAY_MAX_WORKERS` respected under load
- [ ] Rollback drill: `scripts/backup-db.ts` → break a row → restore per
      `docs/OPERATIONS_RECOVERY.md`
- [ ] Login rate limiting returns 429 after 30 bad logins (staging only)

## 3. What staging CANNOT prove (Phase F)

- 24h+ continuous playout and long-run memory behavior
- 50+ channel load — needs the capacity budget in `docs/CAPACITY_PLAN.md`
  validated with real ffmpeg costs on the production host
- Failover under real network partitions

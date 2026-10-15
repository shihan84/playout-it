# Phase 3 — P4 (Operations Dashboard) & P5 (Release Readiness) Plan

Depends on: PR #5 (P1 scheduler), PR #6 (P2 overlay), PR #7 (P3 monitoring)
Status: planning only — no implementation until P1/P2/P3 are reviewed.

---

## P4 — Operations Dashboard

### Pages / components

| Surface | Backend it consumes | Notes |
|---|---|---|
| `SchedulePage` | `GET/POST/PATCH/DELETE /api/schedules`, `/:id/jobs`, `/stream/:id/next` | Calendar/list hybrid; create job = pick inputs + start time + duration |
| `ChannelMonitorPage` | `GET /api/monitoring/channels`, `/channels/:id` | Status chip, progress bar for running job, next item, failures_24h badge |
| `EventsPage` | `GET /api/monitoring/events`, `/jobs/failures` | Filterable operational log |
| `OverlayEditorPage` | `GET/POST/PATCH /api/overlays`, `/:id/start`, `/jobs/:id/stop`, `/capabilities` | Logo position picker, opacity slider, ticker text/speed/color, start/stop + live status |
| Playlist editor (existing `BroadcastPlaylist.tsx`) | existing `/api/streams/:id/videos` | Keep — gains "used by schedule" badge |

### Design constraints
- Reuse existing auth (localStorage JWT + axios), Tailwind, lucide icons
- All P4 surfaces admin-gated; client role keeps read-only `my-streams`
- No new deps required; a tiny date-time picker can be native `<input type="datetime-local">`

### API gaps to close in P4
- `GET /api/schedules/stream/:id/next` exists; may add `GET /api/monitoring/channels/:id/thumbnail` later (deferred — needs ffmpeg snapshot, P5+)
- Bulk-cancel jobs endpoint (convenience)

---

## P5 — Reliability & Release Readiness

### Test additions (mocks only — never CDN-ITAssist)
- **Failure injection**: ffmpeg crash mid-overlay → status 'exited' + event; Flussonic 500 during job swap → job 'failed'; restore failure → 'restore_failed'
- **Restart recovery**: kill app mid-running-job → restart → job finalized, inputs restored
- **Concurrency**: parallel job creation same stream → one 409; parallel overlay start → 409; scheduler tick overlap guarded by `isTicking`
- **Perf**: monitoring `/channels` with 47 streams stays <100ms (single indexed queries)
- **Security**: all new routes admin-gated; client 403 coverage; CSRF on mutations; drawtext escaping fuzz cases

### Ops docs
- `docs/PLAYOUT_OPERATIONS.md` — enable scheduler (`scheduler_enabled=1`), overlay prerequisites (FFmpeg on PATH / `FFMPEG_PATH`), isolated output naming, rollback
- Windows service/PM2 note: single-process constraint still applies (scheduler + overlay managers are process-local)
- Backup/rollback: additive tables only; rollback = stop app, restore DB copy, checkout previous tag

### Merge order (validated)
1. PR #5 (`feature/phase-3-scheduled-playout` → main) — foundation
2. Retarget PR #7 (`feature/phase-3-monitoring`) base → main, merge
3. PR #6 (`feature/phase-3-overlay-pipeline` → main) — independent, any position
4. P4/P5 branches — last

---

## Explicitly NOT in scope (flag for owner review)
- EPG metadata ingest (XMLTV) — no requirement captured yet
- SCTE-35 ad markers — `E:\scte35-go` exists on this machine; possible future integration, needs spec
- Redundant/failover output — current model is single-output per job

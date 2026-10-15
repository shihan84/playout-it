# Phase 3 — Broadcast Operations & Playout Automation
## P0: Architecture Audit & Gap Analysis

Date: 2026-10-15
Baseline: `main` @ `4c50547` (Phase 2 merged, slash-name fix merged via PR #4)
Environment: Windows local dev · CDN-ITAssist (production Flussonic) · FS1/FS2 mocks

---

## 1. What Exists Today (audited, working — do NOT reimplement)

| Capability | Implementation | Status |
|---|---|---|
| Channel/stream CRUD | `routes/streams.ts`, `routes/channels.ts` | ✅ Working |
| Lifecycle state machine | `services/lifecycle.ts` — draft/provisioned/live/suspended/retired, `stream_events` timeline | ✅ Working |
| Atomic channel creation | Collision pre-flight, compensation, companion VOD cleanup, cross-server routing | ✅ Working |
| Per-channel static playlist | `videos` table + `BroadcastPlaylist.tsx` → `playlist.txt` uploaded to companion VOD → `playlist:///…` appended as **last input** on Flussonic | ✅ Working — fallback only |
| Playlist ordering | Drag-order via `PUT /:id/videos/order`, `sort_order` column | ✅ Working |
| Loop modes | Frontend `loopMode` (loop/once/shuffle) — **UI state only, not persisted or pushed to Flussonic** | ⚠️ Partial |
| Duration tracking | `videos.duration` via `PATCH …/duration`, `calcTotalDuration` client-side | ✅ Working (fallback list only) |
| VOD management | Upload (direct + chunked), file list, sync, `vod_files` table | ✅ Working |
| Health monitoring | Watchdog 15s: status/input_status/uptime, failure backoff | ✅ Working |
| Inventory sync | Auto-sync 60s, fail-closed validation, `/` names supported (PR #4) | ✅ Working |
| Event history | `stream_events` — lifecycle + health transitions | ✅ Working |
| Alerts | Telegram (watchdog + per-stream), IP blocking | ✅ Working |
| Access control | JWT, admin/client roles, assignments w/ `expires_at` + `max_sessions` | ✅ Working |
| Realtime | WebSocket `STREAMS_UPDATE`, admin/client scoping | ✅ Working |
| Bulk ops + templates | `POST /api/channels/bulk`, `channel_templates` | ✅ Working |

## 2. What Does NOT Exist (gaps vs broadcast requirements)

| # | Gap | Severity | Needed for |
|---|---|---|---|
| G1 | **No scheduling engine** — nothing executes at a date/time. Playlists are static fallback inputs, not scheduled playout. | P1 blocker | P1 |
| G2 | **No program/schedule model** — no `schedules`/`playout_jobs` table, no date/time-bound playlist runs. | P1 blocker | P1 |
| G3 | **No "now playing" tracking** — cannot report current item, progress, or next item. | P1/P3 | P1, P3 |
| G4 | **No timezone handling** — `CURRENT_TIMESTAMP` is UTC; no per-channel TZ, no DST-aware triggers. | P1 blocker | P1 |
| G5 | **No job recovery** — no persisted job state to resume after app restart. | P1 blocker | P1 |
| G6 | **No FFmpeg/GStreamer pipeline** — cannot transcode, overlay logo, or render ticker. | P2 blocker | P2 |
| G7 | **No overlay/ticker model or UI** — no logo position/opacity config, no ticker text/schedule. | P2 blocker | P2 |
| G8 | **No playout-aware monitoring** — watchdog knows stream up/down, not whether the *scheduled* item is airing. | P3 | P3 |
| G9 | **No schedule editor / EPG UI** — `BroadcastPlaylist.tsx` manages fallback list only. | P4 | P4 |
| G10 | **`loopMode` not persisted** — frontend-only state; Flussonic playlist.txt has no loop directive anyway. | Minor | P1 |
| G11 | **No duration probe** — `videos.duration` relies on manual PATCH; no ffprobe metadata ingest for VOD files. | P1 (nice) | P1 |

## 3. Proposed Architecture (P1 scope)

### Design principle
Flussonic `playlist.txt` mechanism is a **static fallback**, not a scheduler. Scheduled playout = our service **swaps stream inputs at trigger times** (PUT `/streams/:name` with the scheduled input) — Flussonic does the actual switching. This keeps us on the supported API surface with zero stream interruption between runs.

### New tables (additive, idempotent migration)

```sql
playout_schedules (
  id, stream_id FK, name, timezone TEXT NOT NULL,
  enabled INTEGER DEFAULT 1, created_by, created_at
)

playout_jobs (
  id, schedule_id FK, stream_id FK,
  kind TEXT,              -- 'playlist' | 'live_input' | 'file'
  payload TEXT,           -- JSON: inputs[] to PUT, or playlist ref
  start_at_utc TEXT,      -- stored UTC only; TZ applied on entry
  duration_sec INTEGER,
  end_at_utc TEXT,
  status TEXT,            -- 'scheduled'|'running'|'completed'|'failed'|'skipped'|'cancelled'
  last_error TEXT, created_at,
  UNIQUE(stream_id, start_at_utc)   -- conflict prevention
)
```

Indexes: `(stream_id, start_at_utc)`, `(status, start_at_utc)`.

### New module

```
src/server/services/scheduler.ts
  - tick loop (30s): find due jobs (status='scheduled', start_at_utc <= now)
  - single-process claim: UPDATE ... WHERE status='scheduled' (atomic claim, no race)
  - execute: GET current stream → PUT new inputs → mark 'running'
  - end-of-job: restore previous inputs / mark 'completed'
  - restart recovery: jobs with status='running' whose end_at_utc passed → 'completed';
    missed-window jobs → 'skipped' (never silently replay old content mid-air)
  - overlap rule: one running job per stream; conflicting start → reject 409
```

### Validation (P1 acceptance)
- Job start times stored UTC; TZ via IANA name validated against `Intl`
- Duration > 0; end > start; no two enabled jobs overlapping same stream window
- Playlist payload: all referenced files must exist in `vod_files`/`videos`
- Preview endpoint: `GET /api/streams/:id/schedule/next?hours=24`

### Frontend (P4 later; P1 ships API only)
Minimal admin UI can wait — P1 exposes REST so P4 builds on it.

## 4. Operational Risks

| Risk | Mitigation |
|---|---|
| Input swap briefly restarts the stream on Flussonic | Document; execute swaps at item boundaries; log `stream_events` |
| Missed window while app down | Jobs `skipped` not replayed; operator alerted via `stream_events` + optional telegram |
| Two jobs race for same stream | UNIQUE(stream_id,start_at_utc) + atomic status claim |
| TZ/DST bugs | Store UTC exclusively; TZ only for input/display |
| Accidental live-stream interruption | `lifecycle_state='live'` guard option on jobs; dry-run field for previewing input diff |
| FFmpeg absent on Windows host | P2 detects binary at startup; overlay features disabled with clear error |

## 5. Prioritized Implementation Plan

| Order | Milestone | Deliverable |
|---|---|---|
| 1 | **P1 — Scheduled playout** (this branch) | `playout_schedules` + `playout_jobs`, `services/scheduler.ts`, CRUD + preview routes, restart recovery, tests |
| 2 | P3-lite hooks | Job events into `stream_events`; schedule status in `/details` |
| 3 | **P2 — Overlay pipeline** | FFmpeg probe, logo/ticker render → isolated test stream ingest |
| 4 | **P3 — Broadcast monitoring** | Playout progress, now/next endpoints, alerting on job failures |
| 5 | **P4 — Ops dashboard** | Schedule editor, EPG view, overlay editor |
| 6 | **P5 — Release readiness** | Failure-injection tests, perf, docs, rollback |

## 6. P1 Acceptance Criteria

- [ ] `POST /api/schedules` creates schedule + generates jobs (validated, no overlaps)
- [ ] Due job swaps stream inputs on mock Flussonic; `stream_events` records it
- [ ] Restart mid-job → correct recovery (no replay of stale content)
- [ ] Overlapping job → 409
- [ ] `GET /api/streams/:id/schedule/next` returns now/next
- [ ] Client-role users cannot create/modify schedules (admin only)
- [ ] 54 existing tests still pass + new scheduler tests

---

**Next action:** implement P1 on branch `feature/phase-3-scheduled-playout`.

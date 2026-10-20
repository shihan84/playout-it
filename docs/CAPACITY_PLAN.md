# Capacity & Scaling Plan (Phase D)

Cost model and scaling path toward 50+ channels. All numbers are estimates —
Phase F validates them with real load tests.

## Cost model per component

| Component | Cost driver | Budget notes |
|---|---|---|
| **Overlay worker** (ffmpeg decode + logo/ticker + encode) | ~0.5–1.5 CPU cores per worker at 1080p25 h264/veryfast; ~100–200 MB RSS | Dominant resource. `OVERLAY_MAX_WORKERS` (default 8) caps fleet. |
| **Scheduler swap** | one Flussonic PUT per window boundary | negligible; tick `SCHEDULER_TICK_MS` (default ~1s, test 400ms) |
| **Watchdog tick** | 1 GET `/streams` per server per `watchdog_interval` (60s) | `mapLimit(servers, 4)` bounds concurrency |
| **Auto-sync** | full stream + VOD inventory per server per effective interval | `mapLimit(servers, 4)`; per-server `sync_interval_secs` staggers load (fixed in this PR — see below) |
| **HTTP/API** | SQLite `better-sqlite3`, synchronous single-writer (WAL) | Single-process constraint is intentional; fine at this scale |
| **WebSocket fan-out** | one JSON message per broadcast per connected client | small; clients scoped by role |

## Worker budget formula

```
OVERLAY_MAX_WORKERS ≈ floor((physical_cores − reserve) / cores_per_worker)
```

- `reserve` ≈ 1–2 cores for the management server, OS, and Flussonic-side costs
- `cores_per_worker` ≈ 1.0 conservative at 1080p; 0.5 for 720p or lower bitrates
- Example: 8-core box → max ~6 workers at 1080p, ~12 at 720p
- **50+ channels does NOT mean 50+ overlay workers** — only channels that need
  logo/ticker processing consume a worker. Unprocessed channels are pass-through.

## Scaling path to 50+ channels

1. **Watchdog**: per-server cycles are already bounded (4 concurrent). At 50+
   channels across N servers the tick stays O(servers); consider raising
   `watchdog_interval` to 120s+ if servers are numerous.
2. **Auto-sync**: per-server `sync_interval_secs` now correctly staggers syncs
   (the fixed bug had every non-override server syncing at the *shortest*
   override rate — at 50 channels across mixed overrides this would have
   multiplied remote inventory calls several-fold).
3. **Overlay fleet**: size `OVERLAY_MAX_WORKERS` per the formula; a channel
   needing continuous overlay counts as 1 permanent worker — auto-restart
   keeps it alive within the same cap.
4. **Monitoring queries**: bounded (`LIMIT 200` job lists, event pruning in
   settings). Keep retention pruning enabled before 50-channel operation.
5. **Single process**: SQLite WAL + synchronous driver is correct up to this
   scale; a second app instance would need a shared rate-limit store and is
   not supported today.

## Failure diagnostics (this PR)

`describeNetError()` in `services/flussonic.ts` classifies request failures
before they land in `servers.last_error` / Telegram alerts:

| Condition | Stored diagnostic |
|---|---|
| HTTP 401/403 | `authentication rejected (HTTP 4xx)` |
| HTTP 404 | `endpoint not found (check Flussonic version/API path)` |
| HTTP ≥500 | `remote server error (HTTP 5xx)` |
| axios timeout | `request timed out` |
| ECONNREFUSED | `connection refused — Flussonic not listening at host:port` |
| ENOTFOUND/EAI_AGAIN | `DNS resolution failed` |
| ECONNRESET | `connection reset by remote (TLS mismatch or restart mid-request)` |
| TLS codes | `TLS certificate error (<code>)` |

## Deferred to Phase E/F (needs real infrastructure)

- Per-worker CPU/RSS instrumentation (procfs `/proc/<pid>/stat` on Linux,
  WMI on Windows) feeding the monitoring dashboard
- Measured ffmpeg cost at target resolution/bitrate on the production host
- 50+ channel soak test and memory ceiling verification

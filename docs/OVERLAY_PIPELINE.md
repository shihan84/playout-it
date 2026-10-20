# Overlay Pipeline — Operations Reference

Phase 3 P2/P6 + PR #11 hardening. Per-channel FFmpeg workers that pull a
source, composite a logo and/or scrolling ticker, and publish to an
**explicit, isolated destination**. Source channels are never modified.

## Protocol / muxer matrix

Publishing protocol is restricted to verified Flussonic ingest paths only:

| output_url scheme | FFmpeg muxer | Flussonic ingest | Status |
|---|---|---|---|
| `rtmp://` | FLV | RTMP publish (`publish`/`live` app) | Supported |
| `rtmps://` | FLV | RTMPS publish | Supported |
| `srt://` | MPEG-TS | SRT listener/ingest | Supported |
| `udp://` | MPEG-TS | UDP multicast/unicast TS ingest | Supported |
| `http(s)://` | — | **Rejected** — ambiguous (HLS pull vs PUT ingest is not a verified publish path) and widens SSRF surface | Blocked at validation AND at job start (defense in depth) |
| anything else | — | — | Blocked |

`buildArgs` selects `-f flv` for rtmp(s), `-f mpegts` for srt/udp — anything
else never reaches spawn.

## Hard requirements

- **`output_url` is mandatory.** No ingest endpoint is guessed or derived.
  `startOverlay` fails closed with 400 before any capability check.
- **`output_stream` must differ from the source stream name** — always 409.
- **Isolation checks run before capability checks**, so a 409 policy
  violation is reported even when ffmpeg is absent or the feature is gated
  off. Rejected: output == input URL, output targeting the source stream on
  the same host (any port, percent-encoded, `folder/name` multi-segment
  names), output matching any configured source input, A→B/B→A profile
  cycles, and two profiles publishing to the same destination.
- **Logo confinement:** `logo_path` must live under `OVERLAY_ASSET_DIR`
  (default `<cwd>/assets/overlay`). `..\` traversal, outside-absolute paths
  and symlink/junction escapes are rejected at write time and re-verified
  (existence + realpath) at job start.
- **Credential redaction:** `user:pass@` inside `output_url` is masked
  (`***`) in every API response; PATCH ignores echoed-back redacted URLs so
  credentials are never overwritten by the UI.

## Enable gate (off by default)

Workers only start when `settings.overlay_enabled = '1'` **or**
`OVERLAY_ENABLED=1`. Unarmed → 409, no ffmpeg spawned. Do not arm against
production channels until staging proof exists.

## Resource limits

- `MAX_PER_STREAM = 1` — one worker per channel (409 on second start).
- `OVERLAY_MAX_WORKERS` (default **8**) — global ffmpeg process cap; a
  saturated pool returns 429. Each worker is a full decode+encode —
  budget ~0.5–1 core per SD channel, more for HD.
- stderr tails are bounded (4 KB kept, 1 KB persisted).
- `stopOverlay` SIGTERMs, escalates to SIGKILL after ~5 s — no zombies.
- On app boot, stale `starting`/`running` jobs are reconciled so a crash
  never leaves a ghost.

## drawtext escaping

Ticker text is emitted **unquoted** with two-level backslash escaping
(drawtext option level, then filtergraph args level). Do **not** wrap it in
single quotes — `\'` inside `'...'` breaks ffmpeg's args parser and lets
the `[v_out]` label be swallowed into `boxcolor` (verified defect). The
pipeline runs `expansion=none`, so `%` is literal — no `%%` doubling.

## Expected stream behavior

- Input swaps/restarts are **not** involved — the worker reads the source
  like any client. The *output* stream is a separate Flussonic stream.
- Output is frame-composited, not frame-accurate passthrough: expect a few
  seconds of encode latency and normal publishing discontinuities when a
  worker starts/stops/crashes.
- Worker crash → job row `exited`/`failed` + `last_error` tail +
  stream event. Recovery is manual (restart from UI/API); there is no
  auto-restart yet.

## Windows deployment notes

- Requires ffmpeg + ffprobe on PATH (GPL build recommended for
  `drawtext`/`overlay`); `FFMPEG_PATH` overrides the binary name.
- `OVERLAY_ASSET_DIR` may be a Windows path — `\` and `/` are both
  normalized; junctions/symlinks are resolved via `realpath`.
- `OVERLAY_MAX_WORKERS`, `OVERLAY_ENABLED` are env vars; the settings-table
  `overlay_enabled` key is the equivalent runtime toggle.

## Scaling assumptions (50+ channels)

The 8-worker default is deliberately conservative. For 50+ channels you
need 50+ ffmpeg processes — plan ~1 core per SD transcode, prefer SRT/UDP
(local) over RTMPS (TLS cost), and consider a dedicated encoder host. A
single Node process + SQLite is the deployment model; horizontal scaling
requires a worker queue redesign — out of scope here.

## Continuous-playout gap (explicit)

This pipeline plus the P1 scheduler implements **scheduled input swaps**,
not continuous frame-accurate playout. A true playout engine (gapless
file-to-file transitions, no stream restart at boundaries) needs a separate
persistent FFmpeg/GStreamer process model feeding a stable Flussonic
publish endpoint — tracked as future work, not claimed here.

## Automatic worker recovery (Phase C)

Crashed overlay workers can auto-restart — requires BOTH the per-profile
`auto_restart` flag AND the global gate (`settings.overlay_auto_restart=1` or
`OVERLAY_AUTO_RESTART_ENABLED=1`). Both default OFF.

| Env var | Default | Meaning |
|---|---|---|
| `OVERLAY_RESTART_MAX_ATTEMPTS` | 5 | retries before the job is marked `failed` |
| `OVERLAY_RESTART_BASE_DELAY_MS` | 5000 | first backoff delay |
| `OVERLAY_RESTART_MAX_DELAY_MS` | 300000 | backoff cap (min 1000) |
| `OVERLAY_RESTART_STABLE_MS` | 60000 | uptime ≥ this resets the retry counter |

- Backoff: `base · 2^(n-1)`, capped, ±10% jitter. Retry lineage persists via
  `overlay_jobs.restart_count` / `next_retry_at` — pending retries survive an
  application restart (`recoverOverlayJobs` resumes remaining delay; stale
  running jobs get a fresh backoff window).
- Every retry re-runs the FULL `startOverlay` validation — isolation, scheme,
  collision and worker caps — so a target that became unsafe during backoff
  aborts instead of spawning.
- Intentional stops (`stopped`) and exhausted budgets (`failed`) never
  restart. Exhaustion records a stream event and sends a Telegram alert.
- `stderr` tails are credential-scrubbed before persisting (`redactCredsInText`).
- `POST /api/overlays/jobs/:jobId/retry` retries an `exited`/`failed` job now.

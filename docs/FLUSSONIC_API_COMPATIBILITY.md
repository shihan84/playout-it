# Flussonic OpenAPI Compatibility Audit (Phase 2 P5)

Audited against `docs/flussonic/references/media-server.openapi.json` (Flussonic 21.12.1, OpenAPI 3.1, verified manifest).

## Endpoints used vs. spec

| Our usage | Spec path | Status |
|---|---|---|
| `GET /flussonic/api/v3/streams` | `/streams` → `streams_list` | ✅ `{streams: [...], next}` envelope handled |
| `GET /flussonic/api/v3/streams/{name}` | `/streams/{name}` → `stream_config` | ✅ |
| `PUT /flussonic/api/v3/streams/{name}` `{inputs:[{url}], pushes:[{url}]}` | `stream_config.inputs`/`pushes` | ✅ spec-conformant |
| `DELETE /flussonic/api/v3/streams/{name}` | `/streams/{name}` delete | ✅ |
| `GET /flussonic/api/v3/vods` | `/vods` → `vods_list` | ✅ `{vods: [...]}` envelope handled |
| `PUT/GET/DELETE /flussonic/api/v3/vods/{prefix}` `{storages:[{url}]}` | `vod_config.storages` → `vod_storage.url` | ✅ spec-conformant |
| `GET/PUT/DELETE /vods/{prefix}/storages/0/files[/{subpath}]` | `/vods/{prefix}/storages/{storage_index}/files[/{subpath}]` → `disk_files_list` | ✅ `{files: [...]}` handled; bare arrays tolerated as fallback |

## Pagination

- Spec defines `cursor` query param + `next` field in `collection_response` ("properly encoded equivalent of offset"). Our opaque-cursor echo as `?cursor=` is spec-correct; URL-shaped `next` values remain confined to the configured origin + `/flussonic/api`.
- `/vods/{prefix}/storages/{i}/files` responses are also paginated (`disk_files_list` includes `next`). `syncVodFilesFromRemote` now follows `next` cursors via `fetchAllPages()` — large VOD libraries are fully enumerated.

## Stats fields

- `stats.alive`, `stats.bitrate`, `stats.lifetime`, `stats.online_clients`, `stats.media_info` — all in `stream_stats`. ✅
- **Drift fixed:** `stats.input_alive` does **not** exist in the spec. Per-input state is `stats.inputs[].active` (`input_stats`). Watchdog now uses `input_alive` OR `stats.inputs[].active`; `streams.ts /details` still reads `inputs[0].stats` presence, which is a config-input field — kept as best-effort, noted here.
- `stats.client_count` — spec uses `online_clients`; details falls back to `fStats.client_count || 0`. **Minor drift:** prefer `online_clients`. (Non-blocking; flagged.)

## Payload drift (documented, retained intentionally)

- `PUT /vods/{name}` fallback `{storage: path}` in `streams.ts`/`channels` paths is **not** spec-conformant (`vod_config` has `storages` array only). Retained as a legacy retry for very old Flussonic builds; spec-conformant `{storages:[{url}]}` is always tried first.
- Sync accepts bare-array `/streams` responses; spec returns the `streams_list` envelope. Bare arrays remain tolerated for older servers; envelope path is preferred and validated.

## Non-goals confirmed

- No use of undocumented endpoints; all paths exist in `media-server.openapi.json`.
- `config_on_disk` (read in `/details`) is not in `stream_config` properties — likely returned but undocumented; treated as optional.

## Remaining risk

- `client_count` vs `online_clients` naming drift — display field only (both handled via fallback).

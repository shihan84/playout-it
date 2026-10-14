# Flussonic API catalog

Source of truth: https://flussonic.com/doc/fms/api/about-apis/
Last reviewed: 2026-10-14.

## Official API families
| Family | Documentation | Intended use |
|---|---|---|
| Media Server | https://flussonic.com/doc/api/reference/ | Streams, VOD, DVR, monitoring, sessions, server configuration |
| Streaming | https://flussonic.com/doc/api/streaming/ | Playback and ingest protocols |
| Central | https://flussonic.com/doc/api/central/ | Centralized administration (optional) |
| Authorization backend | https://flussonic.com/doc/api/authorization/ | Viewer authorization |
| External configuration | https://flussonic.com/doc/api/config-external/ | External stream configuration |
| Watcher Client | https://flussonic.com/doc/fms/api/about-apis/ | Surveillance (out of current scope) |
| Watcher Admin | https://flussonic.com/doc/fms/api/about-apis/ | Surveillance (out of current scope) |
| Custom stream layout manager | https://flussonic.com/doc/fms/api/about-apis/ | Custom layouts (optional) |

These are reference links, not a claim that all families have been downloaded or validated.

## Machine-readable specification
- Existing root `openapi.json`: Media Server OpenAPI 3.1.0, version 26.03-604, 74 paths, 139 HTTP operations, 493 component schemas (verified 2026-10-14).
- Official reference JSON: https://flussonic.com/doc/api/reference.json
- Per-server schema: `http://SERVER:8080/streamer/api/v3/schema` (validate against the actual deployment).
- Do not automatically overwrite the pinned root specification: review upstream diffs and server version compatibility first.

## Key Media Server endpoints (relative to documented API base)
| Function | Method/path |
|---|---|
| Streams | GET /streams; GET/PUT/DELETE /streams/{name} |
| Stop stream | POST /streams/{name}/stop |
| DVR ranges | GET/DELETE /streams/{name}/dvr/ranges |
| DVR export | POST /streams/{name}/dvr/export |
| VOD locations | GET /vods; GET/PUT/DELETE /vods/{prefix} |
| VOD storage files | GET /vods/{prefix}/storages/{storage_index}/files |
| VOD file | GET/PUT/DELETE /vods/{prefix}/storages/{storage_index}/files/{subpath} |
| Sessions | GET /sessions; GET/DELETE /sessions/{id} |
| Templates | GET /templates; GET/PUT/DELETE /templates/{name} |
| Statistics | GET /config/stats |
| Health | GET /monitoring/liveness; GET /monitoring/readiness |
| Configuration | GET/PUT/POST /config |
| File processing | POST /file_processor/jobs; GET/DELETE /file_processor/jobs/{id} |
| IPTV | GET/PUT/DELETE /iptv; packages and subscribers under /iptv/ |
| Events | GET /event_sinks; GET/PUT/DELETE /event_sinks/{name} |

## Integration conventions
1. Resolve the actual API base URL per Flussonic version. The pinned spec advertises `/streamer/api/v3`; existing application calls often use `/flussonic/api/v3`. Test rather than assume equivalence.
2. Keep Flussonic credentials server-side; never return authorization headers or raw credentials to browsers.
3. Use typed request/response schemas, encoded path parameters, timeouts, bounded retries, and explicit error reporting.
4. Distinguish read-only and mutating operations; require authorization and confirmation for destructive operations.
5. The API supports Basic and Bearer authentication; privileges depend on server configuration.
6. Flussonic documents upsert behavior and nullable fields for disabling features; avoid relying on undocumented response fields.
7. Record upstream version, retrieval date, and checksum when refreshing specifications.

## Related documentation
- https://flussonic.com/doc/fms/api/flussonic-api-design/
- https://flussonic.com/doc/fms/api/streaming-api/
- https://flussonic.com/doc/fms/dvr/api/

## Next steps
- Obtain and validate machine-readable schemas for other relevant API families where published.
- Generate a versioned typed client from the pinned spec and add contract tests.
- Check live server capabilities before enabling endpoints.
- Keep this documentation independent of application code changes.

# Phase 1B — Multi-Flussonic Server Management (handoff)

Phase 1A security foundation is staged on `feature/broadcast-security-foundation` (PR #1, draft, not merged).

## Baseline state entering 1B

- Modular backend under `src/server/` (config / db / middleware / routes / services / websocket / utils).
- Server auth model: `username` + `password` (Basic) with `api_key` backfill; `getServerAuthHeader()` in `services/flussonic.ts`.
- All mutating/admin routes guarded; `/api/vods` admin-only; `/api/settings` admin-only; `/api/watchdog/restart` admin-only.
- Cookie sessions carry `sameSite: 'lax'` + CSRF marker (`X-Requested-With`) enforced by `middleware/csrf.ts`; Bearer auth unaffected.
- `/ws` upgrades require a valid JWT cookie (`verifyWsAuth` in `websocket/index.ts`).
- Tests: `tests/security-regression.test.ts` (6 source checks) + `tests/http-auth.integration.test.ts` (8 real HTTP/WS tests vs spawned prod server + mock Flussonic).
- Deps: bcrypt@6; npm audit = 2 vulns (esbuild low via tsx, qs moderate). Zero critical/high.

## Suggested scope for Phase 1B

1. **Multi-server stream view** — aggregate streams across servers with per-server health grouping (watchdog already groups by server).
2. **Per-server sync control** — independent auto-sync intervals or manual sync per server; surface per-server sync errors in UI.
3. **Server health dashboard** — metrics (`/api/servers/:id/metrics`) aggregation; note current metrics route mount may be double-nested (`/api/servers/:id/metrics/:id`) — verify/fix.
4. **Client-role scoping** — stream assignments already exist; extend to VOD/session views if required.
5. **Failover / redundancy** (optional): multiple Flussonic origins per stream, push/pull failover docs.
6. **Integration test expansion** — sync reconciliation against mock Flussonic streams/vods payload shapes; multi-server watchdog behavior.

## Carry-over risks / open items

- WebSocket broadcasts are all-or-nothing (`STREAMS_UPDATE` to every client) — consider per-user scoping in 1B.
- Sessions/block-IP routes under `/api` mount — verify role guards during 1B.
- `GET /api/streams/:id/details` leaks `flussonic_error` internals — acceptable for admin UI but review for client-role visibility.
- Frontend bundle ~1 MB — consider code-splitting.
- Watchdog currently polls every configured interval globally; multi-server scale may need per-server cadence or concurrency limits.

## Verification gates (same protocol)

- `npm ci`, `npm run lint`, `npx tsx --test tests/*.test.ts`, `npm run build`, `npm audit` — record in `docs/AI_COLLABORATION.md` + PR.
- No merge/deploy without explicit user approval.

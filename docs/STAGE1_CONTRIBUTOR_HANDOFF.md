# Stage 1 contributor / Devin AI handoff

## Scope
Security foundation only. SCTE-35 is deferred. PostgreSQL migration, scheduler, and live/VOD playout are subsequent workstreams.

## Pull and test
```bash
git fetch origin
git switch feature/broadcast-security-foundation
git pull --ff-only origin feature/broadcast-security-foundation
npm ci
npm run lint
npx tsx --test tests/security-regression.test.ts
npm run build
```

Use a disposable staging database and non-production Flussonic servers. Do **not** point this branch at production.

## Critical integration tests for contributor / Devin
1. Verify admin and non-admin/anonymous access to every VOD route (including chunk uploads, sync and playlist updates).
2. Verify GET/POST server responses do not include api_key, username or password. Check nested Flussonic config and status responses for embedded secrets too.
3. Verify deleting a server only detaches local streams/VODs and never calls remote DELETE. Confirm UI can handle null server_id.
4. Confirm VOD browser upload still works. Direct browser upload based on returned upstream authorization headers is intentionally disabled and may require a backend upload redesign.
5. Verify fresh installation has no default administrator. Design a one-time, securely provisioned admin bootstrap before deployment.
6. Verify corrupted SQLite DB/WAL/SHM files are preserved and startup fails closed.
7. Test malicious uploadId, filename, chunk index, huge files, abandoned sessions, disk quotas and cleanup.
8. Review auth cookie/JWT handling, CSRF protection, websocket authorization and authorization on remaining routes.
9. Verify actual staging Flussonic API base paths, API credentials, health checks and sync behavior.
10. Capture lint, test, build, and staging results in PR #1.

## Merge gates
- All CI checks green, meaningful HTTP integration tests, and staging signoff.
- Backup/restore demonstrated, rollback procedure documented.
- Production deployment requires explicit manual approval; do not merge or deploy automatically.
- Coordinate changes on this branch with the contributor to avoid overwriting concurrent commits.

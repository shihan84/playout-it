# Flussonic OpenAPI snapshots

Run `python3 scripts/sync_flussonic_apis.py --strict` to download official machine-readable API references, validate OpenAPI structure, and write normalized JSON snapshots with SHA-256 checksums in `manifest.json`.

A scheduled GitHub Actions workflow runs weekly and can also be triggered manually. It commits changes only when a schema changes. If an upstream endpoint fails, strict mode fails the job and **does not commit** partial updates. Previously committed snapshots remain intact.

Currently configured official JSON references: Media Server, Streaming, Central, Authorization Backend, and External Configuration. Watcher Client, Watcher Admin, and Custom Stream Layout Manager require confirmation of their canonical schema download URLs before being added. Their API landing pages are listed in `../API_CATALOG.md`.

**Important:** The root `openapi.json` is a separate application-pinned specification and is not overwritten by this maintenance process. Upstream changes should be reviewed before updating generated clients or production integrations.

The initial GitHub commit installs the fetch process. The first workflow run is responsible for obtaining actual upstream JSON; do not treat files as downloaded until the workflow succeeds and the snapshots appear here.

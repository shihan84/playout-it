# Staging VOD Upload Test Plan

**Prerequisite:** a reachable staging Flussonic server (URL + admin username/password), and this app deployed or running locally with admin credentials provisioned via `npm run admin:provision`.

## Setup

1. Add the staging server in **Servers** UI (name, URL, username, password).
2. Confirm server shows `online` and streams/VODs sync.
3. Create a VOD location in **VODs** pointing at staging storage, or reuse an existing synced VOD.

## Cases

| # | Case | Steps | Expected |
|---|------|-------|----------|
| 1 | Small file (<5 MB, single chunk) | Upload via VodFileManager | `complete-chunked` → file appears in `vod_files`, visible on Flussonic `/vods/:name/storages/0/files` |
| 2 | Multi-chunk file (>10 MB) | Upload a larger file | All chunks uploaded in order; assembled file size matches source |
| 3 | Partial failure | Kill network mid-upload (or block a chunk request via devtools) | Failed file shows error notification; other files continue; `failedUploads` count prevents false success toast |
| 4 | Invalid filename | Attempt `../evil.mp4` / name with `/` | 400 rejected by `init-chunked` validation |
| 5 | Unauthenticated upload | Call `/api/vods/:id/files/*` without cookie | 401 |
| 6 | Client role upload | Logged-in client calls `/api/vods/:id/files/*` | 403 |
| 7 | Credential non-disclosure | Inspect network tab during upload | No `Authorization: Basic` to Flussonic origin; `upload-info` returns `directUploadSupported:false`, no `authHeader` |
| 8 | Playlist regeneration | After upload, open playlist preview | `playlist.txt` lists new file; VOD input updated if stream-linked |
| 9 | File delete | Delete a file in manager | Removed from Flussonic storage + `vod_files` row |
| 10 | Sync reconciliation | Add a file directly on Flussonic, then "Sync files" | New file appears in `vod_files` |

## Evidence to capture

- Request/response logs for chunked flow (init-chunked → chunk×N → complete-chunked → confirm-upload)
- Flussonic-side `ls` of storage dir before/after
- DevTools network trace proving zero `Authorization` headers to Flussonic origin
- Failure-path screenshot (notification text) for case 3/4

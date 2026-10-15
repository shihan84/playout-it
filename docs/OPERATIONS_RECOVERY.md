# Operations Recovery Procedures

Manual reconciliation steps for partial failures between IBS Manager (local SQLite)
and Flussonic (remote streaming servers).

---

## 1. Stream rename/move partial failure

**Scenario:** `PUT /api/streams/:id` created the new remote stream but the local
DB update failed. The response includes `"detail": "Remote compensation attempted"`.

**What happened:**
- New remote stream exists on the destination server
- Old remote stream still exists on the source server (not deleted — cleanup runs
  after the local update, so it's skipped on DB failure)
- Local DB retains the old stream name/server_id

**Recovery:**
1. Check server logs for `[streams PUT] compensation` messages
2. If compensation succeeded: the new remote stream was deleted. Retry the rename.
3. If compensation failed: log shows `compensation FAILED: could not delete 'X'`.
   - Manually delete stream `X` on the destination Flussonic server
   - Or via API: `DELETE {server_url}/flussonic/api/v3/streams/{name}`
4. Retry the rename once the remote state is clean

**Detection:** Compare local stream names vs Flussonic inventory:
```bash
# List remote streams on a Flussonic server
curl -u user:pass http://flussonic:8080/flussonic/api/v3/streams

# List local streams in the DB
sqlite3 flussonic.db "SELECT id, name, server_id FROM streams"
```

---

## 2. Companion VOD orphaned

**Scenario:** Stream creation/update succeeded locally but the VOD was created
remotely and the stream PUT failed. The VOD rollback may have also failed.

**Recovery:**
1. Check logs for `rollback: failed to delete companion VOD`
2. List remote VODs: `curl -u user:pass http://flussonic:8080/flussonic/api/v3/vods`
3. Delete the orphaned VOD: `curl -u user:pass -X DELETE http://flussonic:8080/flussonic/api/v3/vods/{name}_vod`
4. Remove the local VOD row:
   ```sql
   DELETE FROM vods WHERE name = '{name}_vod' AND server_id = {id};
   ```

---

## 3. Old remote stream not cleaned up after successful rename

**Scenario:** Rename succeeded (local row updated, new remote stream exists) but
the old remote stream DELETE failed. Non-fatal — the log shows
`cleanup of old remote stream (non-fatal)`.

**Impact:** Old stream still exists on Flussonic — it may still accept connections
but is no longer managed by IBS Manager.

**Recovery:**
1. Check logs for the old stream name
2. Verify the old stream is truly orphaned:
   ```bash
   curl -u user:pass http://flussonic:8080/flussonic/api/v3/streams/{old_name}
   ```
3. Delete it manually:
   ```bash
   curl -u user:pass -X DELETE http://flussonic:8080/flussonic/api/v3/streams/{old_name}
   ```

---

## 4. Channel creation partial failure

**Scenario:** `POST /api/channels` created the VOD and/or stream on Flussonic
but the local DB insert failed. Compensation attempted automatically.

**Recovery:**
1. Check logs for `rollback:` messages — the system attempts to clean up
   everything it created
2. If rollback failed, check for the specific resource:
   - `rollback: failed to delete VOD` → delete `"{name}_vod"` on the server
   - `rollback: failed to delete stream` → delete `"{name}"` on the server
3. Local DB should be clean — `INSERT` rolls back the transaction

---

## 5. WebSocket sessions exceeding max_sessions

**Scenario:** Admin lowered `max_sessions` but existing sockets remain open.

**Current behavior:** `enforceMaxSessions()` is called on assignment create/update
and closes excess sockets with code 4409.

**Manual check:** Active WebSocket connections aren't directly queryable.
Restart the application to force-close all sockets if needed.

---

## 6. Periodic reconciliation drill

Run quarterly or after any incident involving remote failures:

```bash
# 1. List all local streams per server
sqlite3 flussonic.db "SELECT s.name, sv.name as server_name FROM streams s JOIN servers sv ON s.server_id = sv.id"

# 2. List all remote streams per server (requires credentials)
curl -u user:pass http://flussonic:8080/flussonic/api/v3/streams

# 3. Compare: any remote stream not in the local list is orphaned
# 4. Compare: any local stream not on the remote is a phantom entry

# 5. Same for VODs
sqlite3 flussonic.db "SELECT v.name, sv.name as server_name FROM vods v JOIN servers sv ON v.server_id = sv.id"
curl -u user:pass http://flussonic:8080/flussonic/api/v3/vods
```

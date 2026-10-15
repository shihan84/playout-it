import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import { db } from '../db';
import { flussonicRequest, resolveCompanionVodName } from '../services/flussonic';
import { updatePlaylistFile } from '../services/playlist';
import { broadcastStreamsUpdate } from '../websocket';
import { parseStream } from '../utils/streams';
import { authenticateToken, requireAdmin, requireStreamAccess, AuthRequest } from '../middleware/auth';
import { transitionStream, getStreamEvents, allowedTransitions, isLifecycleState, recordStreamEvent } from '../services/lifecycle';

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 1000 * 1024 * 1024 * 1024 }
});

const router = Router();

router.get('/', authenticateToken, (req: AuthRequest, res) => {
  try {
    let streams;
    if (req.user.role === 'admin') {
      streams = db.prepare(`
        SELECT streams.*, servers.name as server_name, servers.url as server_url 
        FROM streams 
        LEFT JOIN servers ON streams.server_id = servers.id
      `).all();
    } else {
      streams = db.prepare(`
        SELECT streams.*, servers.name as server_name, servers.url as server_url 
        FROM streams 
        LEFT JOIN servers ON streams.server_id = servers.id
        JOIN user_stream_assignments ON streams.id = user_stream_assignments.stream_id
        WHERE user_stream_assignments.user_id = ?
          AND (user_stream_assignments.expires_at IS NULL OR datetime(user_stream_assignments.expires_at) > datetime('now'))
      `).all(req.user.id);
    }

    const parsedStreams = streams.map(parseStream);
    res.json(parsedStreams);
  } catch (error: any) {
    console.error('Failed to fetch streams:', error);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  const { server_id, name, inputs, push_urls } = req.body;

  // Input validation
  if (!server_id || typeof server_id !== 'number') {
    return res.status(400).json({ error: 'Valid server ID is required' });
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Stream name is required' });
  }
  if (!inputs || !Array.isArray(inputs) || inputs.length === 0) {
    return res.status(400).json({ error: 'At least one input URL is required' });
  }
  if (push_urls && !Array.isArray(push_urls)) {
    return res.status(400).json({ error: 'Push URLs must be an array' });
  }

  const pushes = (push_urls || []).map((url: string) => ({ url }));
  const streamInputs = (inputs || []).map((url: string) => ({ url }));

  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const baseUrl = server.url.replace(/\/$/, '');
    // Automatically create a VOD folder for this stream. Flussonic shares a
    // namespace between streams and VODs, so the VOD name must differ.
    const vodName = `${name}_vod`;
    const vodPath = `/storage/${vodName}`;

    // Check if VOD already exists in DB
    const existingVod = db.prepare('SELECT * FROM vods WHERE name = ? AND server_id = ?').get(vodName, server_id);
    let vodCreated = false;
    if (!existingVod) {
      const vodPayload = {
        storages: [{ url: vodPath }]
      };
      const flussonicVodUrl = `${baseUrl}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}`;
      try {
        await flussonicRequest('PUT', flussonicVodUrl, server, vodPayload);
      } catch (e: any) {
        console.warn(`Flussonic create VOD error for ${vodName}:`, e.message);
        try {
          await flussonicRequest('PUT', flussonicVodUrl, server, { storage: vodPath });
        } catch (e2: any) {
          console.warn('Alternative VOD create also failed:', e2.message);
          return res.status(502).json({ error: `Failed to create companion VOD on Flussonic: ${e2.message}` });
        }
      }
      vodCreated = true;
      db.prepare('INSERT INTO vods (server_id, name, paths) VALUES (?, ?, ?)').run(server_id, vodName, JSON.stringify([vodPath]));
    }

    // Configure stream on Flussonic
    const flussonicUrl = `${baseUrl}/flussonic/api/v3/streams/${encodeURIComponent(name)}`;

    const payload: any = {
      inputs: streamInputs
    };
    if (pushes.length > 0) {
      payload.pushes = pushes;
    }

    try {
      await flussonicRequest('PUT', flussonicUrl, server, payload);
    } catch (e: any) {
      // Roll back the VOD we just created — no phantom locals.
      if (vodCreated) {
        db.prepare('DELETE FROM vods WHERE server_id = ? AND name = ?').run(server_id, vodName);
        await flussonicRequest('DELETE', `${baseUrl}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}`, server)
          .catch(dErr => console.warn('[streams POST] rollback: failed to delete orphan remote VOD:', dErr.message));
      }
      return res.status(502).json({ error: `Failed to create stream on Flussonic: ${e.message}` });
    }

    const stmt = db.prepare('INSERT INTO streams (server_id, name, live_url, playlist_url, push_urls, inputs) VALUES (?, ?, ?, ?, ?, ?)');
    // Keep live_url and playlist_url empty for backward compatibility in DB, use inputs
    const info = stmt.run(server_id, name.trim(), '', '', JSON.stringify(push_urls || []), JSON.stringify(inputs || []));
    recordStreamEvent(Number(info.lastInsertRowid), null, 'live', (req as AuthRequest).user.id, 'stream created');

    broadcastStreamsUpdate();
    res.json({ id: info.lastInsertRowid, server_id, name, inputs, push_urls });
  } catch (error: any) {
    console.error('Error creating stream on Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to configure stream on Flussonic' });
  }
});

router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { server_id, name, inputs, push_urls } = req.body;

  // Input validation
  if (!server_id || typeof server_id !== 'number') {
    return res.status(400).json({ error: 'Valid server ID is required' });
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Stream name is required' });
  }
  if (!inputs || !Array.isArray(inputs) || inputs.length === 0) {
    return res.status(400).json({ error: 'At least one input URL is required' });
  }
  if (push_urls && !Array.isArray(push_urls)) {
    return res.status(400).json({ error: 'Push URLs must be an array' });
  }

  const pushes = (push_urls || []).map((url: string) => ({ url }));
  const streamInputs = (inputs || []).map((url: string) => ({ url }));

  try {
    const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id) as any;
    if (!stream) return res.status(404).json({ error: 'Stream not found' });

    const dstServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
    if (!dstServer) return res.status(404).json({ error: 'Server not found' });

    // Resolve old (source) server — may differ from destination on cross-server moves
    const srcServer = stream.server_id !== server_id
      ? db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any
      : dstServer;

    const trimmedName = name.trim();
    const isRename = stream.name !== trimmedName;
    const isCrossServer = stream.server_id !== server_id;
    const dstBaseUrl = dstServer.url.replace(/\/$/, '');

    // ---- Pre-flight: reject collisions BEFORE any remote changes -----------
    if (isRename || isCrossServer) {
      // Local collision: another stream already owns this name on the destination server
      const localDup = db.prepare(
        'SELECT id FROM streams WHERE server_id = ? AND name = ? AND id != ?'
      ).get(server_id, trimmedName, req.params.id) as any;
      if (localDup) {
        return res.status(409).json({ error: `Stream '${trimmedName}' already exists on this server (local)` });
      }

      // Remote collision: the name already exists on the destination Flussonic
      const probeUrl = `${dstBaseUrl}/flussonic/api/v3/streams/${encodeURIComponent(trimmedName)}`;
      try {
        await flussonicRequest('GET', probeUrl, dstServer);
        // 200 means the name is taken on Flussonic
        return res.status(409).json({ error: `Stream '${trimmedName}' already exists on Flussonic` });
      } catch (probeErr: any) {
        if (probeErr.response?.status !== 404) {
          // Unexpected error — fail closed
          return res.status(502).json({ error: `Cannot verify target availability on Flussonic: ${probeErr.message}` });
        }
        // 404 = name is free — proceed
      }
    }

    // ---- Companion VOD provisioning ----------------------------------------
    const vodName = await resolveCompanionVodName(dstServer, trimmedName);
    const vodPath = `/storage/${vodName}`;
    const existingVod = db.prepare('SELECT * FROM vods WHERE name IN (?, ?) AND server_id = ?').get(vodName, trimmedName, server_id);
    let vodCreated = false;
    if (!existingVod) {
      const flussonicVodUrl = `${dstBaseUrl}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}`;
      try {
        await flussonicRequest('PUT', flussonicVodUrl, dstServer, { storages: [{ url: vodPath }] });
      } catch (e: any) {
        console.warn('Flussonic create VOD error:', e.message);
        return res.status(502).json({ error: `Failed to create companion VOD on Flussonic: ${e.message}` });
      }
      db.prepare('INSERT INTO vods (server_id, name, paths) VALUES (?, ?, ?)').run(server_id, vodName, JSON.stringify([vodPath]));
      vodCreated = true;
    }

    // ---- Create new remote stream ------------------------------------------
    const newStreamUrl = `${dstBaseUrl}/flussonic/api/v3/streams/${encodeURIComponent(trimmedName)}`;
    const payload: any = { name: trimmedName, inputs: streamInputs };
    if (pushes.length > 0) payload.pushes = pushes;

    try {
      await flussonicRequest('PUT', newStreamUrl, dstServer, payload);
    } catch (e: any) {
      // If Flussonic returns 409/422 — the name was taken between our probe and
      // this PUT (TOCTOU race). Treat it as a collision, not a generic failure.
      if (e.response?.status === 409 || e.response?.status === 422) {
        // Another process created it between our probe and PUT — do NOT
        // delete the VOD (it may belong to the other stream's creation)
        return res.status(409).json({
          error: `Stream '${trimmedName}' was created on Flussonic by another process during this request (TOCTOU race)`
        });
      }
      // Clean up companion VOD we just created — don't leave orphaned resources
      if (vodCreated) {
        const vodUrl = `${dstBaseUrl}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}`;
        await flussonicRequest('DELETE', vodUrl, dstServer)
          .catch(ce => console.error('[streams PUT] rollback: failed to delete companion VOD:', ce.message));
        try {
          db.prepare('DELETE FROM vods WHERE server_id = ? AND name = ?').run(server_id, vodName);
        } catch (_) { /* best-effort */ }
      }
      return res.status(502).json({ error: `Failed to create stream on Flussonic: ${e.message}` });
    }

    // ---- Persist locally FIRST — before deleting the old remote stream ------
    // If the UPDATE fails, only the new remote stream needs cleanup (the old
    // one still exists, so no restoration needed).
    try {
      db.prepare('UPDATE streams SET server_id = ?, name = ?, inputs = ?, push_urls = ? WHERE id = ?')
        .run(server_id, trimmedName, JSON.stringify(inputs || []), JSON.stringify(push_urls || []), req.params.id);
    } catch (dbErr: any) {
      // DB failed after remote PUT succeeded but BEFORE old-stream cleanup.
      // Compensation: delete only the NEW remote stream — the old one is
      // still intact on the source server.
      console.error(
        `[streams PUT] DB update failed for stream id=${req.params.id} ` +
        `old='${stream.name}' new='${trimmedName}' — compensating: ${dbErr.message}`
      );
      if (isRename || isCrossServer) {
        await flussonicRequest('DELETE', newStreamUrl, dstServer)
          .then(() => console.log(`[streams PUT] compensation: deleted '${trimmedName}' on destination server`))
          .catch(ce => console.error(
            `[streams PUT] compensation FAILED: could not delete '${trimmedName}' on destination server. ` +
            `Manual cleanup needed: delete stream '${trimmedName}' on server '${dstServer.name}'. ` +
            `Error: ${ce.message}`
          ));
      }
      return res.status(500).json({
        error: `Database update failed: ${dbErr.message}`,
        detail: 'Remote compensation attempted — check server logs for manual recovery steps if needed.'
      });
    }

    // ---- Clean up old remote stream AFTER local update succeeded ------------
    // Now that local state is committed, safely delete the old remote stream.
    if (isRename || isCrossServer) {
      if (srcServer) {
        const srcBaseUrl = srcServer.url.replace(/\/$/, '');
        const oldStreamUrl = `${srcBaseUrl}/flussonic/api/v3/streams/${encodeURIComponent(stream.name)}`;
        await flussonicRequest('DELETE', oldStreamUrl, srcServer)
          .catch(e => console.warn('[streams PUT] cleanup of old remote stream (non-fatal):', e.message));
      }
    }

    broadcastStreamsUpdate();
    res.json({ id: req.params.id, server_id, name: trimmedName, inputs, push_urls });
  } catch (error: any) {
    console.error('Error updating stream on Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to update stream on Flussonic' });
  }
});

router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id) as any;
    if (stream) {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any;
      if (server) {
        // Delete from Flussonic
        const flussonicUrl = `${server.url}/flussonic/api/v3/streams/${encodeURIComponent(stream.name)}`;
        await flussonicRequest('DELETE', flussonicUrl, server)
          .catch(e => console.error('Flussonic delete error (ignored):', e.message));

        // Also try to delete the associated VOD location if it exists
        const vodName = await resolveCompanionVodName(server, stream.name);
        const vodUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}`;
        await flussonicRequest('DELETE', vodUrl, server)
          .catch(e => console.error('Flussonic delete VOD error (ignored):', e.message));
      }
    }
    db.prepare('DELETE FROM streams WHERE id = ?').run(req.params.id);
    if (stream) {
      // Clean up local VOD row under either naming convention
      db.prepare('DELETE FROM vods WHERE name IN (?, ?) AND server_id = ?')
        .run(`${stream.name}_vod`, stream.name, stream.server_id);
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Lifecycle state machine (Phase 2 P0)
router.post('/:id/transition', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
  const { to } = req.body || {};
  if (!to || typeof to !== 'string') {
    return res.status(400).json({ error: 'Target state "to" is required' });
  }
  try {
    const updated = await transitionStream(Number(req.params.id), to as any, req.user.id);
    broadcastStreamsUpdate();
    res.json({ id: updated.id, name: updated.name, lifecycle_state: updated.lifecycle_state });
  } catch (e: any) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/:id/lifecycle', authenticateToken, requireStreamAccess, (req, res) => {
  const stream = db.prepare('SELECT id, name, lifecycle_state FROM streams WHERE id = ?').get(req.params.id) as any;
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  const from = isLifecycleState(stream.lifecycle_state) ? stream.lifecycle_state : 'live';
  res.json({ stream_id: stream.id, name: stream.name, lifecycle_state: from, allowed: allowedTransitions(from), events: getStreamEvents(stream.id) });
});

router.get('/:id/details', authenticateToken, requireStreamAccess, async (req, res) => {
  try {
    const stream = db.prepare(`
      SELECT streams.*, servers.name as server_name, servers.url as server_url, servers.api_key, servers.username, servers.password
      FROM streams 
      LEFT JOIN servers ON streams.server_id = servers.id
      WHERE streams.id = ?
    `).get(req.params.id) as any;

    if (!stream) return res.status(404).json({ error: 'Stream not found' });

    try {
      stream.push_urls = JSON.parse(stream.push_urls || '[]');
    } catch (e) {
      stream.push_urls = [];
    }

    try {
      stream.push_status = JSON.parse(stream.push_status || '[]');
    } catch (e) {
      stream.push_status = [];
    }

    try {
      stream.inputs = JSON.parse(stream.inputs || '[]');
    } catch (e) {
      stream.inputs = [];
    }

    if (stream.server_url && stream.api_key) {
      try {
        const flussonicUrl = `${stream.server_url}/flussonic/api/v3/streams/${encodeURIComponent(stream.name)}`;
        const response = await flussonicRequest('GET', flussonicUrl, { api_key: stream.api_key, username: stream.username, password: stream.password });
        const fData = response.data;

        // Use Flussonic real inputs (has url field)
        const flussonicInputs: any[] = fData.inputs || [];
        const configInputs: any[] = fData.config_on_disk?.inputs || [];
        stream.flussonic_inputs = flussonicInputs;

        // Derive source_type from real Flussonic inputs
        const firstInput = flussonicInputs[0] || configInputs[0];
        const inputUrl: string = firstInput?.url || '';
        if (inputUrl.startsWith('publish://')) {
          stream.source_type = 'publish';
        } else if (inputUrl.startsWith('rtmp://') || inputUrl.startsWith('rtsp://') || inputUrl.startsWith('srt://') || inputUrl.startsWith('udp://') || inputUrl.startsWith('http')) {
          stream.source_type = 'live';
        } else if (inputUrl.includes('.m3u8') || inputUrl.includes('.m3u')) {
          stream.source_type = 'playlist';
        } else if (inputUrl.includes('.mp4') || inputUrl.includes('.mkv') || inputUrl.startsWith('file://')) {
          stream.source_type = 'static';
        } else if (inputUrl) {
          stream.source_type = 'live';
        } else {
          stream.source_type = 'unknown';
        }

        // Use Flussonic real stats
        const fStats = fData.stats || {};
        stream.flussonic_stats = fStats;
        stream.status = (fStats.alive === true || fStats.running === true || fStats.status === 'running') ? 'online' : 'offline';
        stream.input_status = flussonicInputs.length > 0 && flussonicInputs[0].stats ? 'online' : 'offline';
        stream.bitrate = fStats.bitrate || 0;
        stream.client_count = fStats.online_clients ?? fStats.client_count ?? 0;
        // Expose Flussonic's actual session count separately so callers can
        // compare it against max_sessions (which governs WS dashboard
        // connections, not Flussonic playback sessions).
        stream.flussonic_sessions = stream.client_count;
        stream.uptime = fStats.lifetime ? Math.floor(fStats.lifetime / 1000) : 0;
        stream.published_via = fStats.published_via || null;
        stream.published_from = fStats.published_from || null;

        // Real push statuses from Flussonic
        const fPushes: any[] = fData.pushes || [];
        stream.flussonic_pushes = fPushes;

        // Media info (codec, resolution)
        stream.media_info = fStats.media_info || flussonicInputs[0]?.stats?.media_info || null;
      } catch (e: any) {
        stream.flussonic_error = e.message;
        if (e.response && e.response.status === 404) {
          stream.source_type = stream.source_type || 'unknown';
          stream.status = 'offline';
          stream.flussonic_pushes = stream.push_urls.map((url: string) => ({ url, status: 'offline' }));
        } else {
          stream.source_type = stream.source_type || 'unknown';
          stream.flussonic_pushes = stream.push_urls.map((url: string) => ({ url, status: 'unknown' }));
        }
      }
    } else {
      stream.source_type = stream.source_type || 'unknown';
      stream.flussonic_pushes = stream.push_urls.map((url: string) => ({ url, status: 'unknown' }));
    }

    delete stream.api_key;
    delete stream.username;
    delete stream.password;
    res.json(stream);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Stream VOD Videos
router.get('/:id/videos', authenticateToken, requireStreamAccess, (req, res) => {
  const stream = db.prepare('SELECT id FROM streams WHERE id = ?').get(req.params.id) as any;
  if (!stream) return res.status(404).json({ error: 'Stream not found' });

  const videos = db.prepare('SELECT id, filename as name, size, duration, sort_order, created_at FROM videos WHERE stream_id = ? ORDER BY sort_order ASC, created_at ASC').all(req.params.id);
  res.json(videos);
});

// Reorder playlist
router.put('/:id/videos/order', authenticateToken, requireStreamAccess, (req, res) => {
  const { order } = req.body; // array of video ids in new order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of ids' });
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id) as any;
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  const update = db.prepare('UPDATE videos SET sort_order = ? WHERE id = ? AND stream_id = ?');
  db.transaction(() => { order.forEach((id: number, i: number) => update.run(i, id, stream.id)); })();
  // Regenerate playlist with new order
  updatePlaylistFile(stream).catch(e => console.warn('Playlist update after reorder:', e.message));
  res.json({ success: true });
});

// Update video duration
router.patch('/:id/videos/:videoId/duration', authenticateToken, requireStreamAccess, (req, res) => {
  const { duration } = req.body;
  db.prepare('UPDATE videos SET duration = ? WHERE id = ? AND stream_id = ?').run(duration || 0, req.params.videoId, req.params.id);
  res.json({ success: true });
});

router.post('/:id/videos', authenticateToken, requireStreamAccess, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id) as any;
  if (!stream) {
    fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Stream not found' });
  }

  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any;
    if (!server) throw new Error('Server not found');

    // Upload video to Flussonic (VOD name differs from stream name —
    // Flussonic shares a namespace between streams and VODs). Resolves to
    // the legacy same-name VOD when one exists from a pre-upgrade install.
    const vodName = await resolveCompanionVodName(server, stream.name);
    const uploadUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}/storages/0/files/${req.file.originalname}`;
    const fileBuffer = fs.readFileSync(req.file.path);

    try {
      await flussonicRequest('PUT', uploadUrl, server, fileBuffer);
    } catch (uploadError: any) {
      if (uploadError.response && uploadError.response.status === 404) {
        // VOD doesn't exist, create it
        console.log(`VOD ${vodName} not found, creating it...`);
        const createVodUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}`;
        await flussonicRequest('PUT', createVodUrl, server, {
          storages: [{ url: `/storage/vods/${vodName}` }]
        });

        // Also save it to our database so it shows up in VODs page
        db.prepare('INSERT INTO vods (server_id, name, paths) VALUES (?, ?, ?)').run(server.id, vodName, JSON.stringify([`/storage/vods/${vodName}`]));

        // Try uploading again
        await flussonicRequest('PUT', uploadUrl, server, fileBuffer);
      } else {
        throw uploadError;
      }
    }
    console.log(`Video uploaded to Flussonic VOD: ${vodName}/${req.file.originalname}`);

    // Insert into database
    db.prepare('INSERT INTO videos (stream_id, filename, size) VALUES (?, ?, ?)').run(stream.id, req.file.originalname, req.file.size);

    await updatePlaylistFile(stream);

    res.json({ success: true, filename: req.file.originalname });
  } catch (error: any) {
    console.error('Failed to upload video to Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to upload video to Flussonic' });
  } finally {
    // Clean up temp file
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

router.delete('/:id/videos/:filename', authenticateToken, requireStreamAccess, async (req, res) => {
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id) as any;
  if (!stream) return res.status(404).json({ error: 'Stream not found' });

  const video = db.prepare('SELECT * FROM videos WHERE stream_id = ? AND filename = ?').get(stream.id, req.params.filename) as any;
  if (!video) return res.status(404).json({ error: 'File not found' });

  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any;
    if (server) {
      // Delete video from Flussonic (resolve legacy same-name VODs too)
      const vodName = await resolveCompanionVodName(server, stream.name);
      const deleteUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}/storages/0/files/${req.params.filename}`;
      await flussonicRequest('DELETE', deleteUrl, server).catch(e => console.warn('Failed to delete from Flussonic (ignored):', e.message));
      console.log(`Video deleted from Flussonic VOD: ${stream.name}/${req.params.filename}`);
    }

    // Delete from database
    db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);

    await updatePlaylistFile(stream);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Failed to delete video from Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to delete video from Flussonic' });
  }
});

router.get('/:id/playlist.txt', authenticateToken, requireStreamAccess, (req, res) => {
  const stream = db.prepare('SELECT id, name FROM streams WHERE id = ?').get(req.params.id) as any;
  if (!stream) return res.status(404).send('Stream not found');

  const videos = db.prepare('SELECT filename FROM videos WHERE stream_id = ? ORDER BY sort_order ASC, created_at ASC').all(stream.id) as any[];
  if (videos.length === 0) {
    return res.type('text/plain').send('');
  }

  const playlistContent = videos.map((v: any) => {
    const fname = v.filename as string;
    for (const prefix of [`${stream.name}/`, `${stream.name}_vod/`]) {
      if (fname.startsWith(prefix)) return fname.slice(prefix.length);
    }
    return fname;
  }).join('\n');
  res.type('text/plain').send(playlistContent);
});

// Fetch live VOD files from Flussonic for a stream (shows what is actually on the server)
router.get('/:id/vod-files', authenticateToken, requireStreamAccess, async (req, res) => {
  try {
    const stream = db.prepare('SELECT streams.*, servers.url as server_url, servers.api_key, servers.username, servers.password FROM streams LEFT JOIN servers ON streams.server_id = servers.id WHERE streams.id = ?').get(req.params.id) as any;
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    if (!stream.server_url || (!stream.api_key && !stream.username)) return res.json({ files: [] });

    const baseUrl = stream.server_url.replace(/\/$/, '');
    const vodName = await resolveCompanionVodName(
      { url: stream.server_url, api_key: stream.api_key, username: stream.username, password: stream.password },
      stream.name
    );
    const encodedName = encodeURIComponent(vodName);
    const urls = [
      `${baseUrl}/flussonic/api/v3/vods/${encodedName}/storages/0/files`,
      `${baseUrl}/flussonic/api/v3/vods/${encodedName}/files`,
    ];

    let files: any[] = [];
    for (const url of urls) {
      try {
        const r = await flussonicRequest('GET', url, { api_key: stream.api_key, username: stream.username, password: stream.password });
        const data = r.data;
        files = Array.isArray(data) ? data : (Array.isArray(data?.files) ? data.files : []);
        if (files.length > 0) break;
      } catch (e: any) {
        if (e.response?.status !== 404) console.warn('[vod-files]', url, e.message);
      }
    }

    const result = files
      .filter((f: any) => f.type !== 'directory')
      .map((f: any) => ({
        name: f.path || f.name || f.filename,
        size: f.size || 0,
        type: f.type || 'file',
      }));

    delete stream.api_key;
    delete stream.username;
    delete stream.password;
    res.json({ files: result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

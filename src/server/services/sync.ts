import { db } from '../db';
import { flussonicRequest } from './flussonic';
import { updateVodPlaylistFile } from './playlist';

// Parse the supported /streams payload shapes. Throws on anything
// unrecognized so a malformed response can NEVER reach reconciliation
// and wipe local data.
// Keys that indicate an error/pagination envelope rather than an
// object-map of resources — never treat these as resource names.
const ENVELOPE_KEYS = new Set([
  'error', 'message', 'detail', 'errors', 'stats', 'next', 'prev',
  'estimated_count', 'timing', 'streams', 'vods', 'config', 'session'
]);

function parseObjectMap(data: any): any[] {
  const keys = Object.keys(data);
  if (keys.length === 0) return [];
  if (keys.some(k => ENVELOPE_KEYS.has(k))) {
    throw new Error('Response looks like an error/pagination envelope, not a resource map');
  }
  return keys.map(key => {
    const val = data[key];
    return (typeof val === 'object' && val !== null) ? { name: key, ...val } : { name: key };
  });
}

function parseStreamsPayload(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.streams)) return data.streams;
  if (data && typeof data === 'object') return parseObjectMap(data);
  throw new Error('Unrecognized Flussonic /streams response format');
}

export async function syncServerStreams(server: any) {
  const baseUrl = server.url.replace(/\/$/, '');
  const flussonicUrl = `${baseUrl}/flussonic/api/v3/streams`;
  const response = await flussonicRequest('GET', flussonicUrl, server);

  const streams = parseStreamsPayload(response.data);

  let addedCount = 0;
  let removedCount = 0;

  const insertStmt = db.prepare('INSERT INTO streams (server_id, name, live_url, playlist_url, push_urls, inputs, status) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const updateStmt = db.prepare('UPDATE streams SET live_url = ?, playlist_url = ?, push_urls = ?, inputs = ? WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM streams WHERE id = ?');

  // Get all existing streams for this server
  const existingStreams = db.prepare('SELECT id, name FROM streams WHERE server_id = ?').all(server.id) as any[];
  const existingByName = new Map(existingStreams.map(s => [s.name, s.id]));
  const remoteStreamNames = new Set(streams.map((s: any) => typeof s === 'string' ? s : s.name).filter(Boolean));

  for (const s of streams) {
    const name = typeof s === 'string' ? s : s.name;
    if (!name) continue;

    let live_url = '';
    let playlist_url = '';
    let push_urls: string[] = [];
    let status = 'offline';
    let inputs: string[] = [];

    if (typeof s !== 'string') {
      if (s.inputs && s.inputs.length > 0) {
        inputs = s.inputs.map((i: any) => i.url).filter(Boolean);
        live_url = inputs[0] || '';
        playlist_url = inputs[1] || '';
      }
      push_urls = s.pushes ? s.pushes.map((p: any) => p.url) : [];
      status = (s.stats && s.stats.alive) ? 'online' : 'offline';
    }

    const existingId = existingByName.get(name);
    if (existingId) {
      // Upsert: refresh metadata in place so the stream id — and all
      // assignments/videos/alerts keyed by it — is preserved.
      updateStmt.run(live_url, playlist_url, JSON.stringify(push_urls), JSON.stringify(inputs), existingId);
    } else {
      insertStmt.run(server.id, name, live_url, playlist_url, JSON.stringify(push_urls), JSON.stringify(inputs), status);
      addedCount++;
    }
  }

  // Remove deleted streams only when the remote list is trustworthy.
  // Malformed payloads never reach this point (parse throws first), and an
  // empty remote list with non-empty local state is treated as suspicious
  // (partial response, auth regression) — deletions are skipped rather than
  // wiping streams, assignments, videos and alerts.
  if (streams.length === 0 && existingStreams.length > 0) {
    console.warn(`[syncServerStreams] ${server.name}: remote returned 0 streams but ${existingStreams.length} local rows exist — skipping deletions (possible incomplete response)`);
    return { addedCount, removedCount: 0, skippedDeletions: true };
  }

  for (const existing of existingStreams) {
    if (!remoteStreamNames.has(existing.name)) {
      deleteStmt.run(existing.id);
      removedCount++;
    }
  }

  return { addedCount, removedCount };
}

export async function syncServerVods(server: any) {
  const baseUrl = server.url.replace(/\/$/, '');
  const flussonicUrl = `${baseUrl}/flussonic/api/v3/vods`;
  try {
    let response;
    try {
      response = await flussonicRequest('GET', flussonicUrl, server);
      console.log(`[syncServerVods] /vods response for ${server.name}:`, JSON.stringify(response.data).substring(0, 500));
    } catch (e: any) {
      if (e.response && e.response.status === 404) {
        // Fallback to config API if /vods endpoint is not available
        const configUrl = `${baseUrl}/flussonic/api/v3/config`;
        response = await flussonicRequest('GET', configUrl, server);
        console.log(`[syncServerVods] /config response for ${server.name}:`, JSON.stringify(response.data.vods || {}).substring(0, 500));
        if (response.data && response.data.vods) {
          response.data = response.data.vods;
        } else {
          throw new Error('No VODs found in config');
        }
      } else {
        throw e;
      }
    }

    let vodsList: any[] = [];
    if (Array.isArray(response.data)) {
      vodsList = response.data;
    } else if (response.data && Array.isArray(response.data.vods)) {
      vodsList = response.data.vods;
    } else if (response.data && typeof response.data === 'object') {
      // Legacy config-shaped response: VOD names as keys
      vodsList = parseObjectMap(response.data);
    }

    let addedCount = 0;
    let removedCount = 0;

    const insertStmt = db.prepare('INSERT INTO vods (server_id, name, paths) VALUES (?, ?, ?)');
    const updateStmt = db.prepare('UPDATE vods SET paths = ? WHERE id = ?');
    const deleteStmt = db.prepare('DELETE FROM vods WHERE id = ?');

    const existingVods = db.prepare('SELECT id, name FROM vods WHERE server_id = ?').all(server.id) as any[];
    const existingVodNames = new Set(existingVods.map(v => v.name));
    const existingVodByName = new Map(existingVods.map(v => [v.name, v.id]));

    const remoteVodNames = new Set();

    // Add new VODs
    for (const item of vodsList) {
      let name = item.name || item.prefix;
      let paths: string[] = [];

      // If Flussonic returns an array of strings (just names) instead of
      // objects, store the name only — no per-VOD detail request (N+1).
      // File listings are fetched lazily by the vod-files endpoints.
      if (typeof item === 'string') {
        name = item;
      } else if (item && (item.name || item.prefix)) {
        name = item.name || item.prefix;
        if (item.storages && Array.isArray(item.storages)) {
          paths = item.storages.map((s: any) => s.url || s.path || s);
        } else if (item.storage) {
          paths = Array.isArray(item.storage) ? item.storage : [item.storage];
        } else if (item.path) {
          paths = Array.isArray(item.path) ? item.path : [item.path];
        } else if (item.url) {
          paths = Array.isArray(item.url) ? item.url : [item.url];
        }
      }

      if (!name) continue;
      remoteVodNames.add(name);

      const existingId = existingVodByName.get(name);
      if (existingId) {
        updateStmt.run(JSON.stringify(paths), existingId);
      } else {
        insertStmt.run(server.id, name, JSON.stringify(paths));
        addedCount++;
      }
    }

    // Same safety rule as streams: never reconcile an empty remote list
    // against non-empty local state.
    if (vodsList.length === 0 && existingVods.length > 0) {
      console.warn(`[syncServerVods] ${server.name}: remote returned 0 VODs but ${existingVods.length} local rows exist — skipping deletions`);
      return { addedCount, removedCount: 0, skippedDeletions: true };
    }

    // Remove deleted VODs
    for (const existing of existingVods) {
      if (!remoteVodNames.has(existing.name)) {
        deleteStmt.run(existing.id);
        removedCount++;
      }
    }

    return { addedCount, removedCount };
  } catch (error: any) {
    console.warn(`Failed to sync VODs for server ${server.name}:`, error.message);
    return { addedCount: 0, removedCount: 0 };
  }
}

export async function syncVodFilesFromRemote(vod: any, server: any) {
  const baseUrl = server.url.replace(/\/$/, '');
  const encodedName = encodeURIComponent(vod.name);

  // Try multiple URL patterns for VOD files
  const urls = [
    `${baseUrl}/flussonic/api/v3/vods/${encodedName}/storages/0/files`,
    `${baseUrl}/flussonic/api/v3/vods/${encodedName}/files`,
    `${baseUrl}/flussonic/api/v3/vods/${vod.name}/storages/0/files`,
    `${baseUrl}/flussonic/api/v3/vods/${vod.name}/files`
  ];

  let response;
  let lastError;

  for (const url of urls) {
    try {
      console.log(`[syncVodFilesFromRemote] Trying URL: ${url}`);
      response = await flussonicRequest('GET', url, server);
      if (response && response.data) break;
    } catch (e: any) {
      lastError = e;
      console.warn(`[syncVodFilesFromRemote] Failed for ${url}:`, e.message);
      // Continue to next URL if it's a 404 or 500
      if (e.response && (e.response.status === 404 || e.response.status === 500)) {
        continue;
      }
      throw e;
    }
  }

  if (!response) {
    throw lastError || new Error('Failed to fetch VOD files from any known endpoint');
  }

  try {
    let remoteFiles: any[] = [];

    if (Array.isArray(response.data)) {
      remoteFiles = response.data;
    } else if (response.data && Array.isArray(response.data.files)) {
      remoteFiles = response.data.files;
    }

    db.transaction(() => {
      db.prepare('DELETE FROM vod_files WHERE vod_id = ?').run(vod.id);
      const insertStmt = db.prepare('INSERT INTO vod_files (vod_id, filename, size) VALUES (?, ?, ?)');
      for (const file of remoteFiles) {
        const name = file.path || file.name;
        if (!name || name.endsWith('playlist.txt') || file.type === 'directory') continue;
        insertStmt.run(vod.id, name, file.size || 0);
      }
    })();

    await updateVodPlaylistFile(vod);
    return remoteFiles.length;
  } catch (e: any) {
    console.error(`Failed to process synced files for VOD ${vod.name}:`, e.message);
    throw e;
  }
}

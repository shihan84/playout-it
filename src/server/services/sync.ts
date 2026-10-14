import { db } from '../db';
import { flussonicRequest } from './flussonic';
import { updateVodPlaylistFile } from './playlist';

export async function syncServerStreams(server: any) {
  const baseUrl = server.url.replace(/\/$/, '');
  const flussonicUrl = `${baseUrl}/flussonic/api/v3/streams`;
  const response = await flussonicRequest('GET', flussonicUrl, server);

  let streams: any[] = [];
  if (Array.isArray(response.data)) {
    streams = response.data;
  } else if (response.data && Array.isArray(response.data.streams)) {
    streams = response.data.streams;
  } else if (response.data && typeof response.data === 'object') {
    streams = Object.keys(response.data).map(key => {
      const val = response.data[key];
      if (typeof val === 'object' && val !== null) {
        return { name: key, ...val };
      }
      return { name: key };
    });
  }

  let addedCount = 0;
  let removedCount = 0;

  const insertStmt = db.prepare('INSERT INTO streams (server_id, name, live_url, playlist_url, push_urls, status) VALUES (?, ?, ?, ?, ?, ?)');
  const deleteStmt = db.prepare('DELETE FROM streams WHERE id = ?');

  // Get all existing streams for this server
  const existingStreams = db.prepare('SELECT id, name FROM streams WHERE server_id = ?').all(server.id) as any[];
  const existingStreamNames = new Set(existingStreams.map(s => s.name));
  const remoteStreamNames = new Set(streams.map((s: any) => typeof s === 'string' ? s : s.name).filter(Boolean));

  // Add new streams
  for (const s of streams) {
    let name = typeof s === 'string' ? s : s.name;
    if (!name) continue;

    if (!existingStreamNames.has(name)) {
      let live_url = '';
      let playlist_url = '';
      let push_urls: string[] = [];
      let status = 'offline';

      if (typeof s !== 'string') {
        if (s.inputs && s.inputs.length > 0) {
          live_url = s.inputs[0].url || '';
          if (s.inputs.length > 1) {
            playlist_url = s.inputs[1].url || '';
          }
        }
        push_urls = s.pushes ? s.pushes.map((p: any) => p.url) : [];
        status = (s.stats && s.stats.alive) ? 'online' : 'offline';
      }

      insertStmt.run(server.id, name, live_url, playlist_url, JSON.stringify(push_urls), status);
      addedCount++;
    }
  }

  // Remove deleted streams
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
      // Handle case where Flussonic returns an object with VOD names as keys
      vodsList = Object.keys(response.data).map(key => {
        const val = response.data[key];
        if (typeof val === 'object' && val !== null) {
          return { name: key, ...val };
        }
        return { name: key };
      });
    }

    let addedCount = 0;
    let removedCount = 0;

    const insertStmt = db.prepare('INSERT INTO vods (server_id, name, paths) VALUES (?, ?, ?)');
    const deleteStmt = db.prepare('DELETE FROM vods WHERE id = ?');

    const existingVods = db.prepare('SELECT id, name FROM vods WHERE server_id = ?').all(server.id) as any[];
    const existingVodNames = new Set(existingVods.map(v => v.name));

    const remoteVodNames = new Set();

    // Add new VODs
    for (const item of vodsList) {
      let name = item.name || item.prefix;
      let paths: string[] = [];

      // If Flussonic returns an array of strings (just names) instead of objects
      if (typeof item === 'string') {
        name = item;
        try {
          const detailRes = await flussonicRequest('GET', `${flussonicUrl}/${encodeURIComponent(name)}`, server);
          paths = detailRes.data.storages ? detailRes.data.storages.map((s: any) => s.url) : [];
        } catch (e) {
          console.warn(`Failed to fetch details for VOD ${name}`);
        }
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

      if (!existingVodNames.has(name)) {
        insertStmt.run(server.id, name, JSON.stringify(paths));
        addedCount++;
      }
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

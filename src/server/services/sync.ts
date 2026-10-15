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

// Follow `next` pagination cursors until the full inventory is collected.
// Flussonic returns `next` as an OPAQUE cursor token to be echoed back as
// the `?cursor=` query parameter — not a URL. URL-shaped cursors are still
// accepted but strictly confined: same origin, under /flussonic/api only.
// Loop detection + page cap apply to both forms.
// Throws if pagination never terminates — an incomplete inventory must
// never reach deletion reconciliation.
const ALLOWED_API_PREFIX = '/flussonic/api';

function buildPageUrl(server: any, endpoint: string, cursor: string, visited: Set<string>): string {
  const baseUrl = server.url.replace(/\/$/, '');

  if (cursor.startsWith('http') || cursor.startsWith('/')) {
    // URL-shaped cursor: confine to the configured origin + API prefix
    const base = new URL(baseUrl);
    let resolved: URL;
    try {
      resolved = new URL(cursor, `${baseUrl}/`);
    } catch {
      throw new Error('Malformed pagination cursor');
    }
    if (resolved.origin !== base.origin) {
      throw new Error(`Rejected cross-origin pagination cursor: ${resolved.origin}`);
    }
    if (!resolved.pathname.startsWith(ALLOWED_API_PREFIX)) {
      throw new Error(`Rejected pagination cursor outside ${ALLOWED_API_PREFIX}: ${resolved.pathname}`);
    }
    const key = resolved.toString();
    if (visited.has(key)) throw new Error(`Pagination loop detected at ${resolved.pathname}`);
    visited.add(key);
    return key;
  }

  // Opaque cursor token: echo back as ?cursor= on the same endpoint.
  // The request URL is fully constructed by us — no SSRF surface.
  if (cursor.length > 500) throw new Error('Oversized pagination cursor');
  if (visited.has(`cursor:${cursor}`)) throw new Error('Pagination loop detected (repeated cursor)');
  visited.add(`cursor:${cursor}`);
  const sep = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${sep}cursor=${encodeURIComponent(cursor)}`;
}

async function fetchAllPages(server: any, url: string, maxPages = 50): Promise<any[]> {
  const visited = new Set<string>();
  const pages: any[] = [];
  let cursor: string | null = null;
  let guard = 0;

  const response = await flussonicRequest('GET', url, server);
  pages.push(response.data);
  cursor = response.data && typeof response.data === 'object' ? (response.data.next || null) : null;

  while (cursor) {
    if (guard++ >= maxPages) throw new Error(`Pagination did not complete within ${maxPages} pages`);
    const pageUrl = buildPageUrl(server, url, String(cursor), visited);
    const page = await flussonicRequest('GET', pageUrl, server);
    pages.push(page.data);
    cursor = page.data && typeof page.data === 'object' ? (page.data.next || null) : null;
  }
  return pages;
}

// ---- Verified deletion policy -------------------------------------------
// Automatic deletion is DISABLED by default. Sync only ever inserts or
// updates rows; names absent from the remote inventory are reported as
// pendingRemovals. Actual deletion requires an explicit, admin-confirmed
// call (allowDeletions: true) — and even then ALL of these must hold:
//   1. The remote inventory is COMPLETE (all pages fetched).
//   2. The removal count is within a conservative limit — large drops are
//     treated as suspicious and reported as pendingRemovals instead.
//   3. Each candidate name is absent in a SECOND independent fetch.
const MAX_AUTO_REMOVALS = 10;
const MAX_AUTO_REMOVAL_RATIO = 0.2;

export interface SyncOptions {
  allowDeletions?: boolean;
}

// Per-record validation — fail closed. A malformed record means the whole
// inventory is untrustworthy, so reject it rather than partially apply it.
function isValidName(n: any): n is string {
  return typeof n === 'string' && n.length > 0 && n.length <= 200 && !/[\/\0]/.test(n);
}

function validateStreamRecord(s: any) {
  if (typeof s === 'string') {
    if (!isValidName(s)) throw new Error('Invalid stream name in response');
    return;
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    throw new Error('Invalid stream record: expected object or name string');
  }
  if (!isValidName(s.name)) throw new Error('Invalid stream record: missing/invalid name');
  if (s.inputs !== undefined && !Array.isArray(s.inputs)) throw new Error('Invalid stream record: inputs must be an array');
  if (s.pushes !== undefined && !Array.isArray(s.pushes)) throw new Error('Invalid stream record: pushes must be an array');
}

function validateVodRecord(v: any) {
  if (typeof v === 'string') {
    if (!isValidName(v)) throw new Error('Invalid VOD name in response');
    return;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('Invalid VOD record: expected object or name string');
  }
  if (!isValidName(v.name ?? v.prefix)) throw new Error('Invalid VOD record: missing/invalid name');
}

interface SyncResult {
  addedCount: number;
  removedCount: number;
  skippedDeletions?: boolean;
  pendingRemovals?: number;
  protectedRemovals?: number;
  error?: string;
}

// Rows with live child records (assignments, videos, alerts, files) are
// never deleted — even by confirmed prune. Report them as protected so an
// admin can clean up children explicitly first.
const CHILD_TABLES: Record<string, string> = {
  streams: `SELECT (SELECT COUNT(*) FROM user_stream_assignments WHERE stream_id = ?)
    + (SELECT COUNT(*) FROM videos WHERE stream_id = ?)
    + (SELECT COUNT(*) FROM telegram_alerts WHERE stream_id = ?) AS n`,
  vods: `SELECT COUNT(*) AS n FROM vod_files WHERE vod_id = ?`
};

function childCount(table: 'streams' | 'vods', id: number): number {
  const stmt = db.prepare(CHILD_TABLES[table]);
  const row = (table === 'streams' ? stmt.get(id, id, id) : stmt.get(id)) as any;
  return row?.n ?? 0;
}

function partitionProtected(table: 'streams' | 'vods', candidates: any[]) {
  const free: any[] = [];
  const prot: any[] = [];
  for (const c of candidates) {
    (childCount(table, c.id) > 0 ? prot : free).push(c);
  }
  return { free, protected: prot };
}

// Confirm candidate deletions with a second full fetch. Only names absent
// in BOTH inventories are eligible for deletion. `parser` converts one
// page into a list of named items.
async function confirmAbsent(
  server: any,
  url: string,
  candidates: any[],
  parser: (page: any) => any[]
): Promise<any[]> {
  try {
    const pages = await fetchAllPages(server, url);
    const present = new Set<string>();
    for (const page of pages) {
      for (const s of parser(page)) {
        const n = typeof s === 'string' ? s : (s?.name ?? s?.prefix);
        if (n) present.add(n);
      }
    }
    return candidates.filter(c => !present.has(c.name));
  } catch {
    return []; // second fetch failed — delete nothing
  }
}

export async function syncServerStreams(server: any, options: SyncOptions = {}): Promise<SyncResult> {
  const baseUrl = server.url.replace(/\/$/, '');
  const flussonicUrl = `${baseUrl}/flussonic/api/v3/streams`;
  const pages = await fetchAllPages(server, flussonicUrl);
  const streams = pages.flatMap(p => parseStreamsPayload(p));
  streams.forEach(validateStreamRecord); // fail closed on malformed records

  let addedCount = 0;
  let removedCount = 0;

  const insertStmt = db.prepare('INSERT INTO streams (server_id, name, live_url, playlist_url, push_urls, inputs, status) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const updateStmt = db.prepare('UPDATE streams SET live_url = ?, playlist_url = ?, push_urls = ?, inputs = ? WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM streams WHERE id = ?');

  // Get all existing streams for this server (full row for field merge)
  const existingStreams = db.prepare('SELECT * FROM streams WHERE server_id = ?').all(server.id) as any[];
  const existingByName = new Map(existingStreams.map(s => [s.name, s]));
  const remoteStreamNames = new Set(streams.map((s: any) => typeof s === 'string' ? s : s.name).filter(Boolean));

  for (const s of streams) {
    const name = typeof s === 'string' ? s : s.name;
    if (!name) continue;

    const existing = existingByName.get(name);

    if (typeof s === 'string') {
      // Names-only inventory carries no metadata — never overwrite stored
      // live_url/inputs/push_urls with empty values.
      if (!existing) {
        const info = insertStmt.run(server.id, name, '', '', '[]', '[]', 'offline');
        existingByName.set(name, { id: info.lastInsertRowid, live_url: '', playlist_url: '', push_urls: '[]', inputs: '[]' });
        addedCount++;
      }
      continue;
    }

    // Merge: only overwrite fields the remote record actually carries.
    const inputs = Array.isArray(s.inputs)
      ? s.inputs.map((i: any) => i?.url).filter(Boolean)
      : null;
    const push_urls = Array.isArray(s.pushes)
      ? s.pushes.map((p: any) => p?.url).filter(Boolean)
      : null;
    const status = (s.stats && s.stats.alive) ? 'online' : 'offline';

    if (existing) {
      // Upsert: refresh present fields in place so the stream id — and all
      // assignments/videos/alerts keyed by it — is preserved.
      updateStmt.run(
        inputs ? (inputs[0] || '') : existing.live_url,
        inputs ? (inputs[1] || '') : existing.playlist_url,
        push_urls ? JSON.stringify(push_urls) : existing.push_urls,
        inputs ? JSON.stringify(inputs) : existing.inputs,
        existing.id
      );
    } else {
      const info = insertStmt.run(server.id, name,
        inputs?.[0] || '', inputs?.[1] || '',
        JSON.stringify(push_urls || []), JSON.stringify(inputs || []), status);
      // Keep the map current — a record repeated on a later page must update
      // rather than violate the UNIQUE(server_id, name) constraint.
      existingByName.set(name, {
        id: info.lastInsertRowid,
        live_url: inputs?.[0] || '', playlist_url: inputs?.[1] || '',
        push_urls: JSON.stringify(push_urls || []), inputs: JSON.stringify(inputs || [])
      });
      addedCount++;
    }
  }

  // Verified deletion reconciliation. Malformed payloads never reach this
  // point (parse throws). An empty remote list with non-empty local state,
  // or a removal set exceeding the conservative limit, is treated as a
  // possible incomplete response — deletions are skipped and reported.
  const candidates = existingStreams.filter(e => !remoteStreamNames.has(e.name));

  if (candidates.length === 0) return { addedCount, removedCount: 0 };
  const { free, protected: prot } = partitionProtected('streams', candidates);
  if (streams.length === 0) {
    console.warn(`[syncServerStreams] ${server.name}: remote returned 0 streams but ${existingStreams.length} local rows exist — skipping deletions`);
    return { addedCount, removedCount: 0, skippedDeletions: true, pendingRemovals: candidates.length, protectedRemovals: prot.length || undefined };
  }
  if (!options.allowDeletions) {
    return { addedCount, removedCount: 0, skippedDeletions: true, pendingRemovals: candidates.length, protectedRemovals: prot.length || undefined };
  }
  if (candidates.length > MAX_AUTO_REMOVALS || candidates.length > existingStreams.length * MAX_AUTO_REMOVAL_RATIO) {
    console.warn(`[syncServerStreams] ${server.name}: ${candidates.length}/${existingStreams.length} local streams missing remotely — exceeds auto-removal limit, reporting as pendingRemovals`);
    return { addedCount, removedCount: 0, skippedDeletions: true, pendingRemovals: candidates.length, protectedRemovals: prot.length || undefined };
  }
  if (prot.length > 0) {
    console.warn(`[syncServerStreams] ${server.name}: ${prot.length} missing streams have live assignments/videos/alerts — protected from deletion`);
  }

  // Second independent fetch: only names absent in both inventories delete.
  // Child records are RE-CHECKED inside the transaction — the network fetch
  // takes time and a candidate can gain an assignment/video/alert meanwhile.
  const confirmed = await confirmAbsent(server, flussonicUrl, free, parseStreamsPayload);
  let protectedLate = 0;
  const deleteAll = db.transaction((rows: any[]) => {
    let removed = 0;
    for (const c of rows) {
      if (childCount('streams', c.id) > 0) { protectedLate++; continue; }
      deleteStmt.run(c.id);
      removed++;
    }
    return removed;
  });
  removedCount = deleteAll(confirmed);
  console.warn(`[syncServerStreams] ${server.name}: pruned ${removedCount} streams (verified absent in two independent inventories)`);
  if (removedCount < free.length) {
    console.log(`[syncServerStreams] ${server.name}: ${free.length - removedCount} candidate deletions rejected by second-fetch/late-child checks`);
  }

  return { addedCount, removedCount, pendingRemovals: candidates.length - removedCount || undefined, protectedRemovals: (prot.length + protectedLate) || undefined };
}

function parseVodsPayload(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.vods)) return data.vods;
  if (data && typeof data === 'object') return parseObjectMap(data);
  throw new Error('Unrecognized Flussonic /vods response format');
}

export async function syncServerVods(server: any, options: SyncOptions = {}): Promise<SyncResult> {
  const baseUrl = server.url.replace(/\/$/, '');
  const flussonicUrl = `${baseUrl}/flussonic/api/v3/vods`;
  try {
    let pages: any[];
    try {
      pages = await fetchAllPages(server, flussonicUrl);
    } catch (e: any) {
      if (e.response && e.response.status === 404) {
        // Fallback to config API if /vods endpoint is not available
        const configUrl = `${baseUrl}/flussonic/api/v3/config`;
        const response = await flussonicRequest('GET', configUrl, server);
        if (response.data && response.data.vods) {
          pages = [response.data.vods];
        } else {
          throw new Error('No VODs found in config');
        }
      } else {
        throw e;
      }
    }

    const vodsList = pages.flatMap(p => parseVodsPayload(p));
    vodsList.forEach(validateVodRecord); // fail closed on malformed records

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
        // Names-only responses carry no path info — never overwrite
        // existing storage paths with an empty array.
        if (paths.length > 0) {
          updateStmt.run(JSON.stringify(paths), existingId);
        }
      } else {
        const info = insertStmt.run(server.id, name, JSON.stringify(paths));
        existingVodByName.set(name, info.lastInsertRowid); // repeat on a later page must not violate UNIQUE
        addedCount++;
      }
    }

    // Same verified-deletion policy as streams.
    const candidates = existingVods.filter(e => !remoteVodNames.has(e.name));

    if (candidates.length === 0) return { addedCount, removedCount: 0 };
    const { free, protected: prot } = partitionProtected('vods', candidates);
    if (vodsList.length === 0) {
      console.warn(`[syncServerVods] ${server.name}: remote returned 0 VODs but ${existingVods.length} local rows exist — skipping deletions`);
      return { addedCount, removedCount: 0, skippedDeletions: true, pendingRemovals: candidates.length, protectedRemovals: prot.length || undefined };
    }
    if (!options.allowDeletions) {
      return { addedCount, removedCount: 0, skippedDeletions: true, pendingRemovals: candidates.length, protectedRemovals: prot.length || undefined };
    }
    if (candidates.length > MAX_AUTO_REMOVALS || candidates.length > existingVods.length * MAX_AUTO_REMOVAL_RATIO) {
      console.warn(`[syncServerVods] ${server.name}: ${candidates.length}/${existingVods.length} local VODs missing remotely — exceeds auto-removal limit, reporting as pendingRemovals`);
      return { addedCount, removedCount: 0, skippedDeletions: true, pendingRemovals: candidates.length, protectedRemovals: prot.length || undefined };
    }
    if (prot.length > 0) {
      console.warn(`[syncServerVods] ${server.name}: ${prot.length} missing VODs have local vod_files — protected from deletion`);
    }

    const confirmed = await confirmAbsent(server, flussonicUrl, free, parseVodsPayload);
    let protectedLate = 0;
    const deleteAll = db.transaction((rows: any[]) => {
      let removed = 0;
      for (const c of rows) {
        if (childCount('vods', c.id) > 0) { protectedLate++; continue; }
        deleteStmt.run(c.id);
        removed++;
      }
      return removed;
    });
    removedCount = deleteAll(confirmed);
    if (removedCount > 0) {
      console.warn(`[syncServerVods] ${server.name}: pruned ${removedCount} VODs (verified absent in two independent inventories)`);
    }

    return { addedCount, removedCount, pendingRemovals: candidates.length - removedCount || undefined, protectedRemovals: (prot.length + protectedLate) || undefined };
  } catch (error: any) {
    console.warn(`Failed to sync VODs for server ${server.name}:`, error.message);
    // Explicit failure — callers must not treat this as "0 changes"
    return { addedCount: 0, removedCount: 0, error: error.message };
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

  let pages: any[] | null = null;
  let lastError;

  for (const url of urls) {
    try {
      console.log(`[syncVodFilesFromRemote] Trying URL: ${url}`);
      pages = await fetchAllPages(server, url);
      if (pages && pages.length > 0) break;
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

  if (!pages || pages.length === 0) {
    throw lastError || new Error('Failed to fetch VOD files from any known endpoint');
  }

  try {
    // Collect files from all pages. Each page may be a raw array or an
    // envelope with a `files` key. Reject any page with an unrecognized
    // shape BEFORE touching vod_files.
    const remoteFiles: any[] = [];
    for (const pageData of pages) {
      if (Array.isArray(pageData)) {
        remoteFiles.push(...pageData);
      } else if (pageData && Array.isArray(pageData.files)) {
        remoteFiles.push(...pageData.files);
      } else {
        throw new Error('Unrecognized VOD file listing response format');
      }
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

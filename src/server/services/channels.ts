import { db } from '../db';
import { flussonicRequest } from './flussonic';
import { recordStreamEvent } from './lifecycle';

// A "channel" = Flussonic stream + companion VOD + local rows. Creation is
// atomic: the remote VOD is rolled back if the stream PUT fails, and local
// inserts happen in one transaction. Used by POST /api/channels and bulk ops.

// In-memory lock set keyed by `serverId:channelName` — serializes concurrent
// creations so two racing requests for the same name don't both pass the
// preflight check. The lock is released in a finally block.
//
// IMPORTANT: This lock is process-local. It assumes a SINGLE-WRITER
// deployment (one Node.js process). PM2 cluster mode or multiple containers
// would bypass this guard — use the UNIQUE DB index as the final safety net.
// See docs/DEPLOYMENT_CHECKLIST.md for the architecture constraint.
const inFlightCreations = new Set<string>();

export class ChannelError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function remoteExists(url: string, server: any): Promise<boolean | 'unreachable'> {
  try {
    const res = await flussonicRequest('GET', url, server);
    const d = res.data;
    return d !== null && d !== undefined && (!Array.isArray(d) || d.length > 0) ? true : false;
  } catch (e: any) {
    if (e.response && e.response.status === 404) return false;
    return 'unreachable';
  }
}

export interface ChannelSpec {
  name: string;
  inputs: string[];
  push_urls?: string[];
  vod_path?: string;
}

export function validateChannelSpec(body: any): ChannelSpec {
  const { name, inputs, push_urls, vod_path } = body || {};
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new ChannelError('Channel name is required', 400);
  }
  if (!inputs || !Array.isArray(inputs) || inputs.length === 0) {
    throw new ChannelError('At least one input URL is required', 400);
  }
  if (push_urls && !Array.isArray(push_urls)) {
    throw new ChannelError('Push URLs must be an array', 400);
  }
  return { name: name.trim(), inputs, push_urls, vod_path };
}

export async function createChannel(server: any, spec: ChannelSpec, actorId: number | null): Promise<{ streamId: number; vodId: number; vodName: string }> {
  const channelName = spec.name;
  const vodName = `${channelName}_vod`;
  const vodPath = spec.vod_path || `/storage/${vodName}`;

  // Serialize concurrent creations for the same server+name so two racing
  // requests cannot both pass the preflight check.
  const lockKey = `${server.id}:${channelName}`;
  if (inFlightCreations.has(lockKey)) {
    throw new ChannelError(`Channel '${channelName}' creation already in progress on this server`, 409);
  }
  inFlightCreations.add(lockKey);

  try {
    // Local duplicate check — the shared Flussonic namespace means a local VOD
    // or stream with the same name also conflicts.
    const localClash = db.prepare(
      'SELECT id FROM streams WHERE server_id = ? AND name = ? UNION SELECT id FROM vods WHERE server_id = ? AND name IN (?, ?)'
    ).get(server.id, channelName, server.id, channelName, vodName);
    if (localClash) {
      throw new ChannelError(`Channel name '${channelName}' already exists on this server`, 409);
    }

    const baseUrl = server.url.replace(/\/$/, '');
    const streamUrl = `${baseUrl}/flussonic/api/v3/streams/${encodeURIComponent(channelName)}`;
    const vodUrl = `${baseUrl}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}`;

    // Pre-flight remote duplicate check (streams + vods share one namespace in
    // Flussonic — a same-named VOD would reject the stream PUT).
    for (const [label, url] of [
      ['stream', streamUrl],
      ['vod', `${baseUrl}/flussonic/api/v3/vods/${encodeURIComponent(channelName)}`],
      ['companion vod', vodUrl],
    ] as const) {
      const exists = await remoteExists(url, server);
      if (exists === 'unreachable') {
        throw new ChannelError(`Cannot verify namespace on server '${server.name}' — refusing to create channel`, 502);
      }
      if (exists) {
        throw new ChannelError(`Remote ${label} '${channelName}' already exists on '${server.name}'`, 409);
      }
    }

    // Provision: VOD first, then stream; roll the VOD back if the stream fails.
    // Only delete during rollback what *we* created — never delete a
    // preexisting remote resource that belongs to another request.
    let vodCreated = false;
    try {
      await flussonicRequest('PUT', vodUrl, server, { storages: [{ url: vodPath }] });
      vodCreated = true;
    } catch (e: any) {
      throw new ChannelError(`Failed to create companion VOD on '${server.name}': ${e.message}`, 502);
    }

    const payload: any = { inputs: spec.inputs.map((url: string) => ({ url })) };
    if (spec.push_urls?.length) payload.pushes = spec.push_urls.map((url: string) => ({ url }));

    try {
      await flussonicRequest('PUT', streamUrl, server, payload);
    } catch (e: any) {
      if (vodCreated) {
        await flussonicRequest('DELETE', vodUrl, server)
          .catch(dErr => console.error(`[channels] rollback: failed to delete orphan VOD ${vodName}:`, dErr.message));
      }
      throw new ChannelError(`Failed to create stream on '${server.name}': ${e.message}. Companion VOD rolled back.`, 502);
    }

    // Local records in one transaction. The UNIQUE index on (server_id, name)
    // is the final safety net — if another request somehow raced past all
    // checks, the INSERT will throw and we roll back.
    return db.transaction(() => {
      const vodInfo = db.prepare('INSERT INTO vods (server_id, name, paths) VALUES (?, ?, ?)')
        .run(server.id, vodName, JSON.stringify([vodPath]));
      const streamInfo = db.prepare('INSERT INTO streams (server_id, name, live_url, playlist_url, push_urls, inputs, lifecycle_state) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(server.id, channelName, '', '', JSON.stringify(spec.push_urls || []), JSON.stringify(spec.inputs), 'live');
      recordStreamEvent(Number(streamInfo.lastInsertRowid), null, 'live', actorId, 'channel created');
      return { streamId: Number(streamInfo.lastInsertRowid), vodId: Number(vodInfo.lastInsertRowid), vodName };
    })();
  } finally {
    inFlightCreations.delete(lockKey);
  }
}

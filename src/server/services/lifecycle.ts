import { db } from '../db';
import { flussonicRequest } from './flussonic';

export type LifecycleState = 'draft' | 'provisioned' | 'live' | 'suspended' | 'retired';

const STATES: LifecycleState[] = ['draft', 'provisioned', 'live', 'suspended', 'retired'];

// draft → provisioned → live ⇄ suspended → retired
const ALLOWED: Record<LifecycleState, LifecycleState[]> = {
  draft: ['provisioned', 'retired'],
  provisioned: ['live', 'suspended', 'retired'],
  live: ['suspended', 'retired'],
  suspended: ['live', 'retired'],
  retired: [],
};

export function isLifecycleState(v: any): v is LifecycleState {
  return STATES.includes(v);
}

export function allowedTransitions(from: LifecycleState): LifecycleState[] {
  return ALLOWED[from] || [];
}

export function recordStreamEvent(streamId: number, fromState: string | null, toState: string, actorId: number | null, detail?: string) {
  db.prepare('INSERT INTO stream_events (stream_id, from_state, to_state, actor_id, detail) VALUES (?, ?, ?, ?, ?)')
    .run(streamId, fromState, toState, actorId, detail || null);
}

async function checkServerReachable(server: any) {
  const baseUrl = server.url.replace(/\/$/, '');
  await flussonicRequest('GET', `${baseUrl}/flussonic/api/v3/streams`, server);
}

// Throws Error with .status for HTTP-friendly failures.
export async function transitionStream(streamId: number, to: LifecycleState, actorId: number | null): Promise<any> {
  if (!isLifecycleState(to)) {
    const e: any = new Error(`Invalid target state '${to}'. Valid states: ${STATES.join(', ')}`);
    e.status = 400;
    throw e;
  }

  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId) as any;
  if (!stream) {
    const e: any = new Error('Stream not found');
    e.status = 404;
    throw e;
  }

  const from: LifecycleState = isLifecycleState(stream.lifecycle_state) ? stream.lifecycle_state : 'live';
  if (from === to) {
    const e: any = new Error(`Stream is already '${to}'`);
    e.status = 409;
    throw e;
  }
  if (!ALLOWED[from].includes(to)) {
    const e: any = new Error(`Transition ${from} → ${to} is not allowed. Allowed: ${ALLOWED[from].join(', ') || 'none'}`);
    e.status = 409;
    throw e;
  }

  // Remote validations — only when a server is attached.
  if ((to === 'provisioned' || to === 'live') && stream.server_id) {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any;
    if (!server) {
      const e: any = new Error('Attached server no longer exists');
      e.status = 409;
      throw e;
    }
    try {
      if (to === 'provisioned') {
        await checkServerReachable(server);
      } else {
        const baseUrl = server.url.replace(/\/$/, '');
        await flussonicRequest('GET', `${baseUrl}/flussonic/api/v3/streams/${encodeURIComponent(stream.name)}`, server);
      }
    } catch (err: any) {
      const e: any = new Error(`Cannot transition to '${to}': server/stream not reachable (${err.message})`);
      e.status = 409;
      throw e;
    }
  }

  // Playlist channels require their companion VOD to exist locally before going live.
  if (to === 'live') {
    let inputs: string[] = [];
    try { inputs = JSON.parse(stream.inputs || '[]'); } catch {}
    const isPlaylist = stream.source_type === 'playlist' || inputs.some(u => typeof u === 'string' && /\.m3u8?$/i.test(u));
    if (isPlaylist && stream.server_id) {
      const vod = db.prepare('SELECT id FROM vods WHERE server_id = ? AND name IN (?, ?)')
        .get(stream.server_id, `${stream.name}_vod`, stream.name);
      if (!vod) {
        const e: any = new Error(`Cannot transition to 'live': companion VOD for playlist channel '${stream.name}' not found`);
        e.status = 409;
        throw e;
      }
    }
  }

  // Re-read state inside a transaction to reject concurrent conflicting
  // transitions. SQLite serializes transactions, so two racing calls will
  // never both succeed from the same starting state.
  const result = db.transaction(() => {
    const current = db.prepare('SELECT lifecycle_state FROM streams WHERE id = ?').get(streamId) as any;
    const currentState: LifecycleState = isLifecycleState(current?.lifecycle_state) ? current.lifecycle_state : 'live';
    if (currentState !== from) {
      // State changed between our initial read and the transaction — reject.
      throw Object.assign(
        new Error(`Conflicting transition: stream moved to '${currentState}' before this transition could be applied`),
        { status: 409 }
      );
    }
    db.prepare('UPDATE streams SET lifecycle_state = ? WHERE id = ?').run(to, streamId);
    recordStreamEvent(streamId, from, to, actorId, `transition ${from} → ${to}`);
    return db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId);
  })();

  return result;
}

export function getStreamEvents(streamId: number): any[] {
  return db.prepare(`
    SELECT stream_events.*, users.username AS actor_username
    FROM stream_events
    LEFT JOIN users ON stream_events.actor_id = users.id
    WHERE stream_id = ? ORDER BY created_at ASC, id ASC
  `).all(streamId);
}

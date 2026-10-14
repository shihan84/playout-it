import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { db } from '../db';
import { config } from '../config';
import { parseStream } from '../utils/streams';

export const wss = new WebSocketServer({ noServer: true });
export const clients = new Set<WebSocket>();

// Verify the session cookie on WS upgrade requests. cookie-parser does not
// run for upgrade events, so parse the Cookie header directly. Returns the
// decoded JWT payload so the connection can be scoped to the user.
export function verifyWsAuth(request: any): any | null {
  const cookieHeader = request.headers?.cookie || '';
  const token = cookieHeader
    .split(';')
    .map((c: string) => c.trim().split('='))
    .find(([k]: string[]) => k === 'token')?.[1];
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

wss.on('connection', (ws, request: any) => {
  (ws as any).user = (request as any).wsUser || null;
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

export const broadcastStreamsUpdate = () => {
  try {
    const streams = db.prepare(`
      SELECT streams.*, servers.name as server_name, servers.url as server_url 
      FROM streams 
      LEFT JOIN servers ON streams.server_id = servers.id
    `).all();

    const parsedStreams = streams.map(parseStream);
    const adminMessage = JSON.stringify({ type: 'STREAMS_UPDATE', data: parsedStreams });

    const assignmentStmt = db.prepare('SELECT stream_id FROM user_stream_assignments WHERE user_id = ?');
    const userStmt = db.prepare('SELECT role FROM users WHERE id = ?');
    const clientMessageCache = new Map<number, string>();
    const roleCache = new Map<number, string | null>();

    clients.forEach(client => {
      if (client.readyState !== WebSocket.OPEN) return;
      const user = (client as any).user;
      // Fail closed: a socket without a verified, still-existing identity
      // receives nothing. Role is re-validated against the DB so stale or
      // deleted sessions lose access immediately.
      if (!user || typeof user.id !== 'number') return;
      let role = roleCache.get(user.id);
      if (role === undefined) {
        role = (userStmt.get(user.id) as any)?.role ?? null;
        roleCache.set(user.id, role);
      }
      if (role === 'admin') {
        client.send(adminMessage);
        return;
      }
      if (role !== 'client') return;
      // Client roles only receive streams assigned to them
      let message = clientMessageCache.get(user.id);
      if (!message) {
        const assigned = new Set((assignmentStmt.all(user.id) as any[]).map(r => r.stream_id));
        message = JSON.stringify({
          type: 'STREAMS_UPDATE',
          data: parsedStreams.filter((s: any) => assigned.has(s.id))
        });
        clientMessageCache.set(user.id, message);
      }
      client.send(message);
    });
  } catch (error) {
    console.error('Failed to broadcast streams update:', error);
  }
};

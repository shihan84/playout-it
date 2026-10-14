import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { db } from '../db';
import { config } from '../config';
import { parseStream } from '../utils/streams';

export const wss = new WebSocketServer({ noServer: true });
export const clients = new Set<WebSocket>();

// Verify the session cookie on WS upgrade requests. cookie-parser does not
// run for upgrade events, so parse the Cookie header directly.
export function verifyWsAuth(request: any): boolean {
  const cookieHeader = request.headers?.cookie || '';
  const token = cookieHeader
    .split(';')
    .map((c: string) => c.trim().split('='))
    .find(([k]: string[]) => k === 'token')?.[1];
  if (!token) return false;
  try {
    jwt.verify(token, config.jwtSecret);
    return true;
  } catch {
    return false;
  }
}

wss.on('connection', (ws) => {
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

    const message = JSON.stringify({ type: 'STREAMS_UPDATE', data: parsedStreams });
    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  } catch (error) {
    console.error('Failed to broadcast streams update:', error);
  }
};

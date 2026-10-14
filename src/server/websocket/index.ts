import { WebSocketServer, WebSocket } from 'ws';
import { db } from '../db';
import { parseStream } from '../utils/streams';

export const wss = new WebSocketServer({ noServer: true });
export const clients = new Set<WebSocket>();

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

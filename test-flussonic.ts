import Database from 'better-sqlite3';
import axios from 'axios';

const db = new Database('flussonic.db');
const server = db.prepare('SELECT * FROM servers WHERE name = ?').get('it') as any;

if (server) {
  const baseUrl = server.url.replace(/\/$/, '');
  const authString = server.api_key.includes(':') ? server.api_key : `admin:${server.api_key}`;
  const headers = { 'Authorization': `Basic ${Buffer.from(authString).toString('base64')}` };

  const endpoints = [
    '/flussonic/api/server',
    '/flussonic/api/v3/server',
    '/flussonic/api/v3/stats',
    '/flussonic/api/v3/status',
    '/flussonic/api/v3/metrics',
    '/flussonic/api/metrics',
    '/flussonic/api/v3/nodes/self'
  ];

  async function test() {
    for (const ep of endpoints) {
      try {
        const res = await axios.get(`${baseUrl}${ep}`, { headers, timeout: 3000 });
        console.log(`SUCCESS: ${ep} ->`, Object.keys(res.data));
      } catch (e: any) {
        console.log(`FAIL: ${ep} -> ${e.response?.status || e.message}`);
      }
    }
  }
  test();
} else {
  console.log('Server not found');
}

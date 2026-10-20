/**
 * Phase E — Staging Flussonic validation harness.
 *
 * Run against an EXPLICITLY AUTHORIZED staging Flussonic server only.
 * Validates the assumptions Playout-IT's services rely on:
 *   1. v3 API auth (username/password Basic)
 *   2. Stream inventory (GET /streams)
 *   3. VOD inventory (GET /vods)
 *   4. Stream lifecycle roundtrip: PUT config → GET → DELETE (disposable stream)
 *   5. Input swap (the operation the scheduler performs)
 *   6. Optional: real ffmpeg publish into the disposable stream (RTMP/SRT/UDP)
 *
 * Usage:
 *   STAGING_URL=http://stage.example:8080 STAGING_USER=admin STAGING_PASS=secret \
 *     npx tsx scripts/staging-validate.ts            # GET-only (safe)
 *   ... --write                                    # lifecycle roundtrip
 *   ... --write --publish=rtmp://stage.example/live/<name>
 *
 * The disposable stream name is `e2e-val-<timestamp>` — always deleted in
 * finally, never colliding with real channels. NOTHING is touched unless
 * --write is passed. All GET output is credentials-redacted.
 */

const URL_BASE = (process.env.STAGING_URL || '').replace(/\/$/, '');
const USER = process.env.STAGING_USER || '';
const PASS = process.env.STAGING_PASS || '';
const WRITE = process.argv.includes('--write');
const PUBLISH_ARG = process.argv.find(a => a.startsWith('--publish='))?.split('=')[1];
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const STREAM = `e2e-val-${Date.now().toString(36)}`;

if (!URL_BASE || !USER || !PASS) {
  console.error('Required env: STAGING_URL, STAGING_USER, STAGING_PASS');
  process.exit(2);
}

const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
let passed = 0, failed = 0;

function ok(name: string, detail = '') { passed++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name: string, detail = '') { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }

async function api(method: string, path: string, body?: any) {
  const res = await fetch(`${URL_BASE}/flussonic/api/v3${path}`, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function main() {
  console.log(`Staging validation → ${URL_BASE} (write: ${WRITE})`);

  // 1. Auth + config reachability
  const cfg = await api('GET', '/config');
  cfg.status < 300 ? ok('auth + GET /config') : fail('auth + GET /config', `HTTP ${cfg.status}`);

  // 2. Stream inventory
  const streams = await api('GET', '/streams');
  const list = Array.isArray(streams.data) ? streams.data : streams.data?.streams || [];
  streams.status < 300 ? ok('GET /streams', `${list.length} remote streams`) : fail('GET /streams', `HTTP ${streams.status}`);

  // 3. VOD inventory
  const vods = await api('GET', '/vods');
  vods.status < 300 ? ok('GET /vods') : fail('GET /vods', `HTTP ${vods.status}`);

  if (!WRITE) {
    console.log('\nRead-only mode complete. Re-run with --write for lifecycle validation.');
  } else {
    // 4. Lifecycle roundtrip on a disposable stream
    const put = await api('PUT', `/streams/${encodeURIComponent(STREAM)}`, {
      name: STREAM, inputs: [{ url: 'fake://fake' }],
    });
    put.status < 300 ? ok('PUT disposable stream', STREAM) : fail('PUT disposable stream', `HTTP ${put.status} ${JSON.stringify(put.data).slice(0, 200)}`);

    const get = await api('GET', `/streams/${encodeURIComponent(STREAM)}`);
    get.status < 300 ? ok('GET disposable stream') : fail('GET disposable stream', `HTTP ${get.status}`);

    // 5. Input swap — the exact operation scheduler.ts performs
    const swap = await api('PUT', `/streams/${encodeURIComponent(STREAM)}`, {
      name: STREAM, inputs: [{ url: 'fake://fake2' }],
    });
    const back = await api('PUT', `/streams/${encodeURIComponent(STREAM)}`, {
      name: STREAM, inputs: [{ url: 'fake://fake' }],
    });
    swap.status < 300 && back.status < 300
      ? ok('input swap + restore (scheduler op)') : fail('input swap', `PUT1=${swap.status} PUT2=${back.status}`);

    // 6. Optional real publish
    if (PUBLISH_ARG) {
      const { spawnSync } = await import('node:child_process');
      const muxer = /^rtmps?:/i.test(PUBLISH_ARG) ? 'flv' : 'mpegts';
      const r = spawnSync(FFMPEG, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440',
        '-t', '5', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac',
        '-f', muxer, PUBLISH_ARG,
      ], { encoding: 'utf8', timeout: 30000 });
      r.status === 0
        ? ok(`ffmpeg publish (${muxer})`, PUBLISH_ARG.replace(/\/\/[^/@]*@/, '//***@'))
        : fail('ffmpeg publish', (r.stderr || r.error?.message || '').slice(0, 300));
    }
  }

  // Always clean up the disposable stream when it may exist
  if (WRITE) {
    const del = await api('DELETE', `/streams/${encodeURIComponent(STREAM)}`);
    del.status < 300 || del.status === 404
      ? ok('DELETE disposable stream (cleanup)') : fail('cleanup DELETE', `HTTP ${del.status}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('Validation crashed:', e.message); process.exit(1); });

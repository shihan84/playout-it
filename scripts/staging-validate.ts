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
 *   ... STAGING_CONFIRM_HOST=stage.example --write   # lifecycle roundtrip
 *   ... --write --publish=rtmp://stage.example/live/<name>
 *
 * The disposable stream name is `e2e-val-<timestamp>`, never colliding with
 * real channels. Once created it is deleted in a `finally` block (also on
 * crash or Ctrl+C). NOTHING is touched unless --write is passed.
 *
 * Production guards (all modes):
 *   - PRODUCTION_HOSTS (comma-separated hostnames/IPs) — refuse to run against
 *     these hosts, compared by name AND resolved IP address (an IP or alias of
 *     a production host is refused too).
 *   - Every request times out after STAGING_TIMEOUT_MS (default 15000).
 * Production guards (--write only):
 *   - STAGING_CONFIRM_HOST must equal the STAGING_URL hostname.
 *   - Refuse if the server already has more than STAGING_MAX_STREAMS
 *     (default 20) streams — a populated server is treated as production.
 *   - --publish must target the same host as STAGING_URL.
 */

const URL_BASE = (process.env.STAGING_URL || '').replace(/\/$/, '');
const USER = process.env.STAGING_USER || '';
const PASS = process.env.STAGING_PASS || '';
const WRITE = process.argv.includes('--write');
const PUBLISH_ARG = process.argv.find(a => a.startsWith('--publish='))?.split('=')[1];
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const STREAM = `e2e-val-${Date.now().toString(36)}`;
const TIMEOUT_MS = Number(process.env.STAGING_TIMEOUT_MS) > 0 ? Number(process.env.STAGING_TIMEOUT_MS) : 15000;
const MAX_STREAMS = Number(process.env.STAGING_MAX_STREAMS) >= 0 && process.env.STAGING_MAX_STREAMS
  ? Number(process.env.STAGING_MAX_STREAMS) : 20;

if (!URL_BASE || !USER || !PASS) {
  console.error('Required env: STAGING_URL, STAGING_USER, STAGING_PASS');
  process.exit(2);
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

const TARGET_HOST = hostOf(URL_BASE);
if (!TARGET_HOST) {
  console.error(`STAGING_URL is not a valid URL: ${URL_BASE}`);
  process.exit(2);
}
const PRODUCTION_HOSTS = (process.env.PRODUCTION_HOSTS || '')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
if (PRODUCTION_HOSTS.includes(TARGET_HOST)) {
  console.error(`Refusing to run: ${TARGET_HOST} is listed in PRODUCTION_HOSTS.`);
  process.exit(2);
}
if (WRITE && (process.env.STAGING_CONFIRM_HOST || '').trim().toLowerCase() !== TARGET_HOST) {
  console.error(`--write requires STAGING_CONFIRM_HOST=${TARGET_HOST} to confirm this is a staging server.`);
  process.exit(2);
}
if (PUBLISH_ARG && !WRITE) {
  console.error('--publish requires --write.');
  process.exit(2);
}
if (PUBLISH_ARG && hostOf(PUBLISH_ARG) !== TARGET_HOST) {
  console.error(`Refusing --publish to ${hostOf(PUBLISH_ARG) || PUBLISH_ARG}: must target the staging host ${TARGET_HOST}.`);
  process.exit(2);
}

async function addressesOf(host: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  try { return (await lookup(host, { all: true })).map(a => a.address); } catch { return []; }
}

async function refuseProductionAddresses() {
  if (!PRODUCTION_HOSTS.length) return;
  const target = new Set(await addressesOf(TARGET_HOST));
  for (const h of PRODUCTION_HOSTS) {
    const hit = (await addressesOf(h)).find(a => target.has(a));
    if (hit) {
      console.error(`Refusing to run: ${TARGET_HOST} resolves to ${hit}, the address of production host ${h}.`);
      process.exit(2);
    }
  }
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
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

let created = false;

async function cleanup() {
  if (!created) return;
  created = false;
  try {
    const del = await api('DELETE', `/streams/${encodeURIComponent(STREAM)}`);
    del.status < 300 || del.status === 404
      ? ok('DELETE disposable stream (cleanup)') : fail('cleanup DELETE', `HTTP ${del.status} — remove ${STREAM} manually`);
  } catch (e: any) {
    fail('cleanup DELETE', `${e.message} — remove ${STREAM} manually`);
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} — cleaning up`);
    cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  });
}

async function main() {
  await refuseProductionAddresses();
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
    return;
  }

  if (streams.status >= 300) {
    fail('write guard', 'stream inventory unavailable — refusing to write');
    return;
  }
  if (list.length > MAX_STREAMS) {
    fail('write guard', `${list.length} streams > STAGING_MAX_STREAMS=${MAX_STREAMS} — looks like production, refusing to write`);
    return;
  }

  const existing = await api('GET', `/streams/${encodeURIComponent(STREAM)}`);
  if (existing.status < 300) {
    fail('write guard', `${STREAM} already exists — refusing to overwrite it`);
    return;
  }

  try {
    // 4. Lifecycle roundtrip on a disposable stream
    created = true; // a failed/timed-out PUT may still have created it
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
  } finally {
    await cleanup();
  }
}

main()
  .catch(e => { failed++; console.error('Validation crashed:', e.message); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });

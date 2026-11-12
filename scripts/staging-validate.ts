/**
 * Phase E — Staging Flussonic validation harness.
 *
 * Run against an EXPLICITLY AUTHORIZED staging Flussonic server only.
 * Validates the assumptions Playout-IT's services rely on:
 *   1. v3 API auth (username/password Basic)
 *   2. Stream inventory (GET /streams, all pages)
 *   3. VOD inventory (GET /vods)
 *   4. Stream lifecycle roundtrip: PUT config → GET (verified) → DELETE (disposable stream)
 *   5. Input swap + restore, each verified by GET (the operation the scheduler performs)
 *   6. Optional: real ffmpeg publish into the disposable stream (RTMP/SRT/UDP)
 *
 * Usage: see docs/STAGING_E2E.md.
 *
 * The disposable stream name is `e2e-val-<timestamp>`, never colliding with
 * real channels. Once created it is deleted in a `finally` block (also on
 * crash, Ctrl+C or SIGTERM). NOTHING is touched unless --write is passed.
 *
 * Production guards (all modes):
 *   - STAGING_URL must be https:// unless STAGING_ALLOW_HTTP=1 (Basic auth
 *     would otherwise travel in clear text).
 *   - PRODUCTION_HOSTS (comma-separated hostnames/IPs) — refuse to run against
 *     these hosts, compared by name AND resolved IP address.
 *   - Every request times out after STAGING_TIMEOUT_MS (default 15000).
 * Production guards (--write only):
 *   - STAGING_CONFIRM_HOST must equal the STAGING_URL hostname.
 *   - Refuse if the server has more than STAGING_MAX_STREAMS (default 20)
 *     streams, counted across all pages; an incomplete count refuses too.
 *   - --publish must target the STAGING_URL host and contain the `{stream}`
 *     placeholder, which is replaced by the disposable stream name.
 */

const URL_BASE = (process.env.STAGING_URL || '').replace(/\/$/, '');
const USER = process.env.STAGING_USER || '';
const PASS = process.env.STAGING_PASS || '';
const WRITE = process.argv.includes('--write');
const PUBLISH_PREFIX = '--publish=';
const PUBLISH_TEMPLATE = process.argv.find(a => a.startsWith(PUBLISH_PREFIX))?.slice(PUBLISH_PREFIX.length);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const STREAM = `e2e-val-${Date.now().toString(36)}`;
const PUBLISH_URL = PUBLISH_TEMPLATE?.split('{stream}').join(STREAM);
const TIMEOUT_MS = Number(process.env.STAGING_TIMEOUT_MS) > 0 ? Number(process.env.STAGING_TIMEOUT_MS) : 15000;
const MAX_STREAMS = Number(process.env.STAGING_MAX_STREAMS) >= 0 && process.env.STAGING_MAX_STREAMS
  ? Number(process.env.STAGING_MAX_STREAMS) : 20;
const MAX_PAGES = 100;

function refuse(msg: string): never {
  console.error(msg);
  process.exit(2);
}

if (!URL_BASE || !USER || !PASS) refuse('Required env: STAGING_URL, STAGING_USER, STAGING_PASS');

function parseUrl(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}
function hostOf(url: string): string {
  return parseUrl(url)?.hostname.toLowerCase() || '';
}

const TARGET_HOST = hostOf(URL_BASE);
if (!TARGET_HOST) refuse('STAGING_URL is not a valid URL.');
const TARGET_PROTOCOL = parseUrl(URL_BASE)!.protocol;
if (TARGET_PROTOCOL !== 'https:' && !(TARGET_PROTOCOL === 'http:' && process.env.STAGING_ALLOW_HTTP === '1')) {
  refuse('STAGING_URL must use https:// (set STAGING_ALLOW_HTTP=1 to accept plain http on a trusted network).');
}
const PRODUCTION_HOSTS = (process.env.PRODUCTION_HOSTS || '')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
if (PRODUCTION_HOSTS.includes(TARGET_HOST)) refuse(`Refusing to run: ${TARGET_HOST} is listed in PRODUCTION_HOSTS.`);
if (WRITE && (process.env.STAGING_CONFIRM_HOST || '').trim().toLowerCase() !== TARGET_HOST) {
  refuse(`--write requires STAGING_CONFIRM_HOST=${TARGET_HOST} to confirm this is a staging server.`);
}
if (PUBLISH_TEMPLATE !== undefined) {
  if (!WRITE) refuse('--publish requires --write.');
  if (!PUBLISH_TEMPLATE.includes('{stream}')) {
    refuse('--publish must contain {stream}, which is replaced by the disposable stream name (e.g. rtmp://host/{stream}).');
  }
  if (hostOf(PUBLISH_URL!) !== TARGET_HOST) {
    refuse(`Refusing --publish to ${hostOf(PUBLISH_URL!) || 'an invalid URL'}: must target the staging host ${TARGET_HOST}.`);
  }
}

/** Strip credentials from text that may contain the publish URL or any URL with userinfo/secret query params. */
function redact(text: string): string {
  let out = text;
  if (PUBLISH_URL) out = out.split(PUBLISH_URL).join('<publish-url>');
  return out
    .replace(/\/\/[^/@\s]*@/g, '//***@')
    .replace(/((?:pass(?:phrase|word)?|token|secret|key|auth|sign)[^=&\s]*=)[^&\s]*/gi, '$1***');
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
    if (hit) refuse(`Refusing to run: ${TARGET_HOST} resolves to ${hit}, the address of production host ${h}.`);
  }
}

const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
let passed = 0, failed = 0;

function ok(name: string, detail = '') { passed++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name: string, detail = '') { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }

let stopping = false;
let inflight: Promise<unknown> = Promise.resolve();

async function api(method: string, path: string, body?: any, { duringCleanup = false } = {}) {
  if (stopping && !duringCleanup) throw new Error('interrupted');
  const request = (async () => {
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
  })();
  if (!duringCleanup) inflight = request.catch(() => {});
  return request;
}

const streamPath = `/streams/${encodeURIComponent(STREAM)}`;

/** Count remote streams across all `next`-cursor pages; null if the count is incomplete. */
async function countStreams(): Promise<{ count: number | null; error?: string }> {
  let count = 0;
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await api('GET', cursor ? `/streams?cursor=${encodeURIComponent(cursor)}` : '/streams');
    if (r.status >= 300) return { count: null, error: `HTTP ${r.status}` };
    const list = Array.isArray(r.data) ? r.data : r.data?.streams;
    if (!Array.isArray(list)) return { count: null, error: 'unrecognized /streams response' };
    count += list.length;
    const next = !Array.isArray(r.data) && r.data?.next ? String(r.data.next) : null;
    if (!next) return { count };
    if (seen.has(next)) return { count: null, error: 'pagination loop' };
    seen.add(next);
    cursor = next;
  }
  return { count: null, error: `more than ${MAX_PAGES} pages` };
}

function inputUrlOf(data: any): string | undefined {
  return data?.inputs?.[0]?.url;
}

async function putInput(url: string, label: string): Promise<boolean> {
  const put = await api('PUT', streamPath, { name: STREAM, inputs: [{ url }] });
  if (put.status >= 300) {
    fail(label, `PUT HTTP ${put.status} ${redact(JSON.stringify(put.data)).slice(0, 200)}`);
    return false;
  }
  const get = await api('GET', streamPath);
  const actual = inputUrlOf(get.data);
  if (get.status >= 300 || actual !== url) {
    fail(label, get.status >= 300 ? `GET HTTP ${get.status}` : `GET shows input ${redact(String(actual))}, expected ${url}`);
    return false;
  }
  ok(label, url);
  return true;
}

let created = false;
let cleanupPromise: Promise<void> | null = null;

function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    if (!created) return;
    try {
      const del = await api('DELETE', streamPath, undefined, { duringCleanup: true });
      del.status < 300 || del.status === 404
        ? ok('DELETE disposable stream (cleanup)') : fail('cleanup DELETE', `HTTP ${del.status} — remove ${STREAM} manually`);
    } catch (e: any) {
      fail('cleanup DELETE', `${e.message} — remove ${STREAM} manually`);
    }
  })();
  return cleanupPromise;
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    const code = sig === 'SIGINT' ? 130 : 143;
    if (stopping) process.exit(code);
    stopping = true;
    console.log(`\n${sig} — waiting for the current request, then cleaning up (repeat to exit immediately)`);
    inflight.finally(() => cleanup()).finally(() => process.exit(code));
  });
}

async function main() {
  await refuseProductionAddresses();
  console.log(`Staging validation → ${URL_BASE} (write: ${WRITE})`);

  // 1. Auth + config reachability
  const cfg = await api('GET', '/config');
  cfg.status < 300 ? ok('auth + GET /config') : fail('auth + GET /config', `HTTP ${cfg.status}`);

  // 2. Stream inventory (all pages)
  const inventory = await countStreams();
  inventory.count !== null
    ? ok('GET /streams', `${inventory.count} remote streams`) : fail('GET /streams', inventory.error);

  // 3. VOD inventory
  const vods = await api('GET', '/vods');
  vods.status < 300 ? ok('GET /vods') : fail('GET /vods', `HTTP ${vods.status}`);

  if (!WRITE) {
    console.log('\nRead-only mode complete. Re-run with --write for lifecycle validation.');
    return;
  }

  if (inventory.count === null) {
    fail('write guard', 'stream inventory incomplete — refusing to write');
    return;
  }
  if (inventory.count > MAX_STREAMS) {
    fail('write guard', `${inventory.count} streams > STAGING_MAX_STREAMS=${MAX_STREAMS} — looks like production, refusing to write`);
    return;
  }

  const existing = await api('GET', streamPath);
  if (existing.status < 300) {
    fail('write guard', `${STREAM} already exists — refusing to overwrite it`);
    return;
  }

  try {
    // 4. Lifecycle roundtrip on a disposable stream
    created = true; // a failed/timed-out PUT may still have created it
    if (!await putInput('fake://fake', `PUT + GET disposable stream ${STREAM}`)) return;

    // 5. Input swap + restore — the exact operation scheduler.ts performs
    if (!await putInput('fake://fake2', 'input swap (scheduler op)')) return;
    if (!await putInput('fake://fake', 'input restore (scheduler op)')) return;

    // 6. Optional real publish into the disposable stream only
    if (PUBLISH_URL) {
      if (!await putInput('publish://', 'accept publish on disposable stream')) return;
      const { spawnSync } = await import('node:child_process');
      const muxer = /^rtmps?:/i.test(PUBLISH_URL) ? 'flv' : 'mpegts';
      const r = spawnSync(FFMPEG, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440',
        '-t', '5', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac',
        '-f', muxer, PUBLISH_URL,
      ], { encoding: 'utf8', timeout: 30000 });
      r.status === 0
        ? ok(`ffmpeg publish (${muxer})`, redact(PUBLISH_URL))
        : fail('ffmpeg publish', redact(r.stderr || r.error?.message || `exit ${r.status}`).slice(0, 300));
    }
  } finally {
    await cleanup();
  }
}

main()
  .catch(e => { failed++; console.error('Validation crashed:', redact(String(e?.message))); })
  .finally(async () => {
    await cleanup();
    if (stopping) return; // the signal handler exits once cleanup is done
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });

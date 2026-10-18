import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Redirect the DB singleton to a disposable file BEFORE importing the service
// (importing ../db opens DATABASE_PATH at module load).
const tmpDb = path.join(os.tmpdir(), `overlay-test-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'overlay-test-secret-0123456789abcdef';
// Isolated asset dir for logo-path confinement tests.
const assetDir = path.join(os.tmpdir(), `overlay-assets-${process.pid}-${Date.now()}`);
fs.mkdirSync(assetDir, { recursive: true });
process.env.OVERLAY_ASSET_DIR = assetDir;

const { buildArgs, validateProfileSpec, escapeDrawtext, OverlayError, startOverlay,
  assertLogoPathAllowed, resolveLogoPath, redactUrl } =
  await import('../src/server/services/overlay');
const { db } = await import('../src/server/db');

test('buildArgs: logo overlay composes scale/alpha/position correctly', () => {
  const args = buildArgs({
    logo_path: 'C:/logos/ch.png', logo_position: 'tr', logo_x: 20, logo_y: 15,
    logo_width: 120, logo_opacity: 0.8, ticker_enabled: 0,
  }, 'http://flussonic/live/index.m3u8', 'udp://127.0.0.1:5555');
  const s = args.join(' ');
  assert.ok(s.includes('scale=120:-1'), 'logo scaled to width');
  assert.ok(s.includes('colorchannelmixer=aa=0.8'), 'opacity applied');
  assert.ok(s.includes('overlay=W-w-20:15'), 'tr position resolves to W-w-x:y');
  assert.ok(s.endsWith('-f mpegts udp://127.0.0.1:5555'));
});

test('buildArgs: RTMP publishing uses FLV muxer instead of MPEG-TS', () => {
  const profile = { logo_path: null, ticker_enabled: 0 };
  const args = buildArgs(profile, 'http://example.test/source/index.m3u8', 'rtmp://example.test/live/overlay');
  assert.deepEqual(args.slice(-3), ['-f', 'flv', 'rtmp://example.test/live/overlay']);
  const srtArgs = buildArgs(profile, 'http://example.test/source/index.m3u8', 'srt://example.test:9000');
  assert.deepEqual(srtArgs.slice(-3), ['-f', 'mpegts', 'srt://example.test:9000']);
});

test('buildArgs: ticker uses drawtext with escaped text and scroll expression', () => {
  const args = buildArgs({
    logo_path: null, ticker_enabled: 1, ticker_text: "Breaking: it's 100% live!",
    ticker_speed: 60, ticker_position: 'bottom', ticker_font_size: 32,
    ticker_color: 'white', ticker_bg_color: 'black@0.5',
  }, 'in.ts', 'out.ts');
  const s = args.join(' ');
  assert.ok(s.includes('drawtext=text='), 'drawtext present');
  assert.ok(s.includes("it\\'s"), "apostrophe escaped");
  assert.ok(s.includes('100%%'), 'percent doubled for drawtext');
  assert.ok(s.includes('w-mod(t*60'), 'scroll speed in x expression');
  assert.ok(s.includes('h-th-10'), 'bottom position');
  assert.ok(s.includes('fontcolor=white'));
});

test('escapeDrawtext strips control characters and escapes filter metachars', () => {
  const out = escapeDrawtext("a'b:c%d\u001fe");
  assert.equal(out, "a\\'b\\:c%%d e");
});

test('validateProfileSpec rejects unsafe/invalid inputs', () => {
  const base = { name: 'p', ticker_enabled: 0 };
  assert.throws(() => validateProfileSpec({ ...base, logo_opacity: 1.5 }), OverlayError);
  assert.throws(() => validateProfileSpec({ ...base, logo_position: 'middle' }), OverlayError);
  assert.throws(() => validateProfileSpec({ ...base, ticker_enabled: 1 }), OverlayError); // no text
  assert.throws(() => validateProfileSpec({ ...base, ticker_enabled: 1, ticker_text: 'x', ticker_color: 'white;rm -rf /' }), OverlayError);
  assert.throws(() => validateProfileSpec({ ...base, output_url: 'file:///etc/passwd' }), OverlayError);
  assert.throws(() => validateProfileSpec({ ...base, output_stream: 'bad name with spaces&' }), OverlayError);
});

test('validateProfileSpec accepts a full valid profile', () => {
  const p = validateProfileSpec({
    name: 'news-overlay', logo_path: 'C:/media/logo.png', logo_position: 'bl',
    logo_x: 5, logo_y: 5, logo_width: 80, logo_opacity: 0.9,
    ticker_enabled: 1, ticker_text: 'hello', ticker_speed: 80, ticker_position: 'top',
    ticker_font_size: 24, ticker_color: 'yellow', ticker_bg_color: 'black@0.6',
    output_stream: 'news_ovr', enabled: true,
  });
  assert.equal(p.logo_position, 'bl');
  assert.equal(p.ticker_position, 'top');
  assert.equal(p.output_stream, 'news_ovr');
});

// startOverlay policy ordering: isolation + recursion must reject (409)
// regardless of whether ffmpeg is installed. Uses the disposable temp DB.
function seedStream(name: string, opts: { live_url?: string; inputs?: string[] } = {}) {
  db.prepare("INSERT OR IGNORE INTO servers (id, name, url, api_key) VALUES (1, 't', 'http://fs.example', 'u:p')").run();
  db.prepare("INSERT INTO streams (server_id, name, live_url, playlist_url, inputs) VALUES (1, ?, ?, '', ?)")
    .run(name, opts.live_url || '', JSON.stringify(opts.inputs || []));
  return (db.prepare('SELECT id FROM streams WHERE name = ?').get(name) as any).id;
}

test('startOverlay rejects self-targeting output before capability check', async () => {
  const sid = seedStream('selft');
  const pid = db.prepare(
    "INSERT INTO overlay_profiles (stream_id, name, output_stream) VALUES (?, 'self', 'selft')"
  ).run(sid).lastInsertRowid;
  await assert.rejects(() => startOverlay(Number(pid)), (e: any) => e.status === 409 && /isolated/.test(e.message));
});

test('startOverlay rejects A->B / B->A recursion cycles', async () => {
  const aId = seedStream('cyc-a');
  const bId = seedStream('cyc-b');
  // Profile on B outputs to A (explicit output_stream).
  db.prepare("INSERT INTO overlay_profiles (stream_id, name, output_stream) VALUES (?, 'b-to-a', 'cyc-a')").run(bId);
  // Profile on A wants to output to B -> would close the loop.
  const pid = db.prepare(
    "INSERT INTO overlay_profiles (stream_id, name, output_stream) VALUES (?, 'a-to-b', 'cyc-b')"
  ).run(aId).lastInsertRowid;
  await assert.rejects(() => startOverlay(Number(pid)), (e: any) => e.status === 409 && /[Rr]ecursive/.test(e.message));
});

// ---- Review: output_url must NOT bypass isolation ----------------------------

test('startOverlay rejects output_url equal to the source input URL', async () => {
  const sid = seedStream('fb-in', { live_url: 'http://fs.example/fb-in/index.m3u8' });
  const pid = db.prepare(
    "INSERT INTO overlay_profiles (stream_id, name, output_url) VALUES (?, 'selfloop', 'http://fs.example/fb-in/index.m3u8')"
  ).run(sid).lastInsertRowid;
  await assert.rejects(() => startOverlay(Number(pid)),
    (e: any) => e.status === 409 && /feed back|equals the source input/i.test(e.message));
});

test('startOverlay rejects output_url targeting the source stream on its server', async () => {
  const sid = seedStream('fb-target', { live_url: 'http://cdn.other.example/fb-target/index.m3u8' });
  for (const out of [
    'http://fs.example/flussonic/publish/fb-target',
    'http://fs.example/flussonic/api/v3/streams/fb-target',
    'http://fs.example/fb-target/index.m3u8',
  ]) {
    const pid = db.prepare(
      'INSERT INTO overlay_profiles (stream_id, name, output_url) VALUES (?, ?, ?)'
    ).run(sid, `t-${out.length}`, out).lastInsertRowid;
    await assert.rejects(() => startOverlay(Number(pid)),
      (e: any) => e.status === 409 && /source stream|equals the source input/i.test(e.message),
      `expected 409 for ${out}`);
  }
});

test('startOverlay rejects output_url matching a configured source input (feedback)', async () => {
  const sid = seedStream('fb-srcin', {
    live_url: 'http://fs.example/fb-srcin/index.m3u8',
    inputs: ['udp://239.0.0.1:1234'],
  });
  const pid = db.prepare(
    "INSERT INTO overlay_profiles (stream_id, name, output_url) VALUES (?, 'fb', 'udp://239.0.0.1:1234/')"
  ).run(sid).lastInsertRowid;
  await assert.rejects(() => startOverlay(Number(pid)),
    (e: any) => e.status === 409 && /feedback/i.test(e.message));
});

// ---- Review: logo paths confined to the approved asset dir -------------------

test('assertLogoPathAllowed rejects traversal and outside absolute paths', () => {
  assert.throws(() => assertLogoPathAllowed('../../etc/passwd'), OverlayError);
  assert.throws(() => assertLogoPathAllowed('..\\..\\windows\\system.ini'), OverlayError);
  assert.throws(() => assertLogoPathAllowed(path.join(os.tmpdir(), 'outside.png')), OverlayError);
  assert.doesNotThrow(() => assertLogoPathAllowed('ok/logo.png'));
});

test('resolveLogoPath: inside file ok; missing file and symlink escape rejected', () => {
  fs.writeFileSync(path.join(assetDir, 'in.png'), 'x');
  assert.ok(resolveLogoPath('in.png').endsWith('in.png'));
  assert.throws(() => resolveLogoPath('nope.png'), OverlayError);

  const outside = path.join(os.tmpdir(), `outside-${process.pid}-${Date.now()}.png`);
  fs.writeFileSync(outside, 'x');
  const link = path.join(assetDir, 'escape.png');
  let linked = false;
  try { fs.symlinkSync(outside, link); linked = true; } catch { /* platform lacks symlink permission */ }
  if (linked) {
    assert.throws(() => resolveLogoPath('escape.png'), OverlayError);
  }
});

// ---- Review: overlay workers gated off by default ----------------------------

test('startOverlay requires the overlay_enabled gate (off by default)', async () => {
  const sid = seedStream('gated', { live_url: 'http://fs.example/gated/index.m3u8' });
  const pid = db.prepare(
    "INSERT INTO overlay_profiles (stream_id, name, output_stream, output_url) VALUES (?, 'g', 'gated_ovr', 'srt://staging.example:9000')"
  ).run(sid).lastInsertRowid;
  await assert.rejects(() => startOverlay(Number(pid)),
    (e: any) => e.status === 409 && /disabled/i.test(e.message));
});

test('startOverlay rejects unconfigured publishing destination before spawning', async () => {
  const sid = seedStream('missing-destination', { live_url: 'http://fs.example/missing-destination/index.m3u8' });
  const pid = db.prepare(
    "INSERT INTO overlay_profiles (stream_id, name, output_stream) VALUES (?, 'missing', 'missing-destination_ovr')"
  ).run(sid).lastInsertRowid;
  await assert.rejects(() => startOverlay(Number(pid)),
    (e: any) => e.status === 400 && /explicit output_url/i.test(e.message));
});

// ---- Hardening: verified publish schemes only --------------------------------

test('validateProfileSpec rejects http(s) and unknown output_url schemes', () => {
  const base = { name: 'p', stream_id: 1 };
  for (const bad of ['http://cdn.example/publish/x', 'https://cdn.example/publish/x', 'ftp://cdn.example/x', 'file:///tmp/x']) {
    assert.throws(() => validateProfileSpec({ ...base, output_url: bad }),
      (e: any) => /rtmp|srt|udp|publishing/i.test(e.message));
  }
  for (const ok of ['rtmp://cdn.example/live/x', 'rtmps://cdn.example/live/x', 'srt://cdn.example:9000', 'udp://239.1.1.1:5000']) {
    assert.equal(validateProfileSpec({ ...base, output_url: ok }).output_url, ok);
  }
});

test('startOverlay rejects a DB-resident non-publish scheme (defense in depth)', async () => {
  const sid = seedStream('badscheme', { live_url: 'http://fs.example/badscheme/index.m3u8' });
  const pid = db.prepare(
    "INSERT INTO overlay_profiles (stream_id, name, output_stream, output_url) VALUES (?, 'bs', 'badscheme_ovr', 'http://other.example/publish/x')"
  ).run(sid).lastInsertRowid;
  await assert.rejects(() => startOverlay(Number(pid)),
    (e: any) => e.status === 400 && /publishing protocol/i.test(e.message));
});

// ---- Hardening: URL identity variants -----------------------------------------

test('startOverlay rejects folder/name source targeting and port variants', async () => {
  const sid = seedStream('folder/name', { live_url: 'http://fs.example/folder/name/index.m3u8' });
  const pid = db.prepare(
    "INSERT INTO overlay_profiles (stream_id, name, output_url) VALUES (?, 'f', 'http://fs.example:80/flussonic/publish/folder/name')"
  ).run(sid).lastInsertRowid;
  await assert.rejects(() => startOverlay(Number(pid)),
    (e: any) => e.status === 409 && /source stream|equals the source input/i.test(e.message));

  const pid2 = db.prepare(
    "INSERT INTO overlay_profiles (stream_id, name, output_url) VALUES (?, 'f2', 'rtmp://fs.example:1935/publish/folder%2Fname')"
  ).run(sid).lastInsertRowid;
  await assert.rejects(() => startOverlay(Number(pid2)),
    (e: any) => e.status === 409 && /source stream|equals the source input/i.test(e.message));
});

test('startOverlay rejects two profiles publishing to the same destination', async () => {
  const s1 = seedStream('dup-a', { live_url: 'http://fs.example/dup-a/index.m3u8' });
  const s2 = seedStream('dup-b', { live_url: 'http://fs.example/dup-b/index.m3u8' });
  db.prepare("INSERT INTO overlay_profiles (stream_id, name, output_url) VALUES (?, 'first', 'srt://dest.example:9000')").run(s1);
  const pid = db.prepare(
    "INSERT INTO overlay_profiles (stream_id, name, output_url) VALUES (?, 'second', 'srt://dest.example:9000')"
  ).run(s2).lastInsertRowid;
  await assert.rejects(() => startOverlay(Number(pid)),
    (e: any) => e.status === 409 && /already publishes/i.test(e.message));
});

test('startOverlay enforces the global worker cap before spawning', async () => {
  // Park 8 fake running jobs — the cap trips regardless of ffmpeg presence.
  for (let i = 0; i < 8; i++) {
    db.prepare("INSERT INTO overlay_jobs (profile_id, stream_id, status) VALUES (1, 1, 'running')").run();
  }
  const sid = seedStream('capped', { live_url: 'http://fs.example/capped/index.m3u8' });
  const pid = db.prepare(
    "INSERT INTO overlay_profiles (stream_id, name, output_stream, output_url, enabled) VALUES (?, 'c', 'capped_ovr', 'srt://dest.example:9001', 1)"
  ).run(sid).lastInsertRowid;
  // Arm the gate for this test only, then disarm again.
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('overlay_enabled', '1')").run();
  try {
    await assert.rejects(() => startOverlay(Number(pid)),
      (e: any) => e.status === 429 && /worker limit/i.test(e.message));
  } finally {
    db.prepare("DELETE FROM settings WHERE key = 'overlay_enabled'").run();
    db.prepare("DELETE FROM overlay_jobs WHERE status = 'running'").run();
  }
});

test('redactUrl strips credentials from publish URLs', () => {
  assert.equal(redactUrl('rtmp://user:secret@cdn.example/live/x'), 'rtmp://***@cdn.example/live/x');
  assert.equal(redactUrl('srt://cdn.example:9000'), 'srt://cdn.example:9000');
  assert.equal(redactUrl(null), null);
  assert.equal(redactUrl('rtmp://u:p@h/x'.replace('u:p@h', 'u:p@h')), 'rtmp://***@h/x');
  // Unparseable strings are returned unchanged unless they contain user@host form.
  assert.equal(redactUrl('plain text'), 'plain text');
});

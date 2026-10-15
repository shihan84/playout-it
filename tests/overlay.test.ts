import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Redirect the DB singleton to a disposable file BEFORE importing the service
// (importing ../db opens DATABASE_PATH at module load).
const tmpDb = path.join(os.tmpdir(), `overlay-test-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'overlay-test-secret-0123456789abcdef';

const { buildArgs, validateProfileSpec, escapeDrawtext, OverlayError } =
  await import('../src/server/services/overlay');

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

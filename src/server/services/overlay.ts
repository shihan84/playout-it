import { spawn, ChildProcess } from 'child_process';
import { execSync } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db';
import { recordStreamEvent } from './lifecycle';

// Phase 3 P2 -- Logo & ticker overlay pipeline.
//
// Model: one ffmpeg worker per active overlay profile. The worker pulls the
// channel's playable output (streams.live_url), applies logo + ticker filters,
// and publishes to a SEPARATE output stream -- the source channel is never
// touched. Isolated-test-stream safety is enforced: output_stream must differ
// from the source stream name unless output_url is given explicitly.
//
// Process management is injectable for tests: spawnImpl defaults to
// child_process.spawn; tests substitute a fake to exercise lifecycle without
// launching ffmpeg.

export class OverlayError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// Overlay rendering is DISABLED by default — it spawns ffmpeg against real
// channels, so it must be explicitly armed (mirrors the scheduler gate).
// Enable via settings.overlay_enabled = '1' or OVERLAY_ENABLED=1.
export function overlayEnabled(): boolean {
  const s = db.prepare("SELECT value FROM settings WHERE key = 'overlay_enabled'").get() as any;
  if (s) return s.value === '1';
  return process.env.OVERLAY_ENABLED === '1';
}

// Logo assets are confined to a single approved directory. Default:
// <cwd>/assets/overlay. Override with OVERLAY_ASSET_DIR (tests, deployments).
export function overlayAssetDir(): string {
  return path.resolve(process.env.OVERLAY_ASSET_DIR || path.join(process.cwd(), 'assets', 'overlay'));
}

function resolveLogoPathParts(logoPath: string) {
  const root = overlayAssetDir();
  // Normalize '\' to '/' so Windows-style traversal (..\..) is rejected on
  // every platform — on POSIX, a literal backslash is a valid filename char
  // and would otherwise slip past the containment check.
  const normalized = logoPath.replace(/\\/g, '/');
  const resolved = path.resolve(root, normalized);
  const inside = resolved === root || resolved.startsWith(root + path.sep);
  return { root, resolved, inside };
}

// Lightweight containment check used at profile create/update — rejects
// traversal and outside-absolute paths without requiring the file to exist
// yet (assets may be uploaded after the profile is created).
export function assertLogoPathAllowed(logoPath: string) {
  const r = resolveLogoPathParts(logoPath);
  if (!r.inside) {
    throw new OverlayError(`logo_path must be inside the overlay asset dir (${r.root})`, 400);
  }
}

// Full check used at job start — containment, existence, and symlink escape.
// Returns the canonical absolute path for ffmpeg.
export function resolveLogoPath(logoPath: string): string {
  const { root, resolved } = resolveLogoPathParts(logoPath);
  if (!fs.existsSync(resolved)) {
    throw new OverlayError(`logo file not found in overlay asset dir: ${logoPath}`, 400);
  }
  const real = fs.realpathSync(resolved);
  const realRoot = fs.realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new OverlayError('logo_path resolves outside the overlay asset dir (symlink rejected)', 400);
  }
  return real;
}

// Canonicalize a URL for equality checks: lowercase scheme+host, strip the
// default port and trailing slashes. Throws on unparseable input.
function canonUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const port = u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'))
      ? `:${u.port}` : '';
    return `${u.protocol}//${u.hostname.toLowerCase()}${port}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    // udp:// rtmp:// srt:// parse fine via URL; anything unparseable is
    // compared literally after lowercasing + trailing-slash strip.
    return String(raw).toLowerCase().replace(/\/+$/, '');
  }
}

// True when `out` targets the given stream on the given server — i.e. ffmpeg
// would publish back onto the source channel or an endpoint the source
// consumes. Covers publish paths, stream API paths, and any URL that has the
// stream name as a path segment on the same host.
function urlTargetsStream(out: string, serverUrl: string, streamName: string): boolean {
  try {
    const o = new URL(out);
    const s = new URL(serverUrl);
    if (o.hostname.toLowerCase() !== s.hostname.toLowerCase()) return false;
    const segs = o.pathname.split('/').map(decodeURIComponent).filter(Boolean);
    return segs.includes(streamName);
  } catch {
    return false;
  }
}

// ---- Binary detection ------------------------------------------------------

let ffmpegAvailable: boolean | null = null;

export function detectFfmpeg(): boolean {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    execSync(`"${FFMPEG}" -version`, { stdio: 'pipe', timeout: 5000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

// ---- Profile validation ----------------------------------------------------

const POSITIONS = ['tl', 'tr', 'bl', 'br', 'custom'] as const;
const TICKER_POSITIONS = ['top', 'bottom'] as const;
const SAFE_COLOR = /^[a-zA-Z0-9@._\-\s]{1,64}$/;      // e.g. white, black@0.5, #ff0000@0.8
const SAFE_FS_PATH = /^[^<>"|?*\x00-\x1f]+$/;  // no glob/redirect/control chars (args are array-passed, no shell)

export function validateProfileSpec(body: any) {
  if (!body || typeof body !== 'object') throw new OverlayError('Request body is required');
  const name = String(body.name || '').trim();
  if (!name || name.length > 200) throw new OverlayError('name is required (max 200 chars)');

  const logoPath = body.logo_path ? String(body.logo_path) : null;
  if (logoPath && (!SAFE_FS_PATH.test(logoPath) || logoPath.length > 500)) {
    throw new OverlayError('logo_path contains invalid characters');
  }
  const logoPosition = body.logo_position ?? 'tr';
  if (!POSITIONS.includes(logoPosition)) throw new OverlayError(`logo_position must be one of ${POSITIONS.join(', ')}`);

  const opacity = Number(body.logo_opacity ?? 1);
  if (Number.isNaN(opacity) || opacity < 0 || opacity > 1) throw new OverlayError('logo_opacity must be 0-1');

  const lx = Number(body.logo_x ?? 10), ly = Number(body.logo_y ?? 10), lw = Number(body.logo_width ?? 0);
  if (![lx, ly, lw].every(n => Number.isInteger(n) && n >= 0 && n <= 10000)) {
    throw new OverlayError('logo_x / logo_y / logo_width must be integers 0-10000');
  }

  const tickerEnabled = body.ticker_enabled ? 1 : 0;
  const tickerText = body.ticker_text ? String(body.ticker_text) : null;
  if (tickerEnabled && !tickerText) throw new OverlayError('ticker_text required when ticker is enabled');
  if (tickerText && tickerText.length > 2000) throw new OverlayError('ticker_text max 2000 chars');

  const speed = Number(body.ticker_speed ?? 100);
  if (!Number.isInteger(speed) || speed < 1 || speed > 2000) throw new OverlayError('ticker_speed must be 1-2000 px/s');

  const fontSize = Number(body.ticker_font_size ?? 28);
  if (!Number.isInteger(fontSize) || fontSize < 8 || fontSize > 200) throw new OverlayError('ticker_font_size must be 8-200');

  for (const [key, val, def] of [
    ['ticker_color', body.ticker_color, 'white'],
    ['ticker_bg_color', body.ticker_bg_color, 'black@0.5'],
  ] as const) {
    const v = val === undefined || val === null ? def : String(val);
    if (!SAFE_COLOR.test(v)) throw new OverlayError(`invalid ${key}`);
  }

  const tickerPos = body.ticker_position ?? 'bottom';
  if (!TICKER_POSITIONS.includes(tickerPos)) throw new OverlayError(`ticker_position must be ${TICKER_POSITIONS.join(' or ')}`);

  const outputStream = body.output_stream ? String(body.output_stream).trim() : null;
  if (outputStream && !/^[A-Za-z0-9_\-\.\/]{1,200}$/.test(outputStream)) {
    throw new OverlayError('output_stream may contain letters, digits, _ - . / only');
  }
  const outputUrl = body.output_url ? String(body.output_url).trim() : null;
  if (outputUrl && !/^(udp|rtmp|srt|https?):\/\//i.test(outputUrl)) {
    throw new OverlayError('output_url must start with udp://, rtmp://, srt://, or http(s)://');
  }

  return {
    name,
    logo_path: logoPath,
    logo_position: logoPosition,
    logo_x: lx, logo_y: ly, logo_width: lw, logo_opacity: opacity,
    ticker_enabled: tickerEnabled, ticker_text: tickerText,
    ticker_speed: speed, ticker_position: tickerPos,
    ticker_font_size: fontSize,
    ticker_color: body.ticker_color ?? 'white',
    ticker_bg_color: body.ticker_bg_color ?? 'black@0.5',
    output_stream: outputStream,
    output_url: outputUrl,
    enabled: body.enabled === undefined ? 1 : (body.enabled ? 1 : 0),
  };
}

// ---- Filter graph construction ---------------------------------------------

// Escape a string for safe inclusion in a drawtext `text=` option:
// filter-graph level: \ : ' need backslash escapes; % needs %%.
export function escapeDrawtext(t: string): string {
  return t
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '%%')
    .replace(/[\x00-\x1f]/g, ' ');
}

function logoOverlayExpr(p: any): string {
  const pos = p.logo_position;
  if (pos === 'custom') return `${p.logo_x}:${p.logo_y}`;
  const mx = p.logo_x, my = p.logo_y;
  return {
    tl: `${mx}:${my}`,
    tr: `W-w-${mx}:${my}`,
    bl: `${mx}:H-h-${my}`,
    br: `W-w-${mx}:H-h-${my}`,
  }[pos as string] || `${mx}:${my}`;
}

// Build the ffmpeg arg list for a profile. Pure function -- unit-testable.
export function buildArgs(profile: any, inputUrl: string, outputUrl: string): string[] {
  const args = ['-hide_banner', '-loglevel', 'warning', '-re', '-i', inputUrl];
  const filters: string[] = [];
  let hasLogo = false;

  if (profile.logo_path) {
    hasLogo = true;
    args.push('-i', profile.logo_path);
  }

  let vChain = '[0:v]';
  if (hasLogo) {
    const scale = profile.logo_width > 0 ? `scale=${profile.logo_width}:-1,` : '';
    const alpha = profile.logo_opacity < 1 ? `colorchannelmixer=aa=${profile.logo_opacity}` : 'null';
    filters.push(`[1:v]${scale}format=rgba,${alpha}[logo]`);
    filters.push(`[0:v][logo]overlay=${logoOverlayExpr(profile)}[v_logo]`);
    vChain = '[v_logo]';
  }

  if (profile.ticker_enabled && profile.ticker_text) {
    const y = profile.ticker_position === 'top' ? '10' : `h-th-10`;
    const speed = profile.ticker_speed;
    // Scroll right-to-left at speed px/s; loop seamlessly.
    const dt =
      `drawtext=text='${escapeDrawtext(profile.ticker_text)}'` +
      `:x='w-mod(t*${speed}\\,w+tw)'` +
      `:y=${y}:fontsize=${profile.ticker_font_size}` +
      `:fontcolor=${profile.ticker_color}:box=1:boxcolor=${profile.ticker_bg_color}`;
    filters.push(`${vChain}${dt}[v_out]`);
    vChain = '[v_out]';
  }

  if (filters.length) {
    args.push('-filter_complex', filters.join(';'), '-map', vChain, '-map', '0:a?');
  } else {
    args.push('-map', '0:v', '-map', '0:a?');
  }

  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-c:a', 'aac', '-b:a', '128k',
    '-f', /^rtmps?:\/\//i.test(outputUrl) ? 'flv' : 'mpegts', outputUrl
  );
  return args;
}

// ---- Process manager ---------------------------------------------------------

type SpawnFn = (cmd: string, args: string[], opts: any) => ChildProcess;
let spawnImpl: SpawnFn = (cmd, args, opts) => spawn(cmd, args, opts) as ChildProcess;

// Test hook: substitute a fake spawn. Returns a restore function.
export function __setSpawnImpl(fn: SpawnFn) { const prev = spawnImpl; spawnImpl = fn; return () => { spawnImpl = prev; }; }

const activeJobs = new Map<number, ChildProcess>(); // jobId -> process
const MAX_PER_STREAM = 1;                            // one overlay per channel

export function runningJobs() {
  return db.prepare(`SELECT * FROM overlay_jobs WHERE status IN ('starting','running')`).all() as any[];
}

export async function startOverlay(profileId: number): Promise<any> {
  // Policy validation runs BEFORE capability checks (ffmpeg presence, global
  // enable gate) -- a 409 isolation violation must be reported even when
  // ffmpeg is absent or the feature is not yet armed.
  const profile = db.prepare('SELECT * FROM overlay_profiles WHERE id = ?').get(profileId) as any;
  if (!profile) throw new OverlayError('Profile not found', 404);
  if (!profile.enabled) throw new OverlayError('Profile is disabled', 409);

  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(profile.stream_id) as any;
  if (!stream) throw new OverlayError('Stream not found', 404);
  const server = stream.server_id ? db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any : null;

  // Resolve the intended input and output BEFORE any checks so every output
  // destination (named stream OR explicit output_url) is validated.
  const inputUrl = stream.live_url || (server ? `${server.url.replace(/\/$/, '')}/${encodeURIComponent(stream.name)}/index.m3u8` : null);
  if (!inputUrl) throw new OverlayError('No playable input URL for this stream', 400);

  const outputName = profile.output_stream || `${stream.name}_ovr`;
  // Keep the derived URL only for isolation and recursion checks.
  // It is NOT assumed to be a valid Flussonic ingest endpoint.
  const outputUrl = profile.output_url
    || (server ? `${server.url.replace(/\/$/, '')}/flussonic/publish/${encodeURIComponent(outputName)}` : null);
  if (!outputUrl) throw new OverlayError('An explicit output_url is required', 400);

  // Isolation rule A: a named output stream must not be the source channel.
  if (outputName === stream.name && !profile.output_url) {
    throw new OverlayError(
      `output_stream '${outputName}' equals the source stream -- overlay output must be an isolated stream. ` +
      `Set output_stream (e.g. '${stream.name}_ovr') or an explicit output_url.`, 409);
  }

  // Isolation rule B: an explicit output_url gets the SAME scrutiny —
  // canonicalized and rejected if it equals the input URL, targets the
  // source stream on the same server, or points at any endpoint the source
  // already consumes as an input (feedback loop).
  if (canonUrl(outputUrl) === canonUrl(inputUrl)) {
    throw new OverlayError(
      `output_url equals the source input URL — overlay output must not feed back into the channel it reads`, 409);
  }
  if (server && urlTargetsStream(outputUrl, server.url, stream.name)) {
    throw new OverlayError(
      `output_url targets the source stream '${stream.name}' on its own server — overlay output must be isolated`, 409);
  }
  const srcInputs: string[] = (() => { try { return JSON.parse(stream.inputs || '[]'); } catch { return []; } })();
  const outCanon = canonUrl(outputUrl);
  if (srcInputs.some(i => canonUrl(i) === outCanon)) {
    throw new OverlayError(
      `output_url matches one of the source channel's inputs — publishing there creates a feedback loop`, 409);
  }

  // Recursion guard: reject a cycle where our OUTPUT stream is itself the
  // source of an enabled profile whose output resolves back to this stream
  // (A -> B plus B -> A would loop the ffmpeg pipelines indefinitely).
  const backedge = db.prepare(
    `SELECT p.id FROM overlay_profiles p JOIN streams s2 ON s2.id = p.stream_id
     WHERE s2.name = ? AND p.enabled = 1
       AND (p.output_stream = ? OR (p.output_stream IS NULL AND ? = s2.name || '_ovr'))`
  ).get(outputName, stream.name, stream.name) as any;
  if (backedge) {
    throw new OverlayError(
      `Recursive overlay rejected: '${outputName}' already sources an overlay outputting to '${stream.name}'. ` +
      `Chained overlays must not form cycles.`, 409);
  }

  // Fail closed: the management API URL does not identify a verified ingest
  // endpoint. Do not start a worker until an explicit destination is configured.
  if (!profile.output_url) {
    throw new OverlayError('An explicit output_url is required (verified RTMP, SRT or UDP publishing endpoint)', 400);
  }

  // Logo assets: full path resolution (containment + existence + symlink).
  if (profile.logo_path) {
    profile.logo_path = resolveLogoPath(profile.logo_path);
  }

  // Global gate: overlay workers must be explicitly armed (mirrors the
  // scheduler). Prevents accidental ffmpeg runs against real channels.
  if (!overlayEnabled()) {
    throw new OverlayError('Overlay rendering is disabled — set settings.overlay_enabled=1 or OVERLAY_ENABLED=1', 409);
  }

  if (!detectFfmpeg()) {
    throw new OverlayError('ffmpeg not found on PATH (set FFMPEG_PATH). Overlay rendering requires FFmpeg.', 503);
  }

  const running = db.prepare(
    `SELECT COUNT(*) n FROM overlay_jobs WHERE stream_id = ? AND status IN ('starting','running')`
  ).get(stream.id) as any;
  if (running.n >= MAX_PER_STREAM) {
    throw new OverlayError('An overlay job is already running for this stream -- stop it first', 409);
  }

  const info = db.prepare(
    `INSERT INTO overlay_jobs (profile_id, stream_id, status) VALUES (?, ?, 'starting')`
  ).run(profile.id, stream.id);
  const jobId = Number(info.lastInsertRowid);

  const args = buildArgs(profile, inputUrl, outputUrl);
  let proc: ChildProcess;
  try {
    proc = spawnImpl(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e: any) {
    db.prepare(`UPDATE overlay_jobs SET status='failed', last_error=?, stopped_at=CURRENT_TIMESTAMP WHERE id=?`).run(`spawn failed: ${e.message}`, jobId);
    throw new OverlayError(`ffmpeg spawn failed: ${e.message}`, 500);
  }

  let stderrTail = '';
  proc.stderr?.on('data', (d: any) => { stderrTail = (stderrTail + String(d)).slice(-4000); });
  proc.on('error', (e: any) => {
    db.prepare(`UPDATE overlay_jobs SET status='failed', last_error=?, stopped_at=CURRENT_TIMESTAMP WHERE id=?`).run(e.message, jobId);
    activeJobs.delete(jobId);
    recordStreamEvent(stream.id, stream.lifecycle_state, stream.lifecycle_state, null,
      `overlay job #${jobId} failed to start: ${e.message}`);
  });
  proc.on('exit', (code: any) => {
    const cur = db.prepare('SELECT status FROM overlay_jobs WHERE id = ?').get(jobId) as any;
    // 'stopped' means we asked it to stop -- don't overwrite deliberate stops.
    if (cur && cur.status !== 'stopped') {
      db.prepare(`UPDATE overlay_jobs SET status=?, exit_code=?, last_error=?, stopped_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(code === 0 ? 'completed' : 'exited', code, code === 0 ? null : (stderrTail.slice(-1000) || `exit code ${code}`), jobId);
      if (code !== 0) {
        recordStreamEvent(stream.id, stream.lifecycle_state, stream.lifecycle_state, null,
          `overlay job #${jobId} exited unexpectedly (code ${code}): ${stderrTail.slice(-300)}`);
      }
    }
    activeJobs.delete(jobId);
  });

  activeJobs.set(jobId, proc);
  db.prepare(`UPDATE overlay_jobs SET status='running', pid=? WHERE id=?`).run(proc.pid ?? null, jobId);
  recordStreamEvent(stream.id, stream.lifecycle_state, stream.lifecycle_state, null,
    `overlay job #${jobId} started: ${stream.name} -> ${outputName} (pid ${proc.pid})`);
  return db.prepare('SELECT * FROM overlay_jobs WHERE id = ?').get(jobId);
}

export function stopOverlay(jobId: number): boolean {
  const job = db.prepare('SELECT * FROM overlay_jobs WHERE id = ?').get(jobId) as any;
  if (!job) return false;
  const proc = activeJobs.get(jobId);
  db.prepare(`UPDATE overlay_jobs SET status='stopped', stopped_at=CURRENT_TIMESTAMP WHERE id=?`).run(jobId);
  if (proc) {
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* noop */ } }, 5000).unref?.();
    activeJobs.delete(jobId);
  }
  return true;
}

// On boot, any job left 'running'/'starting' is dead (process state is
// process-local) -- mark them so the dashboard reflects reality.
export function recoverOverlayJobs() {
  const r = db.prepare(
    `UPDATE overlay_jobs SET status='exited', last_error='process lost on application restart', stopped_at=CURRENT_TIMESTAMP
     WHERE status IN ('starting','running')`
  ).run();
  if (r.changes) console.log(`[overlay] marked ${r.changes} stale job(s) as exited`);
}

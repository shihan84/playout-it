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

// Auto-restart of crashed overlay workers is DISABLED by default and requires
// BOTH the per-profile auto_restart flag AND this global gate
// (settings.overlay_auto_restart=1 or OVERLAY_AUTO_RESTART_ENABLED=1).
export function autoRestartEnabled(): boolean {
  const s = db.prepare("SELECT value FROM settings WHERE key = 'overlay_auto_restart'").get() as any;
  if (s) return s.value === '1';
  return process.env.OVERLAY_AUTO_RESTART_ENABLED === '1';
}

// Read per-call so ops/tests can tune without a reload.
const restartMaxAttempts = () => Math.max(0, Number(process.env.OVERLAY_RESTART_MAX_ATTEMPTS || 5));
const restartBaseDelayMs = () => Math.max(0, Number(process.env.OVERLAY_RESTART_BASE_DELAY_MS || 5000));
const restartMaxDelayMs = () => Math.max(1000, Number(process.env.OVERLAY_RESTART_MAX_DELAY_MS || 300000));
// A worker alive this long before crashing counts as stable — its restart
// counter resets, so a rare crash never permanently consumes retries.
const restartStableMs = () => Math.max(0, Number(process.env.OVERLAY_RESTART_STABLE_MS || 60000));

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

// Default ports per scheme — used to canonicalize `rtmp://host` and
// `rtmp://host:1935` to the same identity.
const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80', 'https:': '443', 'rtmp:': '1935', 'rtmps:': '443',
};

function effectivePort(u: URL): string {
  return u.port || DEFAULT_PORTS[u.protocol] || '';
}

// Canonicalize a URL for equality checks: lowercase scheme+host, normalize
// the default port, drop userinfo, strip trailing slashes.
function canonUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const port = u.port && u.port !== DEFAULT_PORTS[u.protocol] ? `:${u.port}` : '';
    return `${u.protocol}//${u.hostname.toLowerCase()}${port}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    // udp:// rtmp:// srt:// parse fine via URL; anything unparseable is
    // compared literally after lowercasing + trailing-slash strip.
    return String(raw).toLowerCase().replace(/\/+$/, '');
  }
}

// Strip credentials from a URL for safe display — publish endpoints often
// carry user:pass@ tokens that must never reach the UI or logs.
export function redactUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    return u.toString();
  } catch {
    return raw.replace(/\/\/[^/@]*@/, '//***@');
  }
}

// Scrub user:pass@ credential segments out of arbitrary text (e.g. an ffmpeg
// stderr tail that echoes the publish URL) before persisting to job rows or
// stream events.
export function redactCredsInText(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1***@')
             .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+@/g, '$1***@');
}

// True when `out` targets the given stream on the given server — i.e. ffmpeg
// would publish back onto the source channel or an endpoint the source
// consumes. Compares scheme-normalized host AND effective port (an
// alternate port on the same host still reaches the same server), then
// matches the stream name either as a single path segment ('name') or as a
// trailing multi-segment path ('folder/name' after percent-decoding).
function urlTargetsStream(out: string, serverUrl: string, streamName: string): boolean {
  try {
    const o = new URL(out);
    const s = new URL(serverUrl);
    if (o.hostname.toLowerCase() !== s.hostname.toLowerCase()) return false;
    // Port is intentionally NOT compared: a Flussonic server accepts ingest
    // on rtmp:1935, srt, udp and http simultaneously — publishing to the same
    // hostname under ANY port still reaches the same server.
    const path = o.pathname.split('/').map(seg => {
      try { return decodeURIComponent(seg); } catch { return seg; }
    }).join('/');
    return path.split('/').includes(streamName)
      || path.endsWith(`/${streamName}`)
      || path === `/${streamName}`;
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

// Test hook: force the detection result (null = re-detect). Tests must not
// depend on the runner actually having ffmpeg installed.
export function __setFfmpegAvailable(v: boolean | null) { const prev = ffmpegAvailable; ffmpegAvailable = v; return () => { ffmpegAvailable = prev; }; }

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
  const autoRestart = body.auto_restart ? 1 : 0;

  const outputUrl = body.output_url ? String(body.output_url).trim() : null;
  // Only protocols with verified publish semantics are accepted:
  //   rtmp:// / rtmps:// -> FLV muxer (Flussonic RTMP ingest)
  //   srt://  / udp://   -> MPEG-TS muxer (Flussonic ts/srt/udp ingest)
  // http(s) is rejected — it is ambiguous (HLS/DASH pull vs PUT ingest is
  // not a verified Flussonic publish path) and would broaden SSRF surface.
  if (outputUrl && /^https?:\/\//i.test(outputUrl)) {
    throw new OverlayError('http(s):// output_url is not a verified publishing protocol — use rtmp(s)://, srt:// or udp://');
  }
  if (outputUrl && !/^(rtmps?|srt|udp):\/\//i.test(outputUrl)) {
    throw new OverlayError('output_url must start with rtmp://, rtmps://, srt://, or udp://');
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
    auto_restart: autoRestart,
    enabled: body.enabled === undefined ? 1 : (body.enabled ? 1 : 0),
  };
}

// ---- Filter graph construction ---------------------------------------------

// Escape a string for safe inclusion in a drawtext `text=` option.
// Two parse levels are involved: the filtergraph args parser (separates
// options on ':' and consumes \-escapes) and drawtext's own option parser.
// NOTE: single-quoted values containing \' break ffmpeg's args parser (a
// \' inside '...' is a real parse hazard in -filter_complex), so the text
// is emitted UNQUOTED with both levels backslash-escaped instead.
export function escapeDrawtext(t: string): string {
  // Level 1 — drawtext option parser: \ : ' % are special.
  let s = t
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/[\x00-\x1f]/g, ' ');
  // Level 2 — filtergraph args parser: escape level-1 backslashes first,
  // then the graph-level metacharacters.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/=/g, '\\=')
    .replace(/ /g, '\\ ');
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
      `drawtext=expansion=none:text=${escapeDrawtext(profile.ticker_text)}` +
      `:x='w-mod(t*${speed}\\,w+tw)'` +
      `:y=${y}:fontsize=${profile.ticker_font_size}` +
      `:fontcolor=${profile.ticker_color}:box=1:boxcolor='${profile.ticker_bg_color}'`;
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
// Timers for scheduled auto-restarts, keyed by the crashed job's id. A job
// row keeps next_retry_at as the durable record; the timer is the in-process
// trigger. Clearing next_retry_at (stop, retry consumed, boot reconcile)
// always wins over a stale timer.
const pendingRetries = new Map<number, ReturnType<typeof setTimeout>>();
let shuttingDown = false;

// App shutdown: cancel pending restarts, SIGTERM every worker, SIGKILL after
// graceMs, and resolve once all have exited so none outlives the process.
export async function shutdownOverlays(graceMs = 5000): Promise<void> {
  shuttingDown = true;
  for (const t of pendingRetries.values()) clearTimeout(t);
  pendingRetries.clear();
  await Promise.all([...activeJobs.values()].map(proc => new Promise<void>(resolve => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const kill = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, graceMs);
    proc.once('exit', () => { clearTimeout(kill); resolve(); });
    try { proc.kill('SIGTERM'); } catch { clearTimeout(kill); resolve(); }
  })));
}
const MAX_PER_STREAM = 1;                            // one overlay per channel
// Global ffmpeg worker cap — each job is a full decode+encode process; an
// unbounded count would saturate CPU and starve the management server.
const MAX_TOTAL_WORKERS = Math.max(1, Number(process.env.OVERLAY_MAX_WORKERS || 8));

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

  // Isolation rule A: a named output stream must never be the source channel
  // — regardless of whether an explicit output_url is present.
  if (outputName === stream.name) {
    throw new OverlayError(
      `output_stream '${outputName}' equals the source stream -- overlay output must be an isolated stream. ` +
      `Set output_stream (e.g. '${stream.name}_ovr').`, 409);
  }

  // Recursion guard (name-based — runs even without an output_url): reject a
  // cycle where our OUTPUT stream is itself the source of an enabled profile
  // whose output resolves back to this stream (A -> B plus B -> A would loop
  // the ffmpeg pipelines indefinitely).
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
  // endpoint. No synthetic URL is derived — an explicit, validated
  // destination is required before any further checks.
  if (!profile.output_url) {
    throw new OverlayError('An explicit output_url is required (verified RTMP, SRT or UDP publishing endpoint)', 400);
  }
  const outputUrl = profile.output_url;

  // Isolation rule B: an explicit output_url gets the SAME scrutiny —
  // canonicalized and rejected if it equals the input URL, targets the
  // source stream on the same server, or points at any endpoint the source
  // already consumes as an input (feedback loop).
  if (canonUrl(outputUrl) === canonUrl(inputUrl)) {
    throw new OverlayError(
      `output_url equals the source input URL — overlay output must not feed back into the channel it reads`, 409);
  }
  if ((server && urlTargetsStream(outputUrl, server.url, stream.name))
    || urlTargetsStream(outputUrl, inputUrl, stream.name)) {
    throw new OverlayError(
      `output_url targets the source stream '${stream.name}' on its own server — overlay output must be isolated`, 409);
  }
  const srcInputs: string[] = (() => { try { return JSON.parse(stream.inputs || '[]'); } catch { return []; } })();
  const outCanon = canonUrl(outputUrl);
  if (srcInputs.some(i => canonUrl(i) === outCanon)) {
    throw new OverlayError(
      `output_url matches one of the source channel's inputs — publishing there creates a feedback loop`, 409);
  }

  // Defense in depth: even if a non-publish scheme slips into the DB (legacy
  // row or direct write), refuse to spawn — only verified protocols run.
  if (!/^(rtmps?|srt|udp):\/\//i.test(outputUrl)) {
    throw new OverlayError(
      `output_url scheme is not a verified publishing protocol — use rtmp(s)://, srt:// or udp://`, 400);
  }

  // Output collision: two profiles must not publish to the same destination
  // — two ffmpeg workers writing one endpoint corrupts the stream.
  const collision = db.prepare(
    `SELECT id, output_url FROM overlay_profiles WHERE id != ? AND output_url IS NOT NULL`
  ).all(profile.id) as any[];
  if (collision.some(p => canonUrl(p.output_url) === outCanon)) {
    throw new OverlayError('Another overlay profile already publishes to this output_url', 409);
  }
  const nameCollision = db.prepare(
    `SELECT id FROM overlay_profiles WHERE id != ? AND output_stream = ? AND enabled = 1`
  ).get(profile.id, outputName) as any;
  if (nameCollision) {
    throw new OverlayError(`Another enabled profile already outputs to stream '${outputName}'`, 409);
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

  // Resource caps are policy — enforce before capability checks so a busy
  // pool reports 429/409 deterministically even when ffmpeg is absent.
  const running = db.prepare(
    `SELECT COUNT(*) n FROM overlay_jobs WHERE stream_id = ? AND status IN ('starting','running')`
  ).get(stream.id) as any;
  if (running.n >= MAX_PER_STREAM) {
    throw new OverlayError('An overlay job is already running for this stream -- stop it first', 409);
  }
  const globalRunning = db.prepare(
    `SELECT COUNT(*) n FROM overlay_jobs WHERE status IN ('starting','running')`
  ).get() as any;
  if (globalRunning.n >= MAX_TOTAL_WORKERS) {
    throw new OverlayError(`Overlay worker limit reached (${MAX_TOTAL_WORKERS}) — stop a job or raise OVERLAY_MAX_WORKERS`, 429);
  }

  if (!detectFfmpeg()) {
    throw new OverlayError('ffmpeg not found on PATH (set FFMPEG_PATH). Overlay rendering requires FFmpeg.', 503);
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
    if (shuttingDown) {
      db.prepare(`UPDATE overlay_jobs SET status='exited', exit_code=?, last_error='app shutdown', stopped_at=CURRENT_TIMESTAMP WHERE id=? AND status NOT IN ('stopped','failed')`).run(code, jobId);
      activeJobs.delete(jobId);
      return;
    }
    const cur = db.prepare('SELECT status FROM overlay_jobs WHERE id = ?').get(jobId) as any;
    // 'stopped'/'failed' are deliberate terminal states (stop request or the
    // 'error' handler already recorded the spawn failure) — never overwrite.
    if (cur && cur.status !== 'stopped' && cur.status !== 'failed') {
      const safeTail = redactCredsInText(stderrTail);
      db.prepare(`UPDATE overlay_jobs SET status=?, exit_code=?, last_error=?, stopped_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(code === 0 ? 'completed' : 'exited', code, code === 0 ? null : (safeTail.slice(-1000) || `exit code ${code}`), jobId);
      if (code !== 0) {
        recordStreamEvent(stream.id, stream.lifecycle_state, stream.lifecycle_state, null,
          `overlay job #${jobId} exited unexpectedly (code ${code}): ${safeTail.slice(-300)}`);
        maybeScheduleRestart(jobId, profile.id, stream.id);
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

// Exponential backoff for attempt n (1-based): base * 2^(n-1), capped, with
// ±10% jitter so a fleet of crashed workers doesn't retry in lockstep.
export function restartDelayMs(attempt: number): number {
  const delay = Math.min(restartBaseDelayMs() * Math.pow(2, attempt - 1), restartMaxDelayMs());
  return Math.round(delay * (0.9 + Math.random() * 0.2));
}

// Decide whether an unexpected exit should be retried, and if so schedule it.
// Requires the per-profile auto_restart flag AND the global gate. Intentional
// stops never reach here ('stopped' is terminal before this is called).
function maybeScheduleRestart(jobId: number, profileId: number, streamId: number) {
  const profile = db.prepare('SELECT * FROM overlay_profiles WHERE id = ?').get(profileId) as any;
  if (!profile?.auto_restart || !autoRestartEnabled()) return;

  const job = db.prepare('SELECT * FROM overlay_jobs WHERE id = ?').get(jobId) as any;
  if (!job) return;
  // Stable-run reset: uptime >= threshold means this crash doesn't count
  // against the retry budget.
  const uptimeMs = Date.now() - new Date(String(job.started_at).replace(' ', 'T') + 'Z').getTime();
  const attempt = (uptimeMs >= restartStableMs() ? 0 : (job.restart_count || 0)) + 1;

  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId) as any;
  if (attempt > restartMaxAttempts()) {
    db.prepare(`UPDATE overlay_jobs SET status='failed', last_error=? WHERE id=?`)
      .run(`auto-restart exhausted (${restartMaxAttempts()} attempts)`, jobId);
    recordStreamEvent(streamId, stream?.lifecycle_state, stream?.lifecycle_state, null,
      `overlay job #${jobId} marked failed: auto-restart exhausted after ${restartMaxAttempts()} attempts`);
    void import('./telegram').then(t => t.sendTelegramNotification(
      `Overlay worker failed permanently: job #${jobId} (${stream?.name || streamId}) after ${restartMaxAttempts()} restart attempts`
    )).catch(() => {});
    return;
  }

  const delay = restartDelayMs(attempt);
  db.prepare(`UPDATE overlay_jobs SET restart_count=?, next_retry_at=datetime('now', '+' || ? || ' seconds') WHERE id=?`)
    .run(attempt, Math.ceil(delay / 1000), jobId);
  recordStreamEvent(streamId, stream?.lifecycle_state, stream?.lifecycle_state, null,
    `overlay job #${jobId} crashed — auto-restart attempt ${attempt}/${restartMaxAttempts()} in ${Math.round(delay / 1000)}s`);

  const timer = setTimeout(() => attemptRestart(jobId), delay);
  timer.unref?.();
  pendingRetries.set(jobId, timer);
}

// Fire a scheduled restart. Re-runs the FULL startOverlay validation —
// isolation, scheme, collision and cap checks must all pass again because
// the output target or profile may have become unsafe during the backoff.
export async function attemptRestart(oldJobId: number): Promise<void> {
  pendingRetries.delete(oldJobId);
  const job = db.prepare('SELECT * FROM overlay_jobs WHERE id = ?').get(oldJobId) as any;
  // next_retry_at cleared means the retry was cancelled (stop/retry/boot reconcile).
  if (!job?.next_retry_at) return;
  db.prepare('UPDATE overlay_jobs SET next_retry_at=NULL WHERE id=?').run(oldJobId);
  try {
    const newJob = await startOverlay(job.profile_id);
    db.prepare('UPDATE overlay_jobs SET restart_count=? WHERE id=?').run(job.restart_count || 0, newJob.id);
  } catch (e: any) {
    const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(job.stream_id) as any;
    recordStreamEvent(job.stream_id, stream?.lifecycle_state, stream?.lifecycle_state, null,
      `overlay auto-restart for job #${oldJobId} aborted: ${e.message}`);
  }
}

export function stopOverlay(jobId: number): boolean {
  const job = db.prepare('SELECT * FROM overlay_jobs WHERE id = ?').get(jobId) as any;
  if (!job) return false;
  // Cancel any scheduled auto-restart — an operator stop is terminal.
  const timer = pendingRetries.get(jobId);
  if (timer) { clearTimeout(timer); pendingRetries.delete(jobId); }
  const proc = activeJobs.get(jobId);
  db.prepare(`UPDATE overlay_jobs SET status='stopped', stopped_at=CURRENT_TIMESTAMP, next_retry_at=NULL WHERE id=?`).run(jobId);
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
  const stale = db.prepare(
    `SELECT * FROM overlay_jobs WHERE status IN ('starting','running')`
  ).all() as any[];
  const r = db.prepare(
    `UPDATE overlay_jobs SET status='exited', last_error='process lost on application restart', stopped_at=CURRENT_TIMESTAMP
     WHERE status IN ('starting','running')`
  ).run();
  if (r.changes) console.log(`[overlay] marked ${r.changes} stale job(s) as exited`);
  // Crash-during-run: eligible stale jobs get a fresh backoff window.
  for (const j of stale) maybeScheduleRestart(j.id, j.profile_id, j.stream_id);
  // Crash-during-backoff: rows with a pending retry resume their remaining
  // delay instead of being forgotten with the in-process timer map.
  const pending = db.prepare(
    `SELECT j.*, (julianday(j.next_retry_at) - julianday('now')) * 86400000 AS remaining_ms
     FROM overlay_jobs j WHERE j.next_retry_at IS NOT NULL`
  ).all() as any[];
  for (const j of pending) {
    if (pendingRetries.has(j.id)) continue;
    const delay = Math.max(0, Math.round(j.remaining_ms));
    const timer = setTimeout(() => attemptRestart(j.id), delay);
    timer.unref?.();
    pendingRetries.set(j.id, timer);
  }
  if (pending.length) console.log(`[overlay] resumed ${pending.length} pending auto-restart(s)`);
}

import { spawn, ChildProcess } from 'child_process';
import { execSync } from 'child_process';
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
    '-f', 'mpegts', outputUrl
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
  // Policy validation runs BEFORE the ffmpeg capability check -- a 409
  // isolation violation must be reported even when ffmpeg is absent.
  const profile = db.prepare('SELECT * FROM overlay_profiles WHERE id = ?').get(profileId) as any;
  if (!profile) throw new OverlayError('Profile not found', 404);
  if (!profile.enabled) throw new OverlayError('Profile is disabled', 409);

  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(profile.stream_id) as any;
  if (!stream) throw new OverlayError('Stream not found', 404);
  const server = stream.server_id ? db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any : null;

  // Isolation rule: overlay output must not overwrite the source channel.
  const outputName = profile.output_stream || `${stream.name}_ovr`;
  if (outputName === stream.name && !profile.output_url) {
    throw new OverlayError(
      `output_stream '${outputName}' equals the source stream -- overlay output must be an isolated stream. ` +
      `Set output_stream (e.g. '${stream.name}_ovr') or an explicit output_url.`, 409);
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

  if (!detectFfmpeg()) {
    throw new OverlayError('ffmpeg not found on PATH (set FFMPEG_PATH). Overlay rendering requires FFmpeg.', 503);
  }

  const running = db.prepare(
    `SELECT COUNT(*) n FROM overlay_jobs WHERE stream_id = ? AND status IN ('starting','running')`
  ).get(stream.id) as any;
  if (running.n >= MAX_PER_STREAM) {
    throw new OverlayError('An overlay job is already running for this stream -- stop it first', 409);
  }

  const inputUrl = stream.live_url || (server ? `${server.url.replace(/\/$/, '')}/${encodeURIComponent(stream.name)}/index.m3u8` : null);
  if (!inputUrl) throw new OverlayError('No playable input URL for this stream', 400);

  const outputUrl = profile.output_url
    || (server ? `${server.url.replace(/\/$/, '')}/flussonic/publish/${encodeURIComponent(outputName)}` : null);
  if (!outputUrl) throw new OverlayError('No output_url and stream has no server to derive one from', 400);

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

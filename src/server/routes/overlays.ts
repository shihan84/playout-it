import { Router } from 'express';
import { db } from '../db';
import {
  OverlayError, validateProfileSpec, startOverlay, stopOverlay, detectFfmpeg,
  assertLogoPathAllowed, overlayAssetDir, redactUrl,
} from '../services/overlay';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth';

const router = Router();

function err(e: any, res: any) {
  res.status(e.status || 500).json({ error: e.message });
}

// ---- Capabilities --------------------------------------------------------

router.get('/capabilities', authenticateToken, (_req, res) => {
  res.json({ ffmpeg: detectFfmpeg(), asset_dir: overlayAssetDir() });
});

// ---- Profiles ------------------------------------------------------------

// Publish URLs can carry user:pass@ tokens — always redact before sending.
function publicProfile(row: any) {
  return row ? { ...row, output_url: redactUrl(row.output_url) } : row;
}

router.get('/', authenticateToken, requireAdmin, (_req, res) => {
  const rows = db.prepare(
    `SELECT op.*, s.name AS stream_name,
       (SELECT COUNT(*) FROM overlay_jobs j WHERE j.profile_id = op.id AND j.status IN ('starting','running')) AS running_jobs
     FROM overlay_profiles op JOIN streams s ON s.id = op.stream_id ORDER BY op.id`
  ).all();
  res.json((rows as any[]).map(publicProfile));
});

router.post('/', authenticateToken, requireAdmin, (req: AuthRequest, res) => {
  try {
    const spec = validateProfileSpec(req.body);
    if (spec.logo_path) assertLogoPathAllowed(spec.logo_path);
    const streamId = Number(req.body?.stream_id);
    const stream = db.prepare('SELECT id FROM streams WHERE id = ?').get(streamId);
    if (!stream) throw new OverlayError('Stream not found', 404);
    const cols = Object.keys(spec);
    const info = db.prepare(
      `INSERT INTO overlay_profiles (stream_id, ${cols.join(', ')}, created_by) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`
    ).run(streamId, ...cols.map(c => (spec as any)[c]), req.user.id);
    res.status(201).json(publicProfile(db.prepare('SELECT * FROM overlay_profiles WHERE id = ?').get(info.lastInsertRowid)));
  } catch (e: any) { err(e, res); }
});

router.get('/:id', authenticateToken, requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM overlay_profiles WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Profile not found' });
  res.json(publicProfile(row));
});

router.patch('/:id', authenticateToken, requireAdmin, (req, res) => {
  try {
    const profile = db.prepare('SELECT * FROM overlay_profiles WHERE id = ?').get(req.params.id) as any;
    if (!profile) throw new OverlayError('Profile not found', 404);
    // A redacted '***' output_url echoed back by the UI must not overwrite
    // the stored credential URL.
    if (typeof req.body?.output_url === 'string' && req.body.output_url.includes('***')) {
      delete req.body.output_url;
    }
    const merged = { ...profile, ...req.body };
    const spec = validateProfileSpec(merged);
    if (spec.logo_path) assertLogoPathAllowed(spec.logo_path);
    const cols = Object.keys(spec);
    db.prepare(
      `UPDATE overlay_profiles SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`
    ).run(...cols.map(c => (spec as any)[c]), profile.id);
    res.json(publicProfile(db.prepare('SELECT * FROM overlay_profiles WHERE id = ?').get(profile.id)));
  } catch (e: any) { err(e, res); }
});

router.delete('/:id', authenticateToken, requireAdmin, (req, res) => {
  // Stopping any running jobs first; profile delete never touches remote streams.
  db.transaction(() => {
    const running = db.prepare(
      `SELECT id FROM overlay_jobs WHERE profile_id = ? AND status IN ('starting','running')`
    ).all(req.params.id) as any[];
    for (const j of running) stopOverlay(j.id);
    return db.prepare('DELETE FROM overlay_profiles WHERE id = ?').run(req.params.id);
  })();
  res.json({ success: true });
});

// ---- Jobs ----------------------------------------------------------------

router.get('/jobs/list', authenticateToken, requireAdmin, (req, res) => {
  const rows = db.prepare(
    `SELECT j.*, s.name AS stream_name, op.name AS profile_name
     FROM overlay_jobs j
     JOIN streams s ON s.id = j.stream_id
     JOIN overlay_profiles op ON op.id = j.profile_id
     ORDER BY j.id DESC LIMIT 200`
  ).all();
  res.json(rows);
});

router.post('/:id/start', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const job = await startOverlay(Number(req.params.id));
    res.status(201).json(job);
  } catch (e: any) { err(e, res); }
});

router.post('/jobs/:jobId/stop', authenticateToken, requireAdmin, (req, res) => {
  if (!stopOverlay(Number(req.params.jobId))) return res.status(404).json({ error: 'Job not found' });
  res.json({ success: true });
});

export default router;

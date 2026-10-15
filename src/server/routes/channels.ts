import { Router } from 'express';
import { db } from '../db';
import { flussonicRequest } from '../services/flussonic';
import { createChannel, validateChannelSpec, ChannelError } from '../services/channels';
import { transitionStream, isLifecycleState } from '../services/lifecycle';
import { broadcastStreamsUpdate } from '../websocket';
import { mapLimit } from '../utils/concurrency';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth';

const router = Router();

// ---- Channel templates (Phase 2 P3) -------------------------------------

router.get('/templates', authenticateToken, requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT * FROM channel_templates ORDER BY name').all() as any[];
  res.json(rows.map(r => ({ ...r, inputs: JSON.parse(r.inputs || '[]'), push_urls: JSON.parse(r.push_urls || '[]') })));
});

router.post('/templates', authenticateToken, requireAdmin, (req: AuthRequest, res) => {
  try {
    const spec = validateChannelSpec(req.body);
    const info = db.prepare('INSERT INTO channel_templates (name, inputs, push_urls, vod_path, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(spec.name, JSON.stringify(spec.inputs), JSON.stringify(spec.push_urls || []), spec.vod_path || null, req.user.id);
    res.json(db.prepare('SELECT * FROM channel_templates WHERE id = ?').get(info.lastInsertRowid));
  } catch (e: any) {
    if (e.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ error: `Template '${req.body?.name}' already exists` });
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete('/templates/:id', authenticateToken, requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM channel_templates WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Template not found' });
  res.json({ success: true });
});

// ---- Single channel create (Phase 2 P1) ---------------------------------

router.post('/', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
  const { server_id } = req.body || {};
  if (!server_id || typeof server_id !== 'number') {
    return res.status(400).json({ error: 'Valid server ID is required' });
  }
  try {
    const spec = validateChannelSpec(req.body);
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const { streamId, vodId, vodName } = await createChannel(server, spec, req.user.id);
    broadcastStreamsUpdate();
    res.json({ id: streamId, vod_id: vodId, server_id, name: spec.name, vod_name: vodName, lifecycle_state: 'live', inputs: spec.inputs, push_urls: spec.push_urls });
  } catch (e: any) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- Bulk channel operations (Phase 2 P3) --------------------------------
// action: 'create' (items: channel specs), 'transition' (items: {name,to}),
// 'delete' (items: {name}). One failure never aborts the batch; results are
// reported per item.

const BULK_ACTIONS = ['create', 'transition', 'delete'] as const;
const BULK_LIMIT = 100;

router.post('/bulk', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
  const { server_id, action, items, template_id } = req.body || {};
  if (!server_id || typeof server_id !== 'number') {
    return res.status(400).json({ error: 'Valid server ID is required' });
  }
  if (!BULK_ACTIONS.includes(action)) {
    return res.status(400).json({ error: `action must be one of ${BULK_ACTIONS.join(', ')}` });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }
  if (items.length > BULK_LIMIT) {
    return res.status(400).json({ error: `Bulk operations are limited to ${BULK_LIMIT} items` });
  }

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
  if (!server) return res.status(404).json({ error: 'Server not found' });

  // Template expansion: items become { name, ...template fields }
  let expanded = items;
  if (template_id) {
    const tpl = db.prepare('SELECT * FROM channel_templates WHERE id = ?').get(template_id) as any;
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    if (action !== 'create') return res.status(400).json({ error: 'template_id only applies to the create action' });
    const tplInputs = JSON.parse(tpl.inputs || '[]');
    const tplPushes = JSON.parse(tpl.push_urls || '[]');
    expanded = items.map((it: any) => ({
      ...it,
      inputs: it.inputs || tplInputs,
      push_urls: it.push_urls || tplPushes,
      vod_path: it.vod_path || tpl.vod_path || undefined,
    }));
  }

  const baseUrl = server.url.replace(/\/$/, '');
  const runItem = async (item: any): Promise<{ name: string; ok: boolean; error?: string; id?: number }> => {
    const itemName = item?.name;
    if (!itemName || typeof itemName !== 'string') {
      return { name: String(itemName ?? '?'), ok: false, error: 'item name is required' };
    }
    try {
      if (action === 'create') {
        const spec = validateChannelSpec(item);
        const { streamId } = await createChannel(server, spec, req.user.id);
        return { name: itemName, ok: true, id: streamId };
      }
      const stream = db.prepare('SELECT id FROM streams WHERE server_id = ? AND name = ?').get(server_id, itemName) as any;
      if (!stream) return { name: itemName, ok: false, error: 'stream not found on this server' };
      if (action === 'transition') {
        if (!isLifecycleState(item.to)) return { name: itemName, ok: false, error: `invalid target state '${item.to}'` };
        await transitionStream(stream.id, item.to, req.user.id);
        return { name: itemName, ok: true, id: stream.id };
      }
      // delete: remote first (best-effort), then local row in a transaction
      await flussonicRequest('DELETE', `${baseUrl}/flussonic/api/v3/streams/${encodeURIComponent(itemName)}`, server)
        .catch(e => console.warn(`[bulk] remote stream delete ${itemName}:`, e.message));
      const vodName = `${itemName}_vod`;
      await flussonicRequest('DELETE', `${baseUrl}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}`, server)
        .catch(e => console.warn(`[bulk] remote vod delete ${vodName}:`, e.message));
      db.transaction(() => {
        db.prepare('DELETE FROM streams WHERE id = ?').run(stream.id);
        db.prepare('DELETE FROM vods WHERE server_id = ? AND name IN (?, ?)').run(server_id, vodName, itemName);
      })();
      return { name: itemName, ok: true, id: stream.id };
    } catch (e: any) {
      return { name: itemName, ok: false, error: e.message };
    }
  };

  const results = await mapLimit(expanded, 4, runItem);
  broadcastStreamsUpdate();
  const succeeded = results.filter(r => r.ok).length;
  res.json({ action, server_id, succeeded, failed: results.length - succeeded, results });
});

export default router;

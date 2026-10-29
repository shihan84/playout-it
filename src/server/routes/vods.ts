import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { db } from '../db';
import { flussonicRequest } from '../services/flussonic';
import { syncVodFilesFromRemote } from '../services/sync';
import { updateVodPlaylistFile } from '../services/playlist';
import { authenticateToken, requireAdmin } from '../middleware/auth';
import { singleUpload, uploadPathSegment, UPLOAD_TMP_DIR } from '../utils/upload';

const upload = multer({
  dest: UPLOAD_TMP_DIR,
  limits: { fileSize: 1000 * 1024 * 1024 * 1024 }
});

const router = Router();

// VOD management is privileged; apply authorization before any upload parsing.
router.use(authenticateToken, requireAdmin);

router.get('/', authenticateToken, requireAdmin, (req, res) => {
  const vods = db.prepare(`
    SELECT vods.*, servers.name as server_name 
    FROM vods 
    LEFT JOIN servers ON vods.server_id = servers.id
  `).all();
  res.json(vods.map((v: any) => {
    let paths = [];
    try {
      paths = JSON.parse(v.paths || '[]');
    } catch (e) {
      console.error('Failed to parse paths for vod', v.id);
    }
    return { ...v, paths };
  }));
});

router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  const { server_id, name, paths } = req.body;

  // Input validation
  if (!server_id || typeof server_id !== 'number') {
    return res.status(400).json({ error: 'Valid server ID is required' });
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'VOD name is required' });
  }
  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'At least one storage path is required' });
  }

  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const baseUrl = server.url.replace(/\/$/, '');
    const flussonicUrl = `${baseUrl}/flussonic/api/v3/vods/${encodeURIComponent(name)}`;
    await flussonicRequest('PUT', flussonicUrl, server, {
      storages: paths.map((p: string) => ({ url: p }))
    }).catch(e => {
      console.warn(`Flussonic create VOD error for ${name}:`, e.message);
      // Try alternative payload
      if (paths.length > 0) {
        return flussonicRequest('PUT', flussonicUrl, server, { storage: paths[0] })
          .catch(e2 => console.warn('Alternative VOD create failed:', e2.message));
      }
    });

    const stmt = db.prepare('INSERT INTO vods (server_id, name, paths) VALUES (?, ?, ?)');
    const info = stmt.run(server_id, name.trim(), JSON.stringify(paths));
    res.json({ id: info.lastInsertRowid, server_id, name: name.trim(), paths });
  } catch (error: any) {
    console.error('Error creating VOD on Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to configure VOD on Flussonic' });
  }
});

router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { server_id, name, paths } = req.body;

  // Input validation
  if (!server_id || typeof server_id !== 'number') {
    return res.status(400).json({ error: 'Valid server ID is required' });
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'VOD name is required' });
  }
  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'At least one storage path is required' });
  }

  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const baseUrl = server.url.replace(/\/$/, '');
    const flussonicUrl = `${baseUrl}/flussonic/api/v3/vods/${encodeURIComponent(name)}`;

    // If name changed, we might need to delete old one and create new, but for simplicity let's just update the new one
    if (vod.name !== name) {
      const oldServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
      if (oldServer) {
        const oldBaseUrl = oldServer.url.replace(/\/$/, '');
        const oldFlussonicUrl = `${oldBaseUrl}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}`;
        await flussonicRequest('DELETE', oldFlussonicUrl, oldServer).catch(() => {});
      }
    }

    await flussonicRequest('PUT', flussonicUrl, server, {
      storages: paths.map((p: string) => ({ url: p }))
    }).catch(e => {
      console.warn(`Flussonic update VOD error for ${name}:`, e.message);
      if (paths.length > 0) {
        return flussonicRequest('PUT', flussonicUrl, server, { storage: paths[0] })
          .catch(e2 => console.warn('Alternative VOD update failed:', e2.message));
      }
    });

    db.prepare('UPDATE vods SET server_id = ?, name = ?, paths = ? WHERE id = ?').run(server_id, name.trim(), JSON.stringify(paths), req.params.id);
    res.json({ id: req.params.id, server_id, name: name.trim(), paths });
  } catch (error: any) {
    console.error('Error updating VOD on Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to update VOD on Flussonic' });
  }
});

router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (vod) {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
      if (server) {
        const flussonicUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}`;
        await flussonicRequest('DELETE', flussonicUrl, server)
          .catch(e => console.error('Flussonic delete error:', e.message));
      }
    }
    db.prepare('DELETE FROM vods WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/playlist/content', (req, res) => {
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });

    const files = db.prepare("SELECT filename FROM vod_files WHERE vod_id = ? AND filename NOT LIKE '%playlist.txt' ORDER BY created_at ASC").all(vod.id) as any[];
    const firstPart = vod.name.split('/')[0];
    const playlistContent = files.map(v => {
      if (v.filename.startsWith(`${firstPart}/`)) return v.filename;
      return `${firstPart}/${v.filename}`;
    }).join('\n');

    res.json({ content: playlistContent });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/playlist/update', async (req, res) => {
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });

    await updateVodPlaylistFile(vod);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/files', (req, res) => {
  try {
    const files = db.prepare('SELECT * FROM vod_files WHERE vod_id = ? ORDER BY created_at DESC').all(req.params.id);
    res.json(files);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/upload-info', (req, res) => {
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    // Never disclose upstream administrator credentials to browser clients.
    res.json({ serverUrl: server.url, vodName: vod.name, directUploadSupported: false });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/files/confirm-upload', async (req, res) => {
  const { filename, size } = req.body;
  if (!filename || !size) return res.status(400).json({ error: 'Missing filename or size' });

  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });

    db.prepare('INSERT INTO vod_files (vod_id, filename, size) VALUES (?, ?, ?)').run(vod.id, filename, size);
    await updateVodPlaylistFile(vod);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/files/init-chunked', (req, res) => {
  const { filename, totalChunks } = req.body;
  if (!filename || !totalChunks) return res.status(400).json({ error: 'Missing filename or totalChunks' });

  if (!Number.isSafeInteger(Number(totalChunks)) || Number(totalChunks) < 1 || Number(totalChunks) > 10000 || typeof filename !== 'string' || !/^[^/\\\\]+$/.test(filename) || filename === '.' || filename === '..') return res.status(400).json({ error: 'Invalid upload parameters' });
  const uploadId = randomBytes(16).toString('hex');
  const chunkDir = path.join(os.tmpdir(), `upload_${uploadId}`);

  if (!fs.existsSync(chunkDir)) {
    fs.mkdirSync(chunkDir, { recursive: true });
  }

  res.json({ uploadId, chunkDir });
});

router.post('/:id/files/chunk', singleUpload(upload, 'chunk'), (req, res) => {
  const { uploadId, chunkIndex } = req.body;
  if (!uploadId || chunkIndex === undefined || !req.file) {
    return res.status(400).json({ error: 'Missing uploadId, chunkIndex, or chunk file' });
  }

  if (typeof uploadId !== 'string' || !/^[a-f0-9]{32}$/.test(uploadId) || !Number.isSafeInteger(Number(chunkIndex)) || Number(chunkIndex) < 0 || Number(chunkIndex) > 10000) return res.status(400).json({ error: 'Invalid chunk parameters' });
  const chunkDir = path.join(os.tmpdir(), `upload_${uploadId}`);
  if (!fs.existsSync(chunkDir)) {
    return res.status(400).json({ error: 'Upload session not found' });
  }

  const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}`);
  fs.renameSync(req.file.path, chunkPath);

  res.json({ success: true });
});

router.post('/:id/files/complete-chunked', async (req, res) => {
  const { uploadId, filename, totalChunks, size } = req.body;
  if (!uploadId || !filename || !totalChunks || !size) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  if (typeof uploadId !== 'string' || !/^[a-f0-9]{32}$/.test(uploadId) || typeof filename !== 'string' || !/^[^/\\\\]+$/.test(filename) || filename === '.' || filename === '..' || !Number.isSafeInteger(Number(totalChunks)) || Number(totalChunks) < 1 || Number(totalChunks) > 10000) return res.status(400).json({ error: 'Invalid upload parameters' });
  const chunkDir = path.join(os.tmpdir(), `upload_${uploadId}`);
  const finalPath = path.join(os.tmpdir(), `final_${uploadId}_${filename}`);

  try {
    const writeStream = fs.createWriteStream(finalPath);
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(chunkDir, `chunk_${i}`);
      if (!fs.existsSync(chunkPath)) throw new Error(`Chunk ${i} missing`);
      const chunkData = fs.readFileSync(chunkPath);
      writeStream.write(chunkData);
      fs.unlinkSync(chunkPath);
    }
    writeStream.end();

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
    });

    // Now push to Flussonic
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) throw new Error('VOD not found');

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
    if (!server) throw new Error('Server not found');

    const uploadUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}/storages/0/files/${uploadPathSegment(filename)}`;
    const fileStream = () => fs.createReadStream(finalPath);

    await flussonicRequest('PUT', uploadUrl, server, fileStream, 3600000);

    db.prepare('INSERT INTO vod_files (vod_id, filename, size) VALUES (?, ?, ?)').run(vod.id, filename, size);
    await updateVodPlaylistFile(vod);

    res.json({ success: true });
  } catch (error: any) {
    console.error('Chunked upload completion failed:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (fs.existsSync(chunkDir)) fs.rmSync(chunkDir, { recursive: true, force: true });
    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
  }
});

router.post('/:id/files', singleUpload(upload, 'file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
  if (!vod) {
    fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'VOD not found' });
  }

  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
    if (!server) throw new Error('Server not found');

    const uploadUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}/storages/0/files/${uploadPathSegment(req.file.originalname)}`;
    const fileStream = () => fs.createReadStream(req.file.path);

    // Use a much longer timeout for file uploads (1 hour)
    await flussonicRequest('PUT', uploadUrl, server, fileStream, 3600000);
    console.log(`File uploaded to Flussonic VOD: ${vod.name}/${req.file.originalname}`);

    db.prepare('INSERT INTO vod_files (vod_id, filename, size) VALUES (?, ?, ?)').run(vod.id, req.file.originalname, req.file.size);

    await updateVodPlaylistFile(vod);

    res.json({ success: true, filename: req.file.originalname });
  } catch (error: any) {
    console.error('Failed to upload file to Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to upload file to Flussonic' });
  } finally {
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

router.delete('/:id/files/:filename', async (req, res) => {
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
    if (server) {
      const baseUrl = server.url.replace(/\/$/, '');
      const deleteUrl = `${baseUrl}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}/storages/0/files/${uploadPathSegment(req.params.filename)}`;
      await flussonicRequest('DELETE', deleteUrl, server).catch(e => console.warn('Failed to delete from Flussonic (ignored):', e.message));
    }

    db.prepare('DELETE FROM vod_files WHERE vod_id = ? AND filename = ?').run(vod.id, req.params.filename);

    await updateVodPlaylistFile(vod);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/files/sync', async (req, res) => {
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const count = await syncVodFilesFromRemote(vod, server);
    res.json({ success: true, count });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/sync', async (req, res) => {
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const baseUrl = server.url.replace(/\/$/, '');
    const flussonicUrl = `${baseUrl}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}`;
    try {
      let response;
      try {
        response = await flussonicRequest('GET', flussonicUrl, server);
      } catch (e: any) {
        if (e.response && e.response.status === 404) {
          const configUrl = `${baseUrl}/flussonic/api/v3/config`;
          const configRes = await flussonicRequest('GET', configUrl, server);
          if (configRes.data && configRes.data.vods && configRes.data.vods[vod.name]) {
            response = { data: configRes.data.vods[vod.name] };
          } else {
            throw e; // Re-throw the 404 to trigger deletion
          }
        } else {
          throw e;
        }
      }

      let paths: string[] = [];
      if (response && response.data) {
        const item = response.data;
        if (item.storages && Array.isArray(item.storages)) {
          paths = item.storages.map((p: any) => p.url || p.path || p);
        } else if (item.storage) {
          paths = Array.isArray(item.storage) ? item.storage : [item.storage];
        } else if (item.path) {
          paths = Array.isArray(item.path) ? item.path : [item.path];
        } else if (item.url) {
          paths = Array.isArray(item.url) ? item.url : [item.url];
        }
      }

      if (paths.length > 0) {
        db.prepare('UPDATE vods SET paths = ? WHERE id = ?').run(JSON.stringify(paths), vod.id);

        // Also sync files
        try {
          await syncVodFilesFromRemote(vod, server);
        } catch (e: any) {
          console.warn('Failed to sync files during VOD sync:', e.message);
        }

        res.json({ success: true, paths });
      } else {
        res.json({ success: true, message: 'No paths found or unchanged' });
      }
    } catch (e: any) {
      if (e.response && e.response.status === 404) {
        // VOD doesn't exist on Flussonic anymore, delete it locally
        db.prepare('DELETE FROM vods WHERE id = ?').run(vod.id);
        res.json({ success: true, deleted: true });
      } else {
        console.error('Flussonic sync error:', e.message);
        res.status(500).json({ error: 'Failed to sync with Flussonic' });
      }
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

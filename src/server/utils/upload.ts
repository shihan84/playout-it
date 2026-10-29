import type { RequestHandler } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Dedicated multer temp dir, so stale uploads can be swept without touching other apps' files. */
export const UPLOAD_TMP_DIR = path.join(os.tmpdir(), 'playout-it-uploads');

/**
 * Removes upload leftovers (multer temp files, chunk dirs, assembled files)
 * older than maxAgeMs — e.g. from a crash mid-upload. Returns the count removed.
 */
export function sweepStaleUploads(tmp = os.tmpdir(), maxAgeMs = 6 * 3600_000): number {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  const sweep = (dir: string, match: (name: string) => boolean) => {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!match(name)) continue;
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).mtimeMs > cutoff) continue;
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      } catch { /* in use or already gone */ }
    }
  };
  sweep(path.join(tmp, 'playout-it-uploads'), () => true);
  sweep(tmp, (n) => /^(upload_[a-f0-9]{32}|final_[a-f0-9]{32}_.+)$/.test(n));
  return removed;
}

/**
 * Wraps `upload.single(field)` so parser failures map to client errors:
 * size limit → 413, other multer errors and malformed multipart → 400.
 * Filesystem errors (disk full, permissions) stay 500.
 */
export function singleUpload(upload: multer.Multer, field: string, maxLabel = '1000GB'): RequestHandler {
  const handler = upload.single(field);
  return (req, res, next) => {
    handler(req, res, (err: any) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: `File too large. Max limit is ${maxLabel}.` });
        }
        return res.status(400).json({ error: err.message });
      }
      if (typeof err.errno === 'number' || err.syscall) {
        console.error('Upload storage error:', err.message);
        return res.status(500).json({ error: 'Upload error' });
      }
      return res.status(400).json({ error: 'Malformed multipart request' });
    });
  };
}

/** Encodes a client-supplied filename for use as a single URL path segment. */
export function uploadPathSegment(originalname: string): string {
  return encodeURIComponent(originalname);
}

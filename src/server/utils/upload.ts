import type { RequestHandler } from 'express';
import multer from 'multer';

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

import type { RequestHandler } from 'express';
import multer from 'multer';
import path from 'node:path';

/** Owner upload policy: size cap (override with UPLOAD_MAX_GB) and video-only extensions. */
export const MAX_UPLOAD_GB = Number(process.env.UPLOAD_MAX_GB) > 0 ? Number(process.env.UPLOAD_MAX_GB) : 50;
export const MAX_UPLOAD_BYTES = Math.floor(MAX_UPLOAD_GB * 1024 ** 3);
export const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.ts', '.m2ts', '.mxf', '.avi', '.webm', '.flv', '.mpg', '.mpeg'];

export function isAllowedVideoName(name: unknown): boolean {
  return typeof name === 'string' && ALLOWED_VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

export const UNSUPPORTED_TYPE_MESSAGE = `Unsupported file type. Allowed: ${ALLOWED_VIDEO_EXTENSIONS.join(', ')}`;

export class UnsupportedFileTypeError extends Error {
  constructor() { super(UNSUPPORTED_TYPE_MESSAGE); }
}

/** multer fileFilter: rejects non-video filenames before anything is written to disk. */
export const videoFileFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  if (isAllowedVideoName(file.originalname)) cb(null, true);
  else cb(new UnsupportedFileTypeError());
};

/**
 * Wraps `upload.single(field)` so parser failures map to client errors:
 * size limit → 413, disallowed file type → 415, other multer errors and
 * malformed multipart → 400.
 * Filesystem errors (disk full, permissions) stay 500.
 */
export function singleUpload(upload: multer.Multer, field: string, maxLabel = `${MAX_UPLOAD_GB}GB`): RequestHandler {
  const handler = upload.single(field);
  return (req, res, next) => {
    handler(req, res, (err: any) => {
      if (!err) return next();
      if (err instanceof UnsupportedFileTypeError) {
        return res.status(415).json({ error: err.message });
      }
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

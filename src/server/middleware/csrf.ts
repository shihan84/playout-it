import express from 'express';

// CSRF guard for cookie-authenticated mutating requests.
// Bearer-token requests are CSRF-immune; anonymous requests carry no cookie session.
// Cookie sessions must present X-Requested-With (SPA convention) or a same-host Origin.
export const csrfProtection = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers.authorization) return next();
  if (!req.cookies?.token) return next();

  if (req.headers['x-requested-with'] === 'XMLHttpRequest') return next();

  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host === req.headers.host) return next();
    } catch {}
  }

  return res.status(403).json({ error: 'CSRF check failed' });
};

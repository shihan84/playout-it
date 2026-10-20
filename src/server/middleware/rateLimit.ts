import rateLimit from 'express-rate-limit';

// IP derivation / proxy headers:
// The app does NOT set `trust proxy`, so req.ip is always the direct socket
// peer and client-supplied X-Forwarded-For headers are never trusted. If a
// trusted reverse proxy is added later, set `app.set('trust proxy', <n>)` to
// the exact number of trusted hops — never `true` — so the limiter keys on the
// real client IP rather than a spoofable header.
//
// Multi-instance deployments:
// The default store is in-memory per process, so limits apply per instance.
// If the app ever runs as multiple instances behind a load balancer, use a
// shared store (e.g. rate-limit-redis) for globally enforced limits.

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  message?: string;
}

export function createRateLimiter(options: RateLimiterOptions) {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: options.message || 'Too many requests, please try again later' });
    },
  });
}

// Strict limiter for credential-verification endpoints (login etc.).
// Default 30 attempts per IP per 15 minutes: far above legitimate use, stops
// credential stuffing without permanently locking real users out. Both values
// are env-overridable for tests/tuning.
export const authRateLimiter = createRateLimiter({
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 30),
});

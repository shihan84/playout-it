import rateLimit from 'express-rate-limit';

// IP derivation / proxy headers:
// By default `trust proxy` is off, so req.ip is the direct socket peer and
// client-supplied X-Forwarded-For headers are never trusted. Behind a reverse
// proxy, set TRUST_PROXY to the exact number of trusted hops (e.g. 1 for one
// nginx) so the limiter keys on the real client IP; otherwise every user shares
// the proxy's IP and one attacker can lock everyone out.
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

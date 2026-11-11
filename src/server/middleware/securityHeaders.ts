import helmet from 'helmet';

// Flussonic servers are configured at runtime, so previews (iframe embed,
// HLS media/XHR) must be allowed from any http(s) origin. Scripts stay 'self'.
export function securityHeaders(production: boolean) {
  return helmet({
    // Vite's dev server injects inline scripts, so CSP is enforced only in production.
    contentSecurityPolicy: production
      ? {
          directives: {
            'default-src': ["'self'"],
            'script-src': ["'self'"],
            'style-src': ["'self'", "'unsafe-inline'"],
            'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
            'media-src': ["'self'", 'blob:', 'https:', 'http:'],
            'connect-src': ["'self'", 'ws:', 'wss:', 'https:', 'http:'],
            'frame-src': ['https:', 'http:'],
            'frame-ancestors': ["'none'"],
            'object-src': ["'none'"],
            'base-uri': ["'self'"],
            'form-action': ["'self'"],
            // Flussonic servers may be plain HTTP; don't force-upgrade their URLs.
            'upgrade-insecure-requests': null,
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: { maxAge: 180 * 24 * 60 * 60, includeSubDomains: false },
  });
}

// TRUST_PROXY: number of reverse-proxy hops in front of the app (e.g. 1 for a
// single nginx). Unset/0 = trust none, so X-Forwarded-For is ignored.
export function parseTrustProxy(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error('TRUST_PROXY must be the number of trusted proxy hops (e.g. 1), not true/false or an address');
  }
  return Number(value.trim());
}

import 'dotenv/config';
import { parseTrustProxy } from '../middleware/securityHeaders';

const JWT_WEAK_SECRETS = new Set([
  'your-secret-key-change-in-production',
  'secret',
  'changeme',
  'change-me',
  'jwt-secret',
  'jwt_secret',
  'password',
  'test-secret',
]);

const jwtSecretEnv = process.env.JWT_SECRET;
if (process.env.NODE_ENV === 'production') {
  if (!jwtSecretEnv || jwtSecretEnv.length < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 characters in production');
  }
  if (JWT_WEAK_SECRETS.has(jwtSecretEnv.trim().toLowerCase())) {
    throw new Error('JWT_SECRET must not be a placeholder or commonly used value in production');
  }
}

export const config = {
  port: Number(process.env.PORT || 3000),
  // Dev defaults to loopback so a dev instance (default JWT secret) isn't reachable from the network.
  bindHost: process.env.BIND_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
  nodeEnv: process.env.NODE_ENV || 'development',
  trustProxyHops: parseTrustProxy(process.env.TRUST_PROXY),
  dbPath: process.env.DATABASE_PATH || 'flussonic.db',
  jwtSecret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
  saltRounds: 10,
  sslEnabled: process.env.SSL_ENABLED === 'true',
  sslKeyPath: process.env.SSL_KEY_PATH || '',
  sslCertPath: process.env.SSL_CERT_PATH || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramApiUrl: 'https://api.telegram.org/bot',
};

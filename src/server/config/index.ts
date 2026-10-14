import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPath: process.env.DATABASE_PATH || 'flussonic.db',
  jwtSecret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
  saltRounds: 10,
  sslEnabled: process.env.SSL_ENABLED === 'true',
  sslKeyPath: process.env.SSL_KEY_PATH || '',
  sslCertPath: process.env.SSL_CERT_PATH || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramApiUrl: 'https://api.telegram.org/bot',
};

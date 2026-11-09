import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { sendTelegramMessage } from '../services/telegram';

const router = Router();

// Telegram sends the `secret_token` given to setWebhook in this header.
// Without TELEGRAM_WEBHOOK_SECRET configured the webhook is disabled.
export function isValidWebhookSecret(header: unknown, expected = process.env.TELEGRAM_WEBHOOK_SECRET || ''): boolean {
  if (!expected || typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

router.post('/', async (req, res) => {
  if (!isValidWebhookSecret(req.headers['x-telegram-bot-api-secret-token'])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const update = req.body;

    if (update.message) {
      const chatId = update.message.chat.id;
      const text = update.message.text;

      if (text === '/start') {
        await sendTelegramMessage(chatId,
          '👋 Welcome to Flussonic Stream Alerts!\n\n' +
          'To receive stream alerts, please contact your administrator to register your Telegram chat ID.\n\n' +
          'Your Chat ID: <code>' + chatId + '</code>\n\n' +
          'Share this Chat ID with your administrator to link it to your streams.'
        );
      } else if (text === '/help') {
        await sendTelegramMessage(chatId,
          '📖 Available commands:\n\n' +
          '/start - Register with the bot and get your Chat ID\n' +
          '/help - Show this help message\n\n' +
          'To receive stream alerts, contact your administrator with your Chat ID.'
        );
      }
    }

    res.json({ ok: true });
  } catch (error: any) {
    console.error('Telegram webhook error:', error.message);
    res.status(500).json({ error: 'Webhook error' });
  }
});

export default router;

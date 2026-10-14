import axios from 'axios';
import { db } from '../db';
import { config } from '../config';

export async function sendTelegramMessage(chatId: string, message: string, retryCount = 0): Promise<boolean> {
  if (!config.telegramBotToken) {
    console.error('TELEGRAM_BOT_TOKEN not configured');
    return false;
  }

  const url = `${config.telegramApiUrl}${config.telegramBotToken}/sendMessage`;

  try {
    const response = await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML'
    }, {
      timeout: 10000
    });

    if (response.data.ok) {
      return true;
    } else {
      console.error('Telegram API error:', response.data);
      return false;
    }
  } catch (error: any) {
    console.error('Failed to send Telegram message:', error.message);

    // Retry logic with exponential backoff
    if (retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
      console.log(`Retrying in ${delay}ms... (attempt ${retryCount + 1}/3)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return sendTelegramMessage(chatId, message, retryCount + 1);
    }

    return false;
  }
}

// Dispatch per-stream alerts with rate limiting + history logging.
// Shared by the /api/telegram-alerts/send route and the watchdog (which
// previously called its own HTTP endpoint to reach this logic).
export async function dispatchStreamAlerts(streamId: number, alertType: string, message: string) {
  const alerts = db.prepare(`
    SELECT ta.*, s.name as stream_name
    FROM telegram_alerts ta
    JOIN streams s ON ta.stream_id = s.id
    WHERE ta.stream_id = ? AND ta.alert_enabled = 1
  `).all(streamId) as any[];

  const results = [];
  for (const alert of alerts) {
    if (alert.last_alert_sent) {
      const diffMinutes = (Date.now() - new Date(alert.last_alert_sent).getTime()) / (1000 * 60);
      if (diffMinutes < alert.downtime_threshold) {
        console.log(`Skipping alert for chat ${alert.telegram_chat_id} - last alert sent ${diffMinutes.toFixed(1)} minutes ago`);
        continue;
      }
    }

    const success = await sendTelegramMessage(alert.telegram_chat_id, message);
    db.prepare(`
      INSERT INTO telegram_alert_history (telegram_alert_id, alert_type, message, success, error_message)
      VALUES (?, ?, ?, ?, ?)
    `).run(alert.id, alertType, message, success ? 1 : 0, success ? null : 'Failed to send');
    if (success) {
      db.prepare('UPDATE telegram_alerts SET last_alert_sent = CURRENT_TIMESTAMP WHERE id = ?').run(alert.id);
    }
    results.push({ telegram_chat_id: alert.telegram_chat_id, success });
  }
  return results;
}

export async function sendTelegramNotification(message: string) {
  const enabled = db.prepare('SELECT value FROM settings WHERE key = ?').get('telegram_enabled') as any;
  if (!enabled || enabled.value !== 'true') return;

  const token = db.prepare('SELECT value FROM settings WHERE key = ?').get('telegram_bot_token') as any;
  const chatId = db.prepare('SELECT value FROM settings WHERE key = ?').get('telegram_chat_id') as any;

  if (!token?.value || !chatId?.value) return;

  try {
    await axios.post(`${config.telegramApiUrl}${token.value}/sendMessage`, {
      chat_id: chatId.value,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (error: any) {
    console.error('Telegram notification failed:', error.message);
  }
}

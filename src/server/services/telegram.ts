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

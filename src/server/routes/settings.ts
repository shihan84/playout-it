import { Router } from 'express';
import axios from 'axios';
import { db } from '../db';

const router = Router();

router.get('/', (req, res) => {
  const settings = db.prepare('SELECT * FROM settings').all();
  const settingsObj = settings.reduce((acc: any, curr: any) => {
    acc[curr.key] = curr.value;
    return acc;
  }, {});
  res.json(settingsObj);
});

router.post('/', (req, res) => {
  const { telegram_enabled, telegram_bot_token, telegram_chat_id, watchdog_interval, auto_sync_enabled, auto_sync_interval } = req.body;
  const stmt = db.prepare('UPDATE settings SET value = ? WHERE key = ?');

  db.transaction(() => {
    if (telegram_enabled !== undefined) stmt.run(telegram_enabled.toString(), 'telegram_enabled');
    if (telegram_bot_token !== undefined) stmt.run(telegram_bot_token, 'telegram_bot_token');
    if (telegram_chat_id !== undefined) stmt.run(telegram_chat_id, 'telegram_chat_id');
    if (watchdog_interval !== undefined) stmt.run(watchdog_interval, 'watchdog_interval');
    if (auto_sync_enabled !== undefined) stmt.run(auto_sync_enabled.toString(), 'auto_sync_enabled');
    if (auto_sync_interval !== undefined) stmt.run(auto_sync_interval, 'auto_sync_interval');
  })();

  res.json({ success: true });
});

router.post('/test-telegram', async (req, res) => {
  const { telegram_bot_token, telegram_chat_id } = req.body;
  if (!telegram_bot_token || !telegram_chat_id) {
    return res.status(400).json({ error: 'Missing bot token or chat ID' });
  }
  try {
    const response = await axios.post(`https://api.telegram.org/bot${telegram_bot_token}/sendMessage`, {
      chat_id: telegram_chat_id,
      text: '✅ <b>IBS Manager</b>\n\nTelegram notifications are working correctly!',
      parse_mode: 'HTML'
    });
    res.json({ success: true, data: response.data });
  } catch (error: any) {
    console.error('Failed to send test message from server:', error.response?.data || error.message);
    const description = error.response?.data?.description || error.message;
    res.status(error.response?.status || 500).json({ error: description });
  }
});

export default router;

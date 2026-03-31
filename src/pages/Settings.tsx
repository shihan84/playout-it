import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Save, Bell, Clock } from 'lucide-react';

export default function Settings() {
  const [settings, setSettings] = useState({
    telegram_bot_token: '',
    telegram_chat_id: '',
    watchdog_interval: '60'
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const res = await axios.get('/api/settings');
        setSettings({
          telegram_bot_token: res.data.telegram_bot_token || '',
          telegram_chat_id: res.data.telegram_chat_id || '',
          watchdog_interval: res.data.watchdog_interval || '60'
        });
      } catch (error) {
        console.error('Failed to fetch settings', error);
      }
    };
    fetchSettings();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveMessage('');
    try {
      await axios.post('/api/settings', settings);
      await axios.post('/api/watchdog/restart');
      setSaveMessage('Settings saved successfully. Watchdog restarted.');
      setTimeout(() => setSaveMessage(''), 3000);
    } catch (error) {
      console.error('Failed to save settings', error);
      setSaveMessage('Failed to save settings.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestTelegram = async () => {
    if (!settings.telegram_bot_token || !settings.telegram_chat_id) {
      alert('Please save bot token and chat ID first.');
      return;
    }
    try {
      await axios.post(`https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`, {
        chat_id: settings.telegram_chat_id,
        text: '✅ <b>Flussonic Manager</b>\n\nTelegram notifications are working correctly!',
        parse_mode: 'HTML'
      });
      alert('Test message sent successfully!');
    } catch (error: any) {
      console.error('Failed to send test message', error);
      alert(`Failed to send test message: ${error.message}`);
    }
  };

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">Settings</h1>
        <p className="text-zinc-400 mt-2">Configure monitoring and notifications.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-8">
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-6">
          <div className="flex items-center gap-3 border-b border-zinc-800 pb-4">
            <Bell className="text-blue-400" />
            <h2 className="text-xl font-semibold text-white">Telegram Notifications</h2>
          </div>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1">Bot Token</label>
              <input 
                type="password" 
                value={settings.telegram_bot_token}
                onChange={e => setSettings({...settings, telegram_bot_token: e.target.value})}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
              />
              <p className="text-xs text-zinc-500 mt-1">Get this from @BotFather on Telegram.</p>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1">Chat ID</label>
              <input 
                type="text" 
                value={settings.telegram_chat_id}
                onChange={e => setSettings({...settings, telegram_chat_id: e.target.value})}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                placeholder="-1001234567890"
              />
              <p className="text-xs text-zinc-500 mt-1">The ID of the user or group to send notifications to.</p>
            </div>

            <button 
              type="button"
              onClick={handleTestTelegram}
              className="text-sm text-blue-400 hover:text-blue-300 font-medium"
            >
              Send Test Message
            </button>
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-6">
          <div className="flex items-center gap-3 border-b border-zinc-800 pb-4">
            <Clock className="text-amber-400" />
            <h2 className="text-xl font-semibold text-white">Watchdog Settings</h2>
          </div>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1">Check Interval (seconds)</label>
              <input 
                type="number" 
                min="10"
                value={settings.watchdog_interval}
                onChange={e => setSettings({...settings, watchdog_interval: e.target.value})}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
              />
              <p className="text-xs text-zinc-500 mt-1">How often the watchdog should check stream status.</p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button 
            type="submit" 
            disabled={isSaving}
            className="bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white px-6 py-2.5 rounded-xl font-medium flex items-center gap-2 transition-colors"
          >
            <Save size={20} />
            {isSaving ? 'Saving...' : 'Save Settings'}
          </button>
          
          {saveMessage && (
            <span className="text-emerald-400 text-sm font-medium">{saveMessage}</span>
          )}
        </div>
      </form>
    </div>
  );
}

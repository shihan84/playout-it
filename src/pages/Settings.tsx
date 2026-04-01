import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Save, Bell, Clock, Check, AlertCircle } from 'lucide-react';

export default function Settings() {
  const [settings, setSettings] = useState({
    telegram_enabled: false,
    telegram_bot_token: '',
    telegram_chat_id: '',
    watchdog_interval: '5',
    auto_sync_enabled: false,
    auto_sync_interval: '60'
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' | 'info' } | null>(null);

  const showNotification = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 5000);
  };

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const res = await axios.get('/api/settings');
        setSettings({
          telegram_enabled: res.data.telegram_enabled === 'true',
          telegram_bot_token: res.data.telegram_bot_token || '',
          telegram_chat_id: res.data.telegram_chat_id || '',
          watchdog_interval: res.data.watchdog_interval || '5',
          auto_sync_enabled: res.data.auto_sync_enabled === 'true',
          auto_sync_interval: res.data.auto_sync_interval || '60'
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
      showNotification('Please save bot token and chat ID first.', 'error');
      return;
    }
    try {
      await axios.post('/api/settings/test-telegram', {
        telegram_bot_token: settings.telegram_bot_token,
        telegram_chat_id: settings.telegram_chat_id
      });
      showNotification('Test message sent successfully!', 'success');
    } catch (error: any) {
      console.error('Failed to send test message', error);
      const description = error.response?.data?.error || error.message;
      showNotification(`Failed to send test message: ${description}`, 'error');
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
          <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
            <div className="flex items-center gap-3">
              <Bell className="text-blue-400" />
              <h2 className="text-xl font-semibold text-white">Telegram Notifications</h2>
            </div>
            <button 
              type="button"
              onClick={() => setSettings({...settings, telegram_enabled: !settings.telegram_enabled})}
              className={`w-10 h-6 rounded-full transition-colors relative ${settings.telegram_enabled ? 'bg-emerald-500' : 'bg-zinc-700'}`}
            >
              <div className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${settings.telegram_enabled ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          </div>
          
          <div className={`space-y-4 transition-opacity duration-300 ${settings.telegram_enabled ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
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
            <h2 className="text-xl font-semibold text-white">Monitoring & Sync</h2>
          </div>
          
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1">Watchdog Check Interval (seconds)</label>
              <input 
                type="number" 
                min="5"
                value={settings.watchdog_interval}
                onChange={e => setSettings({...settings, watchdog_interval: e.target.value})}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
              />
              <p className="text-xs text-zinc-500 mt-1">How often the watchdog should check stream status.</p>
            </div>

            <div className="pt-4 border-t border-zinc-800/50">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-medium text-white">Auto-Sync Streams & VODs</h3>
                  <p className="text-xs text-zinc-500">Automatically fetch new streams and VODs from all servers.</p>
                </div>
                <button 
                  type="button"
                  onClick={() => setSettings({...settings, auto_sync_enabled: !settings.auto_sync_enabled})}
                  className={`w-10 h-6 rounded-full transition-colors relative ${settings.auto_sync_enabled ? 'bg-emerald-500' : 'bg-zinc-700'}`}
                >
                  <div className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${settings.auto_sync_enabled ? 'translate-x-5' : 'translate-x-1'}`} />
                </button>
              </div>

              {settings.auto_sync_enabled && (
                <div className="animate-in fade-in slide-in-from-top-2">
                  <label className="block text-sm font-medium text-zinc-400 mb-1">Auto-Sync Interval (seconds)</label>
                  <input 
                    type="number" 
                    min="10"
                    value={settings.auto_sync_interval}
                    onChange={e => setSettings({...settings, auto_sync_interval: e.target.value})}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                  />
                  <p className="text-xs text-zinc-500 mt-1">How often to sync streams and VODs from servers.</p>
                </div>
              )}
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

      {/* Notification Toast */}
      {notification && (
        <div className={`fixed bottom-4 right-4 px-6 py-3 rounded-xl shadow-2xl z-50 flex items-center gap-3 animate-in slide-in-from-right-full duration-300 ${
          notification.type === 'success' ? 'bg-emerald-500 text-white' : 
          notification.type === 'error' ? 'bg-rose-500 text-white' : 
          'bg-blue-500 text-white'
        }`}>
          {notification.type === 'success' ? <Check size={20} /> : <AlertCircle size={20} />}
          <span className="font-medium">{notification.message}</span>
        </div>
      )}
    </div>
  );
}

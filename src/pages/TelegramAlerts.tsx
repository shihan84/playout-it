import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Send, Plus, Trash2, Bell, BellOff, Clock, AlertCircle, Check, X, MessageSquare } from 'lucide-react';

export default function TelegramAlerts() {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [streams, setStreams] = useState<any[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [selectedAlert, setSelectedAlert] = useState<any>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [alertHistory, setAlertHistory] = useState<any[]>([]);
  const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
  const [formData, setFormData] = useState({ stream_id: '', telegram_chat_id: '', downtime_threshold: 30 });

  const showNotification = (message: string, type: 'success' | 'error') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

  useEffect(() => {
    fetchAlerts();
    fetchStreams();
  }, []);

  const fetchAlerts = async () => {
    try {
      const res = await axios.get('/api/telegram-alerts');
      setAlerts(res.data);
    } catch (error) {
      console.error('Failed to fetch alerts', error);
    }
  };

  const fetchStreams = async () => {
    try {
      const res = await axios.get('/api/my-streams');
      setStreams(res.data);
    } catch (error) {
      console.error('Failed to fetch streams', error);
    }
  };

  const handleAddAlert = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await axios.post('/api/telegram-alerts', formData);
      showNotification('Alert registered successfully', 'success');
      setIsAdding(false);
      setFormData({ stream_id: '', telegram_chat_id: '', downtime_threshold: 30 });
      fetchAlerts();
    } catch (error: any) {
      console.error('Failed to register alert', error);
      showNotification(error.response?.data?.error || 'Failed to register alert', 'error');
    }
  };

  const handleToggleAlert = async (id: number, enabled: boolean) => {
    try {
      await axios.put(`/api/telegram-alerts/${id}`, { alert_enabled: enabled });
      showNotification(`Alert ${enabled ? 'enabled' : 'disabled'}`, 'success');
      fetchAlerts();
    } catch (error: any) {
      console.error('Failed to toggle alert', error);
      showNotification(error.response?.data?.error || 'Failed to toggle alert', 'error');
    }
  };

  const handleDeleteAlert = async (id: number) => {
    try {
      await axios.delete(`/api/telegram-alerts/${id}`);
      showNotification('Alert deleted successfully', 'success');
      fetchAlerts();
    } catch (error: any) {
      console.error('Failed to delete alert', error);
      showNotification(error.response?.data?.error || 'Failed to delete alert', 'error');
    }
  };

  const handleViewHistory = async (alertId: number) => {
    try {
      const res = await axios.get(`/api/telegram-alerts/${alertId}/history`);
      setAlertHistory(res.data);
      setSelectedAlert(alerts.find(a => a.id === alertId));
      setShowHistory(true);
    } catch (error) {
      console.error('Failed to fetch alert history', error);
    }
  };

  return (
    <div className="space-y-8 max-w-6xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">Telegram Alerts</h1>
        <p className="text-zinc-400 mt-2">Configure Telegram notifications for stream status changes.</p>
      </div>

      {/* Setup Instructions */}
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-2xl p-6">
        <div className="flex items-start gap-4">
          <MessageSquare className="text-blue-400 mt-1" size={24} />
          <div>
            <h3 className="text-lg font-bold text-white mb-2">How to Setup Telegram Alerts</h3>
            <ol className="text-zinc-300 space-y-2 list-decimal list-inside">
              <li>Open Telegram and search for your bot (contact your admin for bot name)</li>
              <li>Send <code className="bg-zinc-800 px-2 py-1 rounded">/start</code> to the bot</li>
              <li>Copy the Chat ID shown in the response</li>
              <li>Register your Chat ID with a stream using the form below</li>
            </ol>
          </div>
        </div>
      </div>

      {/* Add Alert Button */}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Bell size={18} />
          {alerts.length} alerts configured
        </div>
        <button
          onClick={() => setIsAdding(true)}
          className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-colors"
        >
          <Plus size={18} />
          Add Alert
        </button>
      </div>

      {/* Alerts List */}
      <div className="space-y-3">
        {alerts.length === 0 ? (
          <div className="text-center py-8 text-zinc-500">No Telegram alerts configured</div>
        ) : (
          alerts.map((alert) => (
            <div key={alert.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${alert.alert_enabled ? 'bg-emerald-500/10' : 'bg-zinc-800'}`}>
                    {alert.alert_enabled ? <Bell className="text-emerald-400" size={24} /> : <BellOff className="text-zinc-500" size={24} />}
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white">{alert.stream_name}</h3>
                    <p className="text-sm text-zinc-400 mt-1">Chat ID: <code className="bg-zinc-800 px-2 py-1 rounded">{alert.telegram_chat_id}</code></p>
                    <div className="flex items-center gap-4 mt-2 text-sm text-zinc-500">
                      <span className="flex items-center gap-1">
                        <Clock size={14} />
                        Threshold: {alert.downtime_threshold} min
                      </span>
                      {alert.last_alert_sent && (
                        <span>Last alert: {new Date(alert.last_alert_sent).toLocaleString()}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleToggleAlert(alert.id, !alert.alert_enabled)}
                    className={`p-2 rounded-lg transition-colors ${alert.alert_enabled ? 'text-emerald-400 hover:bg-emerald-500/10' : 'text-zinc-500 hover:bg-zinc-800'}`}
                    title={alert.alert_enabled ? 'Disable alert' : 'Enable alert'}
                  >
                    {alert.alert_enabled ? <Bell size={18} /> : <BellOff size={18} />}
                  </button>
                  <button
                    onClick={() => handleViewHistory(alert.id)}
                    className="p-2 text-zinc-500 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                    title="View history"
                  >
                    <Clock size={18} />
                  </button>
                  <button
                    onClick={() => handleDeleteAlert(alert.id)}
                    className="p-2 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
                    title="Delete alert"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add Alert Modal */}
      {isAdding && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 w-full max-w-md shadow-3xl">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold text-white">Add Telegram Alert</h3>
              <button onClick={() => setIsAdding(false)} className="text-zinc-500 hover:text-white">
                <X size={24} />
              </button>
            </div>
            <form onSubmit={handleAddAlert} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-400 mb-1">Stream</label>
                <select
                  value={formData.stream_id}
                  onChange={(e) => setFormData({ ...formData, stream_id: e.target.value })}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500"
                  required
                >
                  <option value="">Select a stream</option>
                  {streams.map((stream) => (
                    <option key={stream.id} value={stream.id}>{stream.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-400 mb-1">Telegram Chat ID</label>
                <input
                  type="text"
                  value={formData.telegram_chat_id}
                  onChange={(e) => setFormData({ ...formData, telegram_chat_id: e.target.value })}
                  placeholder="e.g., 123456789"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500"
                  required
                />
                <p className="text-xs text-zinc-500 mt-1">Send /start to the bot to get your Chat ID</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-400 mb-1">Downtime Threshold (minutes)</label>
                <input
                  type="number"
                  value={formData.downtime_threshold}
                  onChange={(e) => setFormData({ ...formData, downtime_threshold: parseInt(e.target.value) })}
                  min="1"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500"
                  required
                />
                <p className="text-xs text-zinc-500 mt-1">Minimum time between alerts</p>
              </div>
              <div className="flex gap-3 pt-4">
                <button type="submit" className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white py-2 rounded-xl font-medium">
                  Add Alert
                </button>
                <button type="button" onClick={() => setIsAdding(false)} className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white py-2 rounded-xl font-medium">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Alert History Modal */}
      {showHistory && selectedAlert && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 w-full max-w-2xl shadow-3xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-xl font-bold text-white">Alert History</h3>
                <p className="text-sm text-zinc-400 mt-1">{selectedAlert.stream_name}</p>
              </div>
              <button onClick={() => setShowHistory(false)} className="text-zinc-500 hover:text-white">
                <X size={24} />
              </button>
            </div>
            <div className="space-y-3">
              {alertHistory.length === 0 ? (
                <div className="text-center py-8 text-zinc-500">No alert history</div>
              ) : (
                alertHistory.map((history) => (
                  <div key={history.id} className="flex items-start gap-3 p-4 bg-zinc-950 rounded-xl border border-zinc-800">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${history.success ? 'bg-emerald-500/10' : 'bg-rose-500/10'}`}>
                      {history.success ? <Check className="text-emerald-400" size={16} /> : <AlertCircle className="text-rose-400" size={16} />}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm text-white font-medium">{history.alert_type}</p>
                      <p className="text-xs text-zinc-400 mt-1">{history.message}</p>
                      <p className="text-xs text-zinc-500 mt-1">{new Date(history.sent_at).toLocaleString()}</p>
                      {history.error_message && (
                        <p className="text-xs text-rose-400 mt-1">Error: {history.error_message}</p>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Notification */}
      {notification && (
        <div className={`fixed bottom-4 right-4 px-6 py-3 rounded-xl shadow-2xl z-50 flex items-center gap-3 ${
          notification.type === 'success' ? 'bg-emerald-500 text-white' : 'bg-rose-500 text-white'
        }`}>
          {notification.type === 'success' ? <Check size={20} /> : <AlertCircle size={20} />}
          <span className="font-medium">{notification.message}</span>
        </div>
      )}
    </div>
  );
}

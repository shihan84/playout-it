import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Plus, Trash2, Server as ServerIcon, Activity, X, RefreshCw, Search } from 'lucide-react';

export default function Servers() {
  const [servers, setServers] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [formData, setFormData] = useState({ name: '', url: '', api_key: '' });
  
  const [metricsServer, setMetricsServer] = useState<any>(null);
  const [metricsData, setMetricsData] = useState<any>(null);
  const [isLoadingMetrics, setIsLoadingMetrics] = useState(false);
  
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
  
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false);
  const [isSyncingAll, setIsSyncingAll] = useState(false);

  useEffect(() => {
    fetchServers();
    fetchSettings();

    // Setup WebSocket for real-time updates
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    let ws: WebSocket;
    let reconnectTimer: NodeJS.Timeout;

    const connectWs = () => {
      ws = new WebSocket(wsUrl);
      
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'STREAMS_UPDATE') {
            const streams = Array.isArray(message.data) ? message.data : [];
            setServers(prevServers => prevServers.map(server => {
              const serverStreams = streams.filter((s: any) => s.server_id === server.id);
              return {
                ...server,
                online_streams: serverStreams.filter((s: any) => s.status === 'online').length,
                offline_streams: serverStreams.filter((s: any) => s.status === 'offline').length
              };
            }));
          }
        } catch (e) {
          console.error('Failed to parse WebSocket message', e);
        }
      };

      ws.onclose = () => {
        reconnectTimer = setTimeout(connectWs, 2000);
      };
    };

    connectWs();

    // Fallback polling
    const interval = setInterval(fetchServers, 10000);
    
    return () => {
      clearInterval(interval);
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, []);

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  const showNotification = (message: string, type: 'success' | 'error' = 'success') => {
    setNotification({ message, type });
  };

  const fetchServers = async () => {
    try {
      const res = await axios.get('/api/servers');
      setServers(Array.isArray(res.data) ? res.data : []);
    } catch (error) {
      console.error('Failed to fetch servers', error);
      setServers([]);
    }
  };

  const fetchSettings = async () => {
    try {
      const res = await axios.get('/api/settings');
      setAutoSyncEnabled(res.data.auto_sync_enabled === 'true');
    } catch (error) {
      console.error('Failed to fetch settings', error);
    }
  };

  const handleToggleAutoSync = async () => {
    try {
      const newValue = !autoSyncEnabled;
      await axios.post('/api/settings', { auto_sync_enabled: newValue });
      await axios.post('/api/watchdog/restart');
      setAutoSyncEnabled(newValue);
    } catch (error) {
      console.error('Failed to toggle auto sync', error);
      showNotification('Failed to update setting', 'error');
    }
  };

  const handleSyncAll = async () => {
    setIsSyncingAll(true);
    try {
      const res = await axios.post('/api/servers/sync-all');
      showNotification(`Sync complete! Added ${res.data.added} new streams, removed ${res.data.removed} deleted streams.`);
      fetchServers();
    } catch (error) {
      console.error('Failed to sync all servers', error);
      showNotification('Failed to sync servers', 'error');
    } finally {
      setIsSyncingAll(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await axios.post('/api/servers', formData);
      setFormData({ name: '', url: '', api_key: '' });
      setIsAdding(false);
      fetchServers();
      showNotification('Server added successfully');
    } catch (error) {
      console.error('Failed to add server', error);
      showNotification('Failed to add server', 'error');
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await axios.delete(`/api/servers/${id}`);
      setDeleteConfirmId(null);
      fetchServers();
      showNotification('Server removed successfully');
    } catch (error: any) {
      console.error('Failed to delete server', error);
      showNotification(`Failed to delete server: ${error.response?.data?.error || error.message}`, 'error');
    }
  };

  const handleViewMetrics = async (server: any) => {
    setMetricsServer(server);
    setIsLoadingMetrics(true);
    setMetricsData(null);
    try {
      const res = await axios.get(`/api/servers/${server.id}/metrics`);
      setMetricsData(res.data);
    } catch (error) {
      console.error('Failed to fetch metrics', error);
      setMetricsData({ error: 'Failed to fetch metrics. Ensure the server is reachable and API key is correct.' });
    } finally {
      setIsLoadingMetrics(false);
    }
  };

  const filteredServers = servers.filter(server => {
    const query = searchQuery.toLowerCase();
    return (
      server.name.toLowerCase().includes(query) ||
      server.url.toLowerCase().includes(query)
    );
  });

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Servers</h1>
          <p className="text-zinc-400 mt-2">Manage your Flussonic Media Server instances.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={18} />
            <input
              type="text"
              placeholder="Search servers or IPs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded-xl pl-10 pr-4 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 transition-colors w-64"
            />
          </div>
          <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 px-4 py-2 rounded-xl">
            <span className="text-sm font-medium text-zinc-300">Auto-Sync Streams</span>
            <button 
              onClick={handleToggleAutoSync}
              className={`w-10 h-6 rounded-full transition-colors relative ${autoSyncEnabled ? 'bg-emerald-500' : 'bg-zinc-700'}`}
            >
              <div className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${autoSyncEnabled ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          </div>
          
          <button 
            onClick={handleSyncAll}
            disabled={isSyncingAll || servers.length === 0}
            className="bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-colors"
          >
            <RefreshCw size={20} className={isSyncingAll ? 'animate-spin' : ''} />
            Sync All Now
          </button>

          <button 
            onClick={() => setIsAdding(!isAdding)}
            className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-colors"
          >
            <Plus size={20} />
            Add Server
          </button>
        </div>
      </div>

      {isAdding && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
          <h2 className="text-xl font-semibold text-white mb-4">Add New Server</h2>
          <form onSubmit={handleSubmit} className="space-y-4 max-w-xl">
            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1">Server Name</label>
              <input 
                required
                type="text" 
                value={formData.name}
                onChange={e => setFormData({...formData, name: e.target.value})}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                placeholder="e.g. US East Node 1"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1">Flussonic URL</label>
              <input 
                required
                type="url" 
                value={formData.url}
                onChange={e => setFormData({...formData, url: e.target.value})}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                placeholder="http://192.168.1.100:8080"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1">API Key / Password</label>
              <input 
                required
                type="password" 
                value={formData.api_key}
                onChange={e => setFormData({...formData, api_key: e.target.value})}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                placeholder="flussonic_api_key"
              />
            </div>
            <div className="flex gap-3 pt-2">
              <button type="submit" className="bg-emerald-500 hover:bg-emerald-600 text-white px-6 py-2 rounded-xl font-medium transition-colors">
                Save Server
              </button>
              <button type="button" onClick={() => setIsAdding(false)} className="bg-zinc-800 hover:bg-zinc-700 text-white px-6 py-2 rounded-xl font-medium transition-colors">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredServers.map(server => (
          <div key={server.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 flex flex-col">
            <div className="flex items-start justify-between mb-4">
              <div className="p-3 rounded-xl bg-blue-500/10 text-blue-400">
                <ServerIcon size={24} />
              </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={async () => {
                    try {
                      const res = await axios.post(`/api/servers/${server.id}/sync`);
                      showNotification(`Sync complete! Added ${res.data.added} new streams, removed ${res.data.removed} deleted streams.`);
                      fetchServers();
                    } catch (error) {
                      console.error('Failed to sync server', error);
                      showNotification('Failed to sync server', 'error');
                    }
                  }}
                  className="text-zinc-500 hover:text-blue-400 transition-colors p-2"
                  title="Sync Server"
                >
                  <RefreshCw size={18} />
                </button>
                <button 
                  onClick={() => handleViewMetrics(server)}
                  className="text-zinc-500 hover:text-emerald-400 transition-colors p-2"
                  title="View Metrics"
                >
                  <Activity size={18} />
                </button>
                <button 
                  onClick={() => setDeleteConfirmId(server.id)}
                  className="text-zinc-500 hover:text-rose-400 transition-colors p-2"
                  title="Delete Server"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>
            <h3 className="text-lg font-bold text-white mb-1">{server.name}</h3>
            <p className="text-sm text-zinc-400 font-mono break-all mb-4">{server.url}</p>
            
            <div className="mt-auto pt-4 border-t border-zinc-800 grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-zinc-500 uppercase font-bold tracking-wider mb-1">Online Streams</p>
                <p className="text-xl font-bold text-emerald-400">{server.online_streams || 0}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-500 uppercase font-bold tracking-wider mb-1">Offline Streams</p>
                <p className="text-xl font-bold text-rose-400">{server.offline_streams || 0}</p>
              </div>
            </div>
          </div>
        ))}
        {filteredServers.length === 0 && !isAdding && (
          <div className="col-span-full text-center py-12 text-zinc-500 bg-zinc-900/50 border border-zinc-800 border-dashed rounded-2xl">
            {searchQuery ? 'No servers match your search.' : 'No servers added yet. Click "Add Server" to get started.'}
          </div>
        )}
      </div>

      {metricsServer && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-3xl max-h-[80vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between p-6 border-b border-zinc-800">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Activity className="text-emerald-400" />
                Metrics: {metricsServer.name}
              </h2>
              <button onClick={() => setMetricsServer(null)} className="text-zinc-500 hover:text-white transition-colors">
                <X size={24} />
              </button>
            </div>
            <div className="p-6 overflow-y-auto flex-1">
              {isLoadingMetrics ? (
                <div className="flex justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500"></div>
                </div>
              ) : metricsData?.error ? (
                <div className="text-rose-400 bg-rose-500/10 p-4 rounded-xl border border-rose-500/20">
                  {metricsData.error}
                </div>
              ) : metricsData ? (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-zinc-950 border border-zinc-800 p-4 rounded-xl">
                      <p className="text-xs text-zinc-500 uppercase font-bold tracking-wider mb-1">Total Clients</p>
                      <p className="text-2xl font-bold text-white">{metricsData.total_clients || 0}</p>
                    </div>
                    <div className="bg-zinc-950 border border-zinc-800 p-4 rounded-xl">
                      <p className="text-xs text-zinc-500 uppercase font-bold tracking-wider mb-1">Bandwidth Out</p>
                      <p className="text-2xl font-bold text-white">{((metricsData.bitrate || 0) / 1000000).toFixed(2)} Mbps</p>
                    </div>
                    <div className="bg-zinc-950 border border-zinc-800 p-4 rounded-xl">
                      <p className="text-xs text-zinc-500 uppercase font-bold tracking-wider mb-1">Uptime</p>
                      <p className="text-2xl font-bold text-white">{metricsData.uptime ? Math.floor(metricsData.uptime / 3600) : 0}h</p>
                    </div>
                    <div className="bg-zinc-950 border border-zinc-800 p-4 rounded-xl">
                      <p className="text-xs text-zinc-500 uppercase font-bold tracking-wider mb-1">CPU Usage</p>
                      <p className="text-2xl font-bold text-white">{metricsData.cpu_usage ? metricsData.cpu_usage.toFixed(1) : 0}%</p>
                    </div>
                  </div>
                  
                  {metricsData.active_streams && metricsData.active_streams.length > 0 && (
                    <div>
                      <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-wider mb-3">Active Streams ({metricsData.active_streams.length})</h3>
                      <div className="bg-zinc-950 border border-zinc-800 rounded-xl overflow-hidden">
                        <ul className="divide-y divide-zinc-800">
                          {metricsData.active_streams.map((streamName: string, idx: number) => (
                            <li key={idx} className="px-4 py-3 flex items-center gap-3 text-sm text-zinc-300">
                              <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                              <span className="font-mono">{streamName}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                  
                  <div>
                    <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-wider mb-3">Raw Metrics Data</h3>
                    <pre className="bg-zinc-950 border border-zinc-800 p-4 rounded-xl text-xs text-emerald-400 font-mono overflow-x-auto">
                      {JSON.stringify(metricsData, null, 2)}
                    </pre>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {deleteConfirmId && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md p-6 shadow-2xl">
            <h2 className="text-xl font-bold text-white mb-2">Remove Server?</h2>
            <p className="text-zinc-400 mb-6">
              Are you sure you want to remove this server? Associated streams and VODs will be preserved but marked as orphaned.
            </p>
            <div className="flex gap-3">
              <button 
                onClick={() => handleDelete(deleteConfirmId)}
                className="flex-1 bg-rose-500 hover:bg-rose-600 text-white px-4 py-2 rounded-xl font-medium transition-colors"
              >
                Yes, Remove
              </button>
              <button 
                onClick={() => setDeleteConfirmId(null)}
                className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white px-4 py-2 rounded-xl font-medium transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {notification && (
        <div className={`fixed bottom-6 right-6 px-6 py-3 rounded-xl shadow-2xl z-50 border flex items-center gap-3 animate-in fade-in slide-in-from-bottom-4 duration-300 ${
          notification.type === 'error' ? 'bg-rose-500/10 border-rose-500/20 text-rose-400' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
        }`}>
          <div className={`w-2 h-2 rounded-full ${notification.type === 'error' ? 'bg-rose-500' : 'bg-emerald-500'}`} />
          <p className="font-medium">{notification.message}</p>
          <button onClick={() => setNotification(null)} className="ml-2 hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

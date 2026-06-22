import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Shield, Plus, Trash2, RefreshCw, AlertCircle, Activity, Ban, Lock } from 'lucide-react';

export default function IpManagement() {
  const [blockedIps, setBlockedIps] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [selectedServer, setSelectedServer] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
  const [formData, setFormData] = useState({ ip_address: '', reason: '' });

  const showNotification = (message: string, type: 'success' | 'error') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

  useEffect(() => {
    fetchBlockedIps();
    fetchServers();
  }, []);

  const fetchBlockedIps = async () => {
    try {
      const res = await axios.get('/api/blocked-ips');
      setBlockedIps(res.data);
    } catch (error) {
      console.error('Failed to fetch blocked IPs', error);
    }
  };

  const fetchServers = async () => {
    try {
      const res = await axios.get('/api/servers');
      setServers(res.data);
      if (res.data.length > 0) {
        setSelectedServer(res.data[0].id);
      }
    } catch (error) {
      console.error('Failed to fetch servers', error);
    }
  };

  const fetchSessions = async () => {
    if (!selectedServer) return;
    setIsRefreshing(true);
    try {
      const res = await axios.get(`/api/servers/${selectedServer}/sessions`);
      const sessionsData = Array.isArray(res.data) ? res.data : [];
      setSessions(sessionsData);
    } catch (error: any) {
      console.error('Failed to fetch sessions', error);
      setSessions([]);
      showNotification(error.response?.data?.error || 'Failed to fetch sessions', 'error');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleBlockIp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedServer) {
      showNotification('Please select a server first', 'error');
      return;
    }
    try {
      await axios.post('/api/blocked-ips', { ...formData, server_id: selectedServer });
      showNotification('IP blocked successfully', 'success');
      setIsAdding(false);
      setFormData({ ip_address: '', reason: '' });
      fetchBlockedIps();
    } catch (error: any) {
      console.error('Failed to block IP', error);
      showNotification(error.response?.data?.error || 'Failed to block IP', 'error');
    }
  };

  const handleUnblockIp = async (id: number) => {
    if (!selectedServer) {
      showNotification('Please select a server first', 'error');
      return;
    }
    try {
      await axios.delete(`/api/blocked-ips/${id}`, { data: { server_id: selectedServer } });
      showNotification('IP unblocked successfully', 'success');
      fetchBlockedIps();
    } catch (error: any) {
      console.error('Failed to unblock IP', error);
      showNotification(error.response?.data?.error || 'Failed to unblock IP', 'error');
    }
  };

  const handleBlockFromSession = async (ipAddress: string, streamName: string) => {
    if (!selectedServer) {
      showNotification('Please select a server first', 'error');
      return;
    }
    try {
      await axios.post('/api/sessions/block-ip', { 
        ip_address: ipAddress, 
        reason: 'Blocked from play session', 
        server_id: selectedServer,
        stream_name: streamName
      });
      showNotification('IP blocked successfully', 'success');
      fetchBlockedIps();
    } catch (error: any) {
      console.error('Failed to block IP', error);
      showNotification(error.response?.data?.error || 'Failed to block IP', 'error');
    }
  };

  return (
    <div className="space-y-8 max-w-6xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">IP Management</h1>
        <p className="text-zinc-400 mt-2">Block unauthorized IP addresses and monitor active play sessions.</p>
      </div>

      {/* Blocked IPs Section */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Shield className="text-rose-400" size={24} />
            <h2 className="text-xl font-bold text-white">Blocked IPs</h2>
            <span className="text-sm text-zinc-400">({blockedIps.length} blocked)</span>
          </div>
          <button
            onClick={() => setIsAdding(true)}
            className="bg-rose-500 hover:bg-rose-600 text-white px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-colors"
          >
            <Plus size={18} />
            Block IP
          </button>
        </div>

        {blockedIps.length === 0 ? (
          <div className="text-center py-8 text-zinc-500">No blocked IPs</div>
        ) : (
          <div className="space-y-3">
            {blockedIps.map((blockedIp) => (
              <div key={blockedIp.id} className="flex items-center justify-between p-4 bg-zinc-950 rounded-xl border border-zinc-800">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 bg-rose-500/10 rounded-lg flex items-center justify-center">
                    <Ban className="text-rose-400" size={20} />
                  </div>
                  <div>
                    <p className="text-white font-medium font-mono">{blockedIp.ip_address}</p>
                    <p className="text-sm text-zinc-400">{blockedIp.reason || 'No reason provided'}</p>
                    <p className="text-xs text-zinc-500 mt-1">
                      Blocked by {blockedIp.blocked_by_username || 'Unknown'} • {new Date(blockedIp.created_at).toLocaleString()}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleUnblockIp(blockedIp.id)}
                  className="p-2 text-zinc-500 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors"
                  title="Unblock IP"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Play Sessions Section */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Activity className="text-emerald-400" size={24} />
            <h2 className="text-xl font-bold text-white">Active Play Sessions</h2>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={selectedServer || ''}
              onChange={(e) => setSelectedServer(Number(e.target.value))}
              className="bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500"
            >
              {servers.map((server) => (
                <option key={server.id} value={server.id}>{server.name}</option>
              ))}
            </select>
            <button
              onClick={fetchSessions}
              disabled={isRefreshing}
              className="bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-colors"
            >
              <RefreshCw size={18} className={isRefreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {sessions.length === 0 ? (
          <div className="text-center py-8 text-zinc-500">
            {selectedServer ? 'No active sessions or unable to fetch sessions' : 'Select a server to view sessions'}
          </div>
        ) : (
          <div className="space-y-3">
            {sessions.map((session, index) => (
              <div key={index} className="flex items-center justify-between p-4 bg-zinc-950 rounded-xl border border-zinc-800">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 bg-emerald-500/10 rounded-lg flex items-center justify-center">
                    <Lock className="text-emerald-400" size={20} />
                  </div>
                  <div>
                    <p className="text-white font-medium font-mono">{session.ip || 'Unknown IP'}</p>
                    <p className="text-sm text-zinc-400">{session.stream_name || 'Unknown stream'}</p>
                    {session.started_at && (
                      <p className="text-xs text-zinc-500 mt-1">Started: {new Date(session.started_at).toLocaleString()}</p>
                    )}
                  </div>
                </div>
                {session.ip && (
                  <button
                    onClick={() => handleBlockFromSession(session.ip, session.stream_name)}
                    className="bg-rose-500 hover:bg-rose-600 text-white px-3 py-1 rounded-lg text-sm font-medium transition-colors"
                  >
                    Block IP
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add IP Modal */}
      {isAdding && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 w-full max-w-md shadow-3xl">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold text-white">Block IP Address</h3>
              <button onClick={() => setIsAdding(false)} className="text-zinc-500 hover:text-white">
                <Trash2 size={24} />
              </button>
            </div>
            <form onSubmit={handleBlockIp} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-400 mb-1">IP Address</label>
                <input
                  type="text"
                  value={formData.ip_address}
                  onChange={(e) => setFormData({ ...formData, ip_address: e.target.value })}
                  placeholder="e.g., 192.168.1.100"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-400 mb-1">Reason (optional)</label>
                <input
                  type="text"
                  value={formData.reason}
                  onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                  placeholder="e.g., Unauthorized access"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div className="flex gap-3 pt-4">
                <button type="submit" className="flex-1 bg-rose-500 hover:bg-rose-600 text-white py-2 rounded-xl font-medium">
                  Block IP
                </button>
                <button type="button" onClick={() => setIsAdding(false)} className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white py-2 rounded-xl font-medium">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Notification */}
      {notification && (
        <div className={`fixed bottom-4 right-4 px-6 py-3 rounded-xl shadow-2xl z-50 flex items-center gap-3 ${
          notification.type === 'success' ? 'bg-emerald-500 text-white' : 'bg-rose-500 text-white'
        }`}>
          {notification.type === 'success' ? <AlertCircle size={20} /> : <AlertCircle size={20} />}
          <span className="font-medium">{notification.message}</span>
        </div>
      )}
    </div>
  );
}

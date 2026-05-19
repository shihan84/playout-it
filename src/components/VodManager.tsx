import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { 
  Plus, Trash2, Folder, AlertCircle, RefreshCw, 
  Edit2, FileVideo, X, Copy, Check, Search, 
  Database, Server, MoreHorizontal, Settings2, Trash
} from 'lucide-react';
import VodFileManager from './VodFileManager';

export default function VodManager() {
  const [vods, setVods] = useState<any[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [formData, setFormData] = useState({ server_id: '', name: '', paths: [''] });
  const [searchQuery, setSearchQuery] = useState('');
  
  const [managingFilesFor, setManagingFilesFor] = useState<any | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' | 'info' } | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const showNotification = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 5000);
  };

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [vodsRes, serversRes] = await Promise.all([
        axios.get('/api/vods'),
        axios.get('/api/servers')
      ]);
      setVods(Array.isArray(vodsRes.data) ? vodsRes.data : []);
      setServers(Array.isArray(serversRes.data) ? serversRes.data : []);
      if (Array.isArray(serversRes.data) && serversRes.data.length > 0 && !formData.server_id) {
        setFormData(prev => ({ ...prev, server_id: serversRes.data[0].id.toString() }));
      }
    } catch (error) {
      console.error('Failed to fetch data', error);
      showNotification('Failed to fetch data from server', 'error');
    }
  };

  const handleAddPath = () => {
    setFormData({ ...formData, paths: [...formData.paths, ''] });
  };

  const handlePathChange = (index: number, value: string) => {
    const newPaths = [...formData.paths];
    newPaths[index] = value;
    setFormData({ ...formData, paths: newPaths });
  };

  const handleRemovePath = (index: number) => {
    const newPaths = formData.paths.filter((_, i) => i !== index);
    setFormData({ ...formData, paths: newPaths });
  };

  const startAdd = () => {
    setFormData({ server_id: servers.length > 0 ? servers[0].id.toString() : '', name: '', paths: [''] });
    setEditingId(null);
    setIsAdding(true);
  };

  const startEdit = (vod: any) => {
    setFormData({
      server_id: vod.server_id.toString(),
      name: vod.name,
      paths: vod.paths && vod.paths.length > 0 ? vod.paths : ['']
    });
    setEditingId(vod.id);
    setIsAdding(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const payload = {
        ...formData,
        paths: formData.paths.filter(p => p.trim() !== '')
      };
      
      if (editingId) {
        await axios.put(`/api/vods/${editingId}`, payload);
        showNotification('VOD location updated', 'success');
      } else {
        await axios.post('/api/vods', payload);
        showNotification('VOD location created', 'success');
      }
      
      setIsAdding(false);
      setEditingId(null);
      fetchData();
    } catch (error: any) {
      console.error('Failed to save VOD', error);
      showNotification(error.response?.data?.error || 'Failed to save VOD', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await axios.delete(`/api/vods/${id}`);
      showNotification('VOD location deleted successfully', 'success');
      fetchData();
    } catch (error) {
      console.error('Failed to delete VOD', error);
      showNotification('Failed to delete VOD location', 'error');
    } finally {
      setDeleteConfirmId(null);
    }
  };

  const handleCopy = (vod: any) => {
    const url = `playlist://${vod.name}/playlist.txt`;
    navigator.clipboard.writeText(url);
    setCopiedId(vod.id);
    showNotification('Playlist URL copied!', 'success');
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleSync = async (id: number) => {
    setSyncingId(id);
    try {
      const res = await axios.post(`/api/vods/${id}/sync`);
      if (res.data.deleted) {
        showNotification('VOD no longer exists on Flussonic and has been removed locally.', 'info');
      } else {
        showNotification('VOD synced successfully', 'success');
      }
      fetchData();
    } catch (error) {
      console.error('Failed to sync VOD', error);
      showNotification('Failed to sync VOD with Flussonic.', 'error');
    } finally {
      setSyncingId(null);
    }
  };

  const handleSyncAll = async () => {
    setIsSubmitting(true);
    try {
      let totalAdded = 0;
      let totalRemoved = 0;
      for (const server of servers) {
        const res = await axios.post(`/api/servers/${server.id}/sync`);
        if (res.data.vodsAdded) totalAdded += res.data.vodsAdded;
        if (res.data.vodsRemoved) totalRemoved += res.data.vodsRemoved;
      }
      showNotification(`Sync complete! Added ${totalAdded} and removed ${totalRemoved} VODs.`, 'success');
      fetchData();
    } catch (error) {
      console.error('Sync failed', error);
      showNotification('Failed to sync VODs.', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredVods = vods.filter(vod => {
    const query = searchQuery.toLowerCase();
    return (
      vod.name.toLowerCase().includes(query) ||
      (vod.server_name && vod.server_name.toLowerCase().includes(query)) ||
      (vod.paths && vod.paths.some((p: string) => p.toLowerCase().includes(query)))
    );
  });

  return (
    <div className="space-y-6">
      {/* Search and Global Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex-1 max-w-md relative group">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500 group-focus-within:text-emerald-500 transition-colors" size={18} />
          <input
            type="text"
            placeholder="Search VOD folders, servers, or paths..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-zinc-900/50 border border-zinc-800 rounded-2xl pl-11 pr-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all placeholder:text-zinc-600 shadow-sm"
          />
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={handleSyncAll}
            disabled={isSubmitting || servers.length === 0}
            className="bg-zinc-800/80 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-xl font-medium flex items-center gap-2 transition-all text-sm border border-zinc-700/50 shadow-sm"
          >
            <RefreshCw size={16} className={isSubmitting ? 'animate-spin' : ''} />
            Sync All Servers
          </button>
          <button 
            onClick={startAdd}
            disabled={servers.length === 0}
            className="bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-xl font-bold flex items-center gap-2 transition-all text-sm shadow-lg shadow-emerald-500/20 active:scale-95"
          >
            <Plus size={18} strokeWidth={3} />
            New VOD Location
          </button>
        </div>
      </div>

      {/* Warnings */}
      {servers.length === 0 && (
        <div className="bg-amber-500/5 border border-amber-500/20 text-amber-500 p-4 rounded-2xl flex items-start gap-4 animate-in fade-in slide-in-from-top-2">
          <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0">
            <AlertCircle size={24} />
          </div>
          <div>
            <h4 className="font-bold text-sm">Action Required</h4>
            <p className="text-zinc-400 text-xs mt-1">You need to add a server before you can configure VOD folders. Head over to the Servers page to get started.</p>
          </div>
        </div>
      )}

      {/* Add/Edit Form Overlay */}
      {isAdding && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 w-full max-w-2xl shadow-3xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
                  <Database className="text-emerald-400" size={24} />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white">{editingId ? 'Edit VOD Folder' : 'Create VOD Folder'}</h3>
                  <p className="text-zinc-500 text-sm">Configure how Flussonic stores and serves your VOD content.</p>
                </div>
              </div>
              <button 
                onClick={() => { setIsAdding(false); setEditingId(null); }}
                className="p-2 hover:bg-zinc-800 rounded-xl text-zinc-500 hover:text-white transition-all"
              >
                <X size={24} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2 px-1">Target Server</label>
                  <div className="relative">
                    <Server className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" size={18} />
                    <select 
                      required
                      value={formData.server_id}
                      onChange={e => setFormData({...formData, server_id: e.target.value})}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl pl-11 pr-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all appearance-none cursor-pointer shadow-sm"
                    >
                      {servers.map(s => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2 px-1">VOD Name / Prefix</label>
                  <input 
                    required
                    type="text" 
                    value={formData.name}
                    onChange={e => setFormData({...formData, name: e.target.value})}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl px-5 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all shadow-sm"
                    placeholder="e.g. movies, archives"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2 px-1">
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-widest">Storage Paths</label>
                  <button 
                    type="button" 
                    onClick={handleAddPath}
                    className="text-xs font-bold text-emerald-400 hover:text-emerald-300 flex items-center gap-1.5 transition-colors"
                  >
                    <Plus size={14} strokeWidth={3} /> Add Another Path
                  </button>
                </div>
                <div className="space-y-3">
                  {formData.paths.map((path, index) => (
                    <div key={index} className="flex gap-3 animate-in slide-in-from-left-2 transition-all">
                      <div className="relative flex-1">
                        <HardDrive className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-600" size={18} />
                        <input 
                          required
                          type="text" 
                          value={path}
                          onChange={e => handlePathChange(index, e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl pl-11 pr-5 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all shadow-sm"
                          placeholder="e.g. /storage/disk1 or s3://bucket-name"
                        />
                      </div>
                      {formData.paths.length > 1 && (
                        <button 
                          type="button"
                          onClick={() => handleRemovePath(index)}
                          className="p-3 text-zinc-600 hover:text-rose-500 transition-all bg-zinc-950 border border-zinc-800 rounded-2xl active:scale-95"
                        >
                          <Trash size={18} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-4 pt-4">
                <button 
                  disabled={isSubmitting} 
                  type="submit" 
                  className="flex-1 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-white py-4 rounded-2xl font-bold transition-all shadow-xl shadow-emerald-500/10 active:scale-[0.98]"
                >
                  {isSubmitting ? <RefreshCw className="animate-spin mx-auto" /> : (editingId ? 'Update Configuration' : 'Create VOD Location')}
                </button>
                <button 
                  type="button" 
                  onClick={() => { setIsAdding(false); setEditingId(null); }} 
                  className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white py-4 rounded-2xl font-bold transition-all active:scale-[0.98]"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* VOD Locations Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredVods.length === 0 ? (
          <div className="col-span-full py-20 bg-zinc-900/30 border-2 border-dashed border-zinc-800 rounded-3xl flex flex-col items-center justify-center text-center">
            <div className="w-20 h-20 rounded-full bg-zinc-900 flex items-center justify-center mb-6">
              <Folder size={40} className="text-zinc-800" />
            </div>
            <h3 className="text-zinc-300 font-bold text-lg">No VOD areas found</h3>
            <p className="text-zinc-600 text-sm mt-2 max-w-xs">
              {searchQuery ? 'Try adjusting your search filters.' : 'Create your first VOD location to start managing and uploading content.'}
            </p>
          </div>
        ) : (
          filteredVods.map((vod) => (
            <div key={vod.id} className="group bg-zinc-900 border border-zinc-800/50 rounded-3xl overflow-hidden hover:border-emerald-500/30 transition-all shadow-lg hover:shadow-emerald-500/5 flex flex-col">
              <div className="p-6 flex-1">
                <div className="flex items-start justify-between mb-6">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-amber-500/10 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                      <Folder className="text-amber-400" size={24} />
                    </div>
                    <div className="min-w-0">
                      <h4 className="text-lg font-bold text-white truncate">{vod.name}</h4>
                      <p className="text-xs text-zinc-500 flex items-center gap-1.5 mt-1">
                        <Server size={12} className="text-zinc-600" />
                        {vod.server_name || 'Disconnected'}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <button 
                      onClick={() => startEdit(vod)}
                      className="p-2 text-zinc-500 hover:text-white hover:bg-zinc-800 rounded-xl transition-all"
                      title="Edit VOD"
                    >
                      <Settings2 size={18} />
                    </button>
                    <button 
                      onClick={() => setDeleteConfirmId(vod.id)}
                      className="p-2 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-xl transition-all"
                      title="Delete VOD"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <h5 className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest mb-2">Storage Paths</h5>
                    <div className="space-y-2">
                      {vod.paths?.map((path: string, i: number) => (
                        <div key={i} className="flex items-center gap-2 bg-black/40 px-3 py-2 rounded-xl border border-zinc-800/50 hover:border-zinc-700 transition-colors">
                          <HardDrive size={12} className="text-zinc-600 shrink-0" />
                          <span className="text-[11px] font-mono text-zinc-400 truncate">{path}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="px-6 py-4 bg-zinc-950/50 border-t border-zinc-800/50 flex items-center justify-between gap-3">
                <button 
                  onClick={() => handleCopy(vod)}
                  className="flex items-center gap-2 text-xs font-bold text-zinc-400 hover:text-emerald-400 transition-colors"
                >
                  {copiedId === vod.id ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                  Copy URL
                </button>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => handleSync(vod.id)}
                    disabled={syncingId === vod.id}
                    className="p-2 text-zinc-500 hover:text-emerald-400 transition-colors"
                    title="Sync with Flussonic"
                  >
                    <RefreshCw size={16} className={syncingId === vod.id ? 'animate-spin' : ''} />
                  </button>
                  <button 
                    onClick={() => handleManageFiles(vod)}
                    className="bg-zinc-800 hover:bg-zinc-700 text-white px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all active:scale-95"
                  >
                    <FileVideo size={14} />
                    Manage Files
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* File Manager Side Drawer / Modal (Handled by component) */}
      {managingFilesFor && (
        <VodFileManager 
          vod={managingFilesFor} 
          onClose={() => setManagingFilesFor(null)} 
          showNotification={showNotification}
        />
      )}

      {/* Notification Toast */}
      {notification && (
        <div className={`fixed bottom-8 left-1/2 -translate-x-1/2 px-6 py-3.5 rounded-2xl shadow-2xl z-[100] flex items-center gap-3 animate-in slide-in-from-bottom-full duration-300 border backdrop-blur-md ${
          notification.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 
          notification.type === 'error' ? 'bg-rose-500/10 border-rose-500/20 text-rose-400' : 
          'bg-blue-500/10 border-blue-500/20 text-blue-400'
        }`}>
          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
            notification.type === 'success' ? 'bg-emerald-500/20' : 
            notification.type === 'error' ? 'bg-rose-500/20' : 
            'bg-blue-500/20'
          }`}>
            {notification.type === 'success' ? <Check size={16} strokeWidth={3} /> : <AlertCircle size={16} strokeWidth={3} />}
          </div>
          <span className="font-bold text-sm">{notification.message}</span>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmId && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl max-w-sm w-full p-8 shadow-3xl animate-in zoom-in-95">
            <div className="w-16 h-16 rounded-full bg-rose-500/10 flex items-center justify-center mb-6 text-rose-500">
              <AlertCircle size={32} />
            </div>
            <h3 className="text-xl font-bold text-white mb-2">Delete VOD location?</h3>
            <p className="text-zinc-500 text-sm mb-8 leading-relaxed">
              This will remove the configuration from both your dashboard and the Flussonic server. Existing video files will remain on storage.
            </p>
            <div className="flex gap-4">
              <button
                onClick={() => handleDelete(deleteConfirmId)}
                className="flex-1 bg-rose-500 hover:bg-rose-600 text-white font-bold py-3.5 rounded-2xl transition-all shadow-lg shadow-rose-500/20 active:scale-95"
              >
                Delete
              </button>
              <button
                onClick={() => setDeleteConfirmId(null)}
                className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white font-bold py-3.5 rounded-2xl transition-all active:scale-95"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

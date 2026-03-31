import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Plus, Trash2, Radio, CheckCircle2, XCircle, AlertCircle, PlaySquare, Copy, Check, X, RefreshCw, Upload, FileVideo, Edit2 } from 'lucide-react';

export default function Streams() {
  const [streams, setStreams] = useState<any[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [editingStreamId, setEditingStreamId] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [formData, setFormData] = useState({ server_id: '', name: '', inputs: [''], push_urls: [''] });
  
  const [selectedStreamId, setSelectedStreamId] = useState<number | null>(null);
  const [streamDetails, setStreamDetails] = useState<any>(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  
  const [activeTab, setActiveTab] = useState<'details' | 'vods'>('details');
  const [vods, setVods] = useState<any[]>([]);
  const [availableVods, setAvailableVods] = useState<any[]>([]);
  const [enableVodFallback, setEnableVodFallback] = useState(false);
  const [fallbackVodUrl, setFallbackVodUrl] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [selectedVodLocationId, setSelectedVodLocationId] = useState<number | null>(null);

  useEffect(() => {
    fetchData();
    
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
            setStreams(Array.isArray(message.data) ? message.data : []);
          }
        } catch (e) {
          console.error('Failed to parse WebSocket message', e);
        }
      };

      ws.onclose = () => {
        // Attempt to reconnect after 2 seconds
        reconnectTimer = setTimeout(connectWs, 2000);
      };
    };

    connectWs();

    // Fallback polling just in case WS fails
    const interval = setInterval(fetchStreams, 10000);
    
    return () => {
      clearInterval(interval);
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null; // Prevent reconnect loop on unmount
        ws.close();
      }
    };
  }, []);

  const fetchData = async () => {
    try {
      const [streamsRes, serversRes, vodsRes] = await Promise.all([
        axios.get('/api/streams'),
        axios.get('/api/servers'),
        axios.get('/api/vods')
      ]);
      setStreams(Array.isArray(streamsRes.data) ? streamsRes.data : []);
      setServers(Array.isArray(serversRes.data) ? serversRes.data : []);
      setAvailableVods(Array.isArray(vodsRes.data) ? vodsRes.data : []);
      if (Array.isArray(serversRes.data) && serversRes.data.length > 0 && !formData.server_id) {
        setFormData(prev => ({ ...prev, server_id: serversRes.data[0].id.toString() }));
      }
    } catch (error) {
      console.error('Failed to fetch data', error);
    }
  };

  const fetchStreams = async () => {
    try {
      const res = await axios.get('/api/streams');
      setStreams(Array.isArray(res.data) ? res.data : []);
    } catch (error) {
      console.error('Failed to fetch streams', error);
    }
  };

  const handleAddPushUrl = () => {
    setFormData({ ...formData, push_urls: [...formData.push_urls, ''] });
  };

  const handlePushUrlChange = (index: number, value: string) => {
    const newPushUrls = [...formData.push_urls];
    newPushUrls[index] = value;
    setFormData({ ...formData, push_urls: newPushUrls });
  };

  const handleRemovePushUrl = (index: number) => {
    const newPushUrls = formData.push_urls.filter((_, i) => i !== index);
    setFormData({ ...formData, push_urls: newPushUrls });
  };

  const handleCopy = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl(null), 2000);
  };

  const handleRowClick = async (id: number) => {
    setSelectedStreamId(id);
    setIsLoadingDetails(true);
    setStreamDetails(null);
    setActiveTab('details');
    setSelectedVodLocationId(null);
    try {
      const [detailsRes, vodsRes] = await Promise.all([
        axios.get(`/api/streams/${id}/details`),
        axios.get(`/api/streams/${id}/videos`)
      ]);
      setStreamDetails(detailsRes.data);
      setVods(Array.isArray(vodsRes.data) ? vodsRes.data : []);
    } catch (error) {
      console.error('Failed to fetch stream details', error);
    } finally {
      setIsLoadingDetails(false);
    }
  };

  const fetchVodFiles = async (vodId: number) => {
    try {
      const res = await axios.get(`/api/vods/${vodId}/files`);
      setVods(Array.isArray(res.data) ? res.data : []);
    } catch (error) {
      console.error('Failed to fetch VOD files', error);
      setVods([]);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0 || !selectedStreamId) return;
    
    const file = e.target.files[0];
    const formData = new FormData();
    
    setIsUploading(true);
    setUploadProgress(0);
    
    try {
      if (selectedVodLocationId) {
        formData.append('file', file);
        await axios.post(`/api/vods/${selectedVodLocationId}/files`, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: (progressEvent) => {
            const percentCompleted = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 1));
            setUploadProgress(percentCompleted);
          }
        });
        fetchVodFiles(selectedVodLocationId);
      } else {
        formData.append('video', file);
        await axios.post(`/api/streams/${selectedStreamId}/videos`, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: (progressEvent) => {
            const percentCompleted = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 1));
            setUploadProgress(percentCompleted);
          }
        });
        const vodsRes = await axios.get(`/api/streams/${selectedStreamId}/videos`);
        setVods(Array.isArray(vodsRes.data) ? vodsRes.data : []);
      }
    } catch (error: any) {
      console.error('Upload failed', error);
      alert(error.response?.data?.error || 'Failed to upload video');
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      e.target.value = '';
    }
  };

  const handleDeleteVod = async (filename: string) => {
    if (!confirm(`Are you sure you want to delete ${filename}?`)) return;
    
    try {
      if (selectedVodLocationId) {
        await axios.delete(`/api/vods/${selectedVodLocationId}/files/${filename}`);
        fetchVodFiles(selectedVodLocationId);
      } else {
        if (!selectedStreamId) return;
        await axios.delete(`/api/streams/${selectedStreamId}/videos/${filename}`);
        const vodsRes = await axios.get(`/api/streams/${selectedStreamId}/videos`);
        setVods(Array.isArray(vodsRes.data) ? vodsRes.data : []);
      }
    } catch (error: any) {
      console.error('Failed to delete video', error);
      alert(error.response?.data?.error || 'Failed to delete video');
    }
  };

  const handleEdit = (stream: any) => {
    setEditingStreamId(stream.id);
    
    let inputs = stream.inputs ? [...stream.inputs] : [];
    let fallbackUrl = '';
    let enableFallback = false;
    
    if (inputs.length === 0) {
      if (stream.live_url) inputs.push(stream.live_url);
      if (stream.playlist_url) {
        fallbackUrl = stream.playlist_url;
        enableFallback = true;
      }
    } else {
      const lastInput = inputs[inputs.length - 1];
      if (lastInput && lastInput.startsWith('playlist://')) {
        fallbackUrl = lastInput;
        enableFallback = true;
        inputs = inputs.slice(0, -1);
      }
    }
    
    if (inputs.length === 0) inputs = [''];
    
    setFormData({
      server_id: stream.server_id ? stream.server_id.toString() : '',
      name: stream.name || '',
      inputs: inputs,
      push_urls: stream.push_urls ? [...stream.push_urls] : []
    });
    setEnableVodFallback(enableFallback);
    setFallbackVodUrl(fallbackUrl);
    setIsAdding(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validInputs = formData.inputs.filter(url => url.trim() !== '');
    if (enableVodFallback && fallbackVodUrl.trim() !== '') {
      validInputs.push(fallbackVodUrl);
    }
    if (validInputs.length === 0) {
      alert('Please provide at least one Input Source URL.');
      return;
    }
    setIsSubmitting(true);
    try {
      const payload = {
        ...formData,
        inputs: validInputs,
        push_urls: formData.push_urls.filter(url => url.trim() !== '')
      };
      
      if (editingStreamId) {
        await axios.put(`/api/streams/${editingStreamId}`, payload);
      } else {
        await axios.post('/api/streams', payload);
      }
      
      setFormData({ ...formData, name: '', inputs: [''], push_urls: [''] });
      setEnableVodFallback(false);
      setFallbackVodUrl('');
      setIsAdding(false);
      setEditingStreamId(null);
      fetchData();
    } catch (error: any) {
      console.error(`Failed to ${editingStreamId ? 'update' : 'add'} stream`, error);
      alert(error.response?.data?.error || `Failed to ${editingStreamId ? 'update' : 'add'} stream`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this stream? It will be removed from Flussonic as well.')) return;
    try {
      await axios.delete(`/api/streams/${id}`);
      fetchStreams();
    } catch (error) {
      console.error('Failed to delete stream', error);
    }
  };

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      let totalAdded = 0;
      let totalVodsAdded = 0;
      for (const server of servers) {
        const res = await axios.post(`/api/servers/${server.id}/sync`);
        if (res.data.added) {
          totalAdded += res.data.added;
        }
        if (res.data.vodsAdded) {
          totalVodsAdded += res.data.vodsAdded;
        }
      }
      alert(`Sync complete! Added ${totalAdded} new streams and ${totalVodsAdded} new VODs from servers.`);
      fetchStreams();
    } catch (error) {
      console.error('Sync failed', error);
      alert('Failed to sync streams.');
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Streams</h1>
          <p className="text-zinc-400 mt-2">Configure streams with playlist fallbacks.</p>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={handleSync}
            disabled={isSyncing || servers.length === 0}
            className="bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-colors"
          >
            <RefreshCw size={20} className={isSyncing ? 'animate-spin' : ''} />
            Sync
          </button>
          <button 
            onClick={() => {
              if (isAdding) {
                setIsAdding(false);
                setEditingStreamId(null);
                setFormData({ server_id: '', name: '', inputs: [''], push_urls: [''] });
              } else {
                setIsAdding(true);
                setEnableVodFallback(false);
              }
            }}
            disabled={servers.length === 0}
            className="bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-colors"
          >
            {isAdding ? <X size={20} /> : <Plus size={20} />}
            {isAdding ? 'Cancel' : 'Add Stream'}
          </button>
        </div>
      </div>

      {servers.length === 0 && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-xl flex items-center gap-3">
          <AlertCircle size={20} />
          <p>You need to add a server before you can configure streams.</p>
        </div>
      )}

      {isAdding && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
          <h2 className="text-xl font-semibold text-white mb-4">{editingStreamId ? 'Edit Stream' : 'Add New Stream'}</h2>
          <form onSubmit={handleSubmit} className="space-y-4 max-w-xl">
            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1">Target Server</label>
              <select 
                required
                value={formData.server_id}
                onChange={e => setFormData({...formData, server_id: e.target.value})}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
              >
                {servers.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1">Stream Name</label>
              <input 
                required
                type="text" 
                value={formData.name}
                onChange={e => setFormData({...formData, name: e.target.value})}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                placeholder="e.g. sports_channel_1"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-zinc-400">Input Sources</label>
                <div className="flex items-center gap-3">
                  <button 
                    type="button" 
                    onClick={() => setFormData({...formData, inputs: [...formData.inputs, 'publish://']})}
                    className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                  >
                    <Plus size={14} /> Add Publish Endpoint
                  </button>
                  <button 
                    type="button" 
                    onClick={() => setFormData({...formData, inputs: [...formData.inputs, '']})}
                    className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                  >
                    <Plus size={14} /> Add Input
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                {formData.inputs.map((input, index) => (
                  <div key={index} className="flex gap-2">
                    <div className="flex-1 relative">
                      <input 
                        type="text" 
                        value={input}
                        onChange={e => {
                          const newInputs = [...formData.inputs];
                          newInputs[index] = e.target.value;
                          setFormData({...formData, inputs: newInputs});
                        }}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                        placeholder="e.g. udp://239.0.0.1:5000, publish://, or playlist://vod_name/playlist.txt"
                      />
                    </div>
                    {formData.inputs.length > 1 && (
                      <button 
                        type="button" 
                        onClick={() => {
                          const newInputs = formData.inputs.filter((_, i) => i !== index);
                          setFormData({...formData, inputs: newInputs});
                        }}
                        className="p-2 text-zinc-500 hover:text-red-400 transition-colors"
                      >
                        <X size={20} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-xs text-zinc-500 mt-1">Flussonic will try inputs in order. Use the dropdown to easily select a VOD playlist.</p>
            </div>
            
            <div className="flex items-center justify-between bg-zinc-950/50 border border-zinc-800/50 rounded-xl p-4">
              <div>
                <label className="block text-sm font-medium text-zinc-300">VOD Fallback</label>
                <p className="text-xs text-zinc-500">Enable to automatically switch to a VOD playlist if the live stream drops.</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input 
                  type="checkbox" 
                  className="sr-only peer"
                  checked={enableVodFallback}
                  onChange={(e) => setEnableVodFallback(e.target.checked)}
                />
                <div className="w-11 h-6 bg-zinc-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
              </label>
            </div>

            {enableVodFallback && (
              <div className="bg-zinc-950/30 border border-zinc-800/50 rounded-xl p-4 space-y-3">
                <label className="block text-sm font-medium text-zinc-400">Select Fallback VOD</label>
                <select
                  value={(fallbackVodUrl || '').replace('playlist://', '').replace('/playlist.txt', '')}
                  onChange={e => {
                    const vodName = e.target.value;
                    if (vodName) {
                      setFallbackVodUrl(`playlist://${vodName}/playlist.txt`);
                    } else {
                      setFallbackVodUrl('');
                    }
                  }}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                >
                  <option value="">Select a VOD...</option>
                  {formData.name && <option value={formData.name}>{formData.name} (Current Stream)</option>}
                  {availableVods.filter(v => v.name !== formData.name).map(v => (
                    <option key={v.id} value={v.name}>{v.name}</option>
                  ))}
                </select>
                {fallbackVodUrl && (
                  <p className="text-xs text-emerald-400 font-mono break-all">
                    {fallbackVodUrl}
                  </p>
                )}
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-zinc-400">Push URLs (Optional)</label>
                <button 
                  type="button" 
                  onClick={handleAddPushUrl}
                  className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                >
                  <Plus size={14} /> Add Push Target
                </button>
              </div>
              <div className="space-y-2">
                {formData.push_urls.map((url, index) => (
                  <div key={index} className="flex gap-2">
                    <input 
                      type="text" 
                      value={url}
                      onChange={e => handlePushUrlChange(index, e.target.value)}
                      className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                      placeholder="e.g. rtmp://youtube.com/live2/KEY"
                    />
                    {formData.push_urls.length > 1 && (
                      <button 
                        type="button"
                        onClick={() => handleRemovePushUrl(index)}
                        className="p-2 text-zinc-500 hover:text-rose-400 transition-colors bg-zinc-950 border border-zinc-800 rounded-xl"
                      >
                        <Trash2 size={18} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <button disabled={isSubmitting} type="submit" className="bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white px-6 py-2 rounded-xl font-medium transition-colors">
                {isSubmitting ? 'Configuring...' : 'Save & Configure'}
              </button>
              <button type="button" onClick={() => setIsAdding(false)} className="bg-zinc-800 hover:bg-zinc-700 text-white px-6 py-2 rounded-xl font-medium transition-colors">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
        {streams.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            No streams configured yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-zinc-900 border-b border-zinc-800 text-zinc-400 text-sm">
                  <th className="px-6 py-4 font-medium">Name</th>
                  <th className="px-6 py-4 font-medium">Server</th>
                  <th className="px-6 py-4 font-medium">Sources</th>
                  <th className="px-6 py-4 font-medium">Playback URLs</th>
                  <th className="px-6 py-4 font-medium">Push Targets</th>
                  <th className="px-6 py-4 font-medium">Status</th>
                  <th className="px-6 py-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {streams.map((stream) => (
                  <tr 
                    key={stream.id} 
                    onClick={() => handleRowClick(stream.id)}
                    className="text-zinc-300 hover:bg-zinc-800/20 transition-colors cursor-pointer"
                  >
                    <td className="px-6 py-4 font-medium flex items-center gap-3">
                      <Radio size={18} className="text-purple-400" />
                      {stream.name}
                    </td>
                    <td className="px-6 py-4 text-zinc-400">{stream.server_name}</td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-1 text-xs font-mono">
                        {stream.inputs && stream.inputs.length > 0 ? stream.inputs.map((input: string, i: number) => (
                          <div key={i} className={`flex items-center gap-2 ${i === 0 ? 'text-emerald-400/80' : 'text-amber-400/80'}`} title={`Input ${i + 1}`}>
                            {i === 0 ? <Radio size={12} /> : <PlaySquare size={12} />} 
                            <span className="truncate max-w-[150px]">{input}</span>
                          </div>
                        )) : (
                          <>
                            <div className="flex items-center gap-2 text-emerald-400/80" title="Primary Live Source">
                              <Radio size={12} /> <span className="truncate max-w-[150px]">{stream.live_url}</span>
                            </div>
                            {stream.playlist_url && (
                              <div className="flex items-center gap-2 text-amber-400/80" title="Fallback Playlist">
                                <PlaySquare size={12} /> <span className="truncate max-w-[150px]">{stream.playlist_url}</span>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-2 text-xs font-mono">
                        <div className="flex items-center gap-2 group">
                          <span className="bg-zinc-800 text-zinc-300 px-1.5 py-0.5 rounded text-[10px] font-bold">HLS</span>
                          <span className="truncate max-w-[150px] text-zinc-400" title={`${stream.server_url}/${stream.name}/index.m3u8`}>
                            {stream.server_url}/{stream.name}/index.m3u8
                          </span>
                          <button 
                            onClick={(e) => { e.stopPropagation(); handleCopy(`${stream.server_url}/${stream.name}/index.m3u8`); }} 
                            className="text-zinc-500 hover:text-white transition-colors opacity-0 group-hover:opacity-100"
                            title="Copy HLS URL"
                          >
                            {copiedUrl === `${stream.server_url}/${stream.name}/index.m3u8` ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                          </button>
                        </div>
                        <div className="flex items-center gap-2 group">
                          <span className="bg-zinc-800 text-zinc-300 px-1.5 py-0.5 rounded text-[10px] font-bold">DASH</span>
                          <span className="truncate max-w-[150px] text-zinc-400" title={`${stream.server_url}/${stream.name}/index.mpd`}>
                            {stream.server_url}/{stream.name}/index.mpd
                          </span>
                          <button 
                            onClick={(e) => { e.stopPropagation(); handleCopy(`${stream.server_url}/${stream.name}/index.mpd`); }} 
                            className="text-zinc-500 hover:text-white transition-colors opacity-0 group-hover:opacity-100"
                            title="Copy DASH URL"
                          >
                            {copiedUrl === `${stream.server_url}/${stream.name}/index.mpd` ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                          </button>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-1 text-xs font-mono">
                        {stream.push_urls && stream.push_urls.length > 0 ? (
                          stream.push_urls.length > 2 ? (
                            <div className="text-zinc-400 bg-zinc-800/50 px-2 py-1 rounded w-fit">
                              {stream.push_urls.length} Push Targets
                            </div>
                          ) : (
                            stream.push_urls.map((url: string, i: number) => {
                              const pushStat = stream.push_status?.find((p: any) => p.url === url);
                              const pushStatus = pushStat?.status || 'unknown';
                              
                              let statusColor = 'text-zinc-500';
                              if (pushStatus === 'running') statusColor = 'text-emerald-400';
                              else if (pushStatus === 'error') statusColor = 'text-rose-400';
                              else if (pushStatus === 'starting' || pushStatus === 'pending') statusColor = 'text-amber-400';
                              
                              return (
                                <div key={i} className="flex items-center gap-2 text-blue-400/80" title={`Push Target (${pushStatus})`}>
                                  <div className={`w-1.5 h-1.5 rounded-full ${statusColor.replace('text-', 'bg-')}`} />
                                  <Radio size={12} className="rotate-180" /> 
                                  <span className="truncate max-w-[200px]">{url}</span>
                                </div>
                              );
                            })
                          )
                        ) : (
                          <span className="text-zinc-600 italic">None</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-1">
                        <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider w-fit ${
                          stream.status === 'online' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                          stream.status === 'offline' ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20' :
                          'bg-zinc-500/10 text-zinc-400 border border-zinc-500/20'
                        }`}>
                          {stream.status === 'online' ? (
                            <span className="relative flex h-2 w-2">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                            </span>
                          ) : stream.status === 'offline' ? (
                            <span className="relative flex h-2 w-2">
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
                            </span>
                          ) : (
                            <AlertCircle size={12} />
                          )}
                          {stream.status}
                        </span>
                        {stream.last_checked && (
                          <span className="text-[10px] text-zinc-500">
                            Updated: {new Date(stream.last_checked + 'Z').toLocaleTimeString()}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button 
                          onClick={(e) => { e.stopPropagation(); handleEdit(stream); }}
                          className="text-zinc-500 hover:text-emerald-400 transition-colors p-2"
                          title="Edit Stream"
                        >
                          <Edit2 size={18} />
                        </button>
                        <button 
                          onClick={(e) => { e.stopPropagation(); handleDelete(stream.id); }}
                          className="text-zinc-500 hover:text-rose-400 transition-colors p-2"
                          title="Delete Stream"
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedStreamId && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-3xl max-h-[80vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between p-6 border-b border-zinc-800">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Radio className="text-emerald-400" />
                Stream Details: {streamDetails?.name || 'Loading...'}
              </h2>
              <div className="flex items-center gap-4">
                {streamDetails && (
                  <button 
                    onClick={() => {
                      setSelectedStreamId(null);
                      handleEdit(streamDetails);
                    }} 
                    className="text-zinc-400 hover:text-emerald-400 flex items-center gap-1 text-sm transition-colors"
                  >
                    <Edit2 size={16} /> Edit
                  </button>
                )}
                <button onClick={() => setSelectedStreamId(null)} className="text-zinc-500 hover:text-white transition-colors">
                  <X size={24} />
                </button>
              </div>
            </div>
            
            {streamDetails && !isLoadingDetails && (
              <div className="flex border-b border-zinc-800 px-6">
                <button
                  onClick={() => setActiveTab('details')}
                  className={`px-4 py-3 font-medium text-sm border-b-2 transition-colors ${
                    activeTab === 'details' 
                      ? 'border-emerald-500 text-emerald-400' 
                      : 'border-transparent text-zinc-400 hover:text-zinc-300'
                  }`}
                >
                  Overview
                </button>
                <button
                  onClick={() => setActiveTab('vods')}
                  className={`px-4 py-3 font-medium text-sm border-b-2 transition-colors flex items-center gap-2 ${
                    activeTab === 'vods' 
                      ? 'border-emerald-500 text-emerald-400' 
                      : 'border-transparent text-zinc-400 hover:text-zinc-300'
                  }`}
                >
                  <FileVideo size={16} />
                  VOD Playlist
                </button>
              </div>
            )}

            <div className="p-6 overflow-y-auto flex-1">
              {isLoadingDetails ? (
                <div className="flex justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500"></div>
                </div>
              ) : streamDetails ? (
                activeTab === 'details' ? (
                  <div className="space-y-6">
                    {/* Status & Basic Info */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-4">
                        <div className="bg-zinc-950 border border-zinc-800 p-4 rounded-xl">
                          <p className="text-xs text-zinc-500 uppercase font-bold tracking-wider mb-1">Status</p>
                          <p className="text-lg font-bold text-white capitalize">{streamDetails.status}</p>
                        </div>
                        <div className="bg-zinc-950 border border-zinc-800 p-4 rounded-xl">
                          <p className="text-xs text-zinc-500 uppercase font-bold tracking-wider mb-1">Server</p>
                          <p className="text-lg font-bold text-white">{streamDetails.server_name}</p>
                        </div>
                      </div>
                      
                      {/* Stream Player */}
                      <div className="bg-zinc-950 border border-zinc-800 rounded-xl overflow-hidden flex flex-col p-4">
                        <div className="w-full aspect-video bg-zinc-900 rounded-lg overflow-hidden border border-zinc-800 relative">
                          {streamDetails.status === 'online' ? (
                            <iframe 
                              src={`${streamDetails.server_url.replace(/\/$/, '')}/${encodeURIComponent(streamDetails.name)}/embed.html?realtime=true&autoplay=true&mute=true`}
                              width="100%" 
                              height="100%" 
                              frameBorder="0" 
                              allowFullScreen
                              allow="autoplay; fullscreen"
                              className="absolute inset-0"
                            ></iframe>
                          ) : (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500 text-center px-4">
                              <AlertCircle size={48} className="mb-3 opacity-30" />
                              <p className="text-lg font-semibold">Stream Offline</p>
                              <p className="text-sm text-zinc-600 mt-1">The Flussonic player will be active once the stream status changes to online.</p>
                            </div>
                          )}
                        </div>
                        <div className="mt-4 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${streamDetails.status === 'online' ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
                            <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                              {streamDetails.status}
                            </span>
                          </div>
                          <button 
                            onClick={() => handleCopy(`<iframe src="${streamDetails.server_url}/${streamDetails.name}/embed.html?realtime=true" width="640" height="360" frameborder="0" allowfullscreen></iframe>`)}
                            className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors"
                          >
                            {copiedUrl?.includes('iframe') ? <Check size={14} /> : <Copy size={14} />}
                            Copy Embed Code
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Sources */}
                    <div>
                      <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-wider mb-3">Sources</h3>
                      <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 space-y-3">
                        {streamDetails.inputs && streamDetails.inputs.length > 0 ? streamDetails.inputs.map((input: string, i: number) => (
                          <div key={i}>
                            <p className="text-xs text-zinc-500 mb-1">Input {i + 1} {i === 0 ? '(Primary)' : '(Fallback)'}</p>
                            <p className={`text-sm font-mono break-all ${i === 0 ? 'text-emerald-400' : 'text-amber-400'}`}>{input}</p>
                          </div>
                        )) : (
                          <>
                            <div>
                              <p className="text-xs text-zinc-500 mb-1">Primary Live Source</p>
                              <p className="text-sm text-emerald-400 font-mono break-all">{streamDetails.live_url}</p>
                            </div>
                            {streamDetails.playlist_url && (
                              <div>
                                <p className="text-xs text-zinc-500 mb-1">Fallback Playlist</p>
                                <p className="text-sm text-amber-400 font-mono break-all">{streamDetails.playlist_url}</p>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {/* Push Targets */}
                    <div>
                      <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-wider mb-3">Push Targets</h3>
                      {streamDetails.push_urls && streamDetails.push_urls.length > 0 ? (
                        <div className="space-y-2">
                          {streamDetails.push_urls.map((url: string, idx: number) => {
                            const pushStat = streamDetails.flussonic_pushes?.find((p: any) => p.url === url) || 
                                             streamDetails.flussonic_stats?.pushes?.find((p: any) => p.url === url) ||
                                             streamDetails.push_status?.find((p: any) => p.url === url);
                            
                            const pushStatus = pushStat?.status || 'unknown';
                            
                            return (
                              <div key={idx} className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 flex items-center justify-between gap-4">
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm text-blue-400 font-mono break-all">{url}</p>
                                </div>
                                <div className="flex-shrink-0">
                                  <span className={`inline-flex items-center px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${
                                    pushStatus === 'running' ? 'bg-emerald-500/10 text-emerald-400' :
                                    pushStatus === 'error' ? 'bg-rose-500/10 text-rose-500' :
                                    pushStatus === 'starting' || pushStatus === 'pending' ? 'bg-amber-500/10 text-amber-500' :
                                    'bg-zinc-500/10 text-zinc-400'
                                  }`}>
                                    {pushStatus}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 text-zinc-500 text-sm italic">
                          No push targets configured for this stream.
                        </div>
                      )}
                    </div>

                    {/* Raw Stats */}
                    {streamDetails.flussonic_stats && (
                      <div>
                        <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-wider mb-3">Raw Flussonic Stats</h3>
                        <pre className="bg-zinc-950 border border-zinc-800 p-4 rounded-xl text-xs text-zinc-500 font-mono overflow-x-auto max-h-40">
                          {JSON.stringify(streamDetails.flussonic_stats, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-lg font-bold text-white">VOD Playlist</h3>
                        <p className="text-sm text-zinc-400">Manage videos for the fallback playlist.</p>
                      </div>
                      <div className="relative">
                        <input
                          type="file"
                          accept="video/*"
                          onChange={handleFileUpload}
                          disabled={isUploading}
                          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
                        />
                        <button 
                          disabled={isUploading}
                          className="bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-colors"
                        >
                          <Upload size={18} />
                          {isUploading ? 'Uploading...' : 'Upload Video'}
                        </button>
                      </div>
                    </div>

                    {isUploading && (
                      <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4">
                        <div className="flex justify-between text-sm mb-2">
                          <span className="text-zinc-400">Uploading video...</span>
                          <span className="text-emerald-400 font-medium">{uploadProgress}%</span>
                        </div>
                        <div className="w-full bg-zinc-800 rounded-full h-2">
                          <div 
                            className="bg-emerald-500 h-2 rounded-full transition-all duration-300" 
                            style={{ width: `${uploadProgress}%` }}
                          ></div>
                        </div>
                      </div>
                    )}

                    <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 mb-6">
                      <label className="block text-sm font-medium text-zinc-400 mb-2">Select VOD Location to Manage</label>
                      <select
                        value={selectedVodLocationId || ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          setSelectedVodLocationId(val ? Number(val) : null);
                          if (val) {
                            fetchVodFiles(Number(val));
                          } else {
                            // Fetch stream's default VOD files
                            axios.get(`/api/streams/${selectedStreamId}/videos`).then(res => {
                              setVods(Array.isArray(res.data) ? res.data : []);
                            });
                          }
                        }}
                        className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                      >
                        <option value="">{streamDetails.name} (Stream's Default VOD)</option>
                        {availableVods.filter(v => v.name !== streamDetails.name).map(v => (
                          <option key={v.id} value={v.id}>{v.name}</option>
                        ))}
                      </select>
                    </div>

                    <div className="bg-zinc-950 border border-zinc-800 rounded-xl overflow-hidden">
                      {vods.length === 0 ? (
                        <div className="text-center py-12 text-zinc-500">
                          <FileVideo size={48} className="mx-auto mb-4 opacity-20" />
                          <p>No videos uploaded yet.</p>
                          <p className="text-sm mt-1">Upload videos to use them as a fallback playlist.</p>
                        </div>
                      ) : (
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="bg-zinc-900 border-b border-zinc-800 text-zinc-400 text-sm">
                              <th className="px-6 py-4 font-medium">Filename</th>
                              <th className="px-6 py-4 font-medium">Size</th>
                              <th className="px-6 py-4 font-medium">Uploaded</th>
                              <th className="px-6 py-4 font-medium text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-zinc-800/50">
                            {vods.map((vod, idx) => (
                              <tr key={idx} className="text-zinc-300 hover:bg-zinc-800/20 transition-colors">
                                <td className="px-6 py-4 font-medium flex items-center gap-3">
                                  <FileVideo size={18} className="text-emerald-400" />
                                  {vod.name}
                                </td>
                                <td className="px-6 py-4 text-zinc-400">
                                  {(vod.size / (1024 * 1024)).toFixed(2)} MB
                                </td>
                                <td className="px-6 py-4 text-zinc-400">
                                  {new Date(vod.created_at).toLocaleDateString()}
                                </td>
                                <td className="px-6 py-4 text-right">
                                  <button 
                                    onClick={() => handleDeleteVod(vod.name)}
                                    className="text-zinc-500 hover:text-rose-400 transition-colors p-2"
                                    title="Delete Video"
                                  >
                                    <Trash2 size={18} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                    
                    <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4">
                      <p className="text-sm text-zinc-400 mb-2">Playlist URL for Flussonic:</p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 bg-zinc-900 border border-zinc-800 px-3 py-2 rounded text-emerald-400 font-mono text-sm break-all">
                          {selectedVodLocationId 
                            ? `playlist://${availableVods.find(v => v.id === selectedVodLocationId)?.name}/playlist.txt`
                            : `${window.location.origin}/api/streams/${selectedStreamId}/playlist.txt`
                          }
                        </code>
                      </div>
                      <p className="text-xs text-zinc-500 mt-2">
                        Use this URL as the fallback playlist in your Flussonic stream configuration.
                      </p>
                    </div>
                  </div>
                )
              ) : (
                <div className="text-rose-400 bg-rose-500/10 p-4 rounded-xl border border-rose-500/20">
                  Failed to load stream details.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

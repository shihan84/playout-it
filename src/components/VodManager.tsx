import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Plus, Trash2, Folder, AlertCircle, RefreshCw, Edit2, FileVideo, Upload, X, Copy, Check, FileText } from 'lucide-react';

export default function VodManager() {
  const [vods, setVods] = useState<any[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [formData, setFormData] = useState({ server_id: '', name: '', paths: [''] });
  
  const [managingFilesFor, setManagingFilesFor] = useState<any | null>(null);
  const [vodFiles, setVodFiles] = useState<any[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [copiedId, setCopiedId] = useState<number | null>(null);

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
      } else {
        await axios.post('/api/vods', payload);
      }
      
      setFormData({ ...formData, name: '', paths: [''] });
      setIsAdding(false);
      setEditingId(null);
      fetchData();
    } catch (error: any) {
      console.error('Failed to save VOD', error);
      alert(error.response?.data?.error || 'Failed to save VOD');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this VOD location? It will be removed from Flussonic as well.')) return;
    try {
      await axios.delete(`/api/vods/${id}`);
      fetchData();
    } catch (error) {
      console.error('Failed to delete VOD', error);
    }
  };

  const handleCopy = (vod: any) => {
    const url = `playlist://${vod.name}/playlist.txt`;
    navigator.clipboard.writeText(url);
    setCopiedId(vod.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleManageFiles = async (vod: any) => {
    setManagingFilesFor(vod);
    fetchVodFiles(vod.id);
  };

  const fetchVodFiles = async (vodId: number) => {
    try {
      const res = await axios.get(`/api/vods/${vodId}/files`);
      setVodFiles(res.data);
    } catch (error) {
      console.error('Failed to fetch VOD files', error);
    }
  };

  const handleSyncVodFiles = async () => {
    if (!managingFilesFor) return;
    setIsUploading(true);
    try {
      await axios.post(`/api/vods/${managingFilesFor.id}/files/sync`);
      fetchVodFiles(managingFilesFor.id);
    } catch (error: any) {
      console.error('Failed to sync VOD files', error);
      alert(error.response?.data?.error || 'Failed to sync VOD files');
    } finally {
      setIsUploading(false);
    }
  };

  const handleUpdatePlaylist = async () => {
    if (!managingFilesFor) return;
    setIsUploading(true);
    try {
      await axios.post(`/api/vods/${managingFilesFor.id}/playlist/update`);
      alert('Playlist updated successfully!');
    } catch (error: any) {
      console.error('Failed to update playlist', error);
      alert(error.response?.data?.error || 'Failed to update playlist');
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0 || !managingFilesFor) return;
    
    const file = e.target.files[0];
    setIsUploading(true);
    setUploadProgress(0);

    try {
      // 1. Get upload info from our backend
      const infoRes = await axios.get(`/api/vods/${managingFilesFor.id}/upload-info`);
      const { serverUrl, vodName, authHeader, altAuthHeader } = infoRes.data;

      // Ensure serverUrl doesn't have a trailing slash for consistency
      const cleanServerUrl = serverUrl.replace(/\/$/, '');
      const uploadUrl = `${cleanServerUrl}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}/storages/0/files/${file.name}`;
      
      // Check for mixed content
      if (window.location.protocol === 'https:' && cleanServerUrl.startsWith('http:')) {
        console.warn('Mixed content detected: App is HTTPS but Flussonic is HTTP. Direct upload will likely fail.');
      }

      const performDirectUpload = async (header: string) => {
        return await axios.put(uploadUrl, file, {
          headers: { 
            'Authorization': header,
            'Content-Type': file.type || 'application/octet-stream'
          },
          onUploadProgress: (progressEvent) => {
            const percentCompleted = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 1));
            setUploadProgress(percentCompleted);
          }
        });
      };

      try {
        try {
          await performDirectUpload(authHeader);
        } catch (firstError: any) {
          // If 403 and we have an alternate header, try it
          if (firstError.response?.status === 403 && altAuthHeader) {
            console.log('Direct upload failed with 403, trying alternate auth header...');
            await performDirectUpload(altAuthHeader);
          } else {
            throw firstError;
          }
        }

        // 3. Confirm upload with our backend
        await axios.post(`/api/vods/${managingFilesFor.id}/files/confirm-upload`, {
          filename: file.name,
          size: file.size
        });

        fetchVodFiles(managingFilesFor.id);
      } catch (directError: any) {
        console.error('Direct upload failed', directError);
        
        let errorMsg = 'Direct upload to Flussonic failed. ';
        if (window.location.protocol === 'https:' && cleanServerUrl.startsWith('http:')) {
          errorMsg += 'This is likely due to "Mixed Content" (App is HTTPS, Flussonic is HTTP). Please use HTTPS for your Flussonic server URL or access the app via HTTP.';
        } else if (directError.code === 'ERR_NETWORK') {
          errorMsg += 'Network error. Please ensure the Flussonic server URL is accessible from your browser and CORS is enabled.';
        } else {
          errorMsg += directError.message || 'Unknown error';
        }
        
        // Fallback to chunked upload if direct upload fails
        console.log('Falling back to chunked upload...');
        
        try {
          const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
          const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
          
          // 1. Init chunked upload
          const initRes = await axios.post(`/api/vods/${managingFilesFor.id}/files/init-chunked`, {
            filename: file.name,
            totalChunks
          });
          const { uploadId } = initRes.data;

          // 2. Upload chunks
          for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);
            
            const chunkFormData = new FormData();
            chunkFormData.append('chunk', chunk);
            chunkFormData.append('uploadId', uploadId);
            chunkFormData.append('chunkIndex', i.toString());
            
            await axios.post(`/api/vods/${managingFilesFor.id}/files/chunk`, chunkFormData, {
              onUploadProgress: (progressEvent) => {
                const chunkProgress = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 1));
                const overallProgress = Math.round(((i * 100) + chunkProgress) / totalChunks);
                setUploadProgress(overallProgress);
              }
            });
          }

          // 3. Complete chunked upload
          await axios.post(`/api/vods/${managingFilesFor.id}/files/complete-chunked`, {
            uploadId,
            filename: file.name,
            totalChunks,
            size: file.size
          });

          fetchVodFiles(managingFilesFor.id);
        } catch (chunkError: any) {
          console.error('Chunked upload fallback failed', chunkError);
          const finalError = chunkError.response?.data?.error || chunkError.message || 'Failed to upload file';
          alert(`${errorMsg}\n\nFallback also failed: ${finalError}`);
        }
      }
    } catch (error: any) {
      console.error('Failed to upload file', error);
      const errorMsg = error.response?.data?.error || error.message || 'Failed to upload file';
      alert(errorMsg);
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      if (e.target) e.target.value = '';
    }
  };

  const handleDeleteFile = async (filename: string) => {
    if (!managingFilesFor || !confirm(`Are you sure you want to delete ${filename}?`)) return;
    
    try {
      await axios.delete(`/api/vods/${managingFilesFor.id}/files/${encodeURIComponent(filename)}`);
      fetchVodFiles(managingFilesFor.id);
    } catch (error: any) {
      console.error('Failed to delete file', error);
      alert(error.response?.data?.error || 'Failed to delete file');
    }
  };

  const handleSync = async (id: number) => {
    setSyncingId(id);
    try {
      const res = await axios.post(`/api/vods/${id}/sync`);
      if (res.data.deleted) {
        alert('VOD no longer exists on Flussonic and has been removed locally.');
      }
      fetchData();
    } catch (error) {
      console.error('Failed to sync VOD', error);
      alert('Failed to sync VOD with Flussonic.');
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
      alert(`Sync complete! Added ${totalAdded} and removed ${totalRemoved} VODs from servers.`);
      fetchData();
    } catch (error) {
      console.error('Sync failed', error);
      alert('Failed to sync VODs.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {managingFilesFor && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="p-6 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/50">
              <div>
                <h3 className="text-xl font-bold text-white flex items-center gap-2">
                  <FileVideo className="text-emerald-400" />
                  Manage Files: {managingFilesFor.name}
                </h3>
                <p className="text-sm text-zinc-400 mt-1">Upload and manage video files for this VOD location.</p>
              </div>
              <button 
                onClick={() => setManagingFilesFor(null)}
                className="text-zinc-500 hover:text-white transition-colors p-2 hover:bg-zinc-800 rounded-lg"
              >
                <X size={24} />
              </button>
            </div>
            
            <div className="p-6 flex-1 overflow-y-auto">
              <div className="mb-6">
                <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-zinc-800 border-dashed rounded-xl cursor-pointer bg-zinc-900/50 hover:bg-zinc-800/50 hover:border-emerald-500/50 transition-all group">
                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    <Upload className="w-8 h-8 mb-3 text-zinc-500 group-hover:text-emerald-400 transition-colors" />
                    <p className="mb-2 text-sm text-zinc-400"><span className="font-semibold text-white">Click to upload</span> or drag and drop</p>
                    <p className="text-xs text-zinc-500">MP4, TS, MKV (Max 1000GB)</p>
                  </div>
                  <input 
                    type="file" 
                    className="hidden" 
                    accept="video/*"
                    onChange={handleFileUpload}
                    disabled={isUploading}
                  />
                </label>
                
                {isUploading && (
                  <div className="mt-4">
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-zinc-400">Uploading...</span>
                      <span className="text-emerald-400 font-medium">{uploadProgress}%</span>
                    </div>
                    <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
                      <div 
                        className="bg-emerald-500 h-2 rounded-full transition-all duration-300" 
                        style={{ width: `${uploadProgress}%` }}
                      ></div>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">Playlist</h4>
                  <button 
                    onClick={handleUpdatePlaylist}
                    disabled={isUploading || vodFiles.length === 0}
                    className="text-xs font-medium text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={12} />
                    Update Playlist
                  </button>
                </div>
                {vodFiles.length > 0 ? (
                  <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-xl">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 overflow-hidden">
                        <FileText size={16} className="text-emerald-400 flex-shrink-0" />
                        <span className="text-sm text-zinc-300 truncate font-mono">playlist.txt</span>
                      </div>
                      <button 
                        onClick={() => {
                          const url = `playlist://${managingFilesFor.name}/playlist.txt`;
                          navigator.clipboard.writeText(url);
                          alert('Copied to clipboard!');
                        }}
                        className="text-xs text-zinc-500 hover:text-white transition-colors"
                      >
                        Copy URL
                      </button>
                    </div>
                    <p className="text-[10px] text-zinc-500 mt-1 truncate font-mono">
                      playlist://{managingFilesFor.name}/playlist.txt
                    </p>
                  </div>
                ) : (
                  <div className="text-center py-4 text-zinc-500 bg-zinc-900/50 rounded-xl border border-zinc-800/50 text-xs">
                    Upload files to generate a playlist.
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">Uploaded Files</h4>
                  <button 
                    onClick={handleSyncVodFiles}
                    disabled={isUploading}
                    className="text-xs font-medium text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={12} className={isUploading ? 'animate-spin' : ''} />
                    Sync Files
                  </button>
                </div>
                {vodFiles.length === 0 ? (
                  <div className="text-center py-8 text-zinc-500 bg-zinc-900/50 rounded-xl border border-zinc-800/50">
                    No files uploaded yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {vodFiles.map((file) => (
                      <div key={file.id} className="flex items-center justify-between p-3 bg-zinc-950 border border-zinc-800 rounded-xl hover:border-zinc-700 transition-colors">
                        <div className="flex items-center gap-3 overflow-hidden">
                          <FileVideo size={16} className="text-blue-400 flex-shrink-0" />
                          <span className="text-sm text-zinc-300 truncate font-mono">{file.filename}</span>
                          <span className="text-xs text-zinc-500 flex-shrink-0">
                            {(file.size / (1024 * 1024)).toFixed(2)} MB
                          </span>
                        </div>
                        <button
                          onClick={() => handleDeleteFile(file.filename)}
                          className="text-zinc-500 hover:text-rose-400 p-1.5 hover:bg-zinc-900 rounded-lg transition-colors flex-shrink-0"
                          title="Delete file"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white flex items-center gap-2">
          <Folder className="text-zinc-400" />
          VOD Locations
        </h2>
        <div className="flex items-center gap-3">
          <button 
            onClick={handleSyncAll}
            disabled={isSubmitting || servers.length === 0}
            className="bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-lg font-medium flex items-center gap-2 transition-colors text-sm"
          >
            <RefreshCw size={16} className={isSubmitting ? 'animate-spin' : ''} />
            Sync
          </button>
          <button 
            onClick={startAdd}
            disabled={servers.length === 0}
            className="bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-lg font-medium flex items-center gap-2 transition-colors text-sm"
          >
            <Plus size={16} />
            Add VOD
          </button>
        </div>
      </div>

      {servers.length === 0 && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-xl flex items-center gap-3">
          <AlertCircle size={20} />
          <p className="text-sm">You need to add a server before you can configure VODs.</p>
        </div>
      )}

      {isAdding && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
          <h3 className="text-lg font-semibold text-white mb-4">{editingId ? 'Edit VOD Location' : 'Add New VOD Location'}</h3>
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
              <label className="block text-sm font-medium text-zinc-400 mb-1">VOD Name</label>
              <input 
                required
                type="text" 
                value={formData.name}
                onChange={e => setFormData({...formData, name: e.target.value})}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                placeholder="e.g. movies"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-zinc-400">Storage Paths</label>
                <button 
                  type="button" 
                  onClick={handleAddPath}
                  className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                >
                  <Plus size={14} /> Add Path
                </button>
              </div>
              <div className="space-y-2">
                {formData.paths.map((path, index) => (
                  <div key={index} className="flex gap-2">
                    <input 
                      required
                      type="text" 
                      value={path}
                      onChange={e => handlePathChange(index, e.target.value)}
                      className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                      placeholder="e.g. /storage/disk1 or s3://key:secret@host/bucket"
                    />
                    {formData.paths.length > 1 && (
                      <button 
                        type="button"
                        onClick={() => handleRemovePath(index)}
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
                {isSubmitting ? 'Saving...' : 'Save & Configure'}
              </button>
              <button type="button" onClick={() => { setIsAdding(false); setEditingId(null); }} className="bg-zinc-800 hover:bg-zinc-700 text-white px-6 py-2 rounded-xl font-medium transition-colors">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
        {vods.length === 0 ? (
          <div className="text-center py-8 text-zinc-500">
            No VOD locations configured yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-zinc-900 border-b border-zinc-800 text-zinc-400 text-sm">
                  <th className="px-6 py-4 font-medium">Name</th>
                  <th className="px-6 py-4 font-medium">Server</th>
                  <th className="px-6 py-4 font-medium">Paths</th>
                  <th className="px-6 py-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {vods.map((vod) => (
                  <tr key={vod.id} className="text-zinc-300 hover:bg-zinc-800/20 transition-colors">
                    <td className="px-6 py-4 font-medium flex items-center gap-3">
                      <Folder size={18} className="text-amber-400" />
                      {vod.name}
                    </td>
                    <td className="px-6 py-4 text-zinc-400">{vod.server_name}</td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-1 text-xs font-mono">
                        {vod.paths && vod.paths.map((path: string, i: number) => (
                          <div key={i} className="flex items-center gap-2 text-zinc-400" title="Storage Path">
                             <span className="truncate max-w-[300px]">{path}</span>
                          </div>
                        ))}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button 
                          onClick={() => handleSync(vod.id)}
                          disabled={syncingId === vod.id}
                          className="text-zinc-500 hover:text-emerald-400 transition-colors px-3 py-1.5 rounded-lg border border-zinc-800 hover:border-emerald-500/50 flex items-center gap-2 text-xs font-medium disabled:opacity-50"
                          title="Sync with Flussonic"
                        >
                          <RefreshCw size={14} className={syncingId === vod.id ? 'animate-spin' : ''} />
                          {syncingId === vod.id ? 'Syncing...' : 'Manual Sync'}
                        </button>
                        <button 
                          onClick={() => handleCopy(vod)}
                          className="text-zinc-500 hover:text-emerald-400 transition-colors p-2"
                          title="Copy Playlist URL"
                        >
                          {copiedId === vod.id ? <Check size={18} className="text-emerald-400" /> : <Copy size={18} />}
                        </button>
                        <button 
                          onClick={() => handleManageFiles(vod)}
                          className="text-zinc-500 hover:text-blue-400 transition-colors p-2"
                          title="Manage Files"
                        >
                          <FileVideo size={18} />
                        </button>
                        <button 
                          onClick={() => startEdit(vod)}
                          className="text-zinc-500 hover:text-blue-400 transition-colors p-2"
                          title="Edit VOD"
                        >
                          <Edit2 size={18} />
                        </button>
                        <button 
                          onClick={() => handleDelete(vod.id)}
                          className="text-zinc-500 hover:text-rose-400 transition-colors p-2"
                          title="Delete VOD"
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
    </div>
  );
}

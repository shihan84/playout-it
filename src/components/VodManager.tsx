import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Plus, Trash2, Folder, AlertCircle, RefreshCw, Edit2, FileVideo, Upload, X, Copy, Check, FileText, Search } from 'lucide-react';

export default function VodManager() {
  const [vods, setVods] = useState<any[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [formData, setFormData] = useState({ server_id: '', name: '', paths: [''] });
  const [searchQuery, setSearchQuery] = useState('');
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  
  const [managingFilesFor, setManagingFilesFor] = useState<any | null>(null);
  const [vodFiles, setVodFiles] = useState<any[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [playlistContent, setPlaylistContent] = useState<string | null>(null);
  const [showPlaylistContent, setShowPlaylistContent] = useState(false);
  const [isLoadingPlaylist, setIsLoadingPlaylist] = useState(false);
  const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' | 'info' } | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [fileToDeleteFilename, setFileToDeleteFilename] = useState<string | null>(null);

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
      showNotification(error.response?.data?.error || 'Failed to sync VOD files', 'error');
    } finally {
      setIsUploading(false);
    }
  };

  const handleUpdatePlaylist = async () => {
    if (!managingFilesFor) return;
    setIsUploading(true);
    try {
      await axios.post(`/api/vods/${managingFilesFor.id}/playlist/update`);
      showNotification('Playlist updated successfully!', 'success');
      // Refresh content if it's currently shown
      if (showPlaylistContent) {
        fetchPlaylistContent();
      }
    } catch (error: any) {
      console.error('Failed to update playlist', error);
      showNotification(error.response?.data?.error || 'Failed to update playlist', 'error');
    } finally {
      setIsUploading(false);
    }
  };

  const fetchPlaylistContent = async () => {
    if (!managingFilesFor) return;
    setIsLoadingPlaylist(true);
    try {
      const res = await axios.get(`/api/vods/${managingFilesFor.id}/playlist/content`);
      setPlaylistContent(res.data.content);
      setShowPlaylistContent(true);
    } catch (error: any) {
      console.error('Failed to fetch playlist content', error);
      showNotification(error.response?.data?.error || 'Failed to fetch playlist content', 'error');
    } finally {
      setIsLoadingPlaylist(false);
    }
  };

  const [uploadingFiles, setUploadingFiles] = useState<{ name: string, progress: number }[]>([]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0 || !managingFilesFor) return;
    
    const files = Array.from(e.target.files) as File[];
    setIsUploading(true);
    setUploadingFiles(files.map(f => ({ name: f.name, progress: 0 })));

    try {
      // 1. Get upload info from our backend
      const infoRes = await axios.get(`/api/vods/${managingFilesFor.id}/upload-info`);
      const { serverUrl, vodName, authHeader, altAuthHeader } = infoRes.data;
      const cleanServerUrl = serverUrl.replace(/\/$/, '');

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        // Update current file progress state
        setUploadingFiles(prev => prev.map((f, idx) => idx === i ? { ...f, progress: 0 } : f));
        setUploadProgress(0);

        const uploadUrl = `${cleanServerUrl}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}/storages/0/files/${file.name}`;
        
        const performDirectUpload = async (header: string) => {
          return await axios.put(uploadUrl, file, {
            headers: { 
              'Authorization': header,
              'Content-Type': file.type || 'application/octet-stream'
            },
            onUploadProgress: (progressEvent) => {
              const percentCompleted = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 1));
              setUploadProgress(percentCompleted);
              setUploadingFiles(prev => prev.map((f, idx) => idx === i ? { ...f, progress: percentCompleted } : f));
            }
          });
        };

        try {
          try {
            await performDirectUpload(authHeader);
          } catch (firstError: any) {
            if (firstError.response?.status === 403 && altAuthHeader) {
              await performDirectUpload(altAuthHeader);
            } else {
              throw firstError;
            }
          }

          await axios.post(`/api/vods/${managingFilesFor.id}/files/confirm-upload`, {
            filename: file.name,
            size: file.size
          });
        } catch (directError: any) {
          console.error(`Direct upload failed for ${file.name}, falling back to chunked`, directError);
          
          try {
            const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            
            const initRes = await axios.post(`/api/vods/${managingFilesFor.id}/files/init-chunked`, {
              filename: file.name,
              totalChunks
            });
            const { uploadId } = initRes.data;

            for (let j = 0; j < totalChunks; j++) {
              const start = j * CHUNK_SIZE;
              const end = Math.min(start + CHUNK_SIZE, file.size);
              const chunk = file.slice(start, end);
              
              const chunkFormData = new FormData();
              chunkFormData.append('chunk', chunk);
              chunkFormData.append('uploadId', uploadId);
              chunkFormData.append('chunkIndex', j.toString());
              
              await axios.post(`/api/vods/${managingFilesFor.id}/files/chunk`, chunkFormData, {
                onUploadProgress: (progressEvent) => {
                  const chunkProgress = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 1));
                  const overallProgress = Math.round(((j * 100) + chunkProgress) / totalChunks);
                  setUploadProgress(overallProgress);
                  setUploadingFiles(prev => prev.map((f, idx) => idx === i ? { ...f, progress: overallProgress } : f));
                }
              });
            }

            await axios.post(`/api/vods/${managingFilesFor.id}/files/complete-chunked`, {
              uploadId,
              filename: file.name,
              totalChunks,
              size: file.size
            });
          } catch (chunkError: any) {
            console.error(`Chunked upload fallback failed for ${file.name}`, chunkError);
            alert(`Failed to upload ${file.name}. Fallback also failed.`);
          }
        }
      }

      fetchVodFiles(managingFilesFor.id);
      showNotification('All files uploaded successfully!', 'success');
    } catch (error: any) {
      console.error('Failed to upload files', error);
      showNotification(error.response?.data?.error || error.message || 'Failed to upload files', 'error');
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      setUploadingFiles([]);
      if (e.target) e.target.value = '';
    }
  };

  const handleDeleteFile = async (filename: string) => {
    if (!managingFilesFor) return;
    
    try {
      await axios.delete(`/api/vods/${managingFilesFor.id}/files/${encodeURIComponent(filename)}`);
      showNotification(`File ${filename} deleted`, 'success');
      fetchVodFiles(managingFilesFor.id);
    } catch (error: any) {
      console.error('Failed to delete file', error);
      showNotification(error.response?.data?.error || 'Failed to delete file', 'error');
    } finally {
      setFileToDeleteFilename(null);
    }
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

  const filteredVods = vods.filter(vod => {
    const query = searchQuery.toLowerCase();
    return (
      vod.name.toLowerCase().includes(query) ||
      (vod.server_name && vod.server_name.toLowerCase().includes(query)) ||
      (vod.paths && vod.paths.some((p: string) => p.toLowerCase().includes(query)))
    );
  });

  const filteredFiles = vodFiles.filter(file => 
    file.filename.toLowerCase().includes(fileSearchQuery.toLowerCase())
  );

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
      showNotification(`Sync complete! Added ${totalAdded} and removed ${totalRemoved} VODs from servers.`, 'success');
      fetchData();
    } catch (error) {
      console.error('Sync failed', error);
      showNotification('Failed to sync VODs.', 'error');
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
                    multiple
                  />
                </label>
                
                {isUploading && (
                  <div className="mt-4 space-y-3">
                    {uploadingFiles.map((f, idx) => (
                      <div key={idx} className="animate-in fade-in slide-in-from-top-1">
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-zinc-400 truncate max-w-[200px]">{f.name}</span>
                          <span className="text-emerald-400 font-medium">{f.progress}%</span>
                        </div>
                        <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                          <div 
                            className="bg-emerald-500 h-1.5 rounded-full transition-all duration-300" 
                            style={{ width: `${f.progress}%` }}
                          ></div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">Playlist</h4>
                  <div className="flex items-center gap-3">
                    <button 
                      onClick={fetchPlaylistContent}
                      disabled={isUploading || vodFiles.length === 0 || isLoadingPlaylist}
                      className="text-xs font-medium text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors disabled:opacity-50"
                    >
                      {isLoadingPlaylist ? <RefreshCw size={12} className="animate-spin" /> : <FileText size={12} />}
                      View Content
                    </button>
                    <button 
                      onClick={handleUpdatePlaylist}
                      disabled={isUploading || vodFiles.length === 0}
                      className="text-xs font-medium text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors disabled:opacity-50"
                    >
                      <RefreshCw size={12} />
                      Update Playlist
                    </button>
                  </div>
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
                          const url = `playlist:///${managingFilesFor.name}/playlist.txt`;
                          navigator.clipboard.writeText(url);
                          showNotification('Copied to clipboard!', 'success');
                        }}
                        className="text-xs text-zinc-500 hover:text-white transition-colors"
                      >
                        Copy URL
                      </button>
                    </div>
                    <p className="text-[10px] text-zinc-500 mt-1 truncate font-mono">
                      playlist:///{managingFilesFor.name}/playlist.txt
                    </p>
                  </div>
                ) : (
                  <div className="text-center py-4 text-zinc-500 bg-zinc-900/50 rounded-xl border border-zinc-800/50 text-xs">
                    Upload files to generate a playlist.
                  </div>
                )}

                {showPlaylistContent && (
                  <div className="mt-4 p-4 bg-zinc-950 border border-zinc-800 rounded-xl animate-in fade-in slide-in-from-top-2">
                    <div className="flex items-center justify-between mb-2">
                      <h5 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">playlist.txt Content</h5>
                      <button 
                        onClick={() => setShowPlaylistContent(false)}
                        className="text-zinc-500 hover:text-white transition-colors"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <pre className="text-[11px] text-zinc-300 font-mono bg-black/50 p-3 rounded-lg overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap">
                      {playlistContent || 'Playlist is empty'}
                    </pre>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">Uploaded Files</h4>
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" size={14} />
                      <input
                        type="text"
                        placeholder="Search files..."
                        value={fileSearchQuery}
                        onChange={(e) => setFileSearchQuery(e.target.value)}
                        className="bg-zinc-950 border border-zinc-800 rounded-lg pl-8 pr-3 py-1 text-xs text-white focus:outline-none focus:border-emerald-500 transition-colors w-40"
                      />
                    </div>
                    <button 
                      onClick={handleSyncVodFiles}
                      disabled={isUploading}
                      className="text-xs font-medium text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors disabled:opacity-50"
                    >
                      <RefreshCw size={12} className={isUploading ? 'animate-spin' : ''} />
                      Sync Files
                    </button>
                  </div>
                </div>
                {filteredFiles.length === 0 ? (
                  <div className="text-center py-8 text-zinc-500 bg-zinc-900/50 rounded-xl border border-zinc-800/50">
                    {fileSearchQuery ? 'No files match your search.' : 'No files uploaded yet.'}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredFiles.map((file) => (
                      <div key={file.id} className="flex items-center justify-between p-3 bg-zinc-950 border border-zinc-800 rounded-xl hover:border-zinc-700 transition-colors">
                        <div className="flex items-center gap-3 overflow-hidden">
                          <FileVideo size={16} className="text-blue-400 flex-shrink-0" />
                          <span className="text-sm text-zinc-300 truncate font-mono">{file.filename}</span>
                          <span className="text-xs text-zinc-500 flex-shrink-0">
                            {(file.size / (1024 * 1024)).toFixed(2)} MB
                          </span>
                        </div>
                        <button
                          onClick={() => setFileToDeleteFilename(file.filename)}
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

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Folder className="text-zinc-400" />
            VOD Locations
          </h2>
          <div className="relative max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={18} />
            <input
              type="text"
              placeholder="Search VODs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-10 pr-4 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 transition-colors"
            />
          </div>
        </div>
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
        {filteredVods.length === 0 ? (
          <div className="text-center py-8 text-zinc-500">
            {searchQuery ? 'No VOD locations match your search.' : 'No VOD locations configured yet.'}
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
                {filteredVods.map((vod) => (
                  <tr key={vod.id} className="text-zinc-300 hover:bg-zinc-800/20 transition-colors">
                    <td className="px-6 py-4 font-medium flex items-center gap-3">
                      <Folder size={18} className="text-amber-400" />
                      {vod.name}
                    </td>
                    <td className="px-6 py-4 text-zinc-400">{vod.server_name || <span className="text-rose-400 italic">Deleted Server</span>}</td>
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
                          onClick={() => setDeleteConfirmId(vod.id)}
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

      {/* Notification Toast */}
      {notification && (
        <div className={`fixed bottom-4 right-4 px-6 py-3 rounded-xl shadow-2xl z-[60] flex items-center gap-3 animate-in slide-in-from-right-full duration-300 ${
          notification.type === 'success' ? 'bg-emerald-500 text-white' : 
          notification.type === 'error' ? 'bg-rose-500 text-white' : 
          'bg-blue-500 text-white'
        }`}>
          {notification.type === 'success' ? <Check size={20} /> : <AlertCircle size={20} />}
          <span className="font-medium">{notification.message}</span>
        </div>
      )}

      {/* VOD Deletion Confirmation Modal */}
      {deleteConfirmId && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-md w-full p-6 shadow-2xl">
            <div className="flex items-center gap-3 text-rose-400 mb-4">
              <AlertCircle size={24} />
              <h3 className="text-xl font-bold">Delete VOD Location?</h3>
            </div>
            <p className="text-zinc-400 mb-6">
              Are you sure you want to delete this VOD location? This will remove the configuration from Flussonic as well.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => handleDelete(deleteConfirmId)}
                className="flex-1 bg-rose-500 hover:bg-rose-600 text-white font-bold py-2 rounded-xl transition-colors"
              >
                Yes, Delete
              </button>
              <button
                onClick={() => setDeleteConfirmId(null)}
                className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white font-bold py-2 rounded-xl transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* File Deletion Confirmation Modal */}
      {fileToDeleteFilename && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-md w-full p-6 shadow-2xl">
            <div className="flex items-center gap-3 text-rose-400 mb-4">
              <AlertCircle size={24} />
              <h3 className="text-xl font-bold">Delete File?</h3>
            </div>
            <p className="text-zinc-400 mb-6">
              Are you sure you want to delete <span className="text-white font-mono">{fileToDeleteFilename}</span>?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => handleDeleteFile(fileToDeleteFilename)}
                className="flex-1 bg-rose-500 hover:bg-rose-600 text-white font-bold py-2 rounded-xl transition-colors"
              >
                Yes, Delete
              </button>
              <button
                onClick={() => setFileToDeleteFilename(null)}
                className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white font-bold py-2 rounded-xl transition-colors"
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

import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { 
  FileVideo, Upload, X, Trash2, RefreshCw, FileText, Search, 
  AlertCircle, Check, Copy, MoreVertical, ExternalLink, HardDrive, Play
} from 'lucide-react';

interface VodFileManagerProps {
  vod: any;
  onClose: () => void;
  showNotification: (message: string, type: 'success' | 'error' | 'info') => void;
}

export default function VodFileManager({ vod, onClose, showNotification }: VodFileManagerProps) {
  const [files, setFiles] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<{ name: string, progress: number }[]>([]);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [playlistContent, setPlaylistContent] = useState<string | null>(null);
  const [showPlaylistContent, setShowPlaylistContent] = useState(false);
  const [isLoadingPlaylist, setIsLoadingPlaylist] = useState(false);
  const [deleteConfirmFilename, setDeleteConfirmFilename] = useState<string | null>(null);
  const [playingFile, setPlayingFile] = useState<any | null>(null);

  useEffect(() => {
    fetchFiles();
  }, [vod.id]);

  const fetchFiles = async () => {
    setIsLoading(true);
    try {
      const res = await axios.get(`/api/vods/${vod.id}/files`);
      setFiles(res.data);
    } catch (error) {
      console.error('Failed to fetch VOD files', error);
      showNotification('Failed to load files', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSyncFiles = async () => {
    setIsLoading(true);
    try {
      await axios.post(`/api/vods/${vod.id}/files/sync`);
      fetchFiles();
      showNotification('Files synced with Flussonic', 'success');
    } catch (error: any) {
      console.error('Failed to sync VOD files', error);
      showNotification(error.response?.data?.error || 'Failed to sync VOD files', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdatePlaylist = async () => {
    setIsLoading(true);
    try {
      await axios.post(`/api/vods/${vod.id}/playlist/update`);
      showNotification('Playlist updated successfully!', 'success');
      if (showPlaylistContent) fetchPlaylistContent();
    } catch (error: any) {
      console.error('Failed to update playlist', error);
      showNotification(error.response?.data?.error || 'Failed to update playlist', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchPlaylistContent = async () => {
    setIsLoadingPlaylist(true);
    try {
      const res = await axios.get(`/api/vods/${vod.id}/playlist/content`);
      setPlaylistContent(res.data.content);
      setShowPlaylistContent(true);
    } catch (error: any) {
      console.error('Failed to fetch playlist content', error);
      showNotification(error.response?.data?.error || 'Failed to fetch playlist content', 'error');
    } finally {
      setIsLoadingPlaylist(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    
    const selectedFiles = Array.from(e.target.files) as File[];
    setIsUploading(true);
    setUploadingFiles(selectedFiles.map(f => ({ name: f.name, progress: 0 })));

    try {
      const infoRes = await axios.get(`/api/vods/${vod.id}/upload-info`);
      const { serverUrl, vodName, authHeader, altAuthHeader } = infoRes.data;
      const cleanServerUrl = serverUrl.replace(/\/$/, '');

      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        
        setUploadingFiles(prev => prev.map((f, idx) => idx === i ? { ...f, progress: 0 } : f));

        const uploadUrl = `${cleanServerUrl}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}/storages/0/files/${file.name}`;
        
        const performDirectUpload = async (header: string) => {
          return await axios.put(uploadUrl, file, {
            headers: { 
              'Authorization': header,
              'Content-Type': file.type || 'application/octet-stream'
            },
            onUploadProgress: (progressEvent) => {
              const percentCompleted = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 1));
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

          await axios.post(`/api/vods/${vod.id}/files/confirm-upload`, {
            filename: file.name,
            size: file.size
          });
        } catch (directError: any) {
          console.error(`Direct upload failed for ${file.name}, falling back to chunked`, directError);
          
          try {
            const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            
            const initRes = await axios.post(`/api/vods/${vod.id}/files/init-chunked`, {
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
              
              await axios.post(`/api/vods/${vod.id}/files/chunk`, chunkFormData, {
                onUploadProgress: (progressEvent) => {
                  const chunkProgress = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 1));
                  const overallProgress = Math.round(((j * 100) + chunkProgress) / totalChunks);
                  setUploadingFiles(prev => prev.map((f, idx) => idx === i ? { ...f, progress: overallProgress } : f));
                }
              });
            }

            await axios.post(`/api/vods/${vod.id}/files/complete-chunked`, {
              uploadId,
              filename: file.name,
              totalChunks,
              size: file.size
            });
          } catch (chunkError: any) {
            console.error(`Chunked upload fallback failed for ${file.name}`, chunkError);
            showNotification(`Failed to upload ${file.name}`, 'error');
          }
        }
      }

      fetchFiles();
      showNotification('All files uploaded successfully!', 'success');
    } catch (error: any) {
      console.error('Failed to upload files', error);
      showNotification(error.response?.data?.error || error.message || 'Failed to upload files', 'error');
    } finally {
      setIsUploading(false);
      setUploadingFiles([]);
      if (e.target) e.target.value = '';
    }
  };

  const handleDeleteFile = async (filename: string) => {
    try {
      await axios.delete(`/api/vods/${vod.id}/files/${encodeURIComponent(filename)}`);
      showNotification(`File ${filename} deleted`, 'success');
      fetchFiles();
    } catch (error: any) {
      console.error('Failed to delete file', error);
      showNotification(error.response?.data?.error || 'Failed to delete file', 'error');
    } finally {
      setDeleteConfirmFilename(null);
    }
  };

  const filteredFiles = files.filter(file => 
    file.filename.toLowerCase().includes(fileSearchQuery.toLowerCase())
  );

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-hidden">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="p-6 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/50">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center">
              <FileVideo className="text-emerald-400" size={24} />
            </div>
            <div>
              <h3 className="text-xl font-bold text-white flex items-center gap-2">
                {vod.name}
              </h3>
              <div className="flex items-center gap-3 text-xs text-zinc-500 mt-1">
                <span className="flex items-center gap-1"><HardDrive size={12} /> {vod.server_name}</span>
                <span>•</span>
                <span>{files.length} files</span>
              </div>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="text-zinc-500 hover:text-white transition-colors p-2 hover:bg-zinc-800 rounded-lg"
          >
            <X size={24} />
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Upload Area */}
          <section>
            <label className={`flex flex-col items-center justify-center w-full h-40 border-2 border-zinc-800 border-dashed rounded-2xl cursor-pointer bg-zinc-950/50 hover:bg-zinc-800/30 hover:border-emerald-500/50 transition-all group ${isUploading ? 'opacity-50 cursor-not-allowed' : ''}`}>
              <div className="flex flex-col items-center justify-center pt-5 pb-6">
                <div className="w-12 h-12 rounded-full bg-zinc-900 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                  <Upload className="w-6 h-6 text-zinc-500 group-hover:text-emerald-400 transition-colors" />
                </div>
                <p className="mb-2 text-sm text-zinc-400"><span className="font-semibold text-white">Click to upload</span> or drag and drop</p>
                <p className="text-xs text-zinc-500">Supports large video files up to 1TB</p>
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
            
            {uploadingFiles.length > 0 && (
              <div className="mt-4 p-4 bg-zinc-950 rounded-xl border border-zinc-800 space-y-3">
                <h4 className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Active Uploads</h4>
                {uploadingFiles.map((f, idx) => (
                  <div key={idx} className="animate-in fade-in slide-in-from-top-1">
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-zinc-300 truncate max-w-[300px]">{f.name}</span>
                      <span className="text-emerald-400 font-mono font-bold">{f.progress}%</span>
                    </div>
                    <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
                      <div 
                        className={`h-full rounded-full transition-all duration-300 ${f.progress === 100 ? 'bg-emerald-500' : 'bg-emerald-400'}`}
                        style={{ width: `${f.progress}%` }}
                      ></div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Playlist Management */}
          <section className="bg-zinc-950 rounded-2xl border border-zinc-800 p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <FileText className="text-blue-400" size={18} />
                <h4 className="text-sm font-semibold text-white">VOD Playlist (playlist.txt)</h4>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={fetchPlaylistContent}
                  disabled={isLoading || files.length === 0 || isLoadingPlaylist}
                  className="px-3 py-1.5 text-xs font-medium bg-zinc-900 text-zinc-300 hover:text-white rounded-lg border border-zinc-800 transition-colors flex items-center gap-1.5"
                >
                  {isLoadingPlaylist ? <RefreshCw size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                  Preview Content
                </button>
                <button 
                  onClick={handleUpdatePlaylist}
                  disabled={isLoading || files.length === 0}
                  className="px-3 py-1.5 text-xs font-medium bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 rounded-lg border border-emerald-500/20 transition-colors flex items-center gap-1.5"
                >
                  <RefreshCw size={14} />
                  Update VOD Playlist
                </button>
              </div>
            </div>

            {files.length > 0 ? (
              <div className="flex flex-col md:flex-row md:items-center gap-4 bg-zinc-900/50 p-3 rounded-xl border border-zinc-800">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-zinc-500 uppercase tracking-widest font-bold mb-1">Playlist URL</p>
                  <code className="text-sm text-emerald-400 font-mono break-all inline-block">
                    playlist:///{vod.name}/playlist.txt
                  </code>
                </div>
                <button 
                  onClick={() => {
                    navigator.clipboard.writeText(`playlist:///${vod.name}/playlist.txt`);
                    showNotification('Copied to clipboard!', 'success');
                  }}
                  className="shrink-0 p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-all"
                  title="Copy URL"
                >
                  <Copy size={18} />
                </button>
              </div>
            ) : (
              <div className="text-center py-4 text-zinc-500 border border-zinc-800 border-dashed rounded-xl text-xs bg-zinc-900/20">
                Generate a playlist by uploading some video files first.
              </div>
            )}

            {showPlaylistContent && (
              <div className="mt-4 p-4 bg-black/40 rounded-xl border border-zinc-800 animate-in slide-in-from-top-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider">playlist.txt Content</span>
                  <button onClick={() => setShowPlaylistContent(false)} className="text-zinc-500 hover:text-white">
                    <X size={16} />
                  </button>
                </div>
                <pre className="text-xs text-zinc-300 font-mono bg-black/60 p-4 rounded-lg overflow-auto max-h-48 whitespace-pre">
                  {playlistContent || 'Playlist is empty'}
                </pre>
              </div>
            )}
          </section>

          {/* Files List */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileVideo className="text-zinc-400" size={18} />
                <h4 className="text-sm font-semibold text-white">Files on Storage ({files.length})</h4>
              </div>
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={14} />
                  <input
                    type="text"
                    placeholder="Search files..."
                    value={fileSearchQuery}
                    onChange={(e) => setFileSearchQuery(e.target.value)}
                    className="bg-zinc-950 border border-zinc-800 rounded-xl pl-9 pr-4 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500 transition-colors w-48"
                  />
                </div>
                <button 
                  onClick={handleSyncFiles}
                  disabled={isLoading}
                  className="p-1.5 text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800 rounded-lg transition-all"
                  title="Sync with storage"
                >
                  <RefreshCw size={18} className={isLoading ? 'animate-spin' : ''} />
                </button>
              </div>
            </div>

            <div className="grid gap-3">
              {filteredFiles.length === 0 ? (
                <div className="text-center py-12 bg-zinc-950/50 border border-zinc-800 border-dashed rounded-2xl flex flex-col items-center">
                  <div className="w-16 h-16 rounded-full bg-zinc-900 flex items-center justify-center mb-4">
                    <FileVideo size={32} className="text-zinc-700" />
                  </div>
                  <p className="text-zinc-500 text-sm">
                    {fileSearchQuery ? 'No files match your search' : 'No video files uploaded yet'}
                  </p>
                </div>
              ) : (
                filteredFiles.map((file) => (
                  <div key={file.id} className="group flex items-center justify-between p-4 bg-zinc-950 border border-zinc-800 rounded-xl hover:bg-zinc-900/50 hover:border-zinc-700 transition-all">
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="w-10 h-10 rounded-lg bg-blue-500/5 flex items-center justify-center shrink-0">
                        <FileVideo size={20} className="text-blue-400" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-zinc-200 truncate font-mono">{file.filename}</p>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded font-bold uppercase">
                            {file.filename.split('.').pop()}
                          </span>
                          <span className="text-xs text-zinc-500">{formatSize(file.size)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => setPlayingFile(file)}
                        className="p-2 text-zinc-500 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors"
                        title="Preview video"
                      >
                        <Play size={18} />
                      </button>
                      <button
                        onClick={() => setDeleteConfirmFilename(file.filename)}
                        className="p-2 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
                        title="Delete file"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>

      {/* Video Preview Modal */}
      {playingFile && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-4xl w-full overflow-hidden shadow-3xl animate-in fade-in zoom-in-95 duration-200">
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
              <h3 className="font-bold text-white flex items-center gap-2">
                <Play className="text-emerald-400" size={18} />
                Preview: {playingFile.filename}
              </h3>
              <button 
                onClick={() => setPlayingFile(null)}
                className="text-zinc-500 hover:text-white"
              >
                <X size={20} />
              </button>
            </div>
            <div className="aspect-video bg-black relative">
              <iframe 
                src={`${vod.server_url}/${vod.name}/${playingFile.filename}/embed.html?autoplay=true`}
                className="absolute inset-0 w-full h-full border-none"
                allowFullScreen
              />
            </div>
            <div className="p-4 bg-zinc-950 flex items-center justify-between">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">HLS Playback URL</span>
                <span className="text-xs text-zinc-300 font-mono">
                  {vod.server_url}/{vod.name}/{playingFile.filename}/index.m3u8
                </span>
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(`${vod.server_url}/${vod.name}/${playingFile.filename}/index.m3u8`);
                  showNotification('Copied HLS URL!', 'success');
                }}
                className="text-xs text-emerald-400 hover:border-emerald-400 border border-emerald-500/20 px-3 py-1.5 rounded-lg flex items-center gap-2 transition-all shrink-0"
              >
                <Copy size={14} /> Copy HLS URL
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Local Modal for Deletion Confirmation */}
      {deleteConfirmFilename && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-sm w-full p-6 shadow-3xl animate-in fade-in zoom-in-95 duration-200">
            <div className="w-12 h-12 rounded-full bg-rose-500/10 flex items-center justify-center mb-4 text-rose-500">
              <AlertCircle size={28} />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Delete this file?</h3>
            <p className="text-zinc-400 text-sm mb-6">
              This action will permanently delete <span className="text-white font-mono">{deleteConfirmFilename}</span> from the storage.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => handleDeleteFile(deleteConfirmFilename)}
                className="flex-1 bg-rose-500 hover:bg-rose-600 text-white font-bold py-2.5 rounded-xl transition-all"
              >
                Delete File
              </button>
              <button
                onClick={() => setDeleteConfirmFilename(null)}
                className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white font-bold py-2.5 rounded-xl transition-all"
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

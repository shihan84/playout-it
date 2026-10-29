import React, { useState, useRef } from 'react';
import axios from 'axios';
import {
  Upload, Trash2, GripVertical, Play, Shuffle, Repeat,
  Clock, FileVideo, ChevronUp, ChevronDown,
  Check, Copy, AlertCircle, Loader2, ListVideo, Radio,
  Plus, RefreshCw, HardDrive, FileText
} from 'lucide-react';

interface Video {
  id: number;
  name: string;
  size: number;
  duration: number;
  sort_order: number;
  created_at: string;
}

interface VodFile {
  name: string;
  size: number;
  type: string;
}

interface BroadcastPlaylistProps {
  streamId: number;
  streamName: string;
  serverUrl?: string;
  availableVods?: any[];
  selectedVodLocationId?: number | null;
  onVodLocationChange?: (id: number | null) => void;
  notification?: (msg: string, type?: 'success' | 'error') => void;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function calcTotalDuration(videos: Video[]): number {
  return videos.reduce((sum, v) => sum + (v.duration || 0), 0);
}

export default function BroadcastPlaylist({
  streamId, streamName, serverUrl,
  availableVods = [], selectedVodLocationId, onVodLocationChange,
  notification
}: BroadcastPlaylistProps) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<{ name: string; progress: number; status: 'pending' | 'uploading' | 'done' | 'error' }[]>([]);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [loopMode, setLoopMode] = useState<'loop' | 'once' | 'shuffle'>('loop');
  const [saving, setSaving] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [vodSearch, setVodSearch] = useState('');
  const [vodFiles, setVodFiles] = useState<VodFile[]>([]);
  const [vodFilesLoading, setVodFilesLoading] = useState(false);
  const [vodFilesLoaded, setVodFilesLoaded] = useState(false);
  const [showVodFiles, setShowVodFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load videos when first rendered
  React.useEffect(() => {
    loadVideos();
  }, [streamId]);

  const fetchVodFiles = async () => {
    setVodFilesLoading(true);
    try {
      const res = await axios.get(`/api/streams/${streamId}/vod-files`);
      setVodFiles(Array.isArray(res.data.files) ? res.data.files : []);
      setVodFilesLoaded(true);
      setShowVodFiles(true);
    } catch (e) {
      notification?.('Failed to fetch VOD files from Flussonic', 'error');
    } finally {
      setVodFilesLoading(false);
    }
  };

  const loadVideos = async () => {
    try {
      const res = await axios.get(`/api/streams/${streamId}/videos`);
      setVideos(Array.isArray(res.data) ? res.data : []);
      setLoaded(true);
    } catch (e) {
      console.error('Failed to load videos', e);
      setLoaded(true);
    }
  };

  // Probe video duration via HTML5 video element
  const probeDuration = (file: File): Promise<number> =>
    new Promise(resolve => {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(Math.floor(video.duration)); };
      video.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
      video.src = url;
    });

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    if (!files.length) return;
    e.target.value = '';

    const queue = files.map(f => ({ name: f.name, progress: 0, status: 'pending' as const }));
    setUploadQueue(queue);
    setIsUploading(true);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setUploadQueue(q => q.map((item, idx) => idx === i ? { ...item, status: 'uploading' } : item));
      try {
        const duration = await probeDuration(file);
        const formData = new FormData();
        formData.append('video', file);
        const res = await axios.post(`/api/streams/${streamId}/videos`, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: (e) => {
            const pct = Math.round((e.loaded * 100) / (e.total || 1));
            setUploadQueue(q => q.map((item, idx) => idx === i ? { ...item, progress: pct } : item));
          }
        });
        // Save duration if probed
        if (duration > 0 && res.data?.id) {
          await axios.patch(`/api/streams/${streamId}/videos/${res.data.id}/duration`, { duration }).catch(() => {});
        }
        setUploadQueue(q => q.map((item, idx) => idx === i ? { ...item, status: 'done', progress: 100 } : item));
      } catch (err: any) {
        setUploadQueue(q => q.map((item, idx) => idx === i ? { ...item, status: 'error' } : item));
        notification?.(err.response?.data?.error || `Failed to upload ${file.name}`, 'error');
      }
    }

    setIsUploading(false);
    setTimeout(() => setUploadQueue([]), 2000);
    loadVideos();
    notification?.('Upload complete. Playlist updated on Flussonic.', 'success');
  };

  // Drag and drop reorder
  const handleDragStart = (idx: number) => setDragIdx(idx);
  const handleDragOver = (e: React.DragEvent, idx: number) => { e.preventDefault(); setDragOverIdx(idx); };
  const handleDrop = async (e: React.DragEvent, dropIdx: number) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === dropIdx) { setDragIdx(null); setDragOverIdx(null); return; }
    const reordered = [...videos];
    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(dropIdx, 0, moved);
    setVideos(reordered);
    setDragIdx(null);
    setDragOverIdx(null);
    await saveOrder(reordered);
  };

  const moveItem = async (idx: number, dir: -1 | 1) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= videos.length) return;
    const reordered = [...videos];
    [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
    setVideos(reordered);
    await saveOrder(reordered);
  };

  const saveOrder = async (ordered: Video[]) => {
    setSaving(true);
    try {
      await axios.put(`/api/streams/${streamId}/videos/order`, { order: ordered.map(v => v.id) });
    } catch (e) {
      notification?.('Failed to save order', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (video: Video) => {
    try {
      await axios.delete(`/api/streams/${streamId}/videos/${encodeURIComponent(video.name)}`);
      setVideos(prev => prev.filter(v => v.id !== video.id));
      setDeleteConfirm(null);
      notification?.('Video removed from playlist', 'success');
    } catch (e: any) {
      notification?.(e.response?.data?.error || 'Failed to delete', 'error');
    }
  };

  const handleShuffle = async () => {
    const shuffled = [...videos].sort(() => Math.random() - 0.5);
    setVideos(shuffled);
    await saveOrder(shuffled);
    notification?.('Playlist shuffled', 'success');
  };

  const vodName = selectedVodLocationId
    ? (availableVods.find(v => v.id === selectedVodLocationId)?.name || `${streamName}_vod`)
    : `${streamName}_vod`;
  const playlistUrl = `playlist:///${vodName}/playlist.txt`;

  const copyUrl = () => {
    navigator.clipboard.writeText(playlistUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const filteredVideos = videos.filter(v => v.name.toLowerCase().includes(vodSearch.toLowerCase()));
  const totalDuration = calcTotalDuration(videos);

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="animate-spin text-emerald-400" size={28} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <ListVideo size={20} className="text-emerald-400" />
            Broadcast Playlist
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            {videos.length} clip{videos.length !== 1 ? 's' : ''} · Total {formatDuration(totalDuration)}
            {saving && <span className="ml-2 text-amber-400 animate-pulse">Saving…</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Loop mode toggle */}
          <div className="flex bg-zinc-800 rounded-xl p-1 gap-1">
            {([['loop', Repeat, 'Loop'], ['once', Play, 'Once'], ['shuffle', Shuffle, 'Shuffle']] as const).map(([mode, Icon, label]) => (
              <button
                key={mode}
                onClick={() => setLoopMode(mode)}
                title={label}
                className={`p-1.5 rounded-lg transition-colors ${loopMode === mode ? 'bg-emerald-500/20 text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                <Icon size={15} />
              </button>
            ))}
          </div>
          <button
            onClick={handleShuffle}
            disabled={videos.length < 2}
            title="Shuffle order"
            className="p-2 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-zinc-400 hover:text-white transition-colors disabled:opacity-40"
          >
            <Shuffle size={16} />
          </button>
          {/* Upload button */}
          <label className="relative cursor-pointer">
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,.mp4,.mov,.mkv,.ts,.m2ts,.mxf,.avi,.webm,.flv,.mpg,.mpeg"
              multiple
              onChange={handleFileSelect}
              disabled={isUploading}
              className="absolute inset-0 opacity-0 w-full h-full cursor-pointer disabled:cursor-not-allowed"
            />
            <span className={`flex items-center gap-2 px-4 py-2 rounded-xl font-medium text-sm transition-colors ${isUploading ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed' : 'bg-emerald-500 hover:bg-emerald-600 text-white cursor-pointer'}`}>
              <Upload size={16} />
              {isUploading ? 'Uploading…' : 'Add Clips'}
            </span>
          </label>
        </div>
      </div>

      {/* Upload progress queue */}
      {uploadQueue.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-2">
          <p className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3">Upload Queue</p>
          {uploadQueue.map((item, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="flex-shrink-0">
                {item.status === 'done' && <Check size={14} className="text-emerald-400" />}
                {item.status === 'error' && <AlertCircle size={14} className="text-rose-400" />}
                {(item.status === 'uploading' || item.status === 'pending') && (
                  <Loader2 size={14} className={`${item.status === 'uploading' ? 'animate-spin text-emerald-400' : 'text-zinc-600'}`} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-zinc-300 truncate">{item.name}</p>
                {item.status === 'uploading' && (
                  <div className="w-full bg-zinc-800 rounded-full h-1 mt-1">
                    <div className="bg-emerald-500 h-1 rounded-full transition-all" style={{ width: `${item.progress}%` }} />
                  </div>
                )}
              </div>
              <span className={`text-[10px] font-bold uppercase ${item.status === 'done' ? 'text-emerald-400' : item.status === 'error' ? 'text-rose-400' : 'text-zinc-500'}`}>
                {item.status === 'uploading' ? `${item.progress}%` : item.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* VOD Location selector */}
      {availableVods.length > 0 && (
        <div className="flex items-center gap-3">
          <label className="text-xs text-zinc-400 whitespace-nowrap">VOD Location:</label>
          <select
            value={selectedVodLocationId || ''}
            onChange={e => onVodLocationChange?.(e.target.value ? Number(e.target.value) : null)}
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500 transition-colors"
          >
            <option value="">{streamName} (Default)</option>
            {availableVods.filter(v => v.name !== streamName).map(v => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Search */}
      {videos.length > 4 && (
        <div className="relative">
          <input
            type="text"
            placeholder="Search clips…"
            value={vodSearch}
            onChange={e => setVodSearch(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-4 pr-4 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 transition-colors"
          />
        </div>
      )}

      {/* Playlist */}
      {videos.length === 0 ? (
        <div
          className="border-2 border-dashed border-zinc-700 rounded-2xl py-16 text-center cursor-pointer hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-all"
          onClick={() => fileInputRef.current?.click()}
        >
          <FileVideo size={48} className="mx-auto mb-4 text-zinc-700" />
          <p className="text-zinc-400 font-medium">Drop video files here or click to upload</p>
          <p className="text-xs text-zinc-600 mt-1">MP4, MKV, MOV, AVI supported</p>
        </div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[32px_24px_1fr_80px_80px_90px_80px] gap-0 px-4 py-2 border-b border-zinc-800 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
            <div></div>
            <div>#</div>
            <div>Filename</div>
            <div>Duration</div>
            <div>Size</div>
            <div>Added</div>
            <div className="text-right">Actions</div>
          </div>

          {/* Rows */}
          <div>
            {filteredVideos.map((video, idx) => (
              <div
                key={video.id}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={e => handleDragOver(e, idx)}
                onDrop={e => handleDrop(e, idx)}
                onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
                className={`grid grid-cols-[32px_24px_1fr_80px_80px_90px_80px] gap-0 px-4 py-3 items-center transition-all border-b border-zinc-800/50 last:border-0 ${
                  dragOverIdx === idx ? 'bg-emerald-500/10 border-emerald-500/30' : 'hover:bg-zinc-800/30'
                } ${dragIdx === idx ? 'opacity-40' : ''}`}
              >
                {/* Drag handle */}
                <div className="cursor-grab active:cursor-grabbing text-zinc-600 hover:text-zinc-400 transition-colors">
                  <GripVertical size={16} />
                </div>

                {/* Position */}
                <div className="text-xs font-mono text-zinc-600">{idx + 1}</div>

                {/* Filename */}
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center flex-shrink-0">
                    <FileVideo size={14} className="text-emerald-400" />
                  </div>
                  <span className="text-sm text-zinc-200 truncate font-medium">{video.name}</span>
                </div>

                {/* Duration */}
                <div className="text-xs text-zinc-400 flex items-center gap-1">
                  <Clock size={11} className="text-zinc-600" />
                  {formatDuration(video.duration)}
                </div>

                {/* Size */}
                <div className="text-xs text-zinc-500">{formatSize(video.size)}</div>

                {/* Date */}
                <div className="text-xs text-zinc-600">
                  {new Date(video.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-1">
                  <button
                    onClick={() => moveItem(idx, -1)}
                    disabled={idx === 0}
                    className="p-1 rounded text-zinc-600 hover:text-zinc-300 disabled:opacity-20 transition-colors"
                    title="Move up"
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    onClick={() => moveItem(idx, 1)}
                    disabled={idx === videos.length - 1}
                    className="p-1 rounded text-zinc-600 hover:text-zinc-300 disabled:opacity-20 transition-colors"
                    title="Move down"
                  >
                    <ChevronDown size={14} />
                  </button>
                  <button
                    onClick={() => setDeleteConfirm(video.id)}
                    className="p-1 rounded text-zinc-600 hover:text-rose-400 transition-colors"
                    title="Remove"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Footer summary */}
          <div className="px-4 py-3 bg-zinc-950/50 border-t border-zinc-800 flex items-center justify-between">
            <div className="flex items-center gap-4 text-xs text-zinc-500">
              <span className="flex items-center gap-1.5">
                <ListVideo size={12} /> {videos.length} clips
              </span>
              <span className="flex items-center gap-1.5">
                <Clock size={12} /> {formatDuration(totalDuration)} total
              </span>
              <span className="flex items-center gap-1.5">
                {loopMode === 'loop' && <><Repeat size={12} className="text-emerald-400" /> Looping</>}
                {loopMode === 'once' && <><Play size={12} className="text-amber-400" /> Play once</>}
                {loopMode === 'shuffle' && <><Shuffle size={12} className="text-purple-400" /> Shuffle</>}
              </span>
            </div>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors"
            >
              <Plus size={12} /> Add more
            </button>
          </div>
        </div>
      )}

      {/* VOD Files on Flussonic server */}
      <div className="bg-zinc-950 border border-zinc-800 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <p className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
            <HardDrive size={12} className="text-blue-400" /> Files on Flussonic Server
          </p>
          <button
            onClick={fetchVodFiles}
            disabled={vodFilesLoading}
            className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={vodFilesLoading ? 'animate-spin' : ''} />
            {vodFilesLoaded ? 'Refresh' : 'Fetch Files'}
          </button>
        </div>

        {showVodFiles && (
          <div>
            {vodFiles.length === 0 ? (
              <div className="text-center py-8 text-zinc-600 text-sm">No files found in VOD folder on server.</div>
            ) : (
              <div className="divide-y divide-zinc-800/50 max-h-64 overflow-y-auto">
                {vodFiles.map((f, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-900/50">
                    {f.name?.endsWith('.txt') || f.name?.endsWith('.m3u8')
                      ? <FileText size={14} className="text-amber-400 flex-shrink-0" />
                      : <FileVideo size={14} className="text-emerald-400 flex-shrink-0" />}
                    <span className="flex-1 text-sm text-zinc-300 font-mono truncate">{f.name}</span>
                    <span className="text-xs text-zinc-600 flex-shrink-0">{formatSize(f.size)}</span>
                    {f.name === 'playlist.txt' && (
                      <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-bold">PLAYLIST</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {!showVodFiles && !vodFilesLoading && (
          <div className="text-center py-6 text-zinc-600 text-xs">Click "Fetch Files" to view files stored on the Flussonic server.</div>
        )}
      </div>

      {/* Flussonic input URL */}
      <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4">
        <p className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-2">
          <Radio size={12} className="text-emerald-400" /> Flussonic Input URL
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 bg-zinc-900 border border-zinc-700 px-3 py-2 rounded-xl text-emerald-400 font-mono text-sm break-all">
            {playlistUrl}
          </code>
          <button
            onClick={copyUrl}
            className="flex-shrink-0 p-2 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-zinc-400 hover:text-white transition-colors"
            title="Copy"
          >
            {copiedUrl ? <Check size={16} className="text-emerald-400" /> : <Copy size={16} />}
          </button>
        </div>
        <p className="text-xs text-zinc-600 mt-2">
          <span className="font-mono text-zinc-400">playlist.txt</span> is stored inside the <span className="font-mono text-zinc-400">{vodName}</span> VOD folder (<span className="font-mono text-zinc-400">/storage/{vodName}/</span>). Each line is a bare filename — Flussonic resolves <span className="font-mono text-zinc-400">video.mp4</span> as <span className="font-mono text-zinc-400">/storage/{vodName}/video.mp4</span> via the <span className="font-mono text-zinc-400">{vodName}</span> VOD location.
        </p>
      </div>

      {/* Delete confirm modal */}
      {deleteConfirm !== null && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-sm p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-2">Remove Clip?</h3>
            <p className="text-zinc-400 text-sm mb-6">
              This will remove <span className="text-white font-medium">{videos.find(v => v.id === deleteConfirm)?.name}</span> from the playlist and delete it from the Flussonic VOD storage.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => { const v = videos.find(v => v.id === deleteConfirm); if (v) handleDelete(v); }}
                className="flex-1 bg-rose-500 hover:bg-rose-600 text-white px-4 py-2 rounded-xl font-medium transition-colors"
              >
                Remove
              </button>
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white px-4 py-2 rounded-xl font-medium transition-colors"
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

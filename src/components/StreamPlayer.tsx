import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { AlertCircle, Loader2, Maximize2, Volume2, VolumeX } from 'lucide-react';

interface StreamPlayerProps {
  serverUrl: string;
  streamName: string;
  sourceType?: string;
  status?: string;
  autoplay?: boolean;
}

export default function StreamPlayer({ serverUrl, streamName, sourceType, status, autoplay = true }: StreamPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [useEmbed, setUseEmbed] = useState(false);

  const base = serverUrl.replace(/\/$/, '');
  const hlsUrl = `${base}/${streamName}/index.m3u8`;
  const embedUrl = `${base}/${streamName}/embed.html?autoplay=true&mute=true${(sourceType === 'live' || sourceType === 'publish') ? '&realtime=true' : ''}`;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || useEmbed) return;

    setLoading(true);
    setError(null);

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: sourceType === 'live' || sourceType === 'publish',
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 4,
        maxBufferLength: 15,
        startLevel: -1,
      });

      hlsRef.current = hls;
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setLoading(false);
        if (autoplay) video.play().catch(() => {});
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setError('Stream unavailable');
            setLoading(false);
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            setError('Playback error');
            setLoading(false);
          }
        }
      });

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari)
      video.src = hlsUrl;
      video.onloadedmetadata = () => {
        setLoading(false);
        if (autoplay) video.play().catch(() => {});
      };
      video.onerror = () => {
        setError('Stream unavailable');
        setLoading(false);
      };
    } else {
      // Fallback to embed
      setUseEmbed(true);
      setLoading(false);
    }
  }, [hlsUrl, sourceType, autoplay, useEmbed]);

  const toggleMute = () => {
    const video = videoRef.current;
    if (video) {
      video.muted = !muted;
      setMuted(!muted);
    }
  };

  const openFullscreen = () => {
    const video = videoRef.current;
    if (video?.requestFullscreen) video.requestFullscreen();
  };

  if (useEmbed) {
    return (
      <div className="w-full aspect-video relative bg-zinc-900 rounded-lg overflow-hidden">
        <iframe
          src={embedUrl}
          width="100%"
          height="100%"
          frameBorder="0"
          allowFullScreen
          allow="autoplay; fullscreen"
          className="absolute inset-0"
        />
      </div>
    );
  }

  return (
    <div className="w-full aspect-video relative bg-zinc-950 rounded-lg overflow-hidden group">
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        muted={muted}
        playsInline
        autoPlay={autoplay}
      />

      {/* Loading overlay */}
      {loading && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950/90">
          <Loader2 size={32} className="animate-spin text-emerald-400 mb-2" />
          <p className="text-xs text-zinc-400">Connecting to stream...</p>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950/90 text-center px-4">
          <AlertCircle size={40} className="text-zinc-600 mb-3" />
          <p className="text-sm font-semibold text-zinc-400">{error}</p>
          <p className="text-xs text-zinc-600 mt-1">
            {status === 'offline' ? 'Stream is currently offline.' : 'Check Flussonic server connectivity.'}
          </p>
          <button
            onClick={() => { setError(null); setLoading(true); setUseEmbed(false); }}
            className="mt-3 text-xs text-emerald-400 hover:text-emerald-300 underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Controls overlay (visible on hover) */}
      {!loading && !error && (
        <div className="absolute bottom-0 left-0 right-0 px-3 py-2 flex items-center justify-between bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={toggleMute} className="text-white/80 hover:text-white transition-colors">
            {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-400 uppercase tracking-wider font-bold">
              {sourceType === 'publish' ? '📤 RTMP Push' : sourceType === 'live' ? '📡 Live' : sourceType === 'playlist' ? '📋 Playlist' : '📁 VOD'}
            </span>
            <button onClick={openFullscreen} className="text-white/80 hover:text-white transition-colors">
              <Maximize2 size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

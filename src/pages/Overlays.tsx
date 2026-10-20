import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Layers, Plus, Play, Square, Trash2, AlertTriangle, RotateCw } from 'lucide-react';

// P4 — Overlay profile editor + job control (P2 API).
// Shows a notice instead of breaking when the overlay module isn't deployed.

function fmt(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export default function Overlays() {
  const [profiles, setProfiles] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [streams, setStreams] = useState<any[]>([]);
  const [caps, setCaps] = useState<any>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    stream_id: 0, name: '', logo_path: '', logo_position: 'tr', logo_opacity: 1,
    ticker_enabled: false, ticker_text: '', ticker_position: 'bottom', ticker_speed: 100,
    ticker_font_size: 28, output_stream: '', output_url: '', auto_restart: false,
  });

  const load = useCallback(async () => {
    try {
      const [p, j, c] = await Promise.all([
        axios.get('/api/overlays'),
        axios.get('/api/overlays/jobs/list'),
        axios.get('/api/overlays/capabilities'),
      ]);
      setProfiles(Array.isArray(p.data) ? p.data : []);
      setJobs(Array.isArray(j.data) ? j.data : []);
      setCaps(c.data);
      setError('');
    } catch (e: any) {
      if (e.response?.status === 404 || e.response?.status === 403) {
        setUnavailable(true);
      } else {
        setError(e.response?.data?.error || e.message);
      }
    }
  }, []);

  useEffect(() => {
    load();
    axios.get('/api/my-streams').then(r => {
      const list = Array.isArray(r.data) ? r.data : [];
      setStreams(list);
      if (list.length) setForm(f => ({ ...f, stream_id: f.stream_id || list[0].id }));
    }).catch(() => {});
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const createProfile = async () => {
    setError('');
    try {
      await axios.post('/api/overlays', {
        stream_id: Number(form.stream_id),
        name: form.name,
        logo_path: form.logo_path || null,
        logo_position: form.logo_position,
        logo_opacity: Number(form.logo_opacity),
        ticker_enabled: form.ticker_enabled ? 1 : 0,
        ticker_text: form.ticker_text || null,
        ticker_position: form.ticker_position,
        ticker_speed: Number(form.ticker_speed),
        ticker_font_size: Number(form.ticker_font_size),
        output_stream: form.output_stream || null,
        output_url: form.output_url || null,
        auto_restart: form.auto_restart ? 1 : 0,
      });
      setForm({ ...form, name: '', logo_path: '', ticker_text: '' });
      load();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message);
    }
  };

  const startJob = async (id: number) => {
    try { await axios.post(`/api/overlays/${id}/start`); load(); }
    catch (e: any) { setError(e.response?.data?.error || e.message); }
  };

  const stopJob = async (id: number) => {
    try { await axios.post(`/api/overlays/jobs/${id}/stop`); load(); }
    catch (e: any) { setError(e.response?.data?.error || e.message); }
  };

  const retryJob = async (id: number) => {
    try { await axios.post(`/api/overlays/jobs/${id}/retry`); load(); }
    catch (e: any) { setError(e.response?.data?.error || e.message); }
  };

  const deleteProfile = async (id: number) => {
    try { await axios.delete(`/api/overlays/${id}`); load(); }
    catch (e: any) { setError(e.response?.data?.error || e.message); }
  };

  if (unavailable) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Layers className="text-emerald-500" /> Overlays
        </h1>
        <div className="bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-xl px-4 py-3 text-sm flex items-center gap-2">
          <AlertTriangle size={16} />
          The overlay module is not enabled on this deployment (requires the Phase 3 P2 backend and an armed OVERLAY_ENABLED setting).
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Layers className="text-emerald-500" /> Overlays
        </h1>
        {caps && (
          <span className="text-xs text-zinc-500">
            ffmpeg: {caps.ffmpeg ? 'available' : 'NOT FOUND'} · assets: {caps.asset_dir || '—'}
          </span>
        )}
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 text-sm">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Profile editor */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-white">New overlay profile</h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-zinc-500">Channel
              <select value={form.stream_id} onChange={e => setForm({ ...form, stream_id: Number(e.target.value) })}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-zinc-200">
                {streams.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="text-xs text-zinc-500">Profile name
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-zinc-200" />
            </label>
            <label className="text-xs text-zinc-500">Logo file (asset dir)
              <input value={form.logo_path} onChange={e => setForm({ ...form, logo_path: e.target.value })} placeholder="logo.png"
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-zinc-200" />
            </label>
            <label className="text-xs text-zinc-500">Logo position
              <select value={form.logo_position} onChange={e => setForm({ ...form, logo_position: e.target.value })}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-zinc-200">
                {['tl', 'tr', 'bl', 'br', 'custom'].map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="text-xs text-zinc-500">Opacity (0-1)
              <input type="number" step="0.1" min="0" max="1" value={form.logo_opacity}
                onChange={e => setForm({ ...form, logo_opacity: Number(e.target.value) })}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-zinc-200" />
            </label>
            <label className="text-xs text-zinc-500">Output stream
              <input value={form.output_stream} onChange={e => setForm({ ...form, output_stream: e.target.value })} placeholder="auto: <name>_ovr"
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-zinc-200" />
            </label>
            <label className="text-xs text-zinc-500">Publish URL (required to start)
              <input value={form.output_url} onChange={e => setForm({ ...form, output_url: e.target.value })} placeholder="rtmp(s)://, srt:// or udp:// destination"
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-zinc-200" />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={form.ticker_enabled} onChange={e => setForm({ ...form, ticker_enabled: e.target.checked })} />
            Enable scrolling ticker
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={form.auto_restart} onChange={e => setForm({ ...form, auto_restart: e.target.checked })} />
            Auto-restart worker on crash <span className="text-xs text-zinc-500">(bounded backoff; requires OVERLAY_AUTO_RESTART_ENABLED)</span>
          </label>
          {form.ticker_enabled && (
            <textarea rows={2} value={form.ticker_text} onChange={e => setForm({ ...form, ticker_text: e.target.value })}
              placeholder="Ticker text" className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-zinc-200" />
          )}
          <button onClick={createProfile} disabled={!form.name}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-medium px-4 py-2 rounded-xl">
            <Plus size={16} /> Create profile
          </button>
          <p className="text-xs text-zinc-600">Logo files must live inside the server's overlay asset dir. An explicit publish URL (rtmp/srt/udp) is required — output is always isolated from the source channel and credentials in URLs are redacted in the list.</p>
        </div>

        {/* Profiles + jobs */}
        <div className="space-y-6">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-white mb-3">Profiles</h2>
            {!profiles.length ? (
              <p className="text-zinc-500 text-sm">No overlay profiles.</p>
            ) : (
              <div className="divide-y divide-zinc-800">
                {profiles.map((p: any) => (
                  <div key={p.id} className="py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-zinc-200">{p.name} <span className="text-zinc-500">→ {p.stream_name}</span></p>
                      <p className="text-xs text-zinc-500">
                        {p.logo_path ? 'logo ' : ''}{p.ticker_enabled ? 'ticker ' : ''}out: {p.output_stream || 'auto'}{p.output_url ? ` → ${p.output_url}` : ' · no publish URL'}
                        {p.enabled ? '' : ' · disabled'}{p.auto_restart ? ' · auto-restart' : ''}
                      </p>
                    </div>
                    <button onClick={() => startJob(p.id)} className="text-emerald-400 hover:text-emerald-300" title="Start overlay"><Play size={16} /></button>
                    <button onClick={() => deleteProfile(p.id)} className="text-zinc-500 hover:text-red-400" title="Delete"><Trash2 size={16} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-white mb-3">Jobs</h2>
            {!jobs.length ? (
              <p className="text-zinc-500 text-sm">No overlay jobs.</p>
            ) : (
              <div className="divide-y divide-zinc-800 max-h-64 overflow-auto">
                {jobs.map((j: any) => (
                  <div key={j.id} className="py-2 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-zinc-200">#{j.id} {j.profile_name} → {j.stream_name}</p>
                      <p className="text-xs text-zinc-500">
                        {j.status}{j.last_error ? ` — ${j.last_error}` : ''} · {fmt(j.started_at || j.created_at)}
                        {j.restart_count ? ` · restart #${j.restart_count}` : ''}
                        {j.next_retry_at ? ` · retry at ${j.next_retry_at}` : ''}
                      </p>
                    </div>
                    {['starting', 'running'].includes(j.status) ? (
                      <button onClick={() => stopJob(j.id)} className="text-red-400 hover:text-red-300" title="Stop"><Square size={14} /></button>
                    ) : ['exited', 'failed'].includes(j.status) ? (
                      <button onClick={() => retryJob(j.id)} className="text-emerald-400 hover:text-emerald-300" title="Retry now"><RotateCw size={14} /></button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

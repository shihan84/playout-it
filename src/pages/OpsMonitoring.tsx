import { useState, useEffect } from 'react';
import axios from 'axios';
import { Activity, AlertTriangle, Radio, RefreshCw, Layers } from 'lucide-react';

// P4 — Broadcast monitoring board: per-channel health + playout progress,
// operational event feed, and recent job failures (P3 API).

function fmt(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function StatusDot({ status }: { status: string }) {
  const cls = status === 'online' || status === 'live' ? 'bg-emerald-400' :
    status === 'offline' ? 'bg-red-400' : 'bg-zinc-500';
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${cls}`} />;
}

export default function OpsMonitoring() {
  const [channels, setChannels] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [failures, setFailures] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [ch, ev, fl] = await Promise.all([
        axios.get('/api/monitoring/channels'),
        axios.get('/api/monitoring/events?limit=50'),
        axios.get('/api/monitoring/jobs/failures?limit=50'),
      ]);
      setChannels(Array.isArray(ch.data) ? ch.data : []);
      setEvents(Array.isArray(ev.data) ? ev.data : []);
      setFailures(Array.isArray(fl.data) ? fl.data : []);
      setError('');
    } catch (e: any) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Activity className="text-emerald-500" /> Broadcast Monitoring
        </h1>
        <button onClick={load} className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white px-3 py-2 rounded-xl hover:bg-zinc-800">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 text-sm">{error}</div>
      )}

      {/* Channel board */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {channels.map(ch => (
          <div key={ch.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white truncate flex items-center gap-2">
                <StatusDot status={ch.status} /> {ch.name}
              </h3>
              <span className="text-xs text-zinc-500 capitalize">{ch.lifecycle_state || ch.status}</span>
            </div>

            {ch.playout?.running && (
              <div>
                <div className="flex justify-between text-xs text-zinc-500 mb-1">
                  <span className="truncate">{ch.playout.running.inputs?.[0]?.url || `Job #${ch.playout.running.id}`}</span>
                  <span>{ch.playout.running.progress_pct}%</span>
                </div>
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.min(ch.playout.running.progress_pct, 100)}%` }} />
                </div>
              </div>
            )}

            <div className="flex items-center justify-between text-xs text-zinc-500">
              <span>Next: {ch.playout?.next ? fmt(ch.playout.next.start_at_utc) : '—'}</span>
              {ch.playout?.failures_24h > 0 && (
                <span className="flex items-center gap-1 text-red-400"><AlertTriangle size={12} /> {ch.playout.failures_24h} fail/24h</span>
              )}
            </div>

            {ch.overlay && (
              <div className="text-xs text-sky-400 flex items-center gap-1">
                <Layers size={12} /> overlay #{ch.overlay.id} {ch.overlay.status}
              </div>
            )}
          </div>
        ))}
        {!channels.length && !loading && (
          <div className="col-span-full text-zinc-500 text-sm flex items-center gap-2">
            <Radio size={16} /> No channels to display.
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Failures feed */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
            <AlertTriangle size={16} className="text-red-400" /> Recent job failures
          </h2>
          {!failures.length ? (
            <p className="text-zinc-500 text-sm">No failures recorded.</p>
          ) : (
            <div className="divide-y divide-zinc-800 max-h-80 overflow-auto">
              {failures.map((f: any, i: number) => (
                <div key={`${f.type}-${f.id}-${i}`} className="py-2">
                  <p className="text-xs text-zinc-300">
                    <span className="text-zinc-500">[{f.type}]</span> {f.stream_name || `stream #${f.stream_id}`} — <span className="text-red-400">{f.status}</span>
                  </p>
                  {f.last_error && <p className="text-xs text-zinc-500 truncate">{f.last_error}</p>}
                  <p className="text-[10px] text-zinc-600">{fmt(f.at)}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Event feed */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
            <Activity size={16} className="text-sky-400" /> Operational events
          </h2>
          {!events.length ? (
            <p className="text-zinc-500 text-sm">No events recorded.</p>
          ) : (
            <div className="divide-y divide-zinc-800 max-h-80 overflow-auto">
              {events.map((e: any, i: number) => (
                <div key={e.id || i} className="py-2">
                  <p className="text-xs text-zinc-300">{e.detail || `${e.from_state || '?'} → ${e.to_state}`}</p>
                  <p className="text-[10px] text-zinc-600">{fmt(e.created_at)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

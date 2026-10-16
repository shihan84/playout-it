import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Calendar, Plus, Trash2, Play, Clock, AlertTriangle, CheckCircle2, XCircle, SkipForward } from 'lucide-react';

// P4 — Scheduled playout operations page.
// Schedule editor + job list + now/next preview per channel.

const STATUS_STYLE: Record<string, { icon: any; cls: string }> = {
  scheduled: { icon: Clock, cls: 'text-sky-400' },
  swapping: { icon: Play, cls: 'text-amber-400' },
  running: { icon: Play, cls: 'text-emerald-400' },
  ending: { icon: Play, cls: 'text-emerald-400' },
  completed: { icon: CheckCircle2, cls: 'text-zinc-500' },
  skipped: { icon: SkipForward, cls: 'text-zinc-500' },
  cancelled: { icon: XCircle, cls: 'text-zinc-500' },
  failed: { icon: XCircle, cls: 'text-red-400' },
  restore_failed: { icon: AlertTriangle, cls: 'text-red-400' },
  restore_unverified: { icon: AlertTriangle, cls: 'text-amber-400' },
};

function fmt(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export default function Playout() {
  const [streams, setStreams] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [schedule, setSchedule] = useState<any>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ inputs: '', start_at: '', duration_sec: 300, timezone: 'UTC' });
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const u = localStorage.getItem('user');
    if (u) setUser(JSON.parse(u));
  }, []);
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    axios.get('/api/my-streams').then(r => {
      const list = Array.isArray(r.data) ? r.data : [];
      setStreams(list);
      if (list.length && !selected) setSelected(list[0]);
    }).catch(e => setError(e.response?.data?.error || e.message));
  }, []);

  const loadSchedule = useCallback(async (streamId: number) => {
    try {
      const prev = await axios.get(`/api/schedules/stream/${streamId}/next?hours=72`);
      setPreview(prev.data);
      if (isAdmin) {
        const all = await axios.get('/api/schedules');
        const sched = (all.data || []).find((s: any) => s.stream_id === streamId) || null;
        setSchedule(sched);
        if (sched) {
          const jb = await axios.get(`/api/schedules/${sched.id}/jobs`);
          setJobs(jb.data || []);
        } else setJobs([]);
      }
      setError('');
    } catch (e: any) {
      setSchedule(null);
      setJobs([]);
      if (e.response?.status !== 404 && e.response?.status !== 403) setError(e.response?.data?.error || e.message);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (selected) loadSchedule(selected.id);
  }, [selected, loadSchedule]);

  const ensureSchedule = async () => {
    if (schedule) return schedule;
    const res = await axios.post('/api/schedules', { stream_id: selected.id, name: `${selected.name} schedule`, timezone: form.timezone });
    return res.data;
  };

  const addJob = async () => {
    setError('');
    try {
      const sched = await ensureSchedule();
      const inputs = form.inputs.split('\n').map(s => s.trim()).filter(Boolean).map(url => ({ url }));
      if (!inputs.length) { setError('Enter at least one input URL'); return; }
      await axios.post(`/api/schedules/${sched.id}/jobs`, {
        kind: 'inputs', inputs, start_at: new Date(form.start_at).toISOString(), duration_sec: Number(form.duration_sec),
      });
      setForm({ ...form, inputs: '', start_at: '' });
      loadSchedule(selected.id);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message);
    }
  };

  const cancelJob = async (jobId: number) => {
    try {
      await axios.delete(`/api/schedules/jobs/${jobId}`);
      loadSchedule(selected.id);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Calendar className="text-emerald-500" /> Scheduled Playout
        </h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Channel picker */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase mb-3">Channel</h2>
          <div className="space-y-1 max-h-[60vh] overflow-auto">
            {streams.map(s => (
              <button key={s.id} onClick={() => setSelected(s)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${selected?.id === s.id ? 'bg-emerald-500/10 text-emerald-400' : 'text-zinc-300 hover:bg-zinc-800'}`}>
                {s.name}
              </button>
            ))}
            {!streams.length && <p className="text-zinc-500 text-sm">No channels available</p>}
          </div>
        </div>

        {/* Now / next + job editor */}
        <div className="lg:col-span-2 space-y-6">
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 text-sm">{error}</div>
          )}

          {selected && preview && (
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
                <h3 className="text-xs font-semibold text-zinc-500 uppercase mb-2">Now airing</h3>
                {preview.running?.length ? (
                  <>
                    <p className="text-emerald-400 font-medium">{preview.running[0].inputs?.[0]?.url || `Job #${preview.running[0].id}`}</p>
                    <p className="text-xs text-zinc-500 mt-1">until {fmt(preview.running[0].end_at_utc)}</p>
                  </>
                ) : <p className="text-zinc-500 text-sm">Nothing scheduled</p>}
              </div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
                <h3 className="text-xs font-semibold text-zinc-500 uppercase mb-2">Up next</h3>
                {preview.upcoming?.length ? (
                  <>
                    <p className="text-sky-400 font-medium">{preview.upcoming[0].inputs?.[0]?.url || `Job #${preview.upcoming[0].id}`}</p>
                    <p className="text-xs text-zinc-500 mt-1">starts {fmt(preview.upcoming[0].start_at_utc)}</p>
                  </>
                ) : <p className="text-zinc-500 text-sm">No upcoming job</p>}
              </div>
            </div>
          )}

          {selected && preview?.upcoming?.length > 1 && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
              <h3 className="text-sm font-semibold text-white mb-3">Upcoming (72h)</h3>
              <div className="divide-y divide-zinc-800">
                {preview.upcoming.slice(1).map((j: any) => (
                  <div key={j.id} className="py-2 flex items-center gap-4">
                    <Clock size={14} className="text-sky-400" />
                    <p className="text-xs text-zinc-400 flex-1 truncate">{j.inputs?.[0]?.url || `Job #${j.id}`}</p>
                    <p className="text-xs text-zinc-500">{fmt(j.start_at_utc)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isAdmin && selected && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-white">Schedule a playout job</h3>
              <textarea
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-zinc-200 focus:border-emerald-500 outline-none"
                rows={2} placeholder="Input URLs — one per line (e.g. playlist:///ch_vod/playlist.txt)"
                value={form.inputs} onChange={e => setForm({ ...form, inputs: e.target.value })} />
              <div className="flex gap-3 flex-wrap">
                <label className="text-xs text-zinc-500 flex-1 min-w-[200px]">
                  Start (local time)
                  <input type="datetime-local" value={form.start_at}
                    onChange={e => setForm({ ...form, start_at: e.target.value })}
                    className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-zinc-200" />
                </label>
                <label className="text-xs text-zinc-500 w-32">
                  Duration (s)
                  <input type="number" min={1} value={form.duration_sec}
                    onChange={e => setForm({ ...form, duration_sec: Number(e.target.value) })}
                    className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-zinc-200" />
                </label>
              </div>
              <button onClick={addJob}
                className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-4 py-2 rounded-xl transition-colors">
                <Plus size={16} /> Add job
              </button>
              <p className="text-xs text-zinc-600">Jobs swap the channel's Flussonic inputs for the window, then restore the original inputs. Scheduler must be enabled server-side.</p>
            </div>
          )}

          {/* Job list */}
          {isAdmin && selected && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
              <h3 className="text-sm font-semibold text-white mb-3">Jobs</h3>
              {!jobs.length ? (
                <p className="text-zinc-500 text-sm">No jobs for this channel.</p>
              ) : (
                <div className="divide-y divide-zinc-800">
                  {jobs.map((j: any) => {
                    const st = STATUS_STYLE[j.status] || STATUS_STYLE.scheduled;
                    const Icon = st.icon;
                    return (
                      <div key={j.id} className="py-3 flex items-center gap-4">
                        <Icon size={18} className={st.cls} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-zinc-200 truncate">{j.inputs?.[0]?.url || `Job #${j.id}`}</p>
                          <p className="text-xs text-zinc-500">{fmt(j.start_at_utc)} → {fmt(j.end_at_utc)} · {j.status}{j.last_error ? ` — ${j.last_error}` : ''}</p>
                        </div>
                        {isAdmin && ['scheduled', 'skipped', 'failed', 'restore_failed', 'restore_unverified'].includes(j.status) && (
                          <button onClick={() => cancelJob(j.id)} className="text-zinc-500 hover:text-red-400" title="Cancel job">
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

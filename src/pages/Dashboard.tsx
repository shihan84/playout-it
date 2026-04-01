import { useState, useEffect } from 'react';
import axios from 'axios';
import { Server, Radio, Activity, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import VodManager from '../components/VodManager';

export default function Dashboard() {
  const [stats, setStats] = useState({
    servers: 0,
    streams: 0,
    online: 0,
    offline: 0
  });
  const [recentStreams, setRecentStreams] = useState<any[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [serversRes, streamsRes] = await Promise.all([
          axios.get('/api/servers'),
          axios.get('/api/streams')
        ]);
        
        const servers = Array.isArray(serversRes.data) ? serversRes.data : [];
        const streams = Array.isArray(streamsRes.data) ? streamsRes.data : [];
        
        setStats({
          servers: servers.length,
          streams: streams.length,
          online: streams.filter((s: any) => s.status === 'online').length,
          offline: streams.filter((s: any) => s.status === 'offline').length,
        });
        
        setRecentStreams(streams.slice(0, 5));
      } catch (error) {
        console.error("Failed to fetch dashboard data", error);
      }
    };
    
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
            const streams = Array.isArray(message.data) ? message.data : [];
            setStats(prev => ({
              ...prev,
              streams: streams.length,
              online: streams.filter((s: any) => s.status === 'online').length,
              offline: streams.filter((s: any) => s.status === 'offline').length,
            }));
            setRecentStreams(streams.slice(0, 5));
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
    const interval = setInterval(fetchData, 10000);
    
    return () => {
      clearInterval(interval);
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null; // Prevent reconnect loop on unmount
        ws.close();
      }
    };
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">Dashboard</h1>
        <p className="text-zinc-400 mt-2">Overview of your Flussonic media infrastructure.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Servers" value={stats.servers} icon={Server} color="text-blue-400" />
        <StatCard title="Total Streams" value={stats.streams} icon={Radio} color="text-purple-400" />
        <StatCard title="Online Streams" value={stats.online} icon={CheckCircle2} color="text-emerald-400" />
        <StatCard title="Offline Streams" value={stats.offline} icon={XCircle} color="text-rose-400" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
          <h2 className="text-xl font-semibold text-white mb-4 flex items-center gap-2">
            <Activity className="text-zinc-400" />
            Recent Streams
          </h2>
          
          {recentStreams.length === 0 ? (
            <div className="text-center py-8 text-zinc-500">
              No streams configured yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-400 text-sm">
                    <th className="pb-3 font-medium">Name</th>
                    <th className="pb-3 font-medium">Server</th>
                    <th className="pb-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50">
                  {recentStreams.map((stream) => (
                    <tr key={stream.id} className="text-zinc-300">
                      <td className="py-4 font-medium">{stream.name}</td>
                      <td className="py-4 text-zinc-400">{stream.server_name || <span className="text-rose-400 italic text-xs">Deleted Server</span>}</td>
                      <td className="py-4">
                        <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
          <VodManager />
        </div>
      </div>
    </div>
  );
}

function StatCard({ title, value, icon: Icon, color }: any) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 flex items-center gap-4">
      <div className={`p-4 rounded-xl bg-zinc-800/50 ${color}`}>
        <Icon size={24} />
      </div>
      <div>
        <p className="text-sm font-medium text-zinc-400">{title}</p>
        <p className="text-3xl font-bold text-white mt-1">{value}</p>
      </div>
    </div>
  );
}

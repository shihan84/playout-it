import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { FileVideo, HardDrive, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function VodSummary() {
  const [vods, setVods] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchVods = async () => {
      try {
        const res = await axios.get('/api/vods');
        setVods(Array.isArray(res.data) ? res.data : []);
      } catch (error) {
        console.error('Failed to fetch VODs', error);
      } finally {
        setLoading(false);
      }
    };
    fetchVods();
  }, []);

  if (loading) {
    return <div className="animate-pulse flex flex-col gap-4">
      <div className="h-20 bg-zinc-800/50 rounded-xl"></div>
      <div className="h-20 bg-zinc-800/50 rounded-xl"></div>
    </div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white flex items-center gap-2">
          <FileVideo className="text-zinc-400" />
          VOD Locations
        </h2>
        <Link to="/vods" className="text-xs text-emerald-400 hover:text-emerald-300 font-bold flex items-center gap-1 transition-colors">
          Manage All <ArrowRight size={14} />
        </Link>
      </div>

      <div className="grid gap-3">
        {vods.length === 0 ? (
          <div className="text-center py-8 text-zinc-500 bg-zinc-950/50 rounded-xl border border-zinc-800/50 border-dashed">
            No VOD locations configured.
          </div>
        ) : (
          vods.slice(0, 3).map((vod) => (
            <div key={vod.id} className="p-4 bg-zinc-950 border border-zinc-800 rounded-xl flex items-center justify-between group hover:border-zinc-700 transition-colors">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-amber-500/10 rounded-xl text-amber-400">
                  <FileVideo size={20} />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-zinc-200">{vod.name}</h4>
                  <div className="flex items-center gap-2 text-[10px] text-zinc-500 mt-1 uppercase tracking-wider font-bold">
                    <HardDrive size={10} />
                    {vod.server_name}
                  </div>
                </div>
              </div>
              <Link 
                to="/vods" 
                className="opacity-0 group-hover:opacity-100 transition-opacity bg-zinc-800 hover:bg-zinc-700 p-2 rounded-lg text-zinc-400 hover:text-white"
              >
                <ArrowRight size={16} />
              </Link>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

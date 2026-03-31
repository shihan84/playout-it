import React from 'react';
import VodManager from '../components/VodManager';

export default function Vods() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">VOD Locations</h1>
        <p className="text-zinc-400 mt-2">Manage Video on Demand storage paths.</p>
      </div>
      <VodManager />
    </div>
  );
}

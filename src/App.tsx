import React from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Server, Radio, Settings, Folder } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

import Dashboard from './pages/Dashboard';
import Servers from './pages/Servers';
import Streams from './pages/Streams';
import Vods from './pages/Vods';
import AppSettings from './pages/Settings';

function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

function Sidebar() {
  const location = useLocation();
  
  const links = [
    { name: 'Dashboard', path: '/', icon: LayoutDashboard },
    { name: 'Servers', path: '/servers', icon: Server },
    { name: 'Streams', path: '/streams', icon: Radio },
    { name: 'VODs', path: '/vods', icon: Folder },
    { name: 'Settings', path: '/settings', icon: Settings },
  ];

  return (
    <div className="w-64 bg-zinc-900 text-zinc-300 flex flex-col h-screen border-r border-zinc-800">
      <div className="p-6">
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Radio className="text-emerald-500" />
          Flussonic Manager
        </h1>
      </div>
      <nav className="flex-1 px-4 space-y-2">
        {links.map((link) => {
          const Icon = link.icon;
          const isActive = location.pathname === link.path;
          return (
            <Link
              key={link.path}
              to={link.path}
              className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-xl transition-colors",
                isActive 
                  ? "bg-emerald-500/10 text-emerald-400 font-medium" 
                  : "hover:bg-zinc-800 hover:text-white"
              )}
            >
              <Icon size={20} />
              {link.name}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 font-sans">
      <Sidebar />
      <main className="flex-1 overflow-auto p-8 flex flex-col">
        <div className="max-w-6xl mx-auto flex-1 w-full">
          {children}
        </div>
        <footer className="mt-12 py-6 border-t border-zinc-900 text-center text-zinc-500 text-sm max-w-6xl mx-auto w-full">
          Itassist Broadcast Solution | Mumbai | Gurugram | Dubai
        </footer>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/servers" element={<Servers />} />
          <Route path="/streams" element={<Streams />} />
          <Route path="/vods" element={<Vods />} />
          <Route path="/settings" element={<AppSettings />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

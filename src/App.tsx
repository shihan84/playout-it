import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { LayoutDashboard, Server, Radio, Settings, Folder, Users, LogOut, Shield, Bell, Calendar, Activity, Layers } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import axios from 'axios';

import Dashboard from './pages/Dashboard';
import Servers from './pages/Servers';
import Streams from './pages/Streams';
import Vods from './pages/Vods';
import AppSettings from './pages/Settings';
import Login from './pages/Login';
import UserManagement from './pages/UserManagement';
import IpManagement from './pages/IpManagement';
import TelegramAlerts from './pages/TelegramAlerts';
import Playout from './pages/Playout';
import OpsMonitoring from './pages/OpsMonitoring';
import Overlays from './pages/Overlays';

function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const token = localStorage.getItem('token');
    const userData = localStorage.getItem('user');
    if (token && userData) {
      setUser(JSON.parse(userData));
    }
  }, []);

  const handleLogout = async () => {
    try {
      await axios.post('/api/auth/logout');
    } catch (error) {
      console.error('Logout error:', error);
    }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/login');
  };

  const links = [
    { name: 'Dashboard', path: '/', icon: LayoutDashboard },
    { name: 'Servers', path: '/servers', icon: Server, adminOnly: true },
    { name: 'Streams', path: '/streams', icon: Radio },
    { name: 'Playout', path: '/playout', icon: Calendar },
    { name: 'Monitoring', path: '/monitoring', icon: Activity, adminOnly: true },
    { name: 'Overlays', path: '/overlays', icon: Layers, adminOnly: true },
    { name: 'VODs', path: '/vods', icon: Folder, adminOnly: true },
    { name: 'Users', path: '/users', icon: Users, adminOnly: true },
    { name: 'IP Management', path: '/ip-management', icon: Shield },
    { name: 'Telegram Alerts', path: '/telegram-alerts', icon: Bell },
    { name: 'Settings', path: '/settings', icon: Settings, adminOnly: true },
  ];

  const filteredLinks = user?.role === 'admin' 
    ? links 
    : links.filter(link => !link.adminOnly);

  return (
    <div className="w-64 bg-zinc-900 text-zinc-300 flex flex-col h-screen border-r border-zinc-800">
      <div className="p-6">
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Radio className="text-emerald-500" />
          IBS Manager
        </h1>
      </div>
      <nav className="flex-1 px-4 space-y-2">
        {filteredLinks.map((link) => {
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
      <div className="p-4 border-t border-zinc-800">
        <div className="flex items-center gap-3 mb-4 px-2">
          <div className="w-8 h-8 bg-emerald-500/20 rounded-full flex items-center justify-center">
            <Users size={16} className="text-emerald-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white truncate">{user?.username || 'User'}</p>
            <p className="text-xs text-zinc-500 capitalize">{user?.role || 'client'}</p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-4 py-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-xl transition-colors text-sm"
        >
          <LogOut size={16} />
          Logout
        </button>
      </div>
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

function ProtectedRoutes() {
  const navigate = useNavigate();
  const token = localStorage.getItem('token');

  useEffect(() => {
    if (!token) {
      navigate('/login', { replace: true });
    }
  }, [token, navigate]);

  if (!token) return null;

  const userStr = localStorage.getItem('user');
  const currentUser = userStr ? JSON.parse(userStr) : null;
  const isAdmin = currentUser?.role === 'admin';

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/servers" element={isAdmin ? <Servers /> : <Navigate to="/" replace />} />
        <Route path="/streams" element={<Streams />} />
        <Route path="/playout" element={<Playout />} />
        <Route path="/monitoring" element={isAdmin ? <OpsMonitoring /> : <Navigate to="/" replace />} />
        <Route path="/overlays" element={isAdmin ? <Overlays /> : <Navigate to="/" replace />} />
        <Route path="/vods" element={isAdmin ? <Vods /> : <Navigate to="/" replace />} />
        <Route path="/users" element={isAdmin ? <UserManagement /> : <Navigate to="/" replace />} />
        <Route path="/ip-management" element={<IpManagement />} />
        <Route path="/telegram-alerts" element={<TelegramAlerts />} />
        <Route path="/settings" element={isAdmin ? <AppSettings /> : <Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  useEffect(() => {
    // Add axios interceptor to include token in requests
    const interceptor = axios.interceptors.request.use(
      (config) => {
        const token = localStorage.getItem('token');
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        config.headers['X-Requested-With'] = 'XMLHttpRequest';
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Add axios interceptor to handle 401 errors only (not 403)
    const responseInterceptor = axios.interceptors.response.use(
      (response) => response,
      (error) => {
        console.error('Axios error:', error.response?.status, error.config?.url);
        if (error.response?.status === 401) {
          console.log('401 error, redirecting to login');
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          window.location.href = '/login';
        }
        return Promise.reject(error);
      }
    );

    return () => {
      axios.interceptors.request.eject(interceptor);
      axios.interceptors.response.eject(responseInterceptor);
    };
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={<ProtectedRoutes />} />
      </Routes>
    </BrowserRouter>
  );
}

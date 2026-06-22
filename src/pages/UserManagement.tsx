import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Users, Plus, Trash2, Edit2, Shield, User as UserIcon, Key, AlertCircle, Check, X } from 'lucide-react';

export default function UserManagement() {
  const [users, setUsers] = useState<any[]>([]);
  const [streams, setStreams] = useState<any[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
  const [formData, setFormData] = useState({ username: '', password: '', email: '', role: 'client' });

  const showNotification = (message: string, type: 'success' | 'error') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

  useEffect(() => {
    fetchUsers();
    fetchStreams();
  }, []);

  const fetchUsers = async () => {
    try {
      const res = await axios.get('/api/users');
      setUsers(res.data);
    } catch (error) {
      console.error('Failed to fetch users', error);
    }
  };

  const fetchStreams = async () => {
    try {
      const res = await axios.get('/api/my-streams');
      setStreams(res.data);
    } catch (error) {
      console.error('Failed to fetch streams', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      if (editingUser) {
        await axios.put(`/api/users/${editingUser.id}`, formData);
        showNotification('User updated successfully', 'success');
      } else {
        await axios.post('/api/users', formData);
        showNotification('User created successfully', 'success');
      }
      setIsAdding(false);
      setEditingUser(null);
      setFormData({ username: '', password: '', email: '', role: 'client' });
      fetchUsers();
    } catch (error: any) {
      console.error('Failed to save user', error);
      showNotification(error.response?.data?.error || 'Failed to save user', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await axios.delete(`/api/users/${id}`);
      showNotification('User deleted successfully', 'success');
      fetchUsers();
    } catch (error: any) {
      console.error('Failed to delete user', error);
      showNotification(error.response?.data?.error || 'Failed to delete user', 'error');
    }
  };

  const handleAssignStream = async (userId: number, streamId: number) => {
    try {
      await axios.post(`/api/users/${userId}/streams`, { streamId });
      showNotification('Stream assigned successfully', 'success');
      fetchUsers();
    } catch (error: any) {
      console.error('Failed to assign stream', error);
      showNotification(error.response?.data?.error || 'Failed to assign stream', 'error');
    }
  };

  const handleRemoveStream = async (userId: number, streamId: number) => {
    try {
      await axios.delete(`/api/users/${userId}/streams/${streamId}`);
      showNotification('Stream removed successfully', 'success');
      fetchUsers();
    } catch (error: any) {
      console.error('Failed to remove stream', error);
      showNotification(error.response?.data?.error || 'Failed to remove stream', 'error');
    }
  };

  const getUserStreams = async (userId: number) => {
    try {
      const res = await axios.get(`/api/users/${userId}/streams`);
      return res.data;
    } catch (error) {
      console.error('Failed to fetch user streams', error);
      return [];
    }
  };

  const startEdit = (user: any) => {
    setEditingUser(user);
    setFormData({
      username: user.username,
      password: '',
      email: user.email || '',
      role: user.role
    });
    setIsAdding(true);
  };

  return (
    <div className="space-y-8 max-w-6xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">User Management</h1>
        <p className="text-zinc-400 mt-2">Manage users and their stream access permissions.</p>
      </div>

      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Users size={18} />
          {users.length} users
        </div>
        <button
          onClick={() => { setIsAdding(true); setEditingUser(null); setFormData({ username: '', password: '', email: '', role: 'client' }); }}
          className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-colors"
        >
          <Plus size={18} />
          Add User
        </button>
      </div>

      {/* Add/Edit User Modal */}
      {isAdding && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 w-full max-w-md shadow-3xl">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold text-white">{editingUser ? 'Edit User' : 'Add New User'}</h3>
              <button onClick={() => { setIsAdding(false); setEditingUser(null); }} className="text-zinc-500 hover:text-white">
                <X size={24} />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-400 mb-1">Username</label>
                <input
                  type="text"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-400 mb-1">Password {editingUser && '(leave blank to keep current)'}</label>
                <input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500"
                  required={!editingUser}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-400 mb-1">Email</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-400 mb-1">Role</label>
                <select
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-emerald-500"
                >
                  <option value="client">Client</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div className="flex gap-3 pt-4">
                <button type="submit" disabled={isSubmitting} className="flex-1 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white py-2 rounded-xl font-medium">
                  {isSubmitting ? 'Saving...' : (editingUser ? 'Update' : 'Create')}
                </button>
                <button type="button" onClick={() => { setIsAdding(false); setEditingUser(null); }} className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white py-2 rounded-xl font-medium">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Stream Assignment Modal */}
      {selectedUser && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 w-full max-w-2xl shadow-3xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-xl font-bold text-white">Manage Stream Access</h3>
                <p className="text-zinc-400 text-sm mt-1">User: {selectedUser.username}</p>
              </div>
              <button onClick={() => setSelectedUser(null)} className="text-zinc-500 hover:text-white">
                <X size={24} />
              </button>
            </div>
            <div className="space-y-4">
              {streams.length === 0 ? (
                <div className="text-center py-8 text-zinc-500">No streams available</div>
              ) : (
                streams.map((stream) => (
                  <div key={stream.id} className="flex items-center justify-between p-4 bg-zinc-950 rounded-xl border border-zinc-800">
                    <div>
                      <p className="text-white font-medium">{stream.name}</p>
                      <p className="text-zinc-500 text-sm">{stream.server_name || 'No server'}</p>
                    </div>
                    <button
                      onClick={() => handleAssignStream(selectedUser.id, stream.id)}
                      className="bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 px-3 py-1 rounded-lg text-sm font-medium"
                    >
                      Assign
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Users List */}
      <div className="grid gap-4">
        {users.map((user) => (
          <div key={user.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-4">
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${user.role === 'admin' ? 'bg-rose-500/10' : 'bg-blue-500/10'}`}>
                  {user.role === 'admin' ? <Shield className="text-rose-400" size={24} /> : <UserIcon className="text-blue-400" size={24} />}
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">{user.username}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`text-xs px-2 py-1 rounded-full ${user.role === 'admin' ? 'bg-rose-500/20 text-rose-400' : 'bg-blue-500/20 text-blue-400'}`}>
                      {user.role}
                    </span>
                    {user.email && <span className="text-sm text-zinc-400">{user.email}</span>}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => startEdit(user)}
                  className="p-2 text-zinc-500 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                  title="Edit user"
                >
                  <Edit2 size={18} />
                </button>
                <button
                  onClick={() => setSelectedUser(user)}
                  className="p-2 text-zinc-500 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors"
                  title="Manage streams"
                >
                  <Key size={18} />
                </button>
                <button
                  onClick={() => handleDelete(user.id)}
                  className="p-2 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
                  title="Delete user"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Notification */}
      {notification && (
        <div className={`fixed bottom-4 right-4 px-6 py-3 rounded-xl shadow-2xl z-50 flex items-center gap-3 ${
          notification.type === 'success' ? 'bg-emerald-500 text-white' : 'bg-rose-500 text-white'
        }`}>
          {notification.type === 'success' ? <Check size={20} /> : <AlertCircle size={20} />}
          <span className="font-medium">{notification.message}</span>
        </div>
      )}
    </div>
  );
}

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { formatPhone, formatPhoneInput, stripPhone } from '../../utils/formatPhone';

const SOURCE_LABELS = { direct: 'Direct', thumbtack: 'Thumbtack', referral: 'Referral', website: 'Website' };

export default function ClientsDashboard() {
  const navigate = useNavigate();
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '', source: 'direct' });

  const fetchClients = useCallback(async () => {
    try {
      const params = {};
      if (search) params.search = search;
      const res = await api.get('/clients', { params });
      setClients(res.data);
    } catch (err) {
      console.error('Failed to fetch clients:', err);
    } finally { setLoading(false); }
  }, [search]);

  useEffect(() => { fetchClients(); }, [fetchClients]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setCreating(true);
    try {
      const res = await api.post('/clients', form);
      setClients(prev => [res.data, ...prev]);
      setForm({ name: '', email: '', phone: '', source: 'direct' });
      setShowCreate(false);
    } catch (err) {
      console.error('Failed to create client:', err);
    } finally { setCreating(false); }
  };

  const formatDate = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="page-container wide">
      <div className="flex-between mb-2">
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.2rem' }}>Clients</h1>
          <p className="text-muted text-small">Client relationships and lead management</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Cancel' : '+ New Client'}
        </button>
      </div>

      {showCreate && (
        <div className="card mb-2">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>Add New Client</h3>
          <form onSubmit={handleCreate}>
            <div className="two-col" style={{ gap: '1rem' }}>
              <div className="form-group">
                <label className="form-label">Name *</label>
                <input className="form-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="form-label">Email</label>
                <input className="form-input" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Phone</label>
                <input className="form-input" type="tel" value={formatPhoneInput(form.phone)} onChange={e => setForm(f => ({ ...f, phone: stripPhone(e.target.value) }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Source</label>
                <select className="form-select" value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value }))}>
                  {Object.entries(SOURCE_LABELS).map(([val, label]) => <option key={val} value={val}>{label}</option>)}
                </select>
              </div>
            </div>
            <button className="btn mt-1" type="submit" disabled={creating}>
              {creating ? 'Adding...' : 'Add Client'}
            </button>
          </form>
        </div>
      )}

      <div className="flex gap-1 mb-2" style={{ flexWrap: 'wrap' }}>
        <input
          className="form-input"
          style={{ maxWidth: '280px' }}
          placeholder="Search by name, email, or phone..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem' }}><div className="spinner" /></div>
      ) : clients.length === 0 ? (
        <div className="card" style={{ textAlign: 'center' }}>
          <p className="text-muted">No clients yet. Add one to get started!</p>
        </div>
      ) : (
        <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Source</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            {clients.map(c => (
              <tr key={c.id} onClick={() => navigate(`/admin/clients/${c.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/admin/clients/${c.id}`)} tabIndex={0} role="link" style={{ cursor: 'pointer' }}>
                <td><strong>{c.name}</strong></td>
                <td>{c.email || '—'}</td>
                <td>{formatPhone(c.phone)}</td>
                <td>{SOURCE_LABELS[c.source] || c.source}</td>
                <td>{formatDate(c.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

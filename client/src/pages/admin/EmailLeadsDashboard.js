import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import LeadImportModal from '../../components/LeadImportModal';

const LEAD_SOURCES = ['manual', 'csv_import', 'website', 'thumbtack', 'referral', 'instagram', 'facebook', 'google', 'other'];

export default function EmailLeadsDashboard() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [showImport, setShowImport] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', company: '', event_type: '', location: '', lead_source: 'manual', notes: '' });
  const [error, setError] = useState('');

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 50 };
      if (search) params.search = search;
      if (statusFilter) params.status = statusFilter;
      if (sourceFilter) params.lead_source = sourceFilter;
      const res = await api.get('/email-marketing/leads', { params });
      setLeads(res.data.leads);
      setTotal(res.data.total);
    } catch (err) {
      console.error('Error fetching leads:', err);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, sourceFilter, page]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreating(true);
    setError('');
    try {
      await api.post('/email-marketing/leads', form);
      setForm({ name: '', email: '', company: '', event_type: '', location: '', lead_source: 'manual', notes: '' });
      setShowCreate(false);
      fetchLeads();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create lead.');
    } finally {
      setCreating(false);
    }
  };

  const totalPages = Math.ceil(total / 50);

  return (
    <div className="em-leads">
      <div className="em-section-header">
        <div className="em-actions">
          <button className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>+ Add Lead</button>
          <button className="btn btn-secondary" onClick={() => setShowImport(true)}>Import CSV</button>
        </div>
      </div>

      {showCreate && (
        <form className="em-create-form" onSubmit={handleCreate}>
          <div className="em-form-grid">
            <input className="form-input" placeholder="Name *" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
            <input className="form-input" placeholder="Email *" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
            <input className="form-input" placeholder="Company" value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} />
            <input className="form-input" placeholder="Event Type" value={form.event_type} onChange={e => setForm({ ...form, event_type: e.target.value })} />
            <input className="form-input" placeholder="Location" value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} />
            <select className="form-input" value={form.lead_source} onChange={e => setForm({ ...form, lead_source: e.target.value })}>
              {LEAD_SOURCES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
          </div>
          <textarea className="form-input" placeholder="Notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} />
          {error && <p className="form-error">{error}</p>}
          <div className="em-form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={creating}>{creating ? 'Creating...' : 'Create Lead'}</button>
          </div>
        </form>
      )}

      <div className="em-filters">
        <input className="form-input em-search" placeholder="Search leads..." value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
        <select className="form-input em-filter-select" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }}>
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="unsubscribed">Unsubscribed</option>
          <option value="bounced">Bounced</option>
          <option value="complained">Complained</option>
        </select>
        <select className="form-input em-filter-select" value={sourceFilter} onChange={e => { setSourceFilter(e.target.value); setPage(1); }}>
          <option value="">All Sources</option>
          {LEAD_SOURCES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner" />Loading...</div>
      ) : leads.length === 0 ? (
        <div className="em-empty">No leads found. Add your first lead or import a CSV.</div>
      ) : (
        <>
          <table className="em-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Company</th>
                <th>Source</th>
                <th>Status</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {leads.map(lead => (
                <tr key={lead.id} onClick={() => navigate(`/admin/email-marketing/leads/${lead.id}`)} className="em-row-clickable">
                  <td>{lead.name}</td>
                  <td>{lead.email}</td>
                  <td>{lead.company || '—'}</td>
                  <td><span className="em-badge em-badge-source">{lead.lead_source?.replace('_', ' ')}</span></td>
                  <td><span className={`em-badge em-badge-${lead.status}`}>{lead.status}</span></td>
                  <td>{new Date(lead.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="em-pagination">
              <button className="btn btn-sm btn-secondary" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>Prev</button>
              <span>Page {page} of {totalPages} ({total} leads)</span>
              <button className="btn btn-sm btn-secondary" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>Next</button>
            </div>
          )}
        </>
      )}

      {showImport && <LeadImportModal onClose={() => setShowImport(false)} onImported={fetchLeads} />}
    </div>
  );
}

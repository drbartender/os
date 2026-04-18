import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { useToast } from '../../context/ToastContext';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';

const STATUS_LABELS = {
  pending: 'Pending',
  draft: 'Draft',
  submitted: 'Submitted',
  reviewed: 'Reviewed',
};
const STATUS_CLASSES = {
  pending: 'badge-inprogress',
  draft: 'badge-inprogress',
  submitted: 'badge-submitted',
  reviewed: 'badge-approved',
};

export default function DrinkPlansDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ client_name: '', client_email: '', event_date: '' });
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [copyMessage, setCopyMessage] = useState('');

  const fetchPlans = useCallback(async () => {
    try {
      const params = {};
      if (search) params.search = search;
      if (statusFilter) params.status = statusFilter;
      const res = await api.get('/drink-plans', { params });
      setPlans(res.data);
    } catch (err) {
      toast.error('Failed to load drink plans — try refreshing.');
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, toast]);

  useEffect(() => { fetchPlans(); }, [fetchPlans]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    if (!form.client_name.trim()) {
      setFieldErrors({ client_name: 'Client name is required.' });
      return;
    }
    setCreating(true);
    try {
      const res = await api.post('/drink-plans', form);
      setPlans(prev => [res.data, ...prev]);
      setForm({ client_name: '', client_email: '', event_date: '' });
      setShowCreate(false);
      toast.success('Drink plan created.');
    } catch (err) {
      setError(err.message || 'Failed to create plan.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setCreating(false);
    }
  };

  const copyLink = (token) => {
    const url = `${window.location.origin}/plan/${token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopyMessage(token);
      setTimeout(() => setCopyMessage(''), 2000);
    });
  };

  const formatDate = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="page-container wide">
      <div className="flex-between mb-2">
        <h1 style={{ fontFamily: 'var(--font-display)' }}>Drink Plans</h1>
        <button className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Cancel' : '+ New Plan'}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="card mb-2">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>
            Create New Drink Plan
          </h3>
          <form onSubmit={handleCreate}>
            <div className="two-col" style={{ gap: '1rem' }}>
              <div className="form-group">
                <label className="form-label">Client Name *</label>
                <input
                  className="form-input"
                  value={form.client_name}
                  onChange={(e) => setForm(f => ({ ...f, client_name: e.target.value }))}
                  placeholder="Jane Smith"
                  aria-invalid={!!fieldErrors?.client_name}
                  required
                />
                <FieldError error={fieldErrors?.client_name} />
              </div>
              <div className="form-group">
                <label className="form-label">Client Email</label>
                <input
                  className="form-input"
                  type="email"
                  value={form.client_email}
                  onChange={(e) => setForm(f => ({ ...f, client_email: e.target.value }))}
                  placeholder="jane@example.com"
                  aria-invalid={!!fieldErrors?.client_email}
                />
                <FieldError error={fieldErrors?.client_email} />
              </div>
              <div className="form-group">
                <label className="form-label">Event Date</label>
                <input
                  className="form-input"
                  type="date"
                  value={form.event_date}
                  onChange={(e) => setForm(f => ({ ...f, event_date: e.target.value }))}
                  aria-invalid={!!fieldErrors?.event_date}
                />
                <FieldError error={fieldErrors?.event_date} />
              </div>
            </div>
            <FormBanner error={error} fieldErrors={fieldErrors} />
            <button className="btn mt-1" type="submit" disabled={creating}>
              {creating ? 'Creating...' : 'Create Plan'}
            </button>
          </form>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-1 mb-2" style={{ flexWrap: 'wrap' }}>
        <input
          className="form-input"
          style={{ maxWidth: '280px' }}
          placeholder="Search by client, event, or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="form-select"
          style={{ maxWidth: '160px' }}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="draft">Draft</option>
          <option value="submitted">Submitted</option>
          <option value="reviewed">Reviewed</option>
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <div className="spinner" />
        </div>
      ) : plans.length === 0 ? (
        <div className="card" style={{ textAlign: 'center' }}>
          <p className="text-muted">No drink plans yet. Create one to get started!</p>
        </div>
      ) : (
        <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Event</th>
              <th>Date</th>
              <th>Package</th>
              <th>Status</th>
              <th>Link</th>
            </tr>
          </thead>
          <tbody>
            {plans.map(plan => (
              <tr key={plan.id} onClick={() => navigate(`/admin/drink-plans/${plan.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/admin/drink-plans/${plan.id}`)} tabIndex={0} role="link" style={{ cursor: 'pointer' }}>
                <td>
                  <strong>{plan.client_name || '—'}</strong>
                  {plan.client_email && <div className="text-muted text-small">{plan.client_email}</div>}
                </td>
                <td>{getEventTypeLabel({ event_type: plan.event_type, event_type_custom: plan.event_type_custom })}</td>
                <td>{formatDate(plan.event_date)}</td>
                <td>{plan.serving_type ? { full_bar: 'Full Bar', beer_wine: 'Beer & Wine', beer_wine_seltzer: 'Beer, Wine & Seltzer', non_alcoholic: 'Non-Alcoholic', mocktail: 'Mocktail' }[plan.serving_type] || plan.serving_type.replace(/_/g, ' ') : '—'}</td>
                <td>
                  <span className={`badge ${STATUS_CLASSES[plan.status] || ''}`}>
                    {STATUS_LABELS[plan.status] || plan.status}
                  </span>
                </td>
                <td>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={(e) => { e.stopPropagation(); copyLink(plan.token); }}
                  >
                    {copyMessage === plan.token ? 'Copied!' : 'Copy Link'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { formatPhone, formatPhoneInput, stripPhone } from '../../utils/formatPhone';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { useToast } from '../../context/ToastContext';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';

const STATUS_LABELS = {
  draft: 'Draft', sent: 'Sent', viewed: 'Viewed', modified: 'Modified',
  accepted: 'Accepted', deposit_paid: 'Deposit Paid', confirmed: 'Confirmed',
};
const STATUS_CLASSES = {
  draft: 'badge-inprogress', sent: 'badge-submitted', viewed: 'badge-submitted',
  modified: 'badge-inprogress', accepted: 'badge-approved', deposit_paid: 'badge-approved', confirmed: 'badge-approved',
};
const SOURCE_LABELS = { direct: 'Direct', thumbtack: 'Thumbtack', referral: 'Referral', website: 'Website' };

export default function ClientDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});

  useEffect(() => {
    api.get(`/clients/${id}`)
      .then(res => { setClient(res.data); setForm({ name: res.data.name, email: res.data.email || '', phone: res.data.phone || '', source: res.data.source || 'direct', notes: res.data.notes || '' }); })
      .catch(() => {
        toast.error('Failed to load client. Try refreshing.');
        navigate('/admin/clients');
      })
      .finally(() => setLoading(false));
  }, [id, navigate, toast]);

  const clearServerFieldError = (name) => {
    if (fieldErrors[name]) {
      setFieldErrors(fe => {
        const next = { ...fe };
        delete next[name];
        return next;
      });
    }
  };

  const handleSave = async () => {
    setError('');
    setFieldErrors({});
    setSaving(true);
    try {
      const res = await api.put(`/clients/${id}`, form);
      setClient(prev => ({ ...prev, ...res.data }));
      setEditing(false);
      toast.success('Client saved.');
    } catch (err) {
      setError(err.message || 'Failed to save client. Please try again.');
      setFieldErrors(err.fieldErrors || {});
    } finally { setSaving(false); }
  };

  const handleCancelEdit = () => {
    setError('');
    setFieldErrors({});
    setEditing(false);
    // Reset form to last-saved client values so a re-open doesn't keep stale edits
    if (client) {
      setForm({ name: client.name, email: client.email || '', phone: client.phone || '', source: client.source || 'direct', notes: client.notes || '' });
    }
  };

  const formatDate = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatCurrency = (amount) => {
    if (amount == null) return '—';
    return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  if (loading) return <div className="page-container" style={{ textAlign: 'center', padding: '3rem' }}><div className="spinner" /></div>;
  if (!client) return null;

  return (
    <div className="page-container wide">
      <div className="flex-between mb-2">
        <h1 style={{ fontFamily: 'var(--font-display)' }}>{client.name}</h1>
        <div className="flex gap-1">
          <button className="btn btn-secondary" onClick={() => navigate('/admin/clients')}>Back</button>
          <button className="btn btn-primary" onClick={() => navigate('/admin/proposals/new')}>+ New Proposal</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', alignItems: 'start' }}>
        {/* Client Info */}
        <div className="card">
          <div className="flex-between" style={{ marginBottom: '1rem' }}>
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>Client Info</h3>
            <button className="btn btn-sm btn-secondary" onClick={() => editing ? handleCancelEdit() : setEditing(true)}>
              {editing ? 'Cancel' : 'Edit'}
            </button>
          </div>
          {editing ? (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <div className="form-group">
                <label className="form-label">Name</label>
                <input
                  className="form-input"
                  value={form.name}
                  onChange={e => { setForm(f => ({ ...f, name: e.target.value })); clearServerFieldError('name'); }}
                  aria-invalid={!!fieldErrors?.name}
                />
                <FieldError error={fieldErrors?.name} />
              </div>
              <div className="form-group">
                <label className="form-label">Email</label>
                <input
                  className="form-input"
                  type="email"
                  value={form.email}
                  onChange={e => { setForm(f => ({ ...f, email: e.target.value })); clearServerFieldError('email'); }}
                  aria-invalid={!!fieldErrors?.email}
                />
                <FieldError error={fieldErrors?.email} />
              </div>
              <div className="form-group">
                <label className="form-label">Phone</label>
                <input
                  className="form-input"
                  type="tel"
                  value={formatPhoneInput(form.phone)}
                  onChange={e => { setForm(f => ({ ...f, phone: stripPhone(e.target.value) })); clearServerFieldError('phone'); }}
                  aria-invalid={!!fieldErrors?.phone}
                />
                <FieldError error={fieldErrors?.phone} />
              </div>
              <div className="form-group">
                <label className="form-label">Source</label>
                <select
                  className="form-select"
                  value={form.source}
                  onChange={e => { setForm(f => ({ ...f, source: e.target.value })); clearServerFieldError('source'); }}
                  aria-invalid={!!fieldErrors?.source}
                >
                  {Object.entries(SOURCE_LABELS).map(([val, label]) => <option key={val} value={val}>{label}</option>)}
                </select>
                <FieldError error={fieldErrors?.source} />
              </div>
              <div className="form-group">
                <label className="form-label">Notes</label>
                <textarea className="form-input" rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
              <FormBanner error={error} fieldErrors={fieldErrors} />
              <button className="btn btn-sm" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              <div><span className="text-muted text-small">Email</span><div>{client.email || '—'}</div></div>
              <div><span className="text-muted text-small">Phone</span><div>{formatPhone(client.phone)}</div></div>
              <div><span className="text-muted text-small">Source</span><div>{SOURCE_LABELS[client.source] || client.source}</div></div>
              <div><span className="text-muted text-small">Added</span><div>{formatDate(client.created_at)}</div></div>
              {client.notes && <div><span className="text-muted text-small">Notes</span><div>{client.notes}</div></div>}
            </div>
          )}
        </div>

        {/* Proposals */}
        <div className="card">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>Proposals</h3>
          {!client.proposals || client.proposals.length === 0 ? (
            <p className="text-muted text-small">No proposals yet.</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {client.proposals.map(p => (
                <div key={p.id}
                  onClick={() => navigate(`/admin/proposals/${p.id}`)}
                  style={{ padding: '0.75rem', borderRadius: '6px', border: '1px solid var(--cream-dark, #e8e0d4)', cursor: 'pointer' }}
                >
                  <div className="flex-between">
                    <div>
                      <strong>{p.client_name || `Proposal #${p.id}`}</strong>
                      <div className="event-subtitle">{getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}</div>
                    </div>
                    <span className={`badge ${STATUS_CLASSES[p.status] || ''}`}>{STATUS_LABELS[p.status] || p.status}</span>
                  </div>
                  <div className="text-muted text-small" style={{ marginTop: '0.3rem' }}>
                    {formatDate(p.event_date)} · {p.package_name || '—'} · {formatCurrency(p.total_price)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { PUBLIC_SITE_URL } from '../../utils/constants';
import { useToast } from '../../context/ToastContext';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import Toolbar from '../../components/adminos/Toolbar';
import { fmtDate } from '../../components/adminos/format';

const STATUS = {
  pending:   { label: 'Pending',   kind: 'warn' },
  draft:     { label: 'Draft',     kind: 'neutral' },
  submitted: { label: 'Submitted', kind: 'info' },
  reviewed:  { label: 'Reviewed',  kind: 'ok' },
};

const SERVING_LABEL = {
  full_bar: 'Full Bar',
  beer_wine: 'Beer & Wine',
  beer_wine_seltzer: 'Beer, Wine & Seltzer',
  non_alcoholic: 'Non-Alcoholic',
  mocktail: 'Mocktail',
};

export default function DrinkPlansDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ client_name: '', client_email: '', event_date: '' });
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [copyMessage, setCopyMessage] = useState('');

  const fetchPlans = useCallback(async () => {
    try {
      const res = await api.get('/drink-plans');
      setPlans(res.data || []);
    } catch (err) {
      toast.error('Failed to load drink plans — try refreshing.');
    } finally {
      setLoading(false);
    }
  }, [toast]);

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

  const copyLink = (e, token) => {
    e.stopPropagation();
    if (!token) return;
    const url = `${PUBLIC_SITE_URL}/plan/${token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopyMessage(token);
      setTimeout(() => setCopyMessage(''), 2000);
    });
  };

  const filtered = useMemo(() => plans.filter(p => {
    if (tab !== 'all' && p.status !== tab) return false;
    if (search) {
      const q = search.toLowerCase();
      const fields = [p.client_name, p.client_email, p.event_type].filter(Boolean).join(' ').toLowerCase();
      if (!fields.includes(q)) return false;
    }
    return true;
  }), [plans, tab, search]);

  const tabs = useMemo(() => ([
    { id: 'all',       label: 'All',       count: plans.length },
    { id: 'submitted', label: 'Submitted', count: plans.filter(p => p.status === 'submitted').length },
    { id: 'pending',   label: 'Pending',   count: plans.filter(p => p.status === 'pending').length },
    { id: 'reviewed',  label: 'Reviewed' },
  ]), [plans]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Drink Plans</div>
          <div className="page-subtitle">Potion Planning Lab submissions — review and convert into proposals.</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate(v => !v)}>
            <Icon name={showCreate ? 'x' : 'plus'} />{showCreate ? 'Cancel' : 'New plan'}
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: 'var(--gap)' }}>
          <div className="section-title" style={{ margin: 0, marginBottom: 12 }}>New drink plan</div>
          <form onSubmit={handleCreate}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.85rem' }}>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Client name *</div>
                <input className="input" value={form.client_name} onChange={e => setForm(f => ({ ...f, client_name: e.target.value }))} placeholder="Jane Smith" required aria-invalid={!!fieldErrors?.client_name} />
                <FieldError error={fieldErrors?.client_name} />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Client email</div>
                <input className="input" type="email" value={form.client_email} onChange={e => setForm(f => ({ ...f, client_email: e.target.value }))} placeholder="jane@example.com" aria-invalid={!!fieldErrors?.client_email} />
                <FieldError error={fieldErrors?.client_email} />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Event date</div>
                <input className="input" type="date" value={form.event_date} onChange={e => setForm(f => ({ ...f, event_date: e.target.value }))} aria-invalid={!!fieldErrors?.event_date} />
                <FieldError error={fieldErrors?.event_date} />
              </div>
            </div>
            <FormBanner error={error} fieldErrors={fieldErrors} />
            <div className="hstack" style={{ marginTop: 14, gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? 'Creating…' : 'Create plan'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => { setShowCreate(false); setForm({ client_name: '', client_email: '', event_date: '' }); setError(''); setFieldErrors({}); }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <Toolbar search={search} setSearch={setSearch} tabs={tabs} tab={tab} setTab={setTab} />

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Client</th>
                <th>Event</th>
                <th>Date</th>
                <th>Plan type</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && (<tr><td colSpan={6} className="muted">Loading…</td></tr>)}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={6} className="muted">No drink plans match these filters.</td></tr>
              )}
              {!loading && filtered.map(p => {
                const st = STATUS[p.status] || { label: p.status || '—', kind: 'neutral' };
                return (
                  <tr key={p.id} onClick={() => navigate(`/drink-plans/${p.id}`)}>
                    <td>
                      <strong>{p.client_name || '—'}</strong>
                      {p.client_email && <div className="sub">{p.client_email}</div>}
                    </td>
                    <td>{getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}</td>
                    <td>{p.event_date ? fmtDate(String(p.event_date).slice(0, 10), { year: 'numeric' }) : '—'}</td>
                    <td className="muted">{SERVING_LABEL[p.serving_type] || (p.serving_type ? p.serving_type.replace(/_/g, ' ') : '—')}</td>
                    <td><StatusChip kind={st.kind}>{st.label}</StatusChip></td>
                    <td className="shrink">
                      <button
                        type="button"
                        className="icon-btn"
                        title={copyMessage === p.token ? 'Copied!' : 'Copy link'}
                        onClick={(e) => copyLink(e, p.token)}
                        disabled={!p.token}
                      >
                        <Icon name={copyMessage === p.token ? 'check' : 'copy'} size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

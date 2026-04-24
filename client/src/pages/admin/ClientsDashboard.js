import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../utils/api';
import { formatPhone, formatPhoneInput, stripPhone } from '../../utils/formatPhone';
import useFormValidation from '../../hooks/useFormValidation';
import { useToast } from '../../context/ToastContext';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import Toolbar from '../../components/adminos/Toolbar';
import useDrawerParam from '../../hooks/useDrawerParam';
import ClientDrawer from '../../components/adminos/drawers/ClientDrawer';
import { fmt$, fmtDate } from '../../components/adminos/format';

const SOURCE = {
  direct:    { label: 'Direct',    kind: 'neutral' },
  thumbtack: { label: 'Thumbtack', kind: 'info' },
  referral:  { label: 'Referral',  kind: 'ok' },
  website:   { label: 'Website',   kind: 'accent' },
  instagram: { label: 'Instagram', kind: 'violet' },
};

function initialsOf(name) {
  if (!name) return '?';
  return name.split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

export default function ClientsDashboard() {
  const toast = useToast();
  const drawer = useDrawerParam();
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('recent');
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '', source: 'direct' });
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const { validate, fieldClass, inputClass, clearField } = useFormValidation();

  const fetchClients = useCallback(async () => {
    try {
      const res = await api.get('/clients');
      setClients(res.data || []);
    } catch (err) {
      toast.error('Failed to load clients. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchClients(); }, [fetchClients]);

  const clearServerFieldError = (name) => {
    if (fieldErrors[name]) {
      setFieldErrors(fe => {
        const next = { ...fe };
        delete next[name];
        return next;
      });
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    const result = validate([{ field: 'name', label: 'Name' }], form);
    if (!result.valid) { setError(result.message); return; }
    setCreating(true);
    try {
      const res = await api.post('/clients', form);
      setClients(prev => [res.data, ...prev]);
      setForm({ name: '', email: '', phone: '', source: 'direct' });
      setShowCreate(false);
      toast.success('Client added.');
    } catch (err) {
      setError(err.message || 'Failed to add client. Please try again.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setCreating(false);
    }
  };

  const filtered = useMemo(() => {
    const list = clients.filter(c => {
      if (!search) return true;
      const q = search.toLowerCase();
      const fields = [c.name, c.email, c.phone].filter(Boolean).join(' ').toLowerCase();
      return fields.includes(q);
    });
    return list.sort((a, b) => {
      if (sort === 'ltv') return Number(b.lifetime_value || 0) - Number(a.lifetime_value || 0);
      if (sort === 'name') return (a.name || '').localeCompare(b.name || '');
      // default 'recent'
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
  }, [clients, search, sort]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Clients</div>
          <div className="page-subtitle">Relationships and lifetime value across all events.</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate(v => !v)}>
            <Icon name={showCreate ? 'x' : 'plus'} />{showCreate ? 'Cancel' : 'New client'}
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: 'var(--gap)' }}>
          <div className="section-title" style={{ margin: 0, marginBottom: 12 }}>New client</div>
          <form onSubmit={handleCreate}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.85rem' }}>
              <div className={fieldClass('name')}>
                <div className="meta-k" style={{ marginBottom: 4 }}>Name *</div>
                <input
                  className={'input' + inputClass('name')}
                  value={form.name}
                  onChange={e => { setForm(f => ({ ...f, name: e.target.value })); clearField('name'); clearServerFieldError('name'); }}
                  aria-invalid={!!fieldErrors?.name}
                />
                <FieldError error={fieldErrors?.name} />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Email</div>
                <input
                  className="input"
                  type="email"
                  value={form.email}
                  onChange={e => { setForm(f => ({ ...f, email: e.target.value })); clearServerFieldError('email'); }}
                  aria-invalid={!!fieldErrors?.email}
                />
                <FieldError error={fieldErrors?.email} />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Phone</div>
                <input
                  className="input"
                  type="tel"
                  value={formatPhoneInput(form.phone)}
                  onChange={e => { setForm(f => ({ ...f, phone: stripPhone(e.target.value) })); clearServerFieldError('phone'); }}
                  aria-invalid={!!fieldErrors?.phone}
                />
                <FieldError error={fieldErrors?.phone} />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Source</div>
                <select
                  className="select"
                  value={form.source}
                  onChange={e => { setForm(f => ({ ...f, source: e.target.value })); clearServerFieldError('source'); }}
                >
                  {Object.entries(SOURCE).map(([val, cfg]) => <option key={val} value={val}>{cfg.label}</option>)}
                </select>
                <FieldError error={fieldErrors?.source} />
              </div>
            </div>
            <FormBanner error={error} fieldErrors={fieldErrors} />
            <div className="hstack" style={{ marginTop: 14, gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? 'Adding…' : 'Add client'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => { setShowCreate(false); setForm({ name: '', email: '', phone: '', source: 'direct' }); setError(''); setFieldErrors({}); }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <Toolbar
        search={search}
        setSearch={setSearch}
        filters={(
          <select className="select" value={sort} onChange={e => setSort(e.target.value)} style={{ minWidth: 180 }}>
            <option value="recent">Sort · Recently added</option>
            <option value="ltv">Sort · Lifetime value</option>
            <option value="name">Sort · Name</option>
          </select>
        )}
      />

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Contact</th>
                <th>Source</th>
                <th>Added</th>
                <th className="num">Events</th>
                <th className="num">Lifetime value</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && (<tr><td colSpan={7} className="muted">Loading…</td></tr>)}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={7} className="muted">No clients match this search.</td></tr>
              )}
              {!loading && filtered.map(c => {
                const src = SOURCE[c.source] || { label: c.source || '—', kind: 'neutral' };
                return (
                  <tr key={c.id} onClick={() => drawer.open('client', c.id)}>
                    <td>
                      <div className="hstack">
                        <div className="avatar" style={{ width: 24, height: 24, fontSize: 10 }}>{initialsOf(c.name)}</div>
                        <strong>{c.name}</strong>
                      </div>
                    </td>
                    <td>
                      {c.email && <div>{c.email}</div>}
                      {c.phone && <div className="sub">{formatPhone(c.phone)}</div>}
                      {!c.email && !c.phone && <span className="muted">—</span>}
                    </td>
                    <td><StatusChip kind={src.kind}>{src.label}</StatusChip></td>
                    <td className="muted">{fmtDate(c.created_at && String(c.created_at).slice(0, 10), { year: 'numeric' })}</td>
                    <td className="num">{c.events_count != null ? c.events_count : '—'}</td>
                    <td className="num"><strong>{c.lifetime_value != null ? fmt$(c.lifetime_value) : '—'}</strong></td>
                    <td className="shrink">
                      <button type="button" className="icon-btn" onClick={(e) => e.stopPropagation()} title="More">
                        <Icon name="kebab" size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {!loading && (
        <div className="tiny muted" style={{ padding: '8px 2px' }}>
          {filtered.length} {filtered.length === 1 ? 'client' : 'clients'} · Click a row to peek
        </div>
      )}

      <ClientDrawer
        id={drawer.kind === 'client' ? drawer.id : null}
        open={drawer.kind === 'client'}
        onClose={drawer.close}
      />
    </div>
  );
}

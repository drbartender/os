import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { formatPhone, formatPhoneInput, stripPhone } from '../../utils/formatPhone';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { useToast } from '../../context/ToastContext';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import { fmt$, fmt$2dp, fmtDate, fmtDateFull } from '../../components/adminos/format';

const SOURCE = {
  direct:    { label: 'Direct',    kind: 'neutral' },
  thumbtack: { label: 'Thumbtack', kind: 'info' },
  referral:  { label: 'Referral',  kind: 'ok' },
  website:   { label: 'Website',   kind: 'accent' },
  instagram: { label: 'Instagram', kind: 'violet' },
};

const PROP_STATUS = {
  draft: 'neutral', sent: 'info', viewed: 'accent', modified: 'violet',
  accepted: 'ok', deposit_paid: 'ok', balance_paid: 'ok', completed: 'ok',
  declined: 'danger', confirmed: 'ok',
};

function initialsOf(name) {
  if (!name) return '?';
  return name.split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

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
      .then(res => {
        setClient(res.data);
        setForm({
          name: res.data.name,
          email: res.data.email || '',
          phone: res.data.phone || '',
          source: res.data.source || 'direct',
          notes: res.data.notes || '',
        });
      })
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
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setError('');
    setFieldErrors({});
    setEditing(false);
    if (client) {
      setForm({
        name: client.name,
        email: client.email || '',
        phone: client.phone || '',
        source: client.source || 'direct',
        notes: client.notes || '',
      });
    }
  };

  if (loading) return <div className="page"><div className="muted">Loading client…</div></div>;
  if (!client) return null;

  const proposals = client.proposals || [];
  const ltv = proposals.reduce((s, p) => s + Number(p.amount_paid || 0), 0);
  const totalBooked = proposals.reduce((s, p) => s + Number(p.total_price || 0), 0);
  const src = SOURCE[client.source] || { label: client.source || '—', kind: 'neutral' };

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <div className="hstack" style={{ marginBottom: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/clients')}>
          <Icon name="left" size={11} />Clients
        </button>
      </div>

      {/* Identity bar */}
      <div className="card" style={{ padding: '1.5rem 1.75rem', marginBottom: 'var(--gap)' }}>
        <div className="hstack" style={{ gap: 18, alignItems: 'flex-start' }}>
          <div className="avatar" style={{ width: 56, height: 56, fontSize: 18, flexShrink: 0 }}>
            {initialsOf(client.name)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, marginBottom: 4 }}>
              Client · #{client.id}
            </div>
            <div className="hstack" style={{ gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 500, margin: 0, lineHeight: 1.15 }}>
                {client.name}
              </h1>
              <StatusChip kind={src.kind}>{src.label}</StatusChip>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {client.email || '—'}{client.phone ? ` · ${formatPhone(client.phone)}` : ''}
              {client.created_at && ` · added ${fmtDateFull(String(client.created_at).slice(0, 10))}`}
            </div>
          </div>
          <div className="page-actions" style={{ flexShrink: 0 }}>
            {client.email && (
              <a className="btn btn-ghost" href={`mailto:${client.email}`}>
                <Icon name="mail" size={12} />Email
              </a>
            )}
            {client.phone && (
              <a className="btn btn-ghost" href={`tel:${client.phone}`}>
                <Icon name="phone" size={12} />Call
              </a>
            )}
            <button type="button" className="btn btn-primary" onClick={() => navigate(`/admin/proposals/new?client_id=${client.id}`)}>
              <Icon name="plus" size={12} />New proposal
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 'var(--gap)' }}>
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <div className="card">
            <div className="card-head">
              <h3>Proposals & events</h3>
              <span className="k">{proposals.length}</span>
            </div>
            {proposals.length === 0 ? (
              <div className="card-body"><div className="muted tiny">No proposals yet.</div></div>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>Date</th>
                      <th>Package</th>
                      <th>Status</th>
                      <th className="num">Total</th>
                      <th className="num">Paid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposals.map(p => (
                      <tr key={p.id} onClick={() => navigate(`/admin/proposals/${p.id}`)}>
                        <td>
                          <strong>{getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}</strong>
                        </td>
                        <td>{p.event_date ? fmtDate(String(p.event_date).slice(0, 10), { year: 'numeric' }) : '—'}</td>
                        <td className="muted">{p.package_name || '—'}</td>
                        <td><StatusChip kind={PROP_STATUS[p.status] || 'neutral'}>{p.status || '—'}</StatusChip></td>
                        <td className="num">{fmt$(p.total_price)}</td>
                        <td className="num muted">{fmt$(p.amount_paid)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {client.notes && !editing && (
            <div className="card">
              <div className="card-head"><h3>Notes</h3></div>
              <div className="card-body">
                <div style={{ color: 'var(--ink-2)', fontSize: 13, whiteSpace: 'pre-wrap' }}>{client.notes}</div>
              </div>
            </div>
          )}
        </div>

        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <div className="card">
            <div className="card-head">
              <h3>Contact</h3>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => editing ? handleCancelEdit() : setEditing(true)}>
                <Icon name={editing ? 'x' : 'pen'} size={11} />{editing ? 'Cancel' : 'Edit'}
              </button>
            </div>
            <div className="card-body">
              {editing ? (
                <div style={{ display: 'grid', gap: 10 }}>
                  <div>
                    <div className="meta-k" style={{ marginBottom: 4 }}>Name</div>
                    <input className="input" value={form.name} onChange={e => { setForm(f => ({ ...f, name: e.target.value })); clearServerFieldError('name'); }} aria-invalid={!!fieldErrors?.name} />
                    <FieldError error={fieldErrors?.name} />
                  </div>
                  <div>
                    <div className="meta-k" style={{ marginBottom: 4 }}>Email</div>
                    <input className="input" type="email" value={form.email} onChange={e => { setForm(f => ({ ...f, email: e.target.value })); clearServerFieldError('email'); }} aria-invalid={!!fieldErrors?.email} />
                    <FieldError error={fieldErrors?.email} />
                  </div>
                  <div>
                    <div className="meta-k" style={{ marginBottom: 4 }}>Phone</div>
                    <input className="input" type="tel" value={formatPhoneInput(form.phone)} onChange={e => { setForm(f => ({ ...f, phone: stripPhone(e.target.value) })); clearServerFieldError('phone'); }} aria-invalid={!!fieldErrors?.phone} />
                    <FieldError error={fieldErrors?.phone} />
                  </div>
                  <div>
                    <div className="meta-k" style={{ marginBottom: 4 }}>Source</div>
                    <select className="select" value={form.source} onChange={e => { setForm(f => ({ ...f, source: e.target.value })); clearServerFieldError('source'); }}>
                      {Object.entries(SOURCE).map(([val, cfg]) => <option key={val} value={val}>{cfg.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <div className="meta-k" style={{ marginBottom: 4 }}>Notes</div>
                    <textarea className="input" rows={3} style={{ height: 'auto', padding: '0.5rem 0.6rem' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
                  </div>
                  <FormBanner error={error} fieldErrors={fieldErrors} />
                  <div className="hstack" style={{ gap: 6 }}>
                    <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                    <button type="button" className="btn btn-ghost" onClick={handleCancelEdit}>Cancel</button>
                  </div>
                </div>
              ) : (
                <dl className="dl">
                  <dt>Email</dt><dd>{client.email || '—'}</dd>
                  <dt>Phone</dt><dd>{client.phone ? formatPhone(client.phone) : '—'}</dd>
                  <dt>Source</dt><dd><StatusChip kind={src.kind}>{src.label}</StatusChip></dd>
                  <dt>Added</dt><dd>{client.created_at ? fmtDate(String(client.created_at).slice(0, 10), { year: 'numeric' }) : '—'}</dd>
                </dl>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>Lifetime</h3></div>
            <div className="card-body">
              <dl className="dl">
                <dt>Events</dt><dd className="num">{proposals.length}</dd>
                <dt>Booked</dt><dd className="num">{fmt$2dp(totalBooked)}</dd>
                <dt>Collected</dt><dd className="num">{fmt$2dp(ltv)}</dd>
                <dt>Outstanding</dt>
                <dd className="num" style={{ color: totalBooked - ltv > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : '' }}>
                  {fmt$2dp(totalBooked - ltv)}
                </dd>
              </dl>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

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
import BackButton from '../../components/adminos/BackButton';
import ClickableRow from '../../components/ClickableRow';

const SOURCE = {
  direct:    { label: 'Direct',    kind: 'neutral' },
  thumbtack: { label: 'Thumbtack', kind: 'info' },
  zola:      { label: 'Zola',      kind: 'info' },
  calcom:    { label: 'Cal.com',   kind: 'info' },
  referral:  { label: 'Referral',  kind: 'ok' },
  website:   { label: 'Website',   kind: 'accent' },
  instagram: { label: 'Instagram', kind: 'violet' },
  checkcherry: { label: 'CheckCherry', kind: 'neutral' },
  other:     { label: 'Other',     kind: 'neutral' },
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
  const [harvestEmail, setHarvestEmail] = useState('');
  const [harvestBusy, setHarvestBusy] = useState(false);
  const [harvestError, setHarvestError] = useState('');

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
        navigate('/clients');
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

  const refreshClient = () => api.get(`/clients/${id}`).then(res => setClient(res.data)).catch(() => {});

  // Manual email-harvest fallback (Thumbtack never sends the email). Routes through the
  // admin path of /email-harvested so it sets the email, marks the lead harvested, and
  // re-arms any drip touches suppressed for the missing email.
  const submitHarvestEmail = async () => {
    setHarvestError('');
    const email = harvestEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setHarvestError('Enter a valid email address.'); return; }
    setHarvestBusy(true);
    try {
      await api.post('/admin/thumbtack/email-harvested', { negotiation_id: client.thumbtack_negotiation_id, email });
      setHarvestEmail('');
      await refreshClient();
      toast.success('Customer email saved.');
    } catch (err) {
      setHarvestError(err.message || 'Could not save the email. Try again.');
    } finally {
      setHarvestBusy(false);
    }
  };

  const retryHarvest = async () => {
    setHarvestError('');
    setHarvestBusy(true);
    try {
      await api.post('/admin/thumbtack/rearm', { negotiation_id: client.thumbtack_negotiation_id });
      await refreshClient();
      toast.success('Back in the harvester queue.');
    } catch (err) {
      setHarvestError(err.message || 'Could not retry. Try again.');
    } finally {
      setHarvestBusy(false);
    }
  };

  if (loading) return <div className="page"><div className="muted">Loading client…</div></div>;
  if (!client) return null;

  const proposals = client.proposals || [];
  // LTV/booked stay computed over ALL proposals (money truth); only the table
  // display collapses option-group siblings below.
  const ltv = proposals.reduce((s, p) => s + Number(p.amount_paid || 0), 0);
  const totalBooked = proposals.reduce((s, p) => s + Number(p.total_price || 0), 0);

  // Option-group rollup: siblings sharing a non-null group_id collapse into one
  // row; group_id null rows stay individual (never collapse the nulls together).
  const groupCounts = new Map();
  proposals.forEach(p => {
    if (p.group_id != null) groupCounts.set(p.group_id, (groupCounts.get(p.group_id) || 0) + 1);
  });
  const seenGroups = new Set();
  const proposalRows = proposals.filter(p => {
    if (p.group_id == null) return true;
    if (seenGroups.has(p.group_id)) return false;
    seenGroups.add(p.group_id);
    return true;
  });
  const src = SOURCE[client.source] || { label: client.source || '—', kind: 'neutral' };

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <div className="hstack" style={{ marginBottom: 8 }}>
        <BackButton fallback="/clients" />
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
            <button type="button" className="btn btn-ghost" onClick={() => editing ? handleCancelEdit() : setEditing(true)}>
              <Icon name={editing ? 'x' : 'pen'} size={12} />{editing ? 'Cancel' : 'Edit'}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => navigate(`/proposals/new?client_id=${client.id}`)}>
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
                    {proposalRows.map(p => (
                      <ClickableRow key={p.id} to={`/proposals/${p.id}`}>
                        <td>
                          <strong>{getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}</strong>
                          {p.group_id != null && groupCounts.get(p.group_id) > 1 && (
                            <div className="sub">{groupCounts.get(p.group_id)} options to compare</div>
                          )}
                        </td>
                        <td>{p.event_date ? fmtDate(String(p.event_date).slice(0, 10), { year: 'numeric' }) : '—'}</td>
                        <td className="muted">{p.package_name || '—'}</td>
                        <td><StatusChip kind={PROP_STATUS[p.status] || 'neutral'}>{p.status || '—'}</StatusChip></td>
                        <td className="num">{fmt$(p.total_price)}</td>
                        <td className="num muted">{fmt$(p.amount_paid)}</td>
                      </ClickableRow>
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
          {(client.email_harvest_status === 'pending' || client.email_harvest_status === 'failed') && !client.email && client.thumbtack_negotiation_id && (
            <div className="card">
              <div className="card-head"><h3>Customer email needed</h3></div>
              <div className="card-body">
                <div className="muted tiny" style={{ marginBottom: 8 }}>
                  {client.email_harvest_status === 'failed'
                    ? "The harvester couldn't read this lead's email. Paste it in, or send the lead back to the queue."
                    : "Thumbtack didn't send an email for this lead. The harvester will fill it in, or you can paste it now."}
                </div>
                <input
                  className="input"
                  type="email"
                  placeholder="customer@example.com"
                  value={harvestEmail}
                  onChange={e => { setHarvestEmail(e.target.value); if (harvestError) setHarvestError(''); }}
                  aria-invalid={!!harvestError}
                  disabled={harvestBusy}
                />
                {harvestError && <FieldError error={harvestError} />}
                <div className="hstack" style={{ gap: 6, marginTop: 8 }}>
                  <button type="button" className="btn btn-primary" onClick={submitHarvestEmail} disabled={harvestBusy || !harvestEmail.trim()}>
                    {harvestBusy ? 'Saving…' : 'Save email'}
                  </button>
                  {client.email_harvest_status === 'failed' && (
                    <button type="button" className="btn btn-ghost" onClick={retryHarvest} disabled={harvestBusy}>
                      Retry harvest
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
          {editing && (
            <div className="card">
              <div className="card-head"><h3>Edit contact</h3></div>
              <div className="card-body">
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
              </div>
            </div>
          )}

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

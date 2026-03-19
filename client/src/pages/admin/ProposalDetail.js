import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import PricingBreakdown from '../../components/PricingBreakdown';
import LocationInput from '../../components/LocationInput';

const STATUS_LABELS = {
  draft: 'Draft', sent: 'Sent', viewed: 'Viewed', modified: 'Modified',
  accepted: 'Accepted', deposit_paid: 'Deposit Paid', confirmed: 'Confirmed',
};
const STATUS_CLASSES = {
  draft: 'badge-inprogress', sent: 'badge-submitted', viewed: 'badge-submitted',
  modified: 'badge-inprogress', accepted: 'badge-approved', deposit_paid: 'badge-approved', confirmed: 'badge-approved',
};

// Generate 30-minute time slots from 6:00 AM to 11:30 PM
const TIME_OPTIONS = [];
for (let h = 6; h < 24; h++) {
  ['00', '30'].forEach(m => {
    const val = `${String(h).padStart(2, '0')}:${m}`;
    const hour12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    const ampm = h >= 12 ? 'PM' : 'AM';
    TIME_OPTIONS.push({ value: val, label: `${hour12}:${m} ${ampm}` });
  });
}

export default function ProposalDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [paymentLinkUrl, setPaymentLinkUrl] = useState('');
  const [generatingLink, setGeneratingLink] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [linkError, setLinkError] = useState('');

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [packages, setPackages] = useState([]);
  const [addons, setAddons] = useState([]);
  const [editForm, setEditForm] = useState(null);
  const [editPreview, setEditPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const loadProposal = () => {
    return api.get(`/proposals/${id}`).then(res => {
      setProposal(res.data);
      setNotes(res.data.admin_notes || '');
    }).catch(() => navigate('/admin/proposals')).finally(() => setLoading(false));
  };

  useEffect(() => { loadProposal(); }, [id]); // eslint-disable-line

  // Fetch packages/addons when edit mode is opened
  useEffect(() => {
    if (!editing) return;
    Promise.all([
      api.get('/proposals/packages'),
      api.get('/proposals/addons')
    ]).then(([pkgRes, addonRes]) => {
      setPackages(pkgRes.data);
      setAddons(addonRes.data);
    });
    // Pre-populate edit form from current proposal
    if (proposal && !editForm) {
      const currentAddonIds = (proposal.addons || []).map(a => a.addon_id);
      setEditForm({
        // Client fields
        client_name: proposal.client_name || '',
        client_email: proposal.client_email || '',
        client_phone: proposal.client_phone || '',
        client_source: proposal.client_source || 'thumbtack',
        // Event fields
        event_name: proposal.event_name || '',
        event_date: proposal.event_date ? proposal.event_date.slice(0, 10) : '',
        event_start_time: proposal.event_start_time || '',
        event_duration_hours: Number(proposal.event_duration_hours) || 4,
        event_location: proposal.event_location || '',
        guest_count: proposal.guest_count || 50,
        package_id: proposal.package_id || '',
        needs_bar: proposal.num_bars > 0,
        addon_ids: currentAddonIds,
      });
    }
  }, [editing]); // eslint-disable-line

  // Live pricing preview in edit mode
  useEffect(() => {
    if (!editing || !editForm || !editForm.package_id) { setEditPreview(null); return; }
    api.post('/proposals/calculate', {
      package_id: Number(editForm.package_id),
      guest_count: Number(editForm.guest_count) || 50,
      duration_hours: Number(editForm.event_duration_hours) || 4,
      num_bars: editForm.needs_bar ? 1 : 0,
      addon_ids: (editForm.addon_ids || []).map(Number)
    }).then(res => setEditPreview(res.data)).catch(() => setEditPreview(null));
  }, [editing, editForm?.package_id, editForm?.guest_count, editForm?.event_duration_hours, editForm?.needs_bar, editForm?.addon_ids]); // eslint-disable-line

  const updateEdit = (field, value) => setEditForm(f => ({ ...f, [field]: value }));

  const toggleEditAddon = (id) => {
    setEditForm(f => ({
      ...f,
      addon_ids: f.addon_ids.includes(id) ? f.addon_ids.filter(a => a !== id) : [...f.addon_ids, id]
    }));
  };

  const handleSaveEdit = async () => {
    if (!editForm.package_id) { setEditError('Please select a package.'); return; }
    setEditError('');
    setSaving(true);
    try {
      // Update client record if we have a client_id
      if (proposal.client_id) {
        await api.put(`/clients/${proposal.client_id}`, {
          name: editForm.client_name,
          email: editForm.client_email,
          phone: editForm.client_phone,
          source: editForm.client_source,
        });
      }
      // Update proposal event/package details
      await api.patch(`/proposals/${id}`, {
        event_name: editForm.event_name,
        event_date: editForm.event_date,
        event_start_time: editForm.event_start_time,
        event_duration_hours: Number(editForm.event_duration_hours),
        event_location: editForm.event_location,
        guest_count: Number(editForm.guest_count),
        package_id: Number(editForm.package_id),
        num_bars: editForm.needs_bar ? 1 : 0,
        addon_ids: (editForm.addon_ids || []).map(Number)
      });
      setLoading(true);
      await loadProposal();
      setEditing(false);
      setEditForm(null);
    } catch (err) {
      setEditError(err.response?.data?.error || 'Failed to save changes.');
    } finally {
      setSaving(false);
    }
  };

  const copyLink = () => {
    const url = `${window.location.origin}/proposal/${proposal.token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopyMessage('Copied!');
      setTimeout(() => setCopyMessage(''), 2000);
    });
  };

  const saveNotes = async () => {
    setSavingNotes(true);
    try {
      await api.patch(`/proposals/${id}/notes`, { admin_notes: notes });
    } catch (err) {
      console.error('Failed to save notes:', err);
    } finally { setSavingNotes(false); }
  };

  const generatePaymentLink = async () => {
    setGeneratingLink(true);
    setLinkError('');
    try {
      const res = await api.post(`/stripe/payment-link/${id}?token=${proposal.token}`);
      setPaymentLinkUrl(res.data.url);
    } catch (err) {
      setLinkError(err.response?.data?.error || 'Failed to generate payment link. Check that Stripe env vars are set in Render.');
    } finally {
      setGeneratingLink(false);
    }
  };

  const copyPaymentLink = () => {
    navigator.clipboard.writeText(paymentLinkUrl).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  };

  const updateStatus = async (status) => {
    try {
      const res = await api.patch(`/proposals/${id}/status`, { status });
      setProposal(prev => ({ ...prev, status: res.data.status }));
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  };

  const formatDate = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatDateTime = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  if (loading) return <div className="page-container" style={{ textAlign: 'center', padding: '3rem' }}><div className="spinner" /></div>;
  if (!proposal) return null;

  const snapshot = proposal.pricing_snapshot;
  const includes = proposal.package_includes || [];

  // Edit mode — derived state
  const editSelectedPkg = editForm && packages.find(p => p.id === Number(editForm?.package_id));
  const isHostedPkg = editSelectedPkg && (editSelectedPkg.pricing_type === 'per_guest' || editSelectedPkg.pricing_type === 'per_guest_timed');
  const editFilteredAddons = addons.filter(a => {
    if (a.applies_to !== 'all' && (!editSelectedPkg || a.applies_to !== editSelectedPkg.category)) return false;
    if (isHostedPkg && /bartender/i.test((a.name || '') + (a.slug || ''))) return false;
    return true;
  });

  return (
    <div className="page-container wide">
      <div className="flex-between mb-2">
        <h1 style={{ fontFamily: 'var(--font-display)' }}>Proposal #{proposal.id}</h1>
        <div className="flex gap-1">
          <button className="btn btn-secondary" onClick={() => navigate('/admin/proposals')}>Back</button>
          {!editing && <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit</button>}
          <button className="btn" onClick={copyLink}>{copyMessage || 'Copy Link'}</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', alignItems: 'start' }}>
        {/* Left column */}
        <div>
          {/* Status */}
          <div className="card mb-2">
            <div className="flex-between" style={{ alignItems: 'center' }}>
              <div>
                <span className={`badge ${STATUS_CLASSES[proposal.status] || ''}`} style={{ fontSize: '0.9rem' }}>
                  {STATUS_LABELS[proposal.status] || proposal.status}
                </span>
                {proposal.view_count > 0 && (
                  <span className="text-muted text-small" style={{ marginLeft: '0.75rem' }}>
                    Viewed {proposal.view_count} time{proposal.view_count !== 1 ? 's' : ''}
                    {proposal.last_viewed_at && <> · Last: {formatDateTime(proposal.last_viewed_at)}</>}
                  </span>
                )}
              </div>
              <div className="flex gap-05">
                {proposal.status === 'draft' && <button className="btn btn-sm" onClick={() => updateStatus('sent')}>Mark Sent</button>}
                {proposal.status === 'viewed' && <button className="btn btn-sm" onClick={() => updateStatus('accepted')}>Mark Accepted</button>}
              </div>
            </div>
          </div>

          {/* Client Info */}
          <div className="card mb-2">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Client</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              <div><span className="text-muted text-small">Name</span><div>{proposal.client_name || '—'}</div></div>
              <div><span className="text-muted text-small">Email</span><div>{proposal.client_email || '—'}</div></div>
              <div><span className="text-muted text-small">Phone</span><div>{proposal.client_phone || '—'}</div></div>
              <div><span className="text-muted text-small">Source</span><div>{proposal.client_source || '—'}</div></div>
            </div>
          </div>

          {/* Event Details — view or edit */}
          {editing && editForm ? (
            <div className="card mb-2">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>Edit Proposal</h3>
              {editError && <div style={{ color: '#c0392b', marginBottom: '0.75rem', fontSize: '0.9rem' }}>{editError}</div>}

              {/* Client fields */}
              <h4 style={{ color: 'var(--warm-brown)', marginBottom: '0.5rem' }}>Client</h4>
              <div className="two-col" style={{ gap: '0.75rem', marginBottom: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">Name</label>
                  <input className="form-input" value={editForm.client_name} onChange={e => updateEdit('client_name', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Email</label>
                  <input className="form-input" type="email" value={editForm.client_email} onChange={e => updateEdit('client_email', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Phone</label>
                  <input className="form-input" value={editForm.client_phone} onChange={e => updateEdit('client_phone', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Source</label>
                  <select className="form-select" value={editForm.client_source} onChange={e => updateEdit('client_source', e.target.value)}>
                    <option value="thumbtack">Thumbtack</option>
                    <option value="direct">Direct</option>
                    <option value="referral">Referral</option>
                    <option value="website">Website</option>
                  </select>
                </div>
              </div>

              {/* Event fields */}
              <h4 style={{ color: 'var(--warm-brown)', marginBottom: '0.5rem' }}>Event</h4>
              <div className="two-col" style={{ gap: '0.75rem' }}>
                <div className="form-group">
                  <label className="form-label">Event Name</label>
                  <input className="form-input" value={editForm.event_name} onChange={e => updateEdit('event_name', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Event Date</label>
                  <input className="form-input" type="date" value={editForm.event_date} onChange={e => updateEdit('event_date', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Start Time</label>
                  <select className="form-select" value={editForm.event_start_time} onChange={e => updateEdit('event_start_time', e.target.value)}>
                    <option value="">— Select time —</option>
                    {TIME_OPTIONS.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Duration (hours)</label>
                  <input className="form-input" type="number" min="1" max="12" step="0.5" value={editForm.event_duration_hours} onChange={e => updateEdit('event_duration_hours', e.target.value)} />
                </div>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">Location</label>
                  <LocationInput
                    value={editForm.event_location}
                    onChange={val => updateEdit('event_location', val)}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Guest Count</label>
                  <input className="form-input" type="number" min="1" max="1000" value={editForm.guest_count} onChange={e => updateEdit('guest_count', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Portable Bar Needed?</label>
                  <select className="form-select" value={editForm.needs_bar ? 'yes' : 'no'} onChange={e => updateEdit('needs_bar', e.target.value === 'yes')}>
                    <option value="yes">Yes</option>
                    <option value="no">No — venue has a bar</option>
                  </select>
                </div>
              </div>

              {/* Package selection in edit mode */}
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: '1rem 0 0.75rem' }}>Package</h3>
              <div style={{ display: 'grid', gap: '0.5rem', marginBottom: '1rem' }}>
                {packages.map(pkg => (
                  <label key={pkg.id} style={{
                    display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 0.75rem',
                    borderRadius: '6px', cursor: 'pointer',
                    border: Number(editForm.package_id) === pkg.id ? '2px solid var(--deep-brown)' : '1px solid var(--cream-dark, #e8e0d4)',
                    background: Number(editForm.package_id) === pkg.id ? 'var(--cream-light, #faf5ef)' : 'transparent'
                  }}>
                    <input type="radio" name="edit-package" value={pkg.id} checked={Number(editForm.package_id) === pkg.id}
                      onChange={e => { updateEdit('package_id', e.target.value); updateEdit('addon_ids', []); }} />
                    <span style={{ fontWeight: 600, color: 'var(--deep-brown)', fontSize: '0.9rem' }}>{pkg.name}</span>
                  </label>
                ))}
              </div>

              {/* Add-ons in edit mode */}
              {editFilteredAddons.length > 0 && (
                <>
                  <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: '0 0 0.75rem' }}>Add-ons</h3>
                  <div style={{ display: 'grid', gap: '0.4rem', marginBottom: '1rem' }}>
                    {editFilteredAddons.map(addon => (
                      <label key={addon.id} style={{
                        display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.4rem 0.75rem',
                        borderRadius: '6px', cursor: 'pointer',
                        background: editForm.addon_ids.includes(addon.id) ? 'var(--cream-light, #faf5ef)' : 'transparent'
                      }}>
                        <input type="checkbox" checked={editForm.addon_ids.includes(addon.id)} onChange={() => toggleEditAddon(addon.id)} />
                        <span style={{ color: 'var(--deep-brown)', fontSize: '0.9rem' }}>{addon.name}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              {/* Save / cancel */}
              <div className="flex gap-1">
                <button className="btn" onClick={handleSaveEdit} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
                <button className="btn btn-secondary" onClick={() => { setEditing(false); setEditForm(null); setEditError(''); }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="card mb-2">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Event</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                <div><span className="text-muted text-small">Event</span><div>{proposal.event_name || '—'}</div></div>
                <div><span className="text-muted text-small">Date</span><div>{formatDate(proposal.event_date)}</div></div>
                <div><span className="text-muted text-small">Start Time</span><div>{proposal.event_start_time || '—'}</div></div>
                <div><span className="text-muted text-small">Duration</span><div>{proposal.event_duration_hours}hrs</div></div>
                <div><span className="text-muted text-small">Guests</span><div>{proposal.guest_count}</div></div>
                <div><span className="text-muted text-small">Location</span><div>{proposal.event_location || '—'}</div></div>
              </div>
            </div>
          )}

          {/* Admin Notes */}
          <div className="card mb-2">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Admin Notes</h3>
            <textarea
              className="form-input"
              rows={4}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Internal notes about this proposal..."
              style={{ resize: 'vertical' }}
            />
            <button className="btn btn-sm mt-1" onClick={saveNotes} disabled={savingNotes}>
              {savingNotes ? 'Saving...' : 'Save Notes'}
            </button>
          </div>
        </div>

        {/* Right column */}
        <div>
          {/* Package & Pricing — show edit preview when editing */}
          <div className="card mb-2">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
              {editing && editSelectedPkg ? editSelectedPkg.name : (proposal.package_name || 'Package')}
            </h3>
            {!editing && includes.length > 0 && (
              <ul style={{ margin: '0 0 1rem 0', padding: '0 0 0 1.2rem', color: 'var(--warm-brown, #6b4226)' }}>
                {includes.map((item, i) => <li key={i} className="text-small" style={{ marginBottom: '0.2rem' }}>{item}</li>)}
              </ul>
            )}
            <PricingBreakdown snapshot={editing ? editPreview : snapshot} />
          </div>

          {/* Payment Link */}
          <div className="card mb-2">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>Deposit Collection</h3>
            <p className="text-muted text-small" style={{ marginBottom: '0.75rem' }}>
              {proposal.status === 'deposit_paid' || proposal.status === 'confirmed'
                ? '✓ Deposit has been paid.'
                : 'Generate a payment link to share with the client for the $100 deposit.'}
            </p>
            {proposal.status !== 'deposit_paid' && proposal.status !== 'confirmed' && (
              <>
                <button
                  className="btn btn-sm"
                  onClick={generatePaymentLink}
                  disabled={generatingLink}
                >
                  {generatingLink ? 'Generating…' : 'Generate Payment Link'}
                </button>
                {linkError && (
                  <p style={{ color: '#c0392b', fontSize: '0.85rem', marginTop: '0.5rem' }}>{linkError}</p>
                )}
                {paymentLinkUrl && (
                  <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <input
                      readOnly
                      value={paymentLinkUrl}
                      onClick={e => e.target.select()}
                      style={{ flex: 1, fontSize: '0.8rem', padding: '0.4rem 0.5rem', border: '1px solid var(--cream-dark)', borderRadius: '4px', background: '#faf5ef', color: 'var(--deep-brown)' }}
                    />
                    <button className="btn btn-sm btn-secondary" onClick={copyPaymentLink}>
                      {linkCopied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Event Shift */}
          {(proposal.status === 'deposit_paid' || proposal.status === 'confirmed') && (
            <div className="card mb-2">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>Event Shift</h3>
              <p className="text-muted text-small" style={{ marginBottom: '0.75rem' }}>
                A shift has been created for this event. Staff can now request to work it.
              </p>
              <button className="btn btn-sm" onClick={() => navigate('/admin/events')}>
                View in Events
              </button>
            </div>
          )}

          {/* Activity Log */}
          {proposal.activity && proposal.activity.length > 0 && (
            <div className="card">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Activity</h3>
              <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
                {proposal.activity.map((entry, i) => {
                  const details = entry.details
                    ? (typeof entry.details === 'string' ? JSON.parse(entry.details) : entry.details)
                    : {};
                  return (
                    <div key={i} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--cream-dark, #e8e0d4)' }}>
                      <span className="text-small" style={{ fontWeight: 500 }}>{entry.action}</span>
                      <span className="text-muted text-small" style={{ marginLeft: '0.5rem' }}>
                        {entry.actor_type} · {formatDateTime(entry.created_at)}
                      </span>
                      {details.location && (
                        <span className="text-muted text-small" style={{ marginLeft: '0.5rem' }}>
                          · 📍 {details.location}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

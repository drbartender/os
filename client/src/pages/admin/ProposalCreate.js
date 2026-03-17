import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import PricingBreakdown from '../../components/PricingBreakdown';

export default function ProposalCreate() {
  const navigate = useNavigate();
  const [packages, setPackages] = useState([]);
  const [addons, setAddons] = useState([]);
  const [preview, setPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    client_name: '', client_email: '', client_phone: '', client_source: 'direct',
    event_name: '', event_date: '', event_start_time: '', event_duration_hours: 4,
    event_location: '', guest_count: 50, package_id: '', num_bars: 1,
    num_bartenders: null, addon_ids: []
  });

  useEffect(() => {
    Promise.all([
      api.get('/proposals/packages'),
      api.get('/proposals/addons')
    ]).then(([pkgRes, addonRes]) => {
      setPackages(pkgRes.data);
      setAddons(addonRes.data);
    });
  }, []);

  // Live pricing preview
  const fetchPreview = useCallback(async () => {
    if (!form.package_id) { setPreview(null); return; }
    try {
      const res = await api.post('/proposals/calculate', {
        package_id: Number(form.package_id),
        guest_count: Number(form.guest_count) || 50,
        duration_hours: Number(form.event_duration_hours) || 4,
        num_bars: Number(form.num_bars) || 1,
        num_bartenders: form.num_bartenders != null ? Number(form.num_bartenders) : undefined,
        addon_ids: form.addon_ids.map(Number)
      });
      setPreview(res.data);
    } catch { setPreview(null); }
  }, [form.package_id, form.guest_count, form.event_duration_hours, form.num_bars, form.num_bartenders, form.addon_ids]);

  useEffect(() => { fetchPreview(); }, [fetchPreview]);

  const update = (field, value) => setForm(f => ({ ...f, [field]: value }));

  const toggleAddon = (id) => {
    setForm(f => ({
      ...f,
      addon_ids: f.addon_ids.includes(id) ? f.addon_ids.filter(a => a !== id) : [...f.addon_ids, id]
    }));
  };

  const selectedPkg = packages.find(p => p.id === Number(form.package_id));
  const filteredAddons = addons.filter(a =>
    a.applies_to === 'all' || (selectedPkg && a.applies_to === selectedPkg.category)
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.client_name.trim()) { setError('Client name is required.'); return; }
    if (!form.package_id) { setError('Please select a package.'); return; }
    setError('');
    setSubmitting(true);
    try {
      const payload = {
        ...form,
        package_id: Number(form.package_id),
        guest_count: Number(form.guest_count),
        event_duration_hours: Number(form.event_duration_hours),
        num_bars: Number(form.num_bars),
        num_bartenders: form.num_bartenders != null ? Number(form.num_bartenders) : undefined,
        addon_ids: form.addon_ids.map(Number)
      };
      const res = await api.post('/proposals', payload);
      navigate(`/admin/proposals/${res.data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create proposal.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-container wide">
      <div className="flex-between mb-2">
        <h1 style={{ fontFamily: 'var(--font-display)' }}>New Proposal</h1>
        <button className="btn btn-secondary" onClick={() => navigate('/admin/proposals')}>Back</button>
      </div>

      {error && <div className="card mb-2" style={{ color: '#c0392b', border: '1px solid #c0392b' }}>{error}</div>}

      <form onSubmit={handleSubmit}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: '1.5rem', alignItems: 'start' }}>
          {/* Left: Form sections */}
          <div>
            {/* Client Info */}
            <div className="card mb-2">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>Client Info</h3>
              <div className="two-col" style={{ gap: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">Client Name *</label>
                  <input className="form-input" value={form.client_name} onChange={e => update('client_name', e.target.value)} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Email</label>
                  <input className="form-input" type="email" value={form.client_email} onChange={e => update('client_email', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Phone</label>
                  <input className="form-input" value={form.client_phone} onChange={e => update('client_phone', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Source</label>
                  <select className="form-select" value={form.client_source} onChange={e => update('client_source', e.target.value)}>
                    <option value="direct">Direct</option>
                    <option value="thumbtack">Thumbtack</option>
                    <option value="referral">Referral</option>
                    <option value="website">Website</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Event Details */}
            <div className="card mb-2">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>Event Details</h3>
              <div className="two-col" style={{ gap: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">Event Name</label>
                  <input className="form-input" value={form.event_name} onChange={e => update('event_name', e.target.value)} placeholder="Smith Wedding" />
                </div>
                <div className="form-group">
                  <label className="form-label">Event Date</label>
                  <input className="form-input" type="date" value={form.event_date} onChange={e => update('event_date', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Start Time</label>
                  <input className="form-input" type="time" value={form.event_start_time} onChange={e => update('event_start_time', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Duration (hours)</label>
                  <input className="form-input" type="number" min="1" max="12" step="0.5" value={form.event_duration_hours} onChange={e => update('event_duration_hours', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Location</label>
                  <input className="form-input" value={form.event_location} onChange={e => update('event_location', e.target.value)} placeholder="123 Main St, Chicago, IL" />
                </div>
                <div className="form-group">
                  <label className="form-label">Guest Count</label>
                  <input className="form-input" type="number" min="1" max="1000" value={form.guest_count} onChange={e => update('guest_count', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Number of Bars</label>
                  <input className="form-input" type="number" min="1" max="10" value={form.num_bars} onChange={e => update('num_bars', e.target.value)} />
                </div>
              </div>
            </div>

            {/* Package Selection */}
            <div className="card mb-2">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>Package</h3>
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                {packages.map(pkg => (
                  <label key={pkg.id} style={{
                    display: 'flex', alignItems: 'flex-start', gap: '0.75rem', padding: '0.75rem 1rem',
                    borderRadius: '8px', cursor: 'pointer',
                    border: Number(form.package_id) === pkg.id ? '2px solid var(--deep-brown)' : '1px solid var(--cream-dark, #e8e0d4)',
                    background: Number(form.package_id) === pkg.id ? 'var(--cream-light, #faf5ef)' : 'transparent'
                  }}>
                    <input type="radio" name="package" value={pkg.id} checked={Number(form.package_id) === pkg.id}
                      onChange={e => { update('package_id', e.target.value); update('addon_ids', []); }}
                      style={{ marginTop: '0.2rem' }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, color: 'var(--deep-brown)' }}>{pkg.name}</div>
                      <div className="text-muted text-small" style={{ marginTop: '0.2rem' }}>{pkg.description}</div>
                      <div className="text-small" style={{ marginTop: '0.3rem', color: 'var(--warm-brown, #6b4226)' }}>
                        {pkg.pricing_type === 'per_guest' ? (
                          <>
                            ${Number(pkg.base_rate_4hr)}/guest (50+)
                            {pkg.base_rate_4hr_small && <> · ${Number(pkg.base_rate_4hr_small)}/guest ({'<'}50)</>}
                            {pkg.extra_hour_rate && <> · +${Number(pkg.extra_hour_rate)}/guest/hr extra</>}
                          </>
                        ) : (
                          <>
                            {pkg.base_rate_3hr && <>${ Number(pkg.base_rate_3hr)}/3hr · </>}
                            {pkg.base_rate_4hr && <>${Number(pkg.base_rate_4hr)}/4hr</>}
                            {pkg.extra_hour_rate && <> · +${Number(pkg.extra_hour_rate)}/hr extra</>}
                          </>
                        )}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Add-ons */}
            {form.package_id && filteredAddons.length > 0 && (
              <div className="card mb-2">
                <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>Add-ons</h3>
                <div style={{ display: 'grid', gap: '0.5rem' }}>
                  {filteredAddons.map(addon => (
                    <label key={addon.id} style={{
                      display: 'flex', alignItems: 'flex-start', gap: '0.75rem', padding: '0.5rem 0.75rem',
                      borderRadius: '6px', cursor: 'pointer',
                      background: form.addon_ids.includes(addon.id) ? 'var(--cream-light, #faf5ef)' : 'transparent'
                    }}>
                      <input type="checkbox" checked={form.addon_ids.includes(addon.id)} onChange={() => toggleAddon(addon.id)}
                        style={{ marginTop: '0.2rem' }}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 500, color: 'var(--deep-brown)' }}>{addon.name}</div>
                        <div className="text-muted text-small">
                          {addon.billing_type === 'per_guest' && `$${Number(addon.rate)}/guest`}
                          {addon.billing_type === 'per_guest_timed' && `$${Number(addon.rate)}/guest (4hr) + $${Number(addon.extra_hour_rate)}/guest/hr after`}
                          {addon.billing_type === 'per_hour' && `$${Number(addon.rate)}/hr`}
                          {addon.billing_type === 'flat' && `$${Number(addon.rate)} flat`}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right: Pricing Preview (sticky) */}
          <div style={{ position: 'sticky', top: '1rem' }}>
            <div className="card">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>Pricing Preview</h3>
              {preview ? (
                <>
                  <PricingBreakdown snapshot={preview} compact />
                  <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'var(--cream-light, #faf5ef)', borderRadius: '6px' }}>
                    <div className="text-small text-muted">
                      {preview.staffing.actual} bartender{preview.staffing.actual !== 1 ? 's' : ''} · {preview.inputs.numBars} bar{preview.inputs.numBars !== 1 ? 's' : ''}
                      {preview.staffing.extra > 0 && ` (${preview.staffing.extra} extra)`}
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-muted text-small">Select a package to see pricing</p>
              )}
              <button className="btn mt-2" type="submit" disabled={submitting} style={{ width: '100%' }}>
                {submitting ? 'Creating...' : 'Create Proposal'}
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

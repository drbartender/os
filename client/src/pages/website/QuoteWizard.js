import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

const API_BASE = process.env.REACT_APP_API_URL || '';

// 30-minute time slots from 8 AM to 11 PM
const TIME_OPTIONS = [];
for (let h = 8; h < 23; h++) {
  ['00', '30'].forEach(m => {
    const val = `${String(h).padStart(2, '0')}:${m}`;
    const hour12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
    const ampm = h >= 12 ? 'PM' : 'AM';
    TIME_OPTIONS.push({ value: val, label: `${hour12}:${m} ${ampm}` });
  });
}

// Build the dynamic step list based on alcohol choice
function getSteps(alcoholProvider) {
  const steps = [{ key: 'event', label: 'Event Details' }];
  // BYOB and mocktail auto-select their package, skip package step
  if (alcoholProvider === 'hosted') {
    steps.push({ key: 'package', label: 'Package' });
  }
  steps.push({ key: 'addons', label: 'Extras' });
  steps.push({ key: 'contact', label: 'Your Info' });
  return steps;
}

export default function QuoteWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [packages, setPackages] = useState([]);
  const [addons, setAddons] = useState([]);
  const [preview, setPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(null);

  const [form, setForm] = useState({
    guest_count: 50,
    event_duration_hours: 4,
    event_date: '',
    event_start_time: '17:00',
    event_name: '',
    event_location: '',
    alcohol_provider: '',   // 'byob' | 'hosted' | 'mocktail'
    bar_type: '',           // 'full_bar' | 'beer_and_wine' (set in package step)
    needs_bar: false,
    package_id: '',
    addon_ids: [],
    client_name: '',
    client_email: '',
    client_phone: '',
  });

  const steps = getSteps(form.alcohol_provider);

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/api/proposals/public/packages`).then(r => { if (!r.ok) throw new Error('Failed to load packages'); return r.json(); }),
      fetch(`${API_BASE}/api/proposals/public/addons`).then(r => { if (!r.ok) throw new Error('Failed to load addons'); return r.json(); }),
    ]).then(([pkgs, adds]) => {
      if (Array.isArray(pkgs)) setPackages(pkgs);
      if (Array.isArray(adds)) setAddons(adds);
    }).catch(err => console.error('Failed to load packages:', err));
  }, []);

  // Auto-select package for BYOB and mocktail paths
  useEffect(() => {
    if (form.alcohol_provider === 'byob') {
      const corePkg = packages.find(p => p.bar_type === 'service_only');
      if (corePkg && form.package_id !== String(corePkg.id)) {
        setForm(f => ({ ...f, package_id: String(corePkg.id), addon_ids: [] }));
      }
    } else if (form.alcohol_provider === 'mocktail') {
      const mocktailPkg = packages.find(p => p.bar_type === 'mocktail');
      if (mocktailPkg && form.package_id !== String(mocktailPkg.id)) {
        setForm(f => ({ ...f, package_id: String(mocktailPkg.id), addon_ids: [] }));
      }
    }
  }, [form.alcohol_provider, form.package_id, packages]);

  const numBars = form.needs_bar ? 1 : 0;

  const fetchPreview = useCallback(async () => {
    if (!form.package_id) { setPreview(null); return; }
    try {
      const res = await fetch(`${API_BASE}/api/proposals/public/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          package_id: Number(form.package_id),
          guest_count: Number(form.guest_count) || 50,
          duration_hours: Number(form.event_duration_hours) || 4,
          num_bars: numBars,
          addon_ids: form.addon_ids.map(Number),
        }),
      });
      if (!res.ok) { setPreview(null); return; }
      const data = await res.json();
      if (data && data.total != null) setPreview(data);
      else setPreview(null);
    } catch { setPreview(null); }
  }, [form.package_id, form.guest_count, form.event_duration_hours, numBars, form.addon_ids]);

  useEffect(() => { fetchPreview(); }, [fetchPreview]);

  const update = (field, value) => setForm(f => ({ ...f, [field]: value }));

  const toggleAddon = (id) => {
    setForm(f => ({
      ...f,
      addon_ids: f.addon_ids.includes(id) ? f.addon_ids.filter(a => a !== id) : [...f.addon_ids, id]
    }));
  };

  // When alcohol_provider changes, reset downstream selections
  const handleAlcoholChange = (value) => {
    setForm(f => ({
      ...f,
      alcohol_provider: value,
      bar_type: '',
      package_id: '',
      addon_ids: [],
    }));
  };

  // When bar_type changes in the package step, reset package and addons
  const handleBarTypeChange = (value) => {
    setForm(f => ({
      ...f,
      bar_type: value,
      package_id: '',
      addon_ids: [],
    }));
  };

  const selectedPkg = packages.find(p => p.id === Number(form.package_id));
  const isHosted = selectedPkg && selectedPkg.pricing_type === 'per_guest';

  // Filter packages for the package selection step
  const filteredPackages = packages.filter(p => {
    if (p.bar_type === 'class') return false;
    if (form.bar_type) return p.bar_type === form.bar_type;
    return false;
  });

  const filteredAddons = addons.filter(a => {
    if (a.applies_to !== 'all' && (!selectedPkg || a.applies_to !== selectedPkg.category)) return false;
    if (isHosted && /bartender/i.test((a.name || '') + (a.slug || ''))) return false;
    return true;
  });

  // Determine current step key
  const currentStepKey = steps[step]?.key;

  const canAdvance = () => {
    switch (currentStepKey) {
      case 'event': {
        if (Number(form.guest_count) < 1 || Number(form.event_duration_hours) < 1) return false;
        if (!form.alcohol_provider) return false;
        return true;
      }
      case 'package': return !!form.package_id;
      case 'addons': return true;
      case 'contact': return form.client_name.trim() && form.client_email.trim();
      default: return false;
    }
  };

  const handleSubmit = async () => {
    if (!form.client_name.trim() || !form.client_email.trim()) {
      setError('Name and email are required.');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/proposals/public/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: form.client_name.trim(),
          client_email: form.client_email.trim(),
          client_phone: form.client_phone || null,
          event_name: form.event_name || null,
          event_date: form.event_date || null,
          event_start_time: form.event_start_time || null,
          event_duration_hours: Number(form.event_duration_hours) || 4,
          event_location: form.event_location || null,
          guest_count: Number(form.guest_count) || 50,
          package_id: Number(form.package_id),
          num_bars: numBars,
          addon_ids: form.addon_ids.map(Number),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit quote.');
      setSuccess(data);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const formatCurrency = (amount) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

  if (success) {
    return (
      <section className="wz-section" id="quote">
        <div className="wz-success">
          <div className="wz-success-icon">&#10003;</div>
          <h2>Your quote is ready!</h2>
          <p>
            Estimated total: <strong>{formatCurrency(success.total)}</strong>
          </p>
          <p>We've sent the full proposal to your email. You can also view it now:</p>
          <button
            className="btn btn-primary"
            onClick={() => navigate(`/proposal/${success.token}`)}
            style={{ marginTop: '1rem' }}
          >
            View Your Proposal
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="wz-section" id="quote">
      <div className="ws-section-heading">
        <p className="ws-kicker">Get Your Quote</p>
        <h2>Instant pricing for your event</h2>
        <p className="ws-section-sub">Answer a few questions and get a real quote — no waiting, no back-and-forth.</p>
      </div>

      {/* Step indicators */}
      <div className="wz-steps">
        {steps.map((s, i) => (
          <button
            key={s.key}
            className={`wz-step-dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
            onClick={() => i < step && setStep(i)}
            disabled={i > step}
          >
            <span className="wz-step-num">{i < step ? '\u2713' : i + 1}</span>
            <span className="wz-step-label">{s.label}</span>
          </button>
        ))}
      </div>

      <div className="wz-body">
        <div className="wz-form-area">
          {/* Step: Event Details */}
          {currentStepKey === 'event' && (
            <div className="wz-card">
              <h3>Tell us about your event</h3>
              <div className="wz-grid">
                <div className="form-group">
                  <label className="form-label">Guest Count *</label>
                  <input className="form-input" type="number" min="1" max="1000"
                    value={form.guest_count} onChange={e => update('guest_count', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Duration (hours) *</label>
                  <input className="form-input" type="number" min="1" max="12" step="0.5"
                    value={form.event_duration_hours} onChange={e => update('event_duration_hours', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Event Date</label>
                  <input className="form-input" type="date" value={form.event_date}
                    min={new Date().toISOString().split('T')[0]}
                    onChange={e => update('event_date', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Start Time</label>
                  <select className="form-select" value={form.event_start_time}
                    onChange={e => update('event_start_time', e.target.value)}>
                    <option value="">-- Select --</option>
                    {TIME_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">Event Location</label>
                  <input className="form-input" value={form.event_location}
                    onChange={e => update('event_location', e.target.value)} placeholder="City or venue name" />
                </div>

                {/* Alcohol provider */}
                <div className="form-group">
                  <label className="form-label">Who provides the alcohol? *</label>
                  <select className="form-select" value={form.alcohol_provider}
                    onChange={e => handleAlcoholChange(e.target.value)}>
                    <option value="">-- Select --</option>
                    <option value="byob">I'll provide the alcohol</option>
                    <option value="hosted">Dr. Bartender provides the alcohol</option>
                    <option value="mocktail">No alcohol (mocktails only)</option>
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Need a Portable Bar?</label>
                  <select className="form-select" value={form.needs_bar ? 'yes' : 'no'}
                    onChange={e => update('needs_bar', e.target.value === 'yes')}>
                    <option value="no">No - venue has a bar</option>
                    <option value="yes">Yes - bring one</option>
                  </select>
                </div>
              </div>

              {/* Cocktail class link */}
              <p className="wz-class-link">
                Looking for a cocktail class? <a href="/quote/class">Book a Doctor's Orders session</a>
              </p>
            </div>
          )}

          {/* Step: Package Selection (hosted only) */}
          {currentStepKey === 'package' && (
            <div className="wz-card">
              {/* Bar type picker */}
              {!form.bar_type ? (
                <>
                  <h3>What are you serving?</h3>
                  <div className="wz-choice-group wz-choice-group-lg">
                    <button type="button" className="wz-choice-btn"
                      onClick={() => handleBarTypeChange('full_bar')}>
                      <strong>Full bar with cocktails</strong>
                      <span>Spirits, beer, wine, and mixed drinks</span>
                    </button>
                    <button type="button" className="wz-choice-btn"
                      onClick={() => handleBarTypeChange('beer_and_wine')}>
                      <strong>Beer &amp; wine only</strong>
                      <span>No liquor or mixed drinks</span>
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="wz-package-header">
                    <h3>Choose your package</h3>
                    <button type="button" className="wz-change-type"
                      onClick={() => handleBarTypeChange('')}>
                      Change bar type
                    </button>
                  </div>
                  <div className="wz-pkg-list">
                    {filteredPackages.map(pkg => (
                      <label key={pkg.id} className={`wz-pkg-option ${Number(form.package_id) === pkg.id ? 'selected' : ''}`}>
                        <input type="radio" name="package" value={pkg.id}
                          checked={Number(form.package_id) === pkg.id}
                          onChange={e => { update('package_id', e.target.value); update('addon_ids', []); }}
                        />
                        <div className="wz-pkg-content">
                          <div className="wz-pkg-name">{pkg.name}</div>
                          {pkg.description && <div className="wz-pkg-desc">{pkg.description}</div>}
                          <div className="wz-pkg-price">
                            {pkg.pricing_type === 'per_guest' ? (
                              <>From ${Number(pkg.base_rate_4hr)}/guest</>
                            ) : (
                              <>From ${Number(pkg.base_rate_3hr || pkg.base_rate_4hr)}{pkg.base_rate_3hr ? '/3hr' : '/4hr'}</>
                            )}
                          </div>
                          {pkg.includes && (
                            <div className="wz-pkg-includes">{pkg.includes}</div>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step: Add-ons */}
          {currentStepKey === 'addons' && (
            <div className="wz-card">
              <h3>Any extras?</h3>
              {filteredAddons.length > 0 ? (
                <div className="wz-addon-list">
                  {filteredAddons.map(addon => (
                    <label key={addon.id} className={`wz-addon-option ${form.addon_ids.includes(addon.id) ? 'selected' : ''}`}>
                      <input type="checkbox" checked={form.addon_ids.includes(addon.id)}
                        onChange={() => toggleAddon(addon.id)} />
                      <div className="wz-addon-content">
                        <div className="wz-addon-name">{addon.name}</div>
                        <div className="wz-addon-price">
                          {addon.billing_type === 'per_guest' && `$${Number(addon.rate)}/guest`}
                          {addon.billing_type === 'per_guest_timed' && `$${Number(addon.rate)}/guest`}
                          {addon.billing_type === 'per_hour' && `$${Number(addon.rate)}/hr`}
                          {addon.billing_type === 'flat' && `$${Number(addon.rate)} flat`}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="wz-no-addons">No add-ons available for this package. You can skip this step.</p>
              )}
            </div>
          )}

          {/* Step: Contact Info */}
          {currentStepKey === 'contact' && (
            <div className="wz-card">
              <h3>Where should we send your proposal?</h3>
              <div className="wz-grid">
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">Your Name *</label>
                  <input className="form-input" value={form.client_name}
                    onChange={e => update('client_name', e.target.value)} placeholder="Jane Smith" />
                </div>
                <div className="form-group">
                  <label className="form-label">Email *</label>
                  <input className="form-input" type="email" value={form.client_email}
                    onChange={e => update('client_email', e.target.value)} placeholder="jane@example.com" />
                </div>
                <div className="form-group">
                  <label className="form-label">Phone</label>
                  <input className="form-input" type="tel" value={form.client_phone}
                    onChange={e => update('client_phone', e.target.value)} placeholder="(312) 555-1234" />
                </div>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">Event Name</label>
                  <input className="form-input" value={form.event_name}
                    onChange={e => update('event_name', e.target.value)} placeholder="Smith Wedding Reception" />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Pricing sidebar */}
        <div className="wz-sidebar">
          <div className="wz-price-card">
            <h4>Your Estimate</h4>
            {preview ? (
              <>
                <div className="wz-price-total">{formatCurrency(preview.total)}</div>
                <div className="wz-price-breakdown">
                  {preview.breakdown.map((item, i) => (
                    <div key={i} className="wz-price-line">
                      <span>{item.label}</span>
                      <span>{formatCurrency(item.amount)}</span>
                    </div>
                  ))}
                </div>
                <div className="wz-price-meta">
                  {preview.staffing.actual} bartender{preview.staffing.actual !== 1 ? 's' : ''} included
                </div>
              </>
            ) : (
              <p className="wz-price-empty">Select a package to see pricing</p>
            )}
          </div>
        </div>
      </div>

      {error && <div className="wz-error">{error}</div>}

      {/* Navigation */}
      <div className="wz-nav">
        {step > 0 && (
          <button className="btn btn-secondary" type="button" onClick={() => setStep(s => s - 1)}>
            Back
          </button>
        )}
        <div style={{ flex: 1 }} />
        {step < steps.length - 1 ? (
          <button className="btn btn-primary" type="button" disabled={!canAdvance()}
            onClick={() => setStep(s => s + 1)}>
            Next
          </button>
        ) : (
          <button className="btn btn-primary" type="button" disabled={!canAdvance() || submitting}
            onClick={handleSubmit}>
            {submitting ? 'Submitting...' : 'Get My Quote'}
          </button>
        )}
      </div>
    </section>
  );
}

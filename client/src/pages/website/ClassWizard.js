import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import { useToast } from '../../context/ToastContext';
import useWizardHistory from '../../hooks/useWizardHistory';

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

const STEPS = [
  { key: 'class', label: 'Choose Class' },
  { key: 'details', label: 'Details' },
  { key: 'extras', label: 'Equipment' },
  { key: 'contact', label: 'Your Info' },
];

// Tool kit purchase and rental are mutually exclusive
const TOOL_KIT_SLUGS = ['class-tool-kit-purchase', 'class-tool-kit-rental'];

export default function ClassWizard() {
  const navigate = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const { replaceStep } = useWizardHistory(step, setStep);
  const [packages, setPackages] = useState([]);
  const [addons, setAddons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [success, setSuccess] = useState(null);
  const [topShelf, setTopShelf] = useState(false);

  const [form, setForm] = useState({
    package_id: '',
    spirit_category: '',     // 'whiskey_bourbon' | 'tequila_mezcal' (Spirits Tasting only)
    guest_count: 10,
    event_duration_hours: 2,
    event_date: '',
    event_start_time: '18:00',
    event_location: '',
    supply_addon_id: '',     // selected supply add-on (or '' for BYOB)
    addon_ids: [],           // equipment add-ons
    client_name: '',
    client_email: '',
    client_phone: '',
  });

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/api/proposals/public/packages`).then(r => { if (!r.ok) throw new Error('Failed to load'); return r.json(); }),
      fetch(`${API_BASE}/api/proposals/public/addons`).then(r => { if (!r.ok) throw new Error('Failed to load'); return r.json(); }),
    ]).then(([pkgs, adds]) => {
      if (Array.isArray(pkgs)) setPackages(pkgs.filter(p => p.bar_type === 'class'));
      if (Array.isArray(adds)) setAddons(adds.filter(a => a.applies_to === 'class'));
    }).catch(err => {
      console.error('Failed to load class data:', err);
      toast.error('Failed to load classes. Try refreshing the page.');
    }).finally(() => {
      setLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedPkg = packages.find(p => p.id === Number(form.package_id));
  const isSpirits = selectedPkg && selectedPkg.slug === 'spirits-tasting';

  // Supply add-ons linked to the selected package
  const supplyAddons = addons.filter(a => a.linked_package_id && selectedPkg && a.linked_package_id === selectedPkg.id);

  // Equipment add-ons (not linked to any specific package)
  const equipmentAddons = addons.filter(a => !a.linked_package_id);

  // All addon IDs to send to the API (supply + equipment)
  const allAddonIds = [
    ...(form.supply_addon_id ? [Number(form.supply_addon_id)] : []),
    ...form.addon_ids.map(Number),
  ];

  const numBars = 0; // classes don't include bar rental in base — it's an addon

  const fetchPreview = useCallback(async () => {
    if (!form.package_id || topShelf) { setPreview(null); return; }
    try {
      const res = await fetch(`${API_BASE}/api/proposals/public/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          package_id: Number(form.package_id),
          guest_count: Number(form.guest_count) || 10,
          duration_hours: Number(form.event_duration_hours) || 2,
          num_bars: numBars,
          addon_ids: allAddonIds,
        }),
      });
      if (!res.ok) { setPreview(null); return; }
      const data = await res.json();
      if (data && data.total != null) setPreview(data);
      else setPreview(null);
    } catch { setPreview(null); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.package_id, form.guest_count, form.event_duration_hours, form.supply_addon_id, form.addon_ids, topShelf]);

  useEffect(() => { fetchPreview(); }, [fetchPreview]);

  const update = (field, value) => setForm(f => ({ ...f, [field]: value }));

  const toggleEquipmentAddon = (id) => {
    const addon = addons.find(a => a.id === id);
    if (!addon) return;

    setForm(f => {
      let newIds = [...f.addon_ids];

      // If selecting a tool kit, remove the other one (mutually exclusive)
      if (TOOL_KIT_SLUGS.includes(addon.slug)) {
        const otherSlug = TOOL_KIT_SLUGS.find(s => s !== addon.slug);
        const otherId = addons.find(a => a.slug === otherSlug)?.id;
        if (otherId) newIds = newIds.filter(a => a !== otherId);
      }

      if (newIds.includes(id)) {
        newIds = newIds.filter(a => a !== id);
      } else {
        newIds.push(id);
      }
      return { ...f, addon_ids: newIds };
    });
  };

  const handleClassSelect = (pkgId) => {
    setForm(f => ({
      ...f,
      package_id: String(pkgId),
      supply_addon_id: '',
      spirit_category: '',
    }));
    setTopShelf(false);
  };

  const handleSupplySelect = (addonId) => {
    setTopShelf(false);
    setForm(f => ({ ...f, supply_addon_id: addonId }));
  };

  const handleTopShelf = () => {
    setTopShelf(true);
    setForm(f => ({ ...f, supply_addon_id: '' }));
  };

  const currentStepKey = STEPS[step]?.key;

  const canAdvance = () => {
    switch (currentStepKey) {
      case 'class': return !!form.package_id && (!isSpirits || !!form.spirit_category);
      case 'details': {
        const gc = Number(form.guest_count);
        return gc >= 8 && gc <= 20;
      }
      case 'extras': return true;
      case 'contact': return form.client_name.trim() && form.client_email.trim();
      default: return false;
    }
  };

  const handleSubmit = async () => {
    setError('');
    setFieldErrors({});
    const fe = {};
    if (!form.client_name.trim()) fe.client_name = 'Name is required.';
    if (!form.client_email.trim()) fe.client_email = 'Email is required.';
    if (Object.keys(fe).length > 0) {
      setFieldErrors(fe);
      setError('Please fix the errors below.');
      return;
    }
    setSubmitting(true);
    try {
      const classOptions = {};
      if (isSpirits && form.spirit_category) {
        classOptions.spirit_category = form.spirit_category;
      }
      if (topShelf) {
        classOptions.top_shelf_requested = true;
      }

      const res = await fetch(`${API_BASE}/api/proposals/public/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: form.client_name.trim(),
          client_email: form.client_email.trim(),
          client_phone: form.client_phone || null,
          event_type: 'cocktail-class',
          event_type_category: 'class',
          event_type_custom: null,
          event_date: form.event_date || null,
          event_start_time: form.event_start_time || null,
          event_duration_hours: Number(form.event_duration_hours) || 2,
          event_location: form.event_location || null,
          guest_count: Number(form.guest_count) || 10,
          package_id: Number(form.package_id),
          num_bars: numBars,
          addon_ids: allAddonIds,
          class_options: Object.keys(classOptions).length > 0 ? classOptions : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const err = new Error(data.error || 'Failed to submit quote.');
        err.fieldErrors = data.fieldErrors;
        throw err;
      }
      toast.success('Class request submitted!');
      setSuccess(data);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setSubmitting(false);
    }
  };

  const formatCurrency = (amount) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

  if (success) {
    return (
      <PublicLayout>
      <div className="wz-class-page">
        <div className="wz-section">
          <div className="wz-success">
            <div className="wz-success-icon">&#10003;</div>
            <h2>{topShelf ? 'Request submitted!' : 'Your quote is ready!'}</h2>
            {topShelf ? (
              <p>We'll follow up with custom Top Shelf pricing. Check your email for details.</p>
            ) : (
              <>
                <p>Estimated total: <strong>{formatCurrency(success.total)}</strong></p>
                <p>We've sent the full proposal to your email. You can also view it now:</p>
              </>
            )}
            <button
              className="btn btn-primary"
              onClick={() => navigate(`/proposal/${success.token}`)}
              style={{ marginTop: '1rem' }}
            >
              View Your Proposal
            </button>
          </div>
        </div>
      </div>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout>
    <div className="wz-class-page">
      <div className="wz-section">
        <div className="ws-section-heading">
          <Link to="/quote" className="wz-back-link">&larr; Back to event quotes</Link>
          <p className="ws-kicker">Mixology Classes</p>
          <h2>Book a hands-on cocktail class</h2>
          <p className="ws-section-sub">$35/person &middot; 8-20 guests &middot; 2 hours &middot; All classes include digital recipe cards via QR code</p>
        </div>

        {/* Step indicators */}
        <div className="wz-steps">
          {STEPS.map((s, i) => (
            <button
              key={s.key}
              className={`wz-step-dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
              onClick={() => i < step && replaceStep(i)}
              disabled={i > step}
            >
              <span className="wz-step-num">{i < step ? '\u2713' : i + 1}</span>
              <span className="wz-step-label">{s.label}</span>
            </button>
          ))}
        </div>

        <div className="wz-body">
          <div className="wz-form-area">
            {/* Step 1: Choose Your Class */}
            {currentStepKey === 'class' && (
              <div className="wz-card">
                <h3>Pick your class</h3>
                {loading ? (
                  <p className="wz-no-addons">Loading classes...</p>
                ) : packages.length === 0 ? (
                  <p className="wz-no-addons">No classes available right now. Please try refreshing.</p>
                ) : (
                  <div className="wz-class-grid">
                    {packages.map(pkg => (
                      <button
                        key={pkg.id}
                        type="button"
                        className={`wz-class-card ${Number(form.package_id) === pkg.id ? 'selected' : ''}`}
                        onClick={() => handleClassSelect(pkg.id)}
                      >
                        <div className="wz-class-card-name">{pkg.name}</div>
                        <div className="wz-class-card-desc">{pkg.description}</div>
                        <div className="wz-class-card-price">${Number(pkg.base_rate_4hr)}/person</div>
                      </button>
                    ))}
                  </div>
                )}

                {/* Spirits Tasting sub-option */}
                {isSpirits && (
                  <div className="wz-spirit-choice">
                    <label className="form-label">Choose your tasting category *</label>
                    <div className="wz-choice-group">
                      <button type="button"
                        className={`wz-choice-btn ${form.spirit_category === 'whiskey_bourbon' ? 'selected' : ''}`}
                        onClick={() => update('spirit_category', 'whiskey_bourbon')}>
                        <strong>Whiskey &amp; Bourbon</strong>
                        <span>4-5 selections, nosing techniques, flavor profiles</span>
                      </button>
                      <button type="button"
                        className={`wz-choice-btn ${form.spirit_category === 'tequila_mezcal' ? 'selected' : ''}`}
                        onClick={() => update('spirit_category', 'tequila_mezcal')}>
                        <strong>Tequila &amp; Mezcal</strong>
                        <span>4-5 selections, blanco/reposado/a&ntilde;ejo education</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Supply upgrade selection — shown once a class is selected */}
                {selectedPkg && (
                  <div className="wz-supply-section">
                    <h4>Want us to provide the spirits &amp; supplies?</h4>
                    <p className="wz-supply-hint">BYOB is always an option — you bring the alcohol, we bring everything else.</p>

                    <div className="wz-supply-options">
                      <label className={`wz-supply-option ${!form.supply_addon_id && !topShelf ? 'selected' : ''}`}>
                        <input type="radio" name="supply" checked={!form.supply_addon_id && !topShelf}
                          onChange={() => handleSupplySelect('')} />
                        <div className="wz-supply-content">
                          <div className="wz-supply-name">BYOB — I'll provide the alcohol</div>
                          <div className="wz-supply-price">Included in base price</div>
                        </div>
                      </label>

                      {supplyAddons.map(addon => (
                        <label key={addon.id} className={`wz-supply-option ${form.supply_addon_id === String(addon.id) ? 'selected' : ''}`}>
                          <input type="radio" name="supply" value={addon.id}
                            checked={form.supply_addon_id === String(addon.id)}
                            onChange={() => handleSupplySelect(String(addon.id))} />
                          <div className="wz-supply-content">
                            <div className="wz-supply-name">{addon.name}</div>
                            <div className="wz-supply-desc">{addon.description}</div>
                            <div className="wz-supply-price">+${Number(addon.rate)}/person</div>
                          </div>
                        </label>
                      ))}

                      {/* Top Shelf option for Spirits Tasting */}
                      {isSpirits && (
                        <label className={`wz-supply-option wz-supply-topshelf ${topShelf ? 'selected' : ''}`}>
                          <input type="radio" name="supply" checked={topShelf}
                            onChange={handleTopShelf} />
                          <div className="wz-supply-content">
                            <div className="wz-supply-name">Top Shelf</div>
                            <div className="wz-supply-desc">
                              Whiskey: Blanton's, Whistlepig, allocated selections. Tequila: Clase Azul, Don Julio 1942.
                            </div>
                            <div className="wz-supply-price wz-contact-cta">Custom pricing — we'll follow up</div>
                          </div>
                        </label>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Step 2: Class Details */}
            {currentStepKey === 'details' && (
              <div className="wz-card">
                <h3>Class details</h3>
                <div className="wz-grid">
                  <div className="form-group">
                    <label className="form-label">Guest Count * (8-20)</label>
                    <input className="form-input" type="number" min="8" max="20"
                      value={form.guest_count} onChange={e => update('guest_count', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Duration</label>
                    <div className="form-input wz-fixed-value">2 hours</div>
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
                    <label className="form-label">Location</label>
                    <input className="form-input" value={form.event_location}
                      onChange={e => update('event_location', e.target.value)} placeholder="City or venue name" />
                  </div>
                </div>

                {/* Supply selection summary */}
                {form.supply_addon_id && (
                  <div className="wz-supply-summary">
                    Selected: {addons.find(a => a.id === Number(form.supply_addon_id))?.name || 'Supply upgrade'}
                    {' '}<button type="button" className="wz-change-type" onClick={() => replaceStep(0)}>Change</button>
                  </div>
                )}
              </div>
            )}

            {/* Step 3: Equipment & Extras */}
            {currentStepKey === 'extras' && (
              <div className="wz-card">
                <h3>Equipment &amp; extras</h3>
                <p className="wz-equipment-hint">Optional add-ons for your class. Hosts should plan for table or counter space for guests to work.</p>

                {equipmentAddons.length > 0 ? (
                  <div className="wz-addon-list">
                    {equipmentAddons.map(addon => {
                      const isToolKit = TOOL_KIT_SLUGS.includes(addon.slug);
                      return (
                        <label key={addon.id} className={`wz-addon-option ${form.addon_ids.includes(addon.id) ? 'selected' : ''}`}>
                          <input
                            type={isToolKit ? 'radio' : 'checkbox'}
                            name={isToolKit ? 'tool-kit' : undefined}
                            checked={form.addon_ids.includes(addon.id)}
                            onChange={() => toggleEquipmentAddon(addon.id)}
                          />
                          <div className="wz-addon-content">
                            <div className="wz-addon-name">{addon.name}</div>
                            {addon.description && <div className="wz-addon-desc">{addon.description}</div>}
                            <div className="wz-addon-price">
                              {addon.billing_type === 'per_guest' && `$${Number(addon.rate)}/person`}
                              {addon.billing_type === 'flat' && `$${Number(addon.rate)} flat`}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="wz-no-addons">No equipment add-ons available. You can skip this step.</p>
                )}
              </div>
            )}

            {/* Step 4: Contact Info */}
            {currentStepKey === 'contact' && (
              <div className="wz-card">
                <h3>Where should we send your proposal?</h3>
                <div className="wz-grid">
                  <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                    <label className="form-label">Your Name *</label>
                    <input className="form-input" value={form.client_name}
                      onChange={e => { update('client_name', e.target.value); if (fieldErrors.client_name) setFieldErrors(fe => ({ ...fe, client_name: undefined })); }}
                      placeholder="Jane Smith"
                      aria-invalid={!!fieldErrors?.client_name} />
                    <FieldError error={fieldErrors?.client_name} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Email *</label>
                    <input className="form-input" type="email" value={form.client_email}
                      onChange={e => { update('client_email', e.target.value); if (fieldErrors.client_email) setFieldErrors(fe => ({ ...fe, client_email: undefined })); }}
                      placeholder="jane@example.com"
                      aria-invalid={!!fieldErrors?.client_email} />
                    <FieldError error={fieldErrors?.client_email} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Phone</label>
                    <input className="form-input" type="tel" value={form.client_phone}
                      onChange={e => update('client_phone', e.target.value)} placeholder="(312) 555-1234" />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Pricing sidebar */}
          <div className="wz-sidebar">
            <div className="wz-price-card">
              <h4>Your Estimate</h4>
              {topShelf ? (
                <>
                  <div className="wz-price-total wz-price-custom">Custom Quote</div>
                  <p className="wz-price-empty">Top Shelf pricing varies by selection. We'll follow up with a custom quote after you submit.</p>
                </>
              ) : preview ? (
                <>
                  <div className="wz-price-total">{formatCurrency(preview.total)}</div>
                  <div className="wz-price-breakdown">
                    {preview.breakdown.map((item, i) => (
                      <div key={i} className="wz-price-line">
                        <span>{item.label.replace(/bartender/gi, 'instructor')}</span>
                        <span>{formatCurrency(item.amount)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="wz-price-meta">
                    {preview.staffing.actual} instructor{preview.staffing.actual !== 1 ? 's' : ''} included
                  </div>
                </>
              ) : (
                <p className="wz-price-empty">Select a class to see pricing</p>
              )}
            </div>
          </div>
        </div>

        <FormBanner error={error} fieldErrors={fieldErrors} />

        {/* Navigation */}
        <div className="wz-nav">
          {step > 0 && (
            <button className="btn btn-secondary" type="button" onClick={() => setStep(s => s - 1)}>
              Back
            </button>
          )}
          <div style={{ flex: 1 }} />
          {step < STEPS.length - 1 ? (
            <button className="btn btn-primary" type="button" disabled={!canAdvance()}
              onClick={() => setStep(s => s + 1)}>
              Next
            </button>
          ) : (
            <button className="btn btn-primary" type="button" disabled={!canAdvance() || submitting}
              onClick={handleSubmit}>
              {submitting ? 'Submitting...' : topShelf ? 'Request Custom Quote' : 'Get My Quote'}
            </button>
          )}
        </div>
      </div>
    </div>
    </PublicLayout>
  );
}

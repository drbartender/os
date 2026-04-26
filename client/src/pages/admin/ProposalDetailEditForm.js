import React, { useEffect, useMemo, useRef, useState } from 'react';
import { unstable_usePrompt as usePrompt } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { formatPhoneInput, stripPhone } from '../../utils/formatPhone';
import LocationInput from '../../components/LocationInput';
import SyrupPicker from '../../components/SyrupPicker';
import ConfirmModal from '../../components/ConfirmModal';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import TimePicker from '../../components/TimePicker';
import NumberStepper from '../../components/NumberStepper';
import PricingBreakdown from '../../components/PricingBreakdown';
import Icon from '../../components/adminos/Icon';
import { PACKAGE_EXCLUDED_ADDONS } from '../../data/addonCategories';

// Self-contained edit form for ProposalDetail. Owns:
//  - editForm state, dirty tracking, leave-confirm modal, beforeunload guard
//  - package & addon catalog fetch
//  - debounced live pricing preview
//  - hosted-package bartender filter (CLAUDE.md "Hosted-package bartender rule")
//
// Parent passes the current proposal and callbacks. After a successful save
// onSaved() is fired so the parent can reload and exit edit mode.
export default function ProposalDetailEditForm({ proposal, onSaved, onCancel }) {
  const toast = useToast();
  const [packages, setPackages] = useState([]);
  const [addons, setAddons] = useState([]);
  const [editForm, setEditForm] = useState(() => initialFormFromProposal(proposal));
  const [editPreview, setEditPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const initialRef = useRef(JSON.stringify(initialFormFromProposal(proposal)));

  // Load packages + addons
  useEffect(() => {
    Promise.all([
      api.get('/proposals/packages'),
      api.get('/proposals/addons'),
    ]).then(([pkgRes, addonRes]) => {
      setPackages(pkgRes.data);
      setAddons(addonRes.data);
    }).catch(() => {
      toast.error('Failed to load packages. Try refreshing.');
      setError('Failed to load packages/addons. Please try again.');
    });
  }, []); // eslint-disable-line

  // Debounced live pricing preview
  useEffect(() => {
    if (!editForm.package_id) {
      setEditPreview(null);
      return;
    }
    const timer = setTimeout(() => {
      api.post('/proposals/calculate', {
        package_id: Number(editForm.package_id),
        guest_count: Number(editForm.guest_count) || 50,
        duration_hours: Number(editForm.event_duration_hours) || 4,
        num_bars: Number(editForm.num_bars) || 0,
        addon_ids: (editForm.addon_ids || []).map(Number),
        addon_variants: editForm.addon_variants || {},
        syrup_selections: editForm.syrup_selections || [],
        adjustments: editForm.adjustments || [],
        total_price_override: editForm.total_price_override,
      })
        .then(res => { setEditPreview(res.data); setError(''); })
        .catch(err => {
          setEditPreview(null);
          setError(err?.message || 'Pricing preview unavailable.');
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [
    editForm.package_id,
    editForm.guest_count,
    editForm.event_duration_hours,
    editForm.num_bars,
    editForm.addon_ids,
    editForm.addon_variants,
    editForm.syrup_selections,
    editForm.adjustments,
    editForm.total_price_override,
  ]);

  const isDirty = useMemo(
    () => JSON.stringify(editForm) !== initialRef.current,
    [editForm]
  );

  // Browser refresh / close guard
  useEffect(() => {
    const handler = (e) => { if (isDirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // In-app navigation guard (sidebar links, breadcrumbs, browser back/forward).
  // Pairs with the beforeunload handler above — that one covers refresh/close,
  // this one covers SPA navigation that wouldn't trigger beforeunload.
  usePrompt({
    when: isDirty,
    message: 'You have unsaved changes. Leave anyway?',
  });

  const update = (field, value) => setEditForm(f => ({ ...f, [field]: value }));

  const clearFieldError = (name) => {
    if (fieldErrors[name]) {
      setFieldErrors(fe => {
        const next = { ...fe };
        delete next[name];
        return next;
      });
    }
  };

  const toggleAddon = (id) => {
    setEditForm(f => {
      const removing = f.addon_ids.includes(id);
      const variants = { ...f.addon_variants };
      if (removing) delete variants[String(id)];
      return {
        ...f,
        addon_ids: removing ? f.addon_ids.filter(a => a !== id) : [...f.addon_ids, id],
        addon_variants: variants,
      };
    });
  };

  const addAdjustment = (type) => {
    setEditForm(f => ({
      ...f,
      adjustments: [...(f.adjustments || []), { type, label: '', amount: '', visible: true }],
    }));
  };
  const updateAdjustment = (i, field, value) => {
    setEditForm(f => {
      const next = [...f.adjustments];
      next[i] = { ...next[i], [field]: value };
      return { ...f, adjustments: next };
    });
  };
  const removeAdjustment = (i) => {
    setEditForm(f => ({ ...f, adjustments: f.adjustments.filter((_, idx) => idx !== i) }));
  };

  const handleSave = async () => {
    if (!editForm.package_id) {
      setError('Please select a package.');
      setFieldErrors({ package_id: 'Please select a package' });
      return;
    }
    setError('');
    setFieldErrors({});
    setSaving(true);
    try {
      // Update client record if linked
      if (proposal.client_id) {
        await api.put(`/clients/${proposal.client_id}`, {
          name: editForm.client_name,
          email: editForm.client_email,
          phone: editForm.client_phone,
          source: editForm.client_source,
        });
      }
      // Update proposal
      const res = await api.patch(`/proposals/${proposal.id}`, {
        event_date: editForm.event_date,
        event_start_time: editForm.event_start_time,
        event_duration_hours: Number(editForm.event_duration_hours),
        event_location: editForm.event_location,
        guest_count: Number(editForm.guest_count),
        package_id: Number(editForm.package_id),
        num_bars: Number(editForm.num_bars) || 0,
        addon_ids: (editForm.addon_ids || []).map(Number),
        addon_variants: editForm.addon_variants || {},
        syrup_selections: editForm.syrup_selections || [],
        adjustments: editForm.adjustments || [],
        total_price_override: editForm.total_price_override,
      });
      toast.success('Proposal updated.');
      onSaved?.(res.data);
    } catch (err) {
      setError(err.message || 'Failed to save changes.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (isDirty) setShowLeaveConfirm(true);
    else onCancel?.();
  };

  // Derived state
  const selectedPkg = packages.find(p => p.id === Number(editForm.package_id));
  const isHostedPkg = selectedPkg && (selectedPkg.pricing_type === 'per_guest' || selectedPkg.pricing_type === 'per_guest_timed');
  const filteredAddons = addons.filter(a => {
    if (a.applies_to !== 'all' && (!selectedPkg || a.applies_to !== selectedPkg.category)) return false;
    if (isHostedPkg && /bartender/i.test((a.name || '') + (a.slug || ''))) return false;
    const excluded = selectedPkg && PACKAGE_EXCLUDED_ADDONS[selectedPkg.slug];
    if (excluded && excluded.includes(a.slug)) return false;
    return true;
  });

  return (
    <div className="card">
      <div className="card-head">
        <h3>Edit proposal</h3>
        <span className="k">Internal</span>
      </div>
      <div className="card-body">
        {/* Client */}
        <div className="meta-k" style={{ marginBottom: 8 }}>Client</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Name</label>
            <input className="input" style={{ width: '100%' }} value={editForm.client_name}
              onChange={e => { update('client_name', e.target.value); clearFieldError('name'); }}
              aria-invalid={!!fieldErrors?.name} />
            <FieldError error={fieldErrors?.name} />
          </div>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Email</label>
            <input className="input" type="email" style={{ width: '100%' }} value={editForm.client_email}
              onChange={e => { update('client_email', e.target.value); clearFieldError('email'); }}
              aria-invalid={!!fieldErrors?.email} />
            <FieldError error={fieldErrors?.email} />
          </div>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Phone</label>
            <input className="input" type="tel" style={{ width: '100%' }}
              value={formatPhoneInput(editForm.client_phone)}
              onChange={e => { update('client_phone', stripPhone(e.target.value)); clearFieldError('phone'); }}
              aria-invalid={!!fieldErrors?.phone} />
            <FieldError error={fieldErrors?.phone} />
          </div>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Source</label>
            <select className="select" style={{ width: '100%' }} value={editForm.client_source}
              onChange={e => update('client_source', e.target.value)}>
              <option value="thumbtack">Thumbtack</option>
              <option value="direct">Direct</option>
              <option value="referral">Referral</option>
              <option value="website">Website</option>
            </select>
          </div>
        </div>

        {/* Event */}
        <div className="meta-k" style={{ marginBottom: 8 }}>Event</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Event date</label>
            <input className="input" type="date" style={{ width: '100%' }} value={editForm.event_date}
              onChange={e => { update('event_date', e.target.value); clearFieldError('event_date'); }}
              aria-invalid={!!fieldErrors?.event_date} />
            <FieldError error={fieldErrors?.event_date} />
          </div>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Start time</label>
            <TimePicker value={editForm.event_start_time || ''}
              onChange={(v) => update('event_start_time', v)}
              minHour={6} maxHour={23} />
          </div>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Duration (hours)</label>
            <NumberStepper className="input" min={1} max={12} step={0.5} style={{ width: '100%' }}
              value={editForm.event_duration_hours}
              onChange={v => update('event_duration_hours', v)}
              ariaLabelIncrease="Increase duration" ariaLabelDecrease="Decrease duration" />
          </div>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Guest count</label>
            <input className="input" type="number" min="1" max="1000" style={{ width: '100%' }}
              value={editForm.guest_count}
              onChange={e => update('guest_count', e.target.value)} />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Location</label>
            <LocationInput value={editForm.event_location}
              onChange={(v) => update('event_location', v)} />
          </div>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Portable bars</label>
            <input className="input" type="number" min="0" max="5" style={{ width: '100%' }}
              value={editForm.num_bars}
              onChange={e => update('num_bars', e.target.value)} />
          </div>
        </div>

        {/* Package */}
        <div className="meta-k" style={{ marginBottom: 8 }}>Package</div>
        <div style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
          {packages.map(pkg => {
            const checked = Number(editForm.package_id) === pkg.id;
            return (
              <label key={pkg.id} style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '10px 12px', borderRadius: 4, cursor: 'pointer',
                border: checked ? '1px solid var(--ink-1)' : '1px solid var(--line-1)',
                background: checked ? 'var(--bg-2)' : 'transparent',
              }}>
                <input type="radio" name="edit-package" value={pkg.id} checked={checked}
                  onChange={(e) => {
                    update('package_id', e.target.value);
                    update('addon_ids', []);
                    update('addon_variants', {});
                  }}
                  style={{ marginTop: 3 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{pkg.name}</div>
                  {pkg.description && <div className="tiny muted" style={{ marginTop: 2 }}>{pkg.description}</div>}
                  <div className="tiny muted" style={{ marginTop: 4 }}>
                    {pkg.pricing_type === 'per_guest' ? (
                      <>
                        ${Number(pkg.base_rate_4hr)}/guest (50+)
                        {pkg.base_rate_4hr_small && <> · ${Number(pkg.base_rate_4hr_small)}/guest ({'<'}50)</>}
                        {pkg.extra_hour_rate && <> · +${Number(pkg.extra_hour_rate)}/guest/hr extra</>}
                      </>
                    ) : (
                      <>
                        {pkg.base_rate_3hr && <>${Number(pkg.base_rate_3hr)}/3hr · </>}
                        {pkg.base_rate_4hr && <>${Number(pkg.base_rate_4hr)}/4hr</>}
                        {pkg.extra_hour_rate && <> · +${Number(pkg.extra_hour_rate)}/hr extra</>}
                      </>
                    )}
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        {/* Add-ons */}
        {filteredAddons.length > 0 && (
          <>
            <div className="meta-k" style={{ marginBottom: 8 }}>Add-ons</div>
            <div style={{ display: 'grid', gap: 4, marginBottom: 16 }}>
              {filteredAddons.map(addon => {
                const isBanquet = /banquet/i.test(addon.name || '');
                const checked = editForm.addon_ids.includes(addon.id);
                return (
                  <React.Fragment key={addon.id}>
                    <label style={{
                      display: 'flex', alignItems: 'flex-start', gap: 10,
                      padding: '8px 10px', borderRadius: 4, cursor: 'pointer',
                      border: checked ? '1px solid var(--ink-1)' : '1px solid transparent',
                      background: checked ? 'var(--bg-2)' : 'transparent',
                    }}>
                      <input type="checkbox" checked={checked} onChange={() => toggleAddon(addon.id)}
                        style={{ marginTop: 3 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>
                          {addon.name}
                          {isBanquet && <span className="tiny muted" style={{ marginLeft: 6 }}>(4hr min)</span>}
                        </div>
                        <div className="tiny muted">
                          {addon.billing_type === 'per_guest' && `$${Number(addon.rate)}/guest`}
                          {addon.billing_type === 'per_guest_timed' && `$${Number(addon.rate)}/guest (4hr) + $${Number(addon.extra_hour_rate)}/guest/hr after`}
                          {addon.billing_type === 'per_hour' && `$${Number(addon.rate)}/hr${isBanquet ? ' · 4hr min' : ''}`}
                          {addon.billing_type === 'flat' && `$${Number(addon.rate)} flat`}
                        </div>
                      </div>
                    </label>
                    {addon.slug === 'champagne-toast' && checked && (
                      <label style={{
                        display: 'flex', alignItems: 'center', gap: 8, marginLeft: 36,
                        padding: '4px 8px', cursor: 'pointer', fontSize: 12.5,
                      }}>
                        <input type="checkbox"
                          checked={(editForm.addon_variants || {})[String(addon.id)] === 'non-alcoholic-bubbles'}
                          onChange={e => setEditForm(f => ({
                            ...f,
                            addon_variants: {
                              ...f.addon_variants,
                              [String(addon.id)]: e.target.checked ? 'non-alcoholic-bubbles' : undefined,
                            },
                          }))} />
                        Non-alcoholic bubbles
                      </label>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </>
        )}

        {/* Syrups */}
        <div className="meta-k" style={{ marginBottom: 8 }}>Handcrafted syrups</div>
        <div style={{ marginBottom: 16 }}>
          <SyrupPicker
            selected={editForm.syrup_selections || []}
            onChange={(syrups) => update('syrup_selections', syrups)}
            compact />
        </div>

        {/* Adjustments */}
        <div className="meta-k" style={{ marginBottom: 8 }}>Price adjustments</div>
        <div style={{ marginBottom: 12 }}>
          {(editForm.adjustments || []).map((adj, i) => (
            <div key={i} className="hstack" style={{ gap: 6, marginBottom: 6 }}>
              <span className={`chip ${adj.type === 'discount' ? 'ok' : 'danger'}`} style={{ flexShrink: 0 }}>
                {adj.type === 'discount' ? 'Discount' : 'Surcharge'}
              </span>
              <input className="input" placeholder="Label (e.g. Returning client)"
                value={adj.label}
                onChange={e => updateAdjustment(i, 'label', e.target.value)}
                style={{ flex: 1 }} />
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)', fontSize: 12, pointerEvents: 'none' }}>$</span>
                <input className="input" type="number" min="0" step="0.01" placeholder="0.00"
                  value={adj.amount}
                  onChange={e => updateAdjustment(i, 'amount', e.target.value)}
                  style={{ width: 110, paddingLeft: 18 }} />
              </div>
              <label className="hstack" style={{ gap: 4, fontSize: 11.5, cursor: 'pointer', flexShrink: 0 }}>
                <input type="checkbox" checked={adj.visible}
                  onChange={e => updateAdjustment(i, 'visible', e.target.checked)} />
                Client sees
              </label>
              <button type="button" className="icon-btn" onClick={() => removeAdjustment(i)} title="Remove">
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
          <div className="hstack" style={{ gap: 6, marginTop: 4 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => addAdjustment('discount')}>
              <Icon name="plus" size={11} />Discount
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => addAdjustment('surcharge')}>
              <Icon name="plus" size={11} />Surcharge
            </button>
          </div>
        </div>

        {/* Total override */}
        <div style={{ paddingTop: 12, borderTop: '1px solid var(--line-1)', marginBottom: 12 }}>
          <label className="hstack" style={{ gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
            <input type="checkbox"
              checked={editForm.total_price_override != null}
              onChange={e => update(
                'total_price_override',
                e.target.checked ? (editPreview?.subtotal || editPreview?.total || 0) : null
              )} />
            Override total
          </label>
          {editForm.total_price_override != null && (
            <div className="hstack" style={{ gap: 8, marginTop: 6 }}>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)', fontSize: 12, pointerEvents: 'none' }}>$</span>
                <input className="input" type="number" min="0" step="0.01"
                  value={editForm.total_price_override}
                  onChange={e => update('total_price_override', e.target.value !== '' ? Number(e.target.value) : null)}
                  style={{ width: 140, paddingLeft: 18 }} />
              </div>
              <span className="tiny muted">Overrides calculated total</span>
            </div>
          )}
        </div>

        {/* Live preview */}
        {editPreview && (
          <div style={{ paddingTop: 12, borderTop: '1px solid var(--line-1)', marginBottom: 12 }}>
            <div className="meta-k" style={{ marginBottom: 6 }}>Live preview</div>
            <PricingBreakdown snapshot={editPreview} />
          </div>
        )}

        <FormBanner error={error} fieldErrors={fieldErrors} />
        <div className="hstack" style={{ gap: 8, marginTop: 12 }}>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
        </div>
      </div>

      <ConfirmModal
        isOpen={showLeaveConfirm}
        title="Unsaved changes"
        message="You have unsaved changes. Leave without saving?"
        onConfirm={() => { setShowLeaveConfirm(false); onCancel?.(); }}
        onCancel={() => setShowLeaveConfirm(false)} />
    </div>
  );
}

function initialFormFromProposal(p) {
  const currentAddonIds = (p.addons || []).map(a => a.addon_id);
  const currentAddonVariants = {};
  (p.addons || []).forEach(a => {
    if (a.variant) currentAddonVariants[String(a.addon_id)] = a.variant;
  });
  const snapshot = p.pricing_snapshot || {};
  return {
    client_name: p.client_name || '',
    client_email: p.client_email || '',
    client_phone: p.client_phone || '',
    client_source: p.client_source || 'thumbtack',
    event_date: p.event_date ? p.event_date.slice(0, 10) : '',
    event_start_time: p.event_start_time || '',
    event_duration_hours: Number(p.event_duration_hours) || 4,
    event_location: p.event_location || '',
    guest_count: p.guest_count || 50,
    package_id: p.package_id || '',
    num_bars: p.num_bars || 0,
    addon_ids: currentAddonIds,
    addon_variants: currentAddonVariants,
    syrup_selections: snapshot.syrups?.selections || [],
    adjustments: p.adjustments || [],
    total_price_override: p.total_price_override ?? null,
  };
}

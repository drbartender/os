import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { formatPhoneInput, stripPhone } from '../../utils/formatPhone';
import VenueAddressFields from '../../components/VenueAddressFields';
import SyrupPicker from '../../components/SyrupPicker';
import ConfirmModal from '../../components/ConfirmModal';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import TimePicker from '../../components/TimePicker';
import NumberStepper from '../../components/NumberStepper';
import PricingBreakdown from '../../components/PricingBreakdown';
import Icon from '../../components/adminos/Icon';
import { AddonQtyStepper, clampAddonQty } from '../../components/AddonControls';
import { PACKAGE_EXCLUDED_ADDONS } from '../../data/addonCategories';
import { isQuantityCapable } from '../../utils/proposalRules';
import { formatSetupTime } from '../../utils/setupTime';

// Read-only audit copy for proposals.gratuity_rate_change_origin (NULL when the
// rate was never touched, so the line is hidden). Admin-only: this component is
// only mounted inside the admin proposal detail (auth + requireAdminOrManager).
const GRATUITY_ORIGIN_LABELS = {
  admin: 'Rate set by admin',
  staffing: 'Adjusted by staffing change',
};

// Self-contained edit form for ProposalDetail. Owns:
//  - editForm state, dirty tracking, leave-confirm modal, beforeunload guard
//  - package & addon catalog fetch
//  - debounced live pricing preview
//
// Parent passes the current proposal and callbacks. After a successful save
// onSaved() is fired so the parent can reload and exit edit mode.
export default function ProposalDetailEditForm({ proposal, changeRequest, onSaved, onCancel }) {
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

  // Whether the admin actually touched the gratuity controls this session. When
  // untouched, the edit/preview must NOT send tip_jar/gratuity_total — otherwise
  // the server re-derives the rate from a stale dollar total and silently shifts
  // it on any unrelated edit (e.g. a guest-count change that grows the crew).
  // Mirrors the public checkout's gratuityDirty guard.
  const [gratuityDirty, setGratuityDirty] = useState(false);
  const storedGratuityRate = Number(proposal?.pricing_snapshot?.gratuity?.rate) || 0;
  const storedTipJar = proposal?.pricing_snapshot?.gratuity?.tip_jar !== false;

  // Load packages + addons
  useEffect(() => {
    Promise.all([
      api.get('/proposals/packages'),
      api.get('/proposals/addons'),
    ]).then(([pkgRes, addonRes]) => {
      setPackages(pkgRes.data);
      setAddons(addonRes.data);
      // Seed addon_quantities once the catalog is in hand — recovering the raw
      // 1–10 stepper count needs each catalog row's slug/billing_type/
      // minimum_hours (proposal_addons.quantity stores a transformed value).
      const recovered = recoverAddonQuantities(proposal.addons, addonRes.data, {
        durationHours: proposal.event_duration_hours,
      });
      // Absorb the recovered addon_quantities into whatever baseline is ALREADY set
      // (a clean seed, OR a change-request overlay applied by the effect below) so
      // this catalog fill alone does NOT trip the dirty/leave-confirm guard. Do NOT
      // re-derive from initialFormFromProposal(proposal): that clobbers the overlay
      // baseline and reads the editor dirty the instant "Apply in editor" opens it.
      // Parsing the existing baseline also keeps a (rare) pre-catalog user edit
      // showing as dirty — it isn't folded into the baseline. f.addon_quantities is
      // spread last below so a pre-catalog stepper edit is preserved in the form.
      const baseline = JSON.parse(initialRef.current);
      initialRef.current = JSON.stringify({ ...baseline, addon_quantities: recovered });
      setEditForm(f => ({ ...f, addon_quantities: { ...recovered, ...f.addon_quantities } }));
    }).catch(() => {
      toast.error('Failed to load packages. Try refreshing.');
      setError('Failed to load packages/addons. Please try again.');
    });
  }, []); // eslint-disable-line

  // One-shot overlay of a change request's requested_changes onto the form when an
  // admin opens the editor via "Apply in editor". Re-baselines initialRef (a JSON
  // STRING, matching the dirty guard at the export) so the pre-fill itself does not
  // read as unsaved changes. crAppliedRef keeps it idempotent under StrictMode.
  const crAppliedRef = useRef(false);
  useEffect(() => {
    if (!changeRequest || crAppliedRef.current) return;
    crAppliedRef.current = true;
    const rc = changeRequest.requested_changes || {};
    setEditForm(prev => {
      const next = { ...prev };
      for (const k of Object.keys(rc)) {
        if (k === 'event_date' && rc[k]) next.event_date = String(rc[k]).slice(0, 10);
        else next[k] = rc[k];
      }
      initialRef.current = JSON.stringify(next);
      return next;
    });
  }, [changeRequest]);

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
        addon_quantities: editForm.addon_quantities || {},
        syrup_selections: editForm.syrup_selections || [],
        adjustments: editForm.adjustments || [],
        total_price_override: editForm.total_price_override,
        // Only send the gratuity dollar when the admin actually edited it; else
        // preview at the STORED rate so the line scales with staff/hours and
        // matches what will save (no silent rate re-derivation). See gratuityDirty.
        ...(gratuityDirty
          ? { tip_jar: editForm.tip_jar !== false, gratuity_total: editForm.gratuity_total }
          : { tip_jar: storedTipJar, gratuity_rate: storedGratuityRate }),
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
    editForm.addon_quantities,
    editForm.syrup_selections,
    editForm.adjustments,
    editForm.total_price_override,
    editForm.tip_jar,
    editForm.gratuity_total,
    gratuityDirty,
    storedTipJar,
    storedGratuityRate,
  ]);

  const isDirty = useMemo(
    () => JSON.stringify(editForm) !== initialRef.current,
    [editForm]
  );

  // Browser refresh / close guard. (In-app navigation away — sidebar clicks,
  // in-app links — would need react-router's `useBlocker`, which requires
  // migrating the app from `<BrowserRouter>` to `createBrowserRouter`. That's a
  // larger refactor; until then the user's only loss path is clicking an
  // in-app link mid-edit, which the explicit Cancel button + leave-confirm
  // modal cover for the most common exit.)
  useEffect(() => {
    const handler = (e) => { if (isDirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const update = (field, value) => setEditForm(f => ({ ...f, [field]: value }));

  // Gratuity edits flip gratuityDirty so the request includes tip_jar/gratuity_total
  // (an explicit, admin-intended rate change). Left untouched, those fields are
  // omitted and the server keeps the stored rate, rescaling the dollar by staffing.
  const updateGratuity = (field, value) => { setGratuityDirty(true); update(field, value); };

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

  const setAddonQty = (id, n) => setEditForm(f => ({
    ...f,
    addon_quantities: { ...f.addon_quantities, [id]: clampAddonQty(n) },
  }));

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
        venue_name: editForm.venue_name,
        venue_street: editForm.venue_street,
        venue_city: editForm.venue_city,
        venue_state: editForm.venue_state,
        venue_zip: editForm.venue_zip,
        guest_count: Number(editForm.guest_count),
        package_id: Number(editForm.package_id),
        num_bars: Number(editForm.num_bars) || 0,
        addon_ids: (editForm.addon_ids || []).map(Number),
        addon_variants: editForm.addon_variants || {},
        addon_quantities: editForm.addon_quantities || {},
        syrup_selections: editForm.syrup_selections || [],
        adjustments: editForm.adjustments || [],
        total_price_override: editForm.total_price_override,
        // Persist the gratuity dollar ONLY when the admin edited it; otherwise omit
        // both so the server preserves the stored rate and rescales the dollar by
        // the new staffing (crud.js gratuity branch). Prevents an unrelated edit
        // from silently shifting the client-elected rate. See gratuityDirty.
        ...(gratuityDirty ? { tip_jar: editForm.tip_jar !== false, gratuity_total: editForm.gratuity_total } : {}),
        client_provides_glassware: !!editForm.client_provides_glassware,
        // Top Shelf is class-only — only send class_options for a class package
        // so switching to a non-class package can't trip the server-side guard.
        class_options: selectedPkg?.bar_type === 'class' ? editForm.class_options : null,
        // Blank → explicit null (reset to package default); else a number.
        // Server uses the undefined/null sentinel — sending null is the reset.
        setup_minutes_before: editForm.setup_minutes_before === '' || editForm.setup_minutes_before == null
          ? null
          : Number(editForm.setup_minutes_before),
        change_request_id: changeRequest?.id,
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
  const filteredAddons = addons.filter(a => {
    if (a.applies_to !== 'all' && (!selectedPkg || a.applies_to !== selectedPkg.category)) return false;
    const excluded = selectedPkg && PACKAGE_EXCLUDED_ADDONS[selectedPkg.slug];
    if (excluded && excluded.includes(a.slug)) return false;
    return true;
  });

  // Detect snapshots priced under the pre-2026-05-14 hosted-bartender rule
  // (where ALL extras on hosted were $0). Saving an edit re-prices under the
  // new 1:100 ratio rule, which can add real cost. Banner is informational —
  // admin can still save; this just prevents surprise.
  const snap = proposal?.pricing_snapshot;
  const pkgIsHosted = selectedPkg?.pricing_type === 'per_guest' && selectedPkg?.bar_type !== 'class';
  const hasLegacyStaffing = snap?.staffing?.extra > 0 && Number(snap.staffing.total) === 0;
  const hasLegacyAddon = (snap?.addons || []).some(a => a.slug === 'additional-bartender' && Number(a.line_total) === 0);
  const showLegacyBartenderBanner = pkgIsHosted && (hasLegacyStaffing || hasLegacyAddon);

  return (
    <div className="card">
      <div className="card-head">
        <h3>Edit proposal</h3>
        <span className="k">Internal</span>
      </div>
      <div className="card-body">
        {showLegacyBartenderBanner && (
          <div style={{
            background: 'hsl(var(--warn-h) var(--warn-s) 95%)',
            border: '1px solid hsl(var(--warn-h) var(--warn-s) 70%)',
            borderRadius: 4,
            padding: '8px 12px',
            marginBottom: 16,
            fontSize: 12,
            color: 'var(--ink-1)',
          }}>
            <strong>Heads up:</strong> this hosted proposal was priced under the old "all bartenders free" rule. Saving will re-price additional bartenders under the new 1:100 ratio rule (over-ratio extras bill at hourly + gratuity).
          </div>
        )}
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
            <TimePicker className="input" value={editForm.event_start_time || ''}
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
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Setup time (min before)</label>
            <input className="input" type="number" min="0" max="600" step="5" style={{ width: '100%' }}
              placeholder={pkgIsHosted ? '90 (default)' : '60 (default)'}
              value={editForm.setup_minutes_before}
              onChange={e => update('setup_minutes_before', e.target.value)} />
            {(() => {
              const effMin = editForm.setup_minutes_before === '' || editForm.setup_minutes_before == null
                ? (pkgIsHosted ? 90 : 60)
                : Number(editForm.setup_minutes_before);
              const clock = formatSetupTime(editForm.event_start_time, effMin);
              return (
                <div className="tiny muted" style={{ marginTop: 4 }}>
                  {clock
                    ? <>Crew arrives <strong>{clock}</strong>{editForm.setup_minutes_before === '' || editForm.setup_minutes_before == null ? ` (default ${pkgIsHosted ? 90 : 60} min)` : ''} · back-of-house only</>
                    : <>Blank uses the package default ({pkgIsHosted ? 90 : 60} min) · back-of-house only</>}
                </div>
              );
            })()}
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Location</label>
            <VenueAddressFields
              value={editForm}
              onChange={(f, val) => update(f, val)}
            />
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
                    {/* Quantity stepper — quantity-capable add-ons only (extra
                        bartenders, barback, etc.). A sibling div (not nested in
                        the row <label>) so the +/− buttons don't toggle the
                        checkbox. */}
                    {isQuantityCapable(addon) && checked && (
                      <div style={{
                        display: 'flex', alignItems: 'center', marginLeft: 36,
                        padding: '4px 8px', fontSize: 12.5, color: 'var(--ink-2)',
                      }}>
                        <span>Quantity</span>
                        <AddonQtyStepper
                          value={(editForm.addon_quantities || {})[addon.id]}
                          onChange={(n) => setAddonQty(addon.id, n)}
                        />
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </>
        )}

        {/* Glassware — gates Flavor Blaster validity in the server rule check */}
        <div style={{ marginBottom: 16 }}>
          <label className="hstack" style={{ gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
            <input type="checkbox"
              checked={!!editForm.client_provides_glassware}
              onChange={e => update('client_provides_glassware', e.target.checked)} />
            Client provides their own glassware
          </label>
        </div>

        {/* Class options — class packages only */}
        {selectedPkg?.bar_type === 'class' && (
          <>
            <div className="meta-k" style={{ marginBottom: 8 }}>Class options</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
              <div>
                <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Spirit focus</label>
                <select className="select" style={{ width: '100%' }}
                  value={editForm.class_options?.spirit_category || ''}
                  onChange={e => update('class_options', {
                    ...editForm.class_options,
                    spirit_category: e.target.value || null,
                  })}>
                  <option value="">Not specified</option>
                  <option value="whiskey_bourbon">Whiskey / Bourbon</option>
                  <option value="tequila_mezcal">Tequila / Mezcal</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <label className="hstack" style={{ gap: 8, fontSize: 12.5, cursor: 'pointer', paddingBottom: 6 }}>
                  <input type="checkbox"
                    checked={editForm.class_options?.top_shelf_requested === true}
                    onChange={e => update('class_options', {
                      ...editForm.class_options,
                      top_shelf_requested: e.target.checked,
                    })} />
                  Top Shelf
                </label>
              </div>
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

        {/* Gratuity (§8.3) — admin preset/adjust; client can change at checkout */}
        <div className="meta-k" style={{ marginBottom: 8 }}>Gratuity</div>
        <div style={{ marginBottom: 12 }}>
          {(() => {
            const gB = editPreview?.gratuity || null;
            const gStaff = (gB?.staff_count ?? 0) * (gB?.hours ?? 0);
            const gFloor = Math.round(50 * (gB?.staff_count ?? 0) * (gB?.hours ?? 0));
            const gNoun = gB?.staff_noun || 'bartender';
            if (gStaff <= 0) {
              return <p className="tiny" style={{ color: 'var(--ink-3)' }}>Gratuity unavailable until staffing and duration are set.</p>;
            }
            return (
              <>
                <label className="hstack" style={{ gap: 6 }}>
                  <input type="checkbox" checked={editForm.tip_jar !== false}
                    onChange={e => updateGratuity('tip_jar', e.target.checked)} /> Tip jar at the bar
                </label>
                <div className="hstack" style={{ gap: 6, marginTop: 6, alignItems: 'center' }}>
                  <span>Pre-paid gratuity for {gNoun}s $</span>
                  <input className="input" type="number" min={editForm.tip_jar !== false ? 0 : gFloor} step="1"
                    value={gratuityDirty ? editForm.gratuity_total : (gB?.total ?? editForm.gratuity_total)}
                    onChange={e => updateGratuity('gratuity_total', e.target.value)} style={{ width: 120 }} />
                </div>
                {editForm.tip_jar === false && Number(editForm.gratuity_total) < gFloor && (
                  <p className="chip danger" style={{ marginTop: 6 }}>Without a tip jar, minimum is ${gFloor}.</p>
                )}
                {/* Read-only audit trail: who last moved the gratuity rate. Hidden
                    when never touched (origin is null). Internal-only. */}
                {GRATUITY_ORIGIN_LABELS[proposal?.gratuity_rate_change_origin] && (
                  <p className="tiny muted" style={{ marginTop: 6 }}>
                    {GRATUITY_ORIGIN_LABELS[proposal.gratuity_rate_change_origin]}
                  </p>
                )}
              </>
            );
          })()}
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

export function initialFormFromProposal(p) {
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
    client_provides_glassware: !!p.client_provides_glassware,
    class_options: p.class_options || null,
    event_date: p.event_date ? p.event_date.slice(0, 10) : '',
    event_start_time: p.event_start_time || '',
    event_duration_hours: Number(p.event_duration_hours) || 4,
    venue_name: p.venue_name || '',
    venue_street: p.venue_street || '',
    venue_city: p.venue_city || '',
    venue_state: p.venue_state || '',
    venue_zip: p.venue_zip || '',
    guest_count: p.guest_count || 50,
    package_id: p.package_id || '',
    num_bars: p.num_bars || 0,
    addon_ids: currentAddonIds,
    addon_variants: currentAddonVariants,
    // Raw 1–10 stepper counts for quantity-capable add-ons. Seeded empty here
    // and filled by recoverAddonQuantities() once the add-on catalog loads —
    // the persisted proposal_addons.quantity is a TRANSFORMED value (hours ×
    // count for per_hour, guest count for per_guest), so recovering the raw
    // stepper count needs the catalog row's slug/billing_type/minimum_hours.
    addon_quantities: {},
    syrup_selections: snapshot.syrups?.selections || [],
    adjustments: p.adjustments || [],
    total_price_override: p.total_price_override ?? null,
    tip_jar: snapshot.gratuity?.tip_jar !== false,
    gratuity_total: Number(snapshot.gratuity?.total) || 0,
    // '' = "use the package-derived default" (server resolves null → 90 hosted /
    // 60 else). A number is an explicit override. Inherited by EventEditForm.
    setup_minutes_before: p.setup_minutes_before ?? '',
  };
}

// Recover the raw 1–10 stepper count for each quantity-capable add-on on a
// loaded proposal. proposal_addons.quantity is NOT the raw count — pricingEngine
// transforms it on the way in:
//   - additional-bartender : persisted quantity = durationHours × count
//   - per_hour (barback,
//     banquet-server)      : persisted quantity = effectiveHours × count,
//                            effectiveHours = max(durationHours, minimum_hours)
//   - per_guest (pre-batched
//     -mocktail)           : persisted quantity = guestCount; the count is
//                            folded into line_total only (= guestCount×rate×count)
// The inversion is anchored to PERSISTED row data (row.rate, row.quantity — the
// values frozen at proposal-creation time), NOT the live catalog row. Catalog
// rates drift (pre-batched-mocktail went $1.50 → $2.00 in prod); dividing by the
// current catalog rate would recover a wrong count and silently re-price the
// proposal on save. The catalog row is still consulted only for slug /
// billing_type / minimum_hours (minimum_hours is not persisted on
// proposal_addons — a low-probability residual, see the per_hour branch).
// `proposalAddons` are the proposal_addons rows; `catalog` is the
// /proposals/addons response. Returns an addon_quantities map keyed by addon id
// (number) → recovered count, clamped to 1–10. Addons whose count can't be
// recovered (missing/zero divisors) are omitted (stepper defaults 1).
export function recoverAddonQuantities(proposalAddons, catalog, { durationHours }) {
  const out = {};
  const byId = new Map((catalog || []).map(a => [a.id, a]));
  const dh = Number(durationHours) || 0;
  (proposalAddons || []).forEach(row => {
    const addon = byId.get(row.addon_id);
    if (!addon || !isQuantityCapable(addon)) return;
    const persistedQty = Number(row.quantity);
    const lineTotal = Number(row.line_total);
    let count;
    if (addon.slug === 'additional-bartender') {
      // persisted quantity = durationHours × count. recoverAddonQuantities runs
      // once at form-load, so dh still equals the proposal's persisted duration
      // — no rate divisor here, so no catalog drift.
      count = dh > 0 ? persistedQty / dh : null;
    } else if (addon.billing_type === 'per_hour') {
      // persisted quantity = effectiveHours × count. dh is still the persisted
      // duration (form-load). minimum_hours is NOT persisted on proposal_addons,
      // so it must come from the catalog row — an unavoidable, low-probability
      // residual (minimum_hours rarely changes). No rate divisor here.
      const effectiveHours = Math.max(dh, Number(addon.minimum_hours) || 0);
      count = effectiveHours > 0 ? persistedQty / effectiveHours : null;
    } else if (addon.billing_type === 'per_guest') {
      // persisted line_total = quantity × rate × count, where persisted quantity
      // IS the creation-time guestCount. Invert with the row's own persisted
      // rate + quantity — never the live catalog rate (catalog rates drift) and
      // never the form's current guest_count.
      const rowRate = Number(row.rate);
      count = (persistedQty > 0 && rowRate > 0) ? lineTotal / (persistedQty * rowRate) : null;
    } else if (addon.billing_type === 'per_guest_timed') {
      // per_guest_timed recovery is intentionally unimplemented: its line_total
      // carries an extra-hours term (guestCount × extra_hour_rate × extraHours)
      // on top of the per_guest base, so the per_guest inversion above does not
      // hold. Dead today — no quantity-capable addon uses per_guest_timed — so
      // return null (stepper defaults to 1, visibly unhandled, never re-prices).
      count = null;
    } else {
      // flat / per_staff / per_100_guests — persisted quantity IS the raw count.
      count = persistedQty;
    }
    if (count == null || !Number.isFinite(count)) return;
    const rounded = Math.round(count);
    if (rounded < 1) return;
    out[addon.id] = Math.min(10, Math.max(1, rounded));
  });
  return out;
}

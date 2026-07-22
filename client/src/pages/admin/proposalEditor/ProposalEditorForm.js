import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import { formatPhoneInput, stripPhone } from '../../../utils/formatPhone';
import VenueAddressFields from '../../../components/VenueAddressFields';
import EntityLink from '../../../components/EntityLink';
import ConfirmModal from '../../../components/ConfirmModal';
import FormBanner from '../../../components/FormBanner';
import FieldError from '../../../components/FieldError';
import TimePicker from '../../../components/TimePicker';
import NumberStepper from '../../../components/NumberStepper';
import PricingBreakdown from '../../../components/PricingBreakdown';
import Icon from '../../../components/adminos/Icon';
import { clampAddonQty } from '../../../components/AddonControls';
import { PACKAGE_EXCLUDED_ADDONS } from '../../../data/addonCategories';
import { formatSetupTime } from '../../../utils/setupTime';
import { initialFormFromProposal, recoverAddonQuantities } from './formState';
import { buildProposalPatchBody } from './patchBody';
import { buildRepriceSummary } from './repriceSummary';
import RepriceConfirmModal from './RepriceConfirmModal';
import NotifyConfirmModal from '../../../components/comms/NotifyConfirmModal';
import PackageSection from './PackageSection';

// Read-only audit copy for proposals.gratuity_rate_change_origin (NULL when the
// rate was never touched, so the line is hidden). Admin-only: this component is
// only mounted inside the admin app (auth + requireAdminOrManager).
const GRATUITY_ORIGIN_LABELS = {
  admin: 'Rate set by admin',
  staffing: 'Adjusted by staffing change',
};

// The ONE proposal/event editor, mounted by ProposalDetail (title "Edit
// proposal", changeRequest support) and EventDetailPage (title "Edit event",
// showStaffNotifyToggles). Owns:
//  - editForm state, dirty tracking, leave-confirm modal, beforeunload guard
//  - package & addon catalog fetch
//  - debounced live pricing preview
//  - the booked-event reprice confirmation (buildRepriceSummary gate)
//
// Both mounts build their PATCH body through buildProposalPatchBody so the two
// surfaces cannot drift (the old EventEditForm drifted: it omitted
// addon_quantities and the server reset quantities to 1 on save).
// Parent passes the current proposal and callbacks. After a successful save
// onSaved() is fired so the parent can reload and exit edit mode.
export default function ProposalEditorForm({
  proposal, changeRequest, showStaffNotifyToggles = false,
  title = 'Edit proposal', onSaved, onCancel,
}) {
  const toast = useToast();
  const [packages, setPackages] = useState([]);
  const [addons, setAddons] = useState([]);
  const [editForm, setEditForm] = useState(() => initialFormFromProposal(proposal));
  const [editPreview, setEditPreview] = useState(null);
  // Save stays locked until the package/addon catalog is in hand: a pre-load
  // save would PATCH empty addon_quantities (server defaults them to 1) and
  // misdetect class packages (push-review money finding).
  const [catalogReady, setCatalogReady] = useState(false);
  // Monotonic guard: an out-of-order /calculate response must never clear
  // previewStale for a form it no longer describes (defeats the booked-event
  // reprice gate; push-review finding).
  const calcSeqRef = useRef(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const initialRef = useRef(JSON.stringify(initialFormFromProposal(proposal)));
  // Booked-event reprice confirmation. Non-null = modal open, holding the
  // buildRepriceSummary output the modal renders.
  const [repriceSummary, setRepriceSummary] = useState(null);
  // Notify-confirm chain state (reprice confirm -> preflight -> notify popup -> one save)
  const [pendingNotices, setPendingNotices] = useState([]);
  const [pendingBody, setPendingBody] = useState(null);
  const [notifyBusy, setNotifyBusy] = useState(false);

  // Explicit bartender-count override detection (push-review money finding):
  // stored num_bartenders equals the computed actual, so it is an admin
  // override only when it differs from what the ORIGINAL inputs required.
  // It must round-trip through preview AND PATCH or any editor save silently
  // drops charged over-ratio bartenders. A retired original package (absent
  // from the active catalog) makes detection impossible: fall back to not
  // sending (the server recomputes, matching pre-editor behavior).
  const numBartendersOverride = useMemo(() => {
    const stored = Number(proposal.num_bartenders);
    if (!stored) return null;
    const originalPkg = packages.find(p => p.id === Number(proposal.package_id));
    if (!originalPkg) return null;
    const per = Number(originalPkg.guests_per_bartender) || 100;
    const required = Math.max(1, Math.ceil((Number(proposal.guest_count) || 0) / per));
    return stored !== required ? stored : null;
  }, [packages, proposal]);

  // True while the debounced /calculate preview lags the form (a pricing input
  // changed and the response has not landed). handleSave treats a stale
  // preview like a missing one, so a Save clicked inside the 400ms debounce
  // window cannot compare against an outdated total and silently skip the
  // booked-event confirmation (spec: a booked event never reprices silently).
  const [previewStale, setPreviewStale] = useState(true);

  // Transient per-edit staff-notification toggles (event mount only; Phase 4a).
  // Not part of `editForm` (they never persist and must not trip the dirty
  // guard); they ride exactly one PATCH. All default off; sub-toggles are
  // gated by the parent. Moved verbatim in behavior from EventEditForm.
  const [notifyStaff, setNotifyStaff] = useState(false);
  const [notifyStaffSms, setNotifyStaffSms] = useState(false);
  const [notifyStaffEmail, setNotifyStaffEmail] = useState(false);

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
      setCatalogReady(true);
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
    // A pricing input just changed (this effect's deps are exactly the pricing
    // inputs): the current preview no longer reflects the form until the
    // response below lands.
    setPreviewStale(true);
    const seq = ++calcSeqRef.current;
    const timer = setTimeout(() => {
      api.post('/proposals/calculate', {
        package_id: Number(editForm.package_id),
        guest_count: Number(editForm.guest_count) || 50,
        duration_hours: Number(editForm.event_duration_hours) || 4,
        num_bars: Number(editForm.num_bars) || 0,
        ...(numBartendersOverride != null ? { num_bartenders: numBartendersOverride } : {}),
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
        .then(res => {
          if (seq !== calcSeqRef.current) return; // stale response: a newer edit owns the preview
          setEditPreview(res.data); setPreviewStale(false); setError('');
        })
        .catch(err => {
          if (seq !== calcSeqRef.current) return;
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
    numBartendersOverride,
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

  // Derived state. Declared ABOVE doSave so the save payload can read
  // selectedPkg (class-options gating).
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

  // The one PATCH body, built once per save chain so notify-preflight and the
  // PATCH itself can never see different payloads (the shared builder is the
  // single payload source for both mounts — see patchBody.js).
  const buildBody = () => buildProposalPatchBody(editForm, {
    gratuityDirty,
    // Retired package (absent from the active catalog): keep the stored
    // class semantics instead of silently clearing class_options.
    isClassPackage: selectedPkg ? selectedPkg.bar_type === 'class' : proposal.class_options != null,
    numBartendersOverride,
    changeRequestId: changeRequest?.id, // preflight's CR gate rides on this key
    staffNotify: showStaffNotifyToggles
      ? { enabled: notifyStaff, sms: notifyStaffSms, email: notifyStaffEmail }
      : null,
  });

  // Client-contact PUT lives INSIDE the confirmed save (after every popup
  // decision): Cancel anywhere in the chain must mean nothing happened at all.
  const doSave = async (patchBody, notify) => {
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
      const res = await api.patch(`/proposals/${proposal.id}`, { ...patchBody, notify });
      toast.success(showStaffNotifyToggles ? 'Event updated.' : 'Proposal updated.');
      // Per-channel truth (notify-client contract): failures and real skips
      // surface; "not selected" and never-offered channels stay silent.
      (res.data.notifications || []).forEach((n) => {
        if (n.email === 'failed') toast.error(`Saved, but the email failed: ${n.email_error || 'unknown error'}`);
        if (n.sms === 'failed') toast.error(`Saved, but the text failed: ${n.sms_error || 'unknown error'}`);
        ['email', 'sms'].forEach((ch) => {
          if (n[ch] === 'skipped' && n.skip_reasons?.[ch] && n.skip_reasons[ch] !== 'not selected') {
            toast.info(`Saved. ${ch === 'email' ? 'Email' : 'Text'} not sent: ${n.skip_reasons[ch]}`);
          }
        });
      });
      onSaved?.(res.data);
      return true;
    } catch (err) {
      // The notify-contract 400s key their real reason on fields this form
      // never renders (notify / subject / body_text / sms_body), and
      // ValidationError's message is the generic banner line — append those
      // reasons to the banner so a stale-popup rejection is explained.
      const fe = err.fieldErrors || {};
      const unrendered = ['notify', 'subject', 'body_text', 'sms_body']
        .map((k) => fe[k]).filter(Boolean);
      setError([err.message || 'Failed to save changes.', ...unrendered].join(' '));
      setFieldErrors(fe);
      return false;
    } finally {
      setSaving(false);
    }
  };

  // Between the reprice confirm and the actual save: ask the server whether
  // saving these edits would message the client, and what it would say. A
  // preflight failure BLOCKS the save — silently degrading to a quiet save
  // would suppress a wanted send with no decision made.
  const proceedToNotify = async () => {
    setError('');
    setSaving(true);
    try {
      const patchBody = buildBody();
      const pre = await api.post(`/proposals/${proposal.id}/notify-preflight`, patchBody);
      const notices = pre.data.notices || [];
      if (notices.length > 0) {
        setSaving(false);
        setPendingBody(patchBody);
        setPendingNotices(notices);
        return;
      }
      await doSave(patchBody, []);
    } catch (err) {
      setSaving(false);
      setError(err.message || 'Could not check notifications; nothing was saved.');
      setFieldErrors(err.fieldErrors || {});
    }
  };

  const settleNotify = async (notify) => {
    setNotifyBusy(true);
    try {
      const ok = await doSave(pendingBody, notify);
      // Close ONLY on success: a failed save keeps the popup (and the admin's
      // composed text) alive, with the error banner explaining why. Cancel
      // remains the deliberate way out.
      if (ok) {
        setPendingNotices([]);
        setPendingBody(null);
      } else {
        // The banner sits behind the overlay; the toast is what the admin
        // actually sees while the popup stays open.
        toast.error('Save failed; nothing was saved or sent. Your message is kept. Fix and retry, or cancel.');
      }
    } finally {
      setNotifyBusy(false);
    }
  };

  const handleSave = () => {
    if (!editForm.package_id) {
      setError('Please select a package.');
      setFieldErrors({ package_id: 'Please select a package' });
      return;
    }
    // Booked + price moved = confirm first. buildRepriceSummary returns null
    // for every other case, so unbooked proposals and pure logistics edits
    // save exactly as before.
    const summary = buildRepriceSummary({
      status: proposal.status,
      totalPrice: proposal.total_price,
      amountPaid: proposal.amount_paid,
      // Stale preview = unknown total: fall into the generic-confirm branch
      // rather than comparing against an outdated number (see previewStale).
      newTotal: (!previewStale && editPreview) ? editPreview.total : null,
    });
    if (summary) { setRepriceSummary(summary); return; }
    proceedToNotify();
  };

  const handleCancel = () => {
    if (isDirty) setShowLeaveConfirm(true);
    else onCancel?.();
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>{title}</h3>
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
        <div className="hstack" style={{ marginBottom: 8, gap: 8 }}>
          <div className="meta-k">Client</div>
          {proposal.client_id && (
            <EntityLink to={`/clients/${proposal.client_id}`} className="tiny">Open profile</EntityLink>
          )}
        </div>
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
              minHour={6} maxHour={23} hour24 />
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
              const clock = formatSetupTime(editForm.event_start_time, effMin, { hour24: true });
              return (
                <div className="tiny muted" style={{ marginTop: 4 }}>
                  {clock
                    ? <>Crew arrives <strong>{clock}</strong>{editForm.setup_minutes_before === '' || editForm.setup_minutes_before == null ? ` (default ${pkgIsHosted ? 90 : 60} min)` : ''} · back-of-house only</>
                    : <>Blank uses the package default ({pkgIsHosted ? 90 : 60} min) · back-of-house only</>}
                  {/* Caveat carried over from the old EventEditForm: the PATCH
                      re-syncs setup only for single-shift events. */}
                  {showStaffNotifyToggles && <> · single-shift events only (multi-shift events are edited per shift)</>}
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

        <PackageSection
          editForm={editForm}
          packages={packages}
          filteredAddons={filteredAddons}
          selectedPkg={selectedPkg}
          update={update}
          toggleAddon={toggleAddon}
          setAddonQty={setAddonQty}
          setVariant={(addonId, variant) => setEditForm(f => ({
            ...f,
            addon_variants: { ...f.addon_variants, [String(addonId)]: variant },
          }))}
        />

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

        {showStaffNotifyToggles && (
          <div style={{ paddingTop: 12, borderTop: '1px solid var(--line-1)', marginBottom: 12 }}>
            {/* Staff notification — transient per-edit toggle (Phase 4a). Only
                takes effect when this save is a reschedule (date/time/location
                change). Both channel sub-toggles default off. */}
            <div className="meta-k" style={{ marginBottom: 8, marginTop: 8 }}>Notify assigned staff</div>
            <div style={{ marginBottom: 16 }}>
              <label className="hstack" style={{ gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={notifyStaff}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setNotifyStaff(on);
                    if (!on) { setNotifyStaffSms(false); setNotifyStaffEmail(false); }
                  }}
                />
                <span>Notify assigned staff if this save reschedules the event</span>
              </label>
              <div
                style={{
                  display: 'flex', gap: 16, marginTop: 6, marginLeft: 22,
                  opacity: notifyStaff ? 1 : 0.5,
                }}
              >
                <label className="hstack" style={{ gap: 6, cursor: notifyStaff ? 'pointer' : 'default' }}>
                  <input
                    type="checkbox"
                    disabled={!notifyStaff}
                    checked={notifyStaffSms}
                    onChange={(e) => setNotifyStaffSms(e.target.checked)}
                  />
                  <span>Text (SMS)</span>
                </label>
                <label className="hstack" style={{ gap: 6, cursor: notifyStaff ? 'pointer' : 'default' }}>
                  <input
                    type="checkbox"
                    disabled={!notifyStaff}
                    checked={notifyStaffEmail}
                    onChange={(e) => setNotifyStaffEmail(e.target.checked)}
                  />
                  <span>Email</span>
                </label>
              </div>
              <div className="tiny muted" style={{ marginTop: 4, marginLeft: 22 }}>
                Staff are notified only when the date, time, or location actually changes.
              </div>
            </div>
          </div>
        )}

        <FormBanner error={error} fieldErrors={fieldErrors} />
        <div className="hstack" style={{ gap: 8, marginTop: 12 }}>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving || !catalogReady || pendingNotices.length > 0} title={catalogReady ? undefined : 'Loading pricing catalog...'}>
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

      <RepriceConfirmModal
        isOpen={repriceSummary != null}
        summary={repriceSummary}
        onConfirm={() => { setRepriceSummary(null); proceedToNotify(); }}
        onCancel={() => setRepriceSummary(null)}
      />
      {pendingNotices.length > 0 && (
        <NotifyConfirmModal
          notices={pendingNotices}
          primary="quiet"
          busy={notifyBusy}
          onCancel={() => { if (!notifyBusy) { setPendingNotices([]); setPendingBody(null); } }}
          onQuiet={() => settleNotify([])}
          onSend={(notify) => settleNotify(notify)}
        />
      )}
    </div>
  );
}

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import { resolveGratuityDisplayLabel } from '../../utils/gratuityLabels';
import useFormValidation from '../../hooks/useFormValidation';
import {
  toggleAddonWithRules,
  filterAddons,
  reconcileFlavorBlaster,
} from '../../utils/proposalRules';
import { PACKAGE_EXCLUDED_ADDONS } from '../../data/addonCategories';
import { useToast } from '../../context/ToastContext';
import Icon from '../../components/adminos/Icon';
import { fmt$2dp, fmtDateFull } from '../../components/adminos/format';
import ClientSection from './proposalCreate/ClientSection';
import EventSection from './proposalCreate/EventSection';
import PackageSection from './proposalCreate/PackageSection';
import AddonSection from './proposalCreate/AddonSection';

// ─── Helpers ────────────────────────────────────────────────────────────────

function fieldStatus(form) {
  return {
    client:  (form.client_name || form.client_id) ? 'done' : 'empty',
    event:   (form.event_type || form.event_type_custom) && form.event_date && form.guest_count ? 'done' : 'partial',
    package: form.package_id ? 'done' : 'empty',
    addons:  form.addon_ids.length ? 'done' : 'empty',
    staff:   form.num_bartenders != null ? 'done' : 'partial',
    send:    'partial',
  };
}

function suggestedBartenders(guests, packageType) {
  const g = Number(guests) || 0;
  if (g <= 0) return 1;
  return Math.max(1, Math.ceil(g / 65));
}

const Dot = ({ status }) => {
  const map = {
    done:    { bg: 'var(--accent)',                                ring: 'var(--accent-line)' },
    partial: { bg: 'hsl(var(--warn-h) var(--warn-s) 50%)',         ring: 'hsl(var(--warn-h) var(--warn-s) 50% / 0.3)' },
    empty:   { bg: 'transparent',                                  ring: 'var(--line-2)' },
  }[status] || {};
  return (
    <span style={{
      width: 8, height: 8, borderRadius: '50%',
      background: map.bg, boxShadow: `0 0 0 1.5px ${map.ring}`,
      flexShrink: 0,
    }} />
  );
};

const FieldBlock = ({ id, icon, title, status, span = 1, children }) => (
  <section
    id={id}
    className={span === 2 ? 'field-block field-block--span-2' : 'field-block'}
  >
    <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <Icon name={icon} size={13} style={{ color: 'var(--ink-3)' }} />
      <h3 style={{ margin: 0, fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-1)' }}>
        {title}
      </h3>
      <Dot status={status} />
      <div className="spacer" style={{ flex: 1 }} />
    </header>
    {children}
  </section>
);

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ProposalCreate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const initialClientId = searchParams.get('client_id');

  const [packages, setPackages] = useState([]);
  const [addons, setAddons] = useState([]);
  const [preview, setPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [saveAsDraft, setSaveAsDraft] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [savedAt, setSavedAt] = useState(Date.now());
  const previewErrorShownRef = useRef(false);
  const fbRemovedRef = useRef(false);
  const { validate, clearField } = useFormValidation();

  const [form, setForm] = useState({
    client_id: initialClientId ? Number(initialClientId) : null,
    client_name: '', client_email: '', client_phone: '', client_source: 'thumbtack',
    event_type: '', event_type_category: '', event_type_custom: '',
    event_date: '', event_start_time: '17:00', event_duration_hours: 4,
    venue_name: '', venue_street: '', venue_city: '', venue_state: '', venue_zip: '',
    guest_count: 50,
    package_id: '', num_bars: 0, num_bartenders: null,
    addon_ids: [], addon_variants: {},
    client_provides_glassware: false,
    addon_quantities: {},
    syrup_selections: [],
    class_options: null,
  });

  // Pre-populate from /clients/:id when ?client_id is passed
  useEffect(() => {
    if (!initialClientId) return;
    api.get(`/clients/${initialClientId}`).then(res => {
      const c = res.data;
      setForm(f => ({
        ...f,
        client_id: c.id, client_name: c.name, client_email: c.email || '',
        client_phone: c.phone || '', client_source: c.source || 'direct',
      }));
    }).catch(() => { /* fall through; manual fill */ });
  }, [initialClientId]);

  // Load packages + addons
  useEffect(() => {
    Promise.all([
      api.get('/proposals/packages'),
      api.get('/proposals/addons'),
    ]).then(([pkgRes, addonRes]) => {
      setPackages(pkgRes.data || []);
      setAddons(addonRes.data || []);
    }).catch(() => {
      toast.error('Failed to load packages. Please refresh.');
    });
  }, [toast]);

  // Live pricing preview — debounced 400ms so typing a guest count from
  // "5" → "50" is one round-trip, not five. Mirrors the pattern in
  // ProposalDetailEditForm.
  useEffect(() => {
    if (!form.package_id) { setPreview(null); return; }
    // Top Shelf is custom-priced — the admin follows up manually, so there's
    // no live total to compute. Skip the calculate round-trip and clear any
    // stale preview. class_options is in the deps so toggling this re-runs.
    if (form.class_options?.top_shelf_requested) { setPreview(null); return; }
    const timer = setTimeout(() => {
      api.post('/proposals/calculate', {
        package_id: Number(form.package_id),
        guest_count: Number(form.guest_count) || 50,
        duration_hours: Number(form.event_duration_hours) || 4,
        num_bars: Number(form.num_bars) || 0,
        num_bartenders: form.num_bartenders != null ? Number(form.num_bartenders) : undefined,
        addon_ids: form.addon_ids.map(Number),
        addon_variants: form.addon_variants,
        addon_quantities: form.addon_quantities,
        syrup_selections: form.syrup_selections,
      })
        .then(res => {
          setPreview(res.data);
          previewErrorShownRef.current = false;
        })
        .catch(err => {
          setPreview(null);
          if (!previewErrorShownRef.current) {
            previewErrorShownRef.current = true;
            toast.error(err?.message || 'Could not calculate preview pricing.');
          }
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [form.package_id, form.guest_count, form.event_duration_hours, form.num_bars, form.num_bartenders, form.addon_ids, form.addon_variants, form.addon_quantities, form.syrup_selections, form.class_options, toast]);

  // Saved indicator (cosmetic only — no autosave backend)
  useEffect(() => {
    const t = setTimeout(() => setSavedAt(Date.now()), 600);
    return () => clearTimeout(t);
  }, [form]);

  const update = useCallback((field, value) => {
    setForm(f => ({ ...f, [field]: value }));
    clearField(field);
    setFieldErrors(fe => {
      if (!fe[field]) return fe;
      const next = { ...fe };
      delete next[field];
      return next;
    });
  }, [clearField]);

  const merge = useCallback((patch) => {
    setForm(f => ({ ...f, ...patch }));
  }, []);

  const toggleAddon = useCallback((id) => {
    setForm(f => {
      const next = toggleAddonWithRules(
        { addonIds: f.addon_ids, syrupSelections: f.syrup_selections },
        id, addons,
      );
      // preserve the cockpit's addon_variants cleanup for removed addons
      const newVariants = { ...f.addon_variants };
      if (!next.addon_ids.includes(id)) delete newVariants[String(id)];
      return { ...f, ...next, addon_variants: newVariants };
    });
  }, [addons]);

  // Flavor Blaster requires real glassware — drop it if neither the
  // real-glassware addon nor client_provides_glassware is set. reconcileFlavorBlaster
  // returns the SAME array reference when nothing changes, so the identity guard
  // prevents a render loop. The toast fires from a separate effect — a state
  // updater must stay pure (StrictMode double-invokes it in dev), so the updater
  // only marks the ref; the toast effect below fires it once per real removal.
  useEffect(() => {
    setForm(f => {
      const next = reconcileFlavorBlaster(f.addon_ids, addons, f.client_provides_glassware);
      if (next === f.addon_ids) return f;
      fbRemovedRef.current = true;
      return { ...f, addon_ids: next };
    });
  }, [form.addon_ids, form.client_provides_glassware, addons]);

  useEffect(() => {
    if (fbRemovedRef.current) {
      fbRemovedRef.current = false;
      toast.info('Flavor Blaster removed. Requires real glassware.');
    }
  });

  const selectedPkg = packages.find(p => p.id === Number(form.package_id));
  const isHostedPackage = !!selectedPkg && selectedPkg.pricing_type === 'per_guest';

  // filterAddons covers the applies_to / bundle / glassware rules. Layer the
  // package-slug exclusion (PACKAGE_EXCLUDED_ADDONS) on top — it's a cockpit-
  // local UI-visibility concern (e.g. The Clear Reaction hides mocktail-bar +
  // pre-batched-mocktail, which it already includes). Kept out of the shared
  // filterAddons so it doesn't leak into the public quote wizard. Mirrors the
  // same filter in ProposalDetailEditForm.
  const { visibleAddons: filteredAddons, isIncludedMap, isUnavailableMap } = useMemo(() => {
    const result = filterAddons({
      addons,
      isHosted: isHostedPackage,
      packageCategory: selectedPkg?.category,
      addonIds: form.addon_ids,
      guestCount: form.guest_count,
    });
    const excluded = (selectedPkg && PACKAGE_EXCLUDED_ADDONS[selectedPkg.slug]) || [];
    return {
      visibleAddons: result.visibleAddons.filter(a => !excluded.includes(a.slug)),
      isIncludedMap: result.isIncludedMap,
      isUnavailableMap: result.isUnavailableMap,
    };
  }, [addons, isHostedPackage, selectedPkg, form.addon_ids, form.guest_count]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const rules = [
      { field: 'client_name', label: 'Client Name' },
      { field: 'package_id',  label: 'Package' },
    ];
    const result = validate(rules, form);
    if (!result.valid) { setError(result.message); return; }
    setError('');
    setFieldErrors({});
    setSubmitting(true);
    try {
      const payload = {
        ...form,
        package_id: Number(form.package_id),
        guest_count: Number(form.guest_count),
        event_duration_hours: Number(form.event_duration_hours),
        num_bars: Number(form.num_bars) || 0,
        num_bartenders: form.num_bartenders != null ? Number(form.num_bartenders) : undefined,
        addon_ids: form.addon_ids.map(Number),
        addon_variants: form.addon_variants,
        // addon_quantities / syrup_selections / class_options /
        // client_provides_glassware ride along in the ...form spread above.
        // send_now is NOT a form field — it comes from the saveAsDraft toggle.
        // The server defaults send_now to false (fail-safe), so the cockpit
        // must send it explicitly: true => create as 'sent' + invoice + email.
        send_now: !saveAsDraft,
      };
      const res = await api.post('/proposals', payload);
      toast.success('Proposal created!');
      navigate(`/proposals/${res.data.id}`);
    } catch (err) {
      setError(err.message || 'Failed to create proposal.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setSubmitting(false);
    }
  };

  const status = fieldStatus(form);
  const ago = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));

  // "Create & send" needs client, event, and package complete — sending an
  // incomplete proposal would email the client a half-built quote. A draft
  // can be incomplete, so this gate only applies in send mode.
  const canSend = status.client === 'done' && status.event === 'done' && status.package === 'done';
  const submitLabel = saveAsDraft ? 'Save as draft' : 'Create & send';
  const submitBlocked = !saveAsDraft && !canSend;

  return (
    <form onSubmit={handleSubmit} style={{ height: '100%', minHeight: 'calc(100dvh - var(--header-h))' }}>
      <div
        className="proposal-create-outer"
        style={{
          gap: 0,
          minHeight: 'calc(100dvh - var(--header-h))',
          background: 'var(--bg-0)',
        }}
      >
        {/* ─── Left column ─── */}
        <div className="proposal-create-form-col" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* Top bar */}
          <div style={{
            borderBottom: '1px solid var(--line-1)',
            padding: '12px 22px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            background: 'var(--bg-1)',
          }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/proposals')}>
              <Icon name="left" size={11} />Cancel
            </button>
            <div style={{ width: 1, height: 18, background: 'var(--line-1)' }} />
            <div className="mono tiny" style={{ color: 'var(--ink-3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              ℞ New prescription · Draft
            </div>
            <div className="spacer" style={{ flex: 1, minWidth: 12 }} />

            {/* Field nav chips */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {[
                { id: 'client',  label: 'Client' },
                { id: 'event',   label: 'Event' },
                { id: 'package', label: 'Package' },
                { id: 'addons',  label: 'Add-ons' },
                { id: 'staff',   label: 'Staffing' },
                { id: 'send',    label: 'Send' },
              ].map(field => (
                <a key={field.id} href={`#cockpit-${field.id}`} className="hstack" style={{
                  gap: 6, padding: '4px 10px', borderRadius: 4,
                  border: '1px solid var(--line-1)', background: 'var(--bg-1)',
                  textDecoration: 'none', fontSize: 11.5, color: 'var(--ink-2)',
                }}>
                  <Dot status={status[field.id]} />
                  <span>{field.label}</span>
                </a>
              ))}
            </div>

            <div className="spacer" style={{ flex: 1, minWidth: 12 }} />
            <span className="tiny mono" style={{ color: 'var(--ink-3)' }}>
              <Icon name="check" size={10} /> Saved {ago < 3 ? 'just now' : `${ago}s ago`}
            </span>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={submitting || submitBlocked}
              title={submitBlocked ? 'Add client, event date, and package to send.' : undefined}
            >
              <Icon name="send" size={11} />{submitting ? 'Creating…' : submitLabel}
            </button>
          </div>

          {/* Field grid */}
          <div className="scroll-thin" style={{ flex: 1, overflow: 'auto', padding: '14px 22px 22px' }}>
            <div className="proposal-create-grid">
              <FieldBlock id="cockpit-client" icon="users" title="Client" status={status.client}>
                <ClientSection form={form} merge={merge} update={update} fieldErrors={fieldErrors} />
              </FieldBlock>

              <FieldBlock id="cockpit-event" icon="calendar" title="Event" status={status.event}>
                <EventSection form={form} update={update} merge={merge} fieldErrors={fieldErrors} isHostedPackage={isHostedPackage} />
              </FieldBlock>

              <FieldBlock id="cockpit-package" icon="flask" title="Package" status={status.package} span={2}>
                <PackageSection form={form} packages={packages} update={update} merge={merge} fieldErrors={fieldErrors} />
              </FieldBlock>

              {form.package_id && filteredAddons.length > 0 && (
                <FieldBlock id="cockpit-addons" icon="sparkles" title="Add-ons & line items" status={status.addons} span={2}>
                  <AddonSection form={form} addons={filteredAddons} toggleAddon={toggleAddon} setForm={setForm} update={update} preview={preview} isIncludedMap={isIncludedMap} isUnavailableMap={isUnavailableMap} />
                </FieldBlock>
              )}

              <FieldBlock id="cockpit-staff" icon="userplus" title="Staffing" status={status.staff}>
                <StaffingSection form={form} update={update} preview={preview} isHostedPackage={isHostedPackage} />
              </FieldBlock>

              <FieldBlock id="cockpit-send" icon="send" title="Send" status={status.send}>
                <SendSection form={form} saveAsDraft={saveAsDraft} setSaveAsDraft={setSaveAsDraft} />
              </FieldBlock>
            </div>
          </div>
        </div>

        {/* ─── Pricing dock ─── */}
        <PricingDock
          form={form}
          preview={preview}
          packages={packages}
          submitting={submitting}
          submitLabel={submitLabel}
          submitBlocked={submitBlocked}
          error={error}
          fieldErrors={fieldErrors}
        />
      </div>
    </form>
  );
}

// ─── Staffing section ───────────────────────────────────────────────────────

function StaffingSection({ form, update, preview, isHostedPackage }) {
  const suggested = suggestedBartenders(form.guest_count);
  const actual = preview?.staffing?.actual ?? form.num_bartenders ?? suggested;
  const extra = preview?.staffing?.extra || 0;
  const usingDefault = form.num_bartenders == null;

  return (
    <div>
      <div style={{
        background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 4,
        padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tiny mono" style={{ color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 9.5 }}>
            Bartenders
          </div>
          <div className="num" style={{ fontSize: 22, lineHeight: 1, marginTop: 2, color: 'var(--ink-1)' }}>
            {actual}
            {extra > 0 && <span className="tiny mono" style={{ color: 'var(--ink-3)', marginLeft: 6 }}>(+{extra} extra)</span>}
          </div>
          <div className="tiny" style={{ color: 'var(--ink-3)', marginTop: 4 }}>
            {usingDefault ? 'Auto from guest count' : 'Manual override'}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ width: 22, height: 18, padding: 0 }}
            onClick={() => update('num_bartenders', Math.max(0, Number(actual) + 1))}
          >+</button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ width: 22, height: 18, padding: 0 }}
            onClick={() => update('num_bartenders', Math.max(0, Number(actual) - 1))}
          >−</button>
        </div>
      </div>

      {!usingDefault && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ marginTop: 6 }}
          onClick={() => update('num_bartenders', null)}
        >
          Reset to auto
        </button>
      )}

      <div className="tiny" style={{ marginTop: 8, color: 'var(--ink-3)' }}>
        <Icon name="sparkles" size={10} style={{ color: 'var(--accent)' }} />
        {' '}For {form.guest_count} guests we'd suggest <strong style={{ color: 'var(--ink-1)' }}>{suggested}</strong>.
        {Number(actual) !== suggested && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ marginLeft: 6 }}
            onClick={() => update('num_bartenders', suggested)}
          >Apply</button>
        )}
      </div>

      {isHostedPackage && (
        <div className="tiny" style={{ marginTop: 6, color: 'var(--ink-3)' }}>
          <Icon name="check" size={10} style={{ color: 'hsl(var(--ok-h) var(--ok-s) 52%)' }} /> Bartenders included at 1:100 guest ratio. Anything beyond ratio bills at the standard hourly rate plus gratuity.
        </div>
      )}
    </div>
  );
}

// ─── Send section ──────────────────────────────────────────────────────────

function SendSection({ form, saveAsDraft, setSaveAsDraft }) {
  const recipient = form.client_email || "the client's email";
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="tiny" style={{ color: 'var(--ink-3)', lineHeight: 1.55 }}>
        <strong style={{ color: 'var(--ink-1)' }}>Create &amp; send</strong> → the client gets the proposal email at{' '}
        <strong style={{ color: 'var(--ink-1)' }}>{recipient}</strong> · Sign &amp; Pay goes live immediately.
        <br />
        The first invoice is auto-created.
      </div>
      <label className="hstack" style={{ gap: 8, cursor: 'pointer', fontSize: 12.5, color: 'var(--ink-2)' }}>
        <input
          type="checkbox"
          checked={saveAsDraft}
          onChange={(e) => setSaveAsDraft(e.target.checked)}
        />
        <span>Save as draft instead. Nothing is sent; finish it later from the proposal page.</span>
      </label>
    </div>
  );
}

// ─── Pricing dock ──────────────────────────────────────────────────────────

const DEPOSIT_AMOUNT = 100;

function PricingDock({ form, preview, packages, submitting, submitLabel, submitBlocked, error, fieldErrors }) {
  const pkg = packages.find(p => p.id === Number(form.package_id));
  const total = Number(preview?.total) || 0;
  const subtotal = Number(preview?.subtotal) || 0;
  const breakdown = preview?.breakdown || [];
  // Top Shelf class bookings are priced by hand later — there's no live total.
  const isCustomPricing = !!form.class_options?.top_shelf_requested;

  return (
    <aside style={{
      background: 'var(--bg-1)',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      position: 'sticky',
      top: 0,
      alignSelf: 'start',
      maxHeight: 'calc(100dvh - var(--header-h))',
    }}>
      {/* Header */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--line-1)' }}>
        <div className="tiny mono" style={{ color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Live pricing
        </div>
        {isCustomPricing ? (
          <div style={{ fontSize: 15, color: 'var(--ink-1)', marginTop: 6, fontWeight: 500, lineHeight: 1.4 }}>
            Custom pricing: admin will follow up
          </div>
        ) : (
          <div className="num" style={{ fontSize: 32, color: 'var(--ink-1)', marginTop: 4, fontWeight: 500 }}>
            {fmt$2dp(total)}
          </div>
        )}
        <div className="tiny" style={{ color: 'var(--ink-3)' }}>
          {pkg?.name || 'Choose a package'}
          {form.guest_count ? ` · ${form.guest_count} guests` : ''}
          {form.event_duration_hours ? ` · ${form.event_duration_hours}hr` : ''}
        </div>
      </div>

      {/* Body */}
      <div className="scroll-thin" style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
        {!preview && !isCustomPricing && (
          <div className="muted tiny" style={{ padding: '6px 0' }}>
            Choose a package to see pricing.
          </div>
        )}
        {isCustomPricing && (
          <div style={{
            padding: '10px 12px', borderRadius: 4,
            border: '1px solid var(--line-1)', background: 'var(--bg-2)',
            fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.5,
          }}>
            <strong style={{ color: 'var(--ink-1)' }}>Top Shelf requested.</strong>
            {' '}This class booking is custom-priced. No live total. The admin
            will set the price and follow up after the proposal is created.
          </div>
        )}
        {preview && !isCustomPricing && (
          <div>
            {breakdown.map((item, i) => <Row key={i} label={resolveGratuityDisplayLabel(item.label, preview)} value={item.amount} />)}
            <div style={{ margin: '10px 0', borderTop: '1px solid var(--line-1)' }} />
            {subtotal !== total && (
              <Row label="Subtotal" value={subtotal} />
            )}
            <Row label="Total" value={total} primary big />
            <Row label="Deposit" value={DEPOSIT_AMOUNT} muted />
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {['Stripe · sign & pay electronically', '$100 deposit locks the date'].map((line) => (
                <div key={line} className="tiny" style={{ display: 'flex', alignItems: 'baseline', gap: 6, color: 'var(--ink-3)' }}>
                  <span className="mono" aria-hidden="true" style={{ color: 'var(--accent)' }}>⚗</span>
                  <span>{line}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Client preview placeholder */}
        <div style={{ marginTop: 14, padding: '10px 12px', border: '1px solid var(--line-1)', borderRadius: 4, background: 'var(--bg-2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <Icon name="eye" size={11} style={{ color: 'var(--ink-3)' }} />
            <span className="tiny mono" style={{ color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Client preview
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-2)', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--ink-1)' }}>℞ Dr. Bartender</strong>
            <br />
            For {form.client_name || '—'}
            <br />
            <span className="tiny" style={{ color: 'var(--ink-3)' }}>
              {form.event_date ? fmtDateFull(form.event_date) : 'date pending'}
            </span>
          </div>
        </div>

        {/* Error banner inside dock */}
        {(error || Object.keys(fieldErrors).length > 0) && (
          <div style={{
            marginTop: 10,
            padding: '8px 10px',
            border: '1px solid hsl(var(--danger-h) var(--danger-s) 50% / 0.4)',
            borderRadius: 4,
            background: 'hsl(var(--danger-h) var(--danger-s) 50% / 0.08)',
            color: 'hsl(var(--danger-h) var(--danger-s) 65%)',
            fontSize: 12,
          }}>
            {error || 'Please review the highlighted fields.'}
          </div>
        )}
      </div>

      {/* Footer */}
      <footer style={{ borderTop: '1px solid var(--line-1)', padding: '10px 16px', display: 'flex', gap: 6 }}>
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={submitting || submitBlocked}
          title={submitBlocked ? 'Add client, event date, and package to send.' : undefined}
          style={{ flex: 1, justifyContent: 'center' }}
        >
          <Icon name="send" size={11} />{submitting ? 'Creating…' : submitLabel}
        </button>
      </footer>
    </aside>
  );
}

const Row = ({ label, value, primary, sub, muted, big }) => (
  <div style={{
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    padding: sub ? '2px 0 2px 12px' : '3px 0',
    fontSize: big ? 14 : sub ? 11.5 : 12.5,
    color: muted ? 'var(--ink-3)' : primary ? 'var(--ink-1)' : 'var(--ink-2)',
  }}>
    <span style={{ fontWeight: primary && big ? 600 : 400 }}>{label}</span>
    <span className="num" style={{ fontWeight: primary && big ? 600 : 400, fontSize: big ? 18 : undefined }}>
      {fmt$2dp(value || 0)}
    </span>
  </div>
);

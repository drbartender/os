import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import { formatPhoneInput, stripPhone } from '../../utils/formatPhone';
import LocationInput from '../../components/LocationInput';
import useFormValidation from '../../hooks/useFormValidation';
import EVENT_TYPES from '../../data/eventTypes';
import { PACKAGE_EXCLUDED_ADDONS } from '../../data/addonCategories';
import { useToast } from '../../context/ToastContext';
import FieldError from '../../components/FieldError';
import TimePicker from '../../components/TimePicker';
import NumberStepper from '../../components/NumberStepper';
import Icon from '../../components/adminos/Icon';
import { fmt$, fmt$cents, fmtDateFull } from '../../components/adminos/format';

const SOURCES = [
  { value: 'direct',    label: 'Direct' },
  { value: 'referral',  label: 'Referral' },
  { value: 'thumbtack', label: 'Thumbtack' },
  { value: 'website',   label: 'Website' },
];

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

function initialsOf(name) {
  if (!name) return '?';
  return name.split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
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

const Lbl = ({ text, span = 1, children }) => (
  <label style={{ gridColumn: span > 1 ? `span ${span}` : undefined, minWidth: 0 }}>
    <div className="tiny mono" style={{ color: 'var(--ink-3)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 9.5 }}>
      {text}
    </div>
    {children}
  </label>
);

const FieldBlock = ({ id, icon, title, status, span = 1, children }) => (
  <section
    id={id}
    style={{
      gridColumn: span === 2 ? 'span 2' : undefined,
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderRadius: 6,
      padding: '12px 14px',
    }}
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
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [savedAt, setSavedAt] = useState(Date.now());
  const previewErrorShownRef = useRef(false);
  const { validate, clearField } = useFormValidation();

  const [form, setForm] = useState({
    client_id: initialClientId ? Number(initialClientId) : null,
    client_name: '', client_email: '', client_phone: '', client_source: 'thumbtack',
    event_type: '', event_type_category: '', event_type_custom: '',
    event_date: '', event_start_time: '17:00', event_duration_hours: 4,
    event_location: '', guest_count: 50,
    package_id: '', num_bars: 0, num_bartenders: null,
    addon_ids: [], addon_variants: {},
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
    const timer = setTimeout(() => {
      api.post('/proposals/calculate', {
        package_id: Number(form.package_id),
        guest_count: Number(form.guest_count) || 50,
        duration_hours: Number(form.event_duration_hours) || 4,
        num_bars: Number(form.num_bars) || 0,
        num_bartenders: form.num_bartenders != null ? Number(form.num_bartenders) : undefined,
        addon_ids: form.addon_ids.map(Number),
        addon_variants: form.addon_variants,
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
  }, [form.package_id, form.guest_count, form.event_duration_hours, form.num_bars, form.num_bartenders, form.addon_ids, form.addon_variants, toast]);

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
      const removing = f.addon_ids.includes(id);
      const newVariants = { ...f.addon_variants };
      if (removing) delete newVariants[String(id)];
      return {
        ...f,
        addon_ids: removing ? f.addon_ids.filter(a => a !== id) : [...f.addon_ids, id],
        addon_variants: newVariants,
      };
    });
  }, []);

  const selectedPkg = packages.find(p => p.id === Number(form.package_id));
  const isHostedPackage = selectedPkg && (selectedPkg.pricing_type === 'per_guest' || selectedPkg.pricing_type === 'per_guest_timed');

  const filteredAddons = useMemo(() => addons.filter(a => {
    if (a.applies_to !== 'all' && (!selectedPkg || a.applies_to !== selectedPkg.category)) return false;
    if (isHostedPackage && /bartender/i.test((a.name || '') + (a.slug || ''))) return false;
    const excluded = selectedPkg && PACKAGE_EXCLUDED_ADDONS[selectedPkg.slug];
    if (excluded && excluded.includes(a.slug)) return false;
    return true;
  }), [addons, selectedPkg, isHostedPackage]);

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
      };
      const res = await api.post('/proposals', payload);
      toast.success('Proposal created!');
      navigate(`/admin/proposals/${res.data.id}`);
    } catch (err) {
      setError(err.message || 'Failed to create proposal.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setSubmitting(false);
    }
  };

  const status = fieldStatus(form);
  const ago = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));

  return (
    <form onSubmit={handleSubmit} style={{ height: '100%', minHeight: 'calc(100vh - var(--header-h))' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 320px',
        gap: 0,
        minHeight: 'calc(100vh - var(--header-h))',
        background: 'var(--bg-0)',
      }}>
        {/* ─── Left column ─── */}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, borderRight: '1px solid var(--line-1)' }}>
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
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/proposals')}>
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
            <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
              <Icon name="send" size={11} />{submitting ? 'Creating…' : 'Create proposal'}
            </button>
          </div>

          {/* Field grid */}
          <div className="scroll-thin" style={{ flex: 1, overflow: 'auto', padding: '14px 22px 22px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14 }}>
              <FieldBlock id="cockpit-client" icon="users" title="Client" status={status.client}>
                <ClientSection form={form} merge={merge} update={update} fieldErrors={fieldErrors} />
              </FieldBlock>

              <FieldBlock id="cockpit-event" icon="calendar" title="Event" status={status.event}>
                <EventSection form={form} update={update} merge={merge} fieldErrors={fieldErrors} />
              </FieldBlock>

              <FieldBlock id="cockpit-package" icon="flask" title="Package" status={status.package} span={2}>
                <PackageSection form={form} packages={packages} update={update} merge={merge} fieldErrors={fieldErrors} />
              </FieldBlock>

              {form.package_id && filteredAddons.length > 0 && (
                <FieldBlock id="cockpit-addons" icon="sparkles" title="Add-ons & line items" status={status.addons} span={2}>
                  <AddonSection form={form} addons={filteredAddons} toggleAddon={toggleAddon} setForm={setForm} preview={preview} />
                </FieldBlock>
              )}

              <FieldBlock id="cockpit-staff" icon="userplus" title="Staffing" status={status.staff}>
                <StaffingSection form={form} update={update} preview={preview} isHostedPackage={isHostedPackage} />
              </FieldBlock>

              <FieldBlock id="cockpit-send" icon="send" title="Send" status={status.send}>
                <SendSection />
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
          error={error}
          fieldErrors={fieldErrors}
        />
      </div>
    </form>
  );
}

// ─── Client section ─────────────────────────────────────────────────────────

function ClientSection({ form, merge, update, fieldErrors }) {
  const [editing, setEditing] = useState(!form.client_name);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  // Quick client lookup
  useEffect(() => {
    if (!editing || !q) { setResults([]); return; }
    const t = setTimeout(() => {
      setSearching(true);
      api.get('/clients', { params: { search: q } })
        .then(r => setResults((r.data || []).slice(0, 5)))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 200);
    return () => clearTimeout(t);
  }, [q, editing]);

  if (!editing && form.client_name) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--line-1)', borderRadius: 4, background: 'var(--bg-2)' }}>
        <div className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{initialsOf(form.client_name)}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-1)' }}>{form.client_name}</div>
          <div className="tiny" style={{ color: 'var(--ink-3)' }}>
            {form.client_email || 'no email'}
            {form.client_phone && ` · ${formatPhoneInput(form.client_phone)}`}
          </div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Change</button>
      </div>
    );
  }

  return (
    <div>
      <div className="input-group" style={{ padding: '0 10px' }}>
        <Icon name="search" />
        <input
          autoFocus={!form.client_name}
          placeholder="Search clients or type a new name…"
          value={q || form.client_name}
          onChange={(e) => {
            setQ(e.target.value);
            // free-typing also seeds the new-client name
            merge({ client_id: null, client_name: e.target.value });
          }}
        />
      </div>

      {/* Search results dropdown */}
      {q && (results.length > 0 || searching) && (
        <div style={{ marginTop: 6, border: '1px solid var(--line-1)', borderRadius: 4, background: 'var(--bg-1)', maxHeight: 200, overflow: 'auto' }}>
          {searching && <div className="muted tiny" style={{ padding: '7px 10px' }}>Searching…</div>}
          {results.map(c => (
            <div
              key={c.id}
              onClick={() => {
                merge({
                  client_id: c.id,
                  client_name: c.name,
                  client_email: c.email || '',
                  client_phone: c.phone || '',
                  client_source: c.source || 'direct',
                });
                setEditing(false);
                setQ('');
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
                borderBottom: '1px solid var(--line-1)', cursor: 'pointer',
              }}
            >
              <div className="avatar" style={{ width: 22, height: 22, fontSize: 9 }}>{initialsOf(c.name)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5 }}>{c.name}</div>
                <div className="tiny" style={{ color: 'var(--ink-3)' }}>{c.email || '—'}</div>
              </div>
              {c.lifetime_value != null && (
                <span className="tiny mono" style={{ color: 'var(--ink-3)' }}>{fmt$(c.lifetime_value)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      <FieldError error={fieldErrors?.client_name} />

      {/* New-client extra fields */}
      {!form.client_id && form.client_name && (
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <input
            className="input"
            placeholder="Email"
            type="email"
            value={form.client_email}
            onChange={e => update('client_email', e.target.value)}
          />
          <input
            className="input"
            placeholder="Phone"
            value={formatPhoneInput(form.client_phone)}
            onChange={e => update('client_phone', stripPhone(e.target.value))}
          />
          <select
            className="select"
            value={form.client_source}
            onChange={e => update('client_source', e.target.value)}
            style={{ gridColumn: 'span 2' }}
          >
            {SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

// ─── Event section ──────────────────────────────────────────────────────────

function EventSection({ form, update, merge, fieldErrors }) {
  const [eventTypeQuery, setEventTypeQuery] = useState(form.event_type || '');
  const [eventTypeOpen, setEventTypeOpen] = useState(false);
  const [eventTypeHighlight, setEventTypeHighlight] = useState(-1);
  const eventTypeRef = useRef(null);

  const eventTypeFiltered = eventTypeQuery.length >= 1
    ? EVENT_TYPES.filter(et => et.id === 'other' || et.label.toLowerCase().includes(eventTypeQuery.toLowerCase()))
    : EVENT_TYPES;

  useEffect(() => {
    const handler = (e) => {
      if (eventTypeRef.current && !eventTypeRef.current.contains(e.target)) setEventTypeOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectEventType = (et) => {
    merge({
      event_type: et.label,
      event_type_category: et.category,
      event_type_custom: et.id === 'other' ? form.event_type_custom : '',
    });
    setEventTypeQuery(et.label === 'Other' ? '' : et.label);
    setEventTypeOpen(false);
    setEventTypeHighlight(-1);
  };

  const handleEventTypeKeyDown = (e) => {
    if (!eventTypeOpen) return;
    const list = eventTypeFiltered;
    if (e.key === 'ArrowDown') { e.preventDefault(); setEventTypeHighlight(h => Math.min(h + 1, list.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setEventTypeHighlight(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (eventTypeHighlight >= 0 && eventTypeHighlight < list.length) selectEventType(list[eventTypeHighlight]); }
    else if (e.key === 'Escape') setEventTypeOpen(false);
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {/* Row 1 — Type + Date */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(140px, 1fr)', gap: 8 }}>
        <Lbl text="Type">
          <div style={{ position: 'relative' }} ref={eventTypeRef}>
            <input
              className="input"
              value={eventTypeQuery}
              onChange={(e) => {
                setEventTypeQuery(e.target.value);
                setEventTypeOpen(true);
                setEventTypeHighlight(-1);
                if (form.event_type) merge({ event_type: '', event_type_category: '', event_type_custom: '' });
              }}
              onFocus={() => setEventTypeOpen(true)}
              onKeyDown={handleEventTypeKeyDown}
              placeholder="Wedding, Birthday…"
              autoComplete="off"
              style={{ width: '100%' }}
            />
            {eventTypeOpen && eventTypeFiltered.length > 0 && (
              <ul style={{
                position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
                zIndex: 10, listStyle: 'none', margin: 0, padding: 4,
                background: 'var(--bg-elev)', border: '1px solid var(--line-1)',
                borderRadius: 4, boxShadow: 'var(--shadow-pop)',
                maxHeight: 220, overflow: 'auto',
              }}>
                {eventTypeFiltered.map((et, i) => (
                  <li
                    key={et.id}
                    onMouseDown={() => selectEventType(et)}
                    onMouseEnter={() => setEventTypeHighlight(i)}
                    style={{
                      padding: '6px 8px', cursor: 'pointer', borderRadius: 3, fontSize: 12.5,
                      background: i === eventTypeHighlight ? 'var(--row-hover)' : 'transparent',
                    }}
                  >
                    {et.label}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <FieldError error={fieldErrors?.event_type} />
        </Lbl>

        <Lbl text="Date">
          <input
            className="input"
            type="date"
            value={form.event_date}
            onChange={(e) => update('event_date', e.target.value)}
            placeholder="mm/dd/yyyy"
            style={{ width: '100%' }}
          />
        </Lbl>
      </div>

      {form.event_type === 'Other' && (
        <Lbl text="Custom event type">
          <input
            className="input"
            value={form.event_type_custom}
            onChange={(e) => update('event_type_custom', e.target.value)}
            placeholder="Describe the event"
            style={{ width: '100%' }}
          />
        </Lbl>
      )}

      {/* Row 2 — Start / Hrs / Guests / Bars */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 1.5fr) minmax(64px, 0.7fr) minmax(72px, 0.8fr) minmax(72px, 0.8fr)', gap: 8 }}>
        <Lbl text="Start">
          <TimePicker
            className="input"
            value={form.event_start_time}
            onChange={(v) => update('event_start_time', v)}
            minHour={6}
            maxHour={23}
          />
        </Lbl>

        <Lbl text="Hrs">
          <NumberStepper
            className="input num"
            min={1} max={12} step={0.5}
            value={form.event_duration_hours}
            onChange={(v) => update('event_duration_hours', v)}
            style={{ width: '100%', textAlign: 'right' }}
            ariaLabelIncrease="Increase duration" ariaLabelDecrease="Decrease duration"
          />
        </Lbl>

        <Lbl text="Guests">
          <input
            className="input num"
            type="number"
            min="1" max="1000"
            value={form.guest_count}
            onChange={(e) => update('guest_count', e.target.value)}
            style={{ width: '100%', textAlign: 'right' }}
          />
        </Lbl>

        <Lbl text="Bars">
          <input
            className="input num"
            type="number"
            min="0" max="5"
            value={form.num_bars}
            onChange={(e) => update('num_bars', e.target.value)}
            style={{ width: '100%', textAlign: 'right' }}
          />
        </Lbl>
      </div>

      {/* Row 3 — Venue full width */}
      <Lbl text="Venue / location">
        <LocationInput
          className="input"
          value={form.event_location}
          onChange={(val) => update('event_location', val)}
        />
      </Lbl>
    </div>
  );
}

// ─── Package section ────────────────────────────────────────────────────────

function PackageSection({ form, packages, update, merge, fieldErrors }) {
  if (packages.length === 0) {
    return <div className="muted tiny">Loading packages…</div>;
  }

  const rateLabel = (pkg) => {
    if (pkg.pricing_type === 'per_guest' || pkg.pricing_type === 'per_guest_timed') {
      const big = pkg.base_rate_4hr ? `$${Number(pkg.base_rate_4hr)}/guest` : '';
      const small = pkg.base_rate_4hr_small ? `$${Number(pkg.base_rate_4hr_small)}/guest <50` : '';
      return [big, small].filter(Boolean).join(' · ');
    }
    const r3 = pkg.base_rate_3hr ? `$${Number(pkg.base_rate_3hr)}/3hr` : '';
    const r4 = pkg.base_rate_4hr ? `$${Number(pkg.base_rate_4hr)}/4hr` : '';
    const xtra = pkg.extra_hour_rate ? `+$${Number(pkg.extra_hour_rate)}/hr extra` : '';
    return [r3, r4, xtra].filter(Boolean).join(' · ');
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {packages.map(pkg => {
          const sel = Number(form.package_id) === pkg.id;
          return (
            <button
              key={pkg.id}
              type="button"
              onClick={() => {
                merge({ package_id: String(pkg.id), addon_ids: [], addon_variants: {} });
              }}
              style={{
                flex: '1 1 200px', minWidth: 200, textAlign: 'left',
                padding: '10px 12px', borderRadius: 4, cursor: 'pointer',
                background: sel ? 'var(--accent-soft)' : 'var(--bg-2)',
                border: sel ? '1px solid var(--accent)' : '1px solid var(--line-1)',
                color: 'var(--ink-1)',
                font: 'inherit',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <Icon name={sel ? 'check' : 'flask'} size={11} style={{ color: sel ? 'var(--accent)' : 'var(--ink-3)' }} />
                <strong style={{ fontSize: 13 }}>{pkg.name}</strong>
                <div className="spacer" style={{ flex: 1 }} />
                <span className="num tiny" style={{ color: 'var(--ink-2)' }}>{rateLabel(pkg)}</span>
              </div>
              {pkg.description && (
                <div className="tiny" style={{ color: 'var(--ink-3)' }}>{pkg.description}</div>
              )}
            </button>
          );
        })}
      </div>
      <FieldError error={fieldErrors?.package_id} />
    </div>
  );
}

// ─── Add-on section ─────────────────────────────────────────────────────────

function AddonSection({ form, addons, toggleAddon, setForm, preview }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);

  const selected = addons.filter(a => form.addon_ids.includes(a.id));
  const available = addons.filter(a => !form.addon_ids.includes(a.id));
  const matches = available
    .filter(a => !q || (a.name || '').toLowerCase().includes(q.toLowerCase()) || (a.applies_to || '').toLowerCase().includes(q.toLowerCase()))
    .slice(0, 8);
  const grouped = matches.reduce((g, a) => { (g[a.applies_to || 'Other'] = g[a.applies_to || 'Other'] || []).push(a); return g; }, {});

  // Lookup snapshot for actual computed total per addon
  const lineTotalFor = (addon) => {
    const snap = preview?.addons?.find(s => s.id === addon.id);
    if (snap?.amount != null) return Number(snap.amount);
    // Fallback: best-effort estimate
    if (addon.billing_type === 'per_guest') return Number(addon.rate) * (Number(form.guest_count) || 0);
    if (addon.billing_type === 'per_hour')  return Number(addon.rate) * (Number(form.event_duration_hours) || 0);
    return Number(addon.rate);
  };

  const labelFor = (addon) => {
    if (addon.billing_type === 'per_guest') return `${form.guest_count} × ${fmt$(addon.rate)}/g`;
    if (addon.billing_type === 'per_guest_timed') return `${form.guest_count} × ${fmt$(addon.rate)}/g (4hr)`;
    if (addon.billing_type === 'per_hour') return `${form.event_duration_hours} × ${fmt$(addon.rate)}/hr`;
    return Number(addon.rate) ? 'flat' : 'included';
  };

  return (
    <div>
      {selected.length === 0 ? (
        <div style={{ padding: '10px 12px', border: '1px dashed var(--line-2)', borderRadius: 4, color: 'var(--ink-3)', fontSize: 12 }}>
          No add-ons. Type below to add — items appear here as line items.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--line-1)', borderRadius: 4, overflow: 'hidden' }}>
          {selected.map((addon, i) => (
            <div key={addon.id} style={{
              display: 'grid', gridTemplateColumns: '20px 1fr 110px 90px 24px',
              alignItems: 'center', gap: 10,
              padding: '7px 10px', borderTop: i ? '1px solid var(--line-1)' : 'none',
              background: 'var(--bg-1)', fontSize: 12.5,
            }}>
              <Icon
                name={
                  addon.billing_type === 'per_guest' ? 'users' :
                  addon.billing_type === 'per_hour' ? 'clock' :
                  /champagne|toast/i.test(addon.name) ? 'sparkles' :
                  /mocktail/i.test(addon.name) ? 'flask' :
                  /bartender|server/i.test(addon.name) ? 'userplus' :
                  'check'
                }
                size={13}
                style={{ color: 'var(--ink-3)' }}
              />
              <div style={{ minWidth: 0 }}>
                <span style={{ color: 'var(--ink-1)' }}>{addon.name}</span>
                {addon.applies_to && addon.applies_to !== 'all' && (
                  <span className="tiny" style={{ color: 'var(--ink-3)', marginLeft: 6 }}>· {addon.applies_to}</span>
                )}
                {addon.slug === 'champagne-toast' && (
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 10 }}>
                    <input
                      type="checkbox"
                      checked={form.addon_variants[String(addon.id)] === 'non-alcoholic-bubbles'}
                      onChange={(e) => setForm(f => ({
                        ...f,
                        addon_variants: {
                          ...f.addon_variants,
                          [String(addon.id)]: e.target.checked ? 'non-alcoholic-bubbles' : undefined,
                        },
                      }))}
                    />
                    <span className="tiny" style={{ color: 'var(--ink-3)' }}>NA bubbles</span>
                  </label>
                )}
              </div>
              <span className="num tiny" style={{ color: 'var(--ink-3)', textAlign: 'right' }}>{labelFor(addon)}</span>
              <span className="num" style={{ textAlign: 'right', color: 'var(--ink-1)' }}>{fmt$(lineTotalFor(addon))}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleAddon(addon.id)} style={{ padding: 0, width: 24, height: 22 }}>
                <Icon name="x" size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Quick add */}
      <div style={{ position: 'relative', marginTop: 8 }}>
        <div className="input-group" style={{ padding: '0 10px' }}>
          <Icon name="plus" />
          <input
            placeholder="Add an add-on — champagne, glassware, banquet…"
            value={q}
            onFocus={() => setOpen(true)}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
          />
        </div>
        {open && matches.length > 0 && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 10,
            background: 'var(--bg-elev)', border: '1px solid var(--line-1)', borderRadius: 4, padding: 6,
            boxShadow: 'var(--shadow-pop)', maxHeight: 240, overflow: 'auto',
          }}>
            {Object.entries(grouped).map(([cat, items]) => (
              <div key={cat}>
                <div className="tiny mono" style={{ color: 'var(--ink-3)', padding: '4px 8px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {cat}
                </div>
                {items.map(a => (
                  <div
                    key={a.id}
                    onMouseDown={() => { toggleAddon(a.id); setQ(''); setOpen(false); }}
                    style={{
                      display: 'grid', gridTemplateColumns: '18px 1fr auto', alignItems: 'center', gap: 8,
                      padding: '6px 8px', borderRadius: 3, cursor: 'pointer', fontSize: 12.5,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--row-hover)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <Icon
                      name={
                        a.billing_type === 'per_guest' ? 'users' :
                        a.billing_type === 'per_hour' ? 'clock' :
                        /champagne|toast/i.test(a.name) ? 'sparkles' :
                        /mocktail/i.test(a.name) ? 'flask' :
                        /bartender|server/i.test(a.name) ? 'userplus' :
                        'check'
                      }
                      size={12}
                      style={{ color: 'var(--ink-3)' }}
                    />
                    <span>{a.name}</span>
                    <span className="tiny mono" style={{ color: 'var(--ink-3)' }}>
                      {a.billing_type === 'per_guest'       && `${fmt$(a.rate)}/guest`}
                      {a.billing_type === 'per_guest_timed' && `${fmt$(a.rate)}/guest`}
                      {a.billing_type === 'per_hour'        && `${fmt$(a.rate)}/hr`}
                      {a.billing_type === 'flat'            && (Number(a.rate) ? `${fmt$(a.rate)} flat` : 'included')}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
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
          <Icon name="check" size={10} style={{ color: 'hsl(var(--ok-h) var(--ok-s) 52%)' }} /> Bartenders included in per-guest rate. Extras don't add cost on hosted packages.
        </div>
      )}
    </div>
  );
}

// ─── Send section ──────────────────────────────────────────────────────────

function SendSection() {
  return (
    <div className="tiny" style={{ color: 'var(--ink-3)', lineHeight: 1.55 }}>
      Click <strong style={{ color: 'var(--ink-1)' }}>Create proposal</strong> in the top bar to save the draft. From the proposal page you can write a custom message, send to client, set deposit terms, and capture signature.
    </div>
  );
}

// ─── Pricing dock ──────────────────────────────────────────────────────────

const DEPOSIT_AMOUNT = 100;

function PricingDock({ form, preview, packages, submitting, error, fieldErrors }) {
  const pkg = packages.find(p => p.id === Number(form.package_id));
  const total = Number(preview?.total) || 0;
  const subtotal = Number(preview?.subtotal) || 0;
  const breakdown = preview?.breakdown || [];

  return (
    <aside style={{
      background: 'var(--bg-1)',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      position: 'sticky',
      top: 0,
      alignSelf: 'start',
      maxHeight: 'calc(100vh - var(--header-h))',
    }}>
      {/* Header */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--line-1)' }}>
        <div className="tiny mono" style={{ color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Live pricing
        </div>
        <div className="num" style={{ fontSize: 32, color: 'var(--ink-1)', marginTop: 4, fontWeight: 500 }}>
          {fmt$cents(total)}
        </div>
        <div className="tiny" style={{ color: 'var(--ink-3)' }}>
          {pkg?.name || 'Choose a package'}
          {form.guest_count ? ` · ${form.guest_count} guests` : ''}
          {form.event_duration_hours ? ` · ${form.event_duration_hours}hr` : ''}
        </div>
      </div>

      {/* Body */}
      <div className="scroll-thin" style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
        {!preview && (
          <div className="muted tiny" style={{ padding: '6px 0' }}>
            Choose a package to see pricing.
          </div>
        )}
        {preview && (
          <div>
            {breakdown.map((item, i) => (
              <Row key={i} label={item.label} value={item.amount} />
            ))}
            <div style={{ margin: '10px 0', borderTop: '1px solid var(--line-1)' }} />
            {subtotal !== total && (
              <Row label="Subtotal" value={subtotal} />
            )}
            <Row label="Total" value={total} primary big />
            <Row label="Deposit" value={DEPOSIT_AMOUNT} muted />
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
        <button type="submit" className="btn btn-primary btn-sm" disabled={submitting} style={{ flex: 1, justifyContent: 'center' }}>
          <Icon name="send" size={11} />{submitting ? 'Creating…' : 'Create proposal'}
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
      {fmt$cents(value || 0)}
    </span>
  </div>
);

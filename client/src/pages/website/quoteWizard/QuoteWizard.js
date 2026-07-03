import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import FormBanner from '../../../components/FormBanner';
import { useToast } from '../../../context/ToastContext';
import { ADDON_CATEGORIES } from '../../../data/addonCategories';
import useFormValidation from '../../../hooks/useFormValidation';
import useWizardHistory from '../../../hooks/useWizardHistory';
import EVENT_TYPES from '../../../data/eventTypes';
import {
  stripIncludedAddons,
  isIncludedByBundle,
  isUnavailableByBundle,
  toggleAddonWithRules,
  reconcileFlavorBlaster,
  enforceHostedMinimum,
  filterAddons,
} from '../../../utils/proposalRules';
import { getSteps, formatCurrency } from './helpers';
import PrescriptionCard from './PrescriptionCard';
import WizardPriceBar from './WizardPriceBar';
import EventDetailsStep from './steps/EventDetailsStep';
import YourInfoStep from './steps/YourInfoStep';
import PackageStep from './steps/PackageStep';
import ExtrasStep from './steps/ExtrasStep';
import ReviewStep from './steps/ReviewStep';

const API_BASE = process.env.REACT_APP_API_URL || '';
const DRAFT_KEY = 'drb_quote_draft';

export default function QuoteWizard() {
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState(0);
  const { replaceStep } = useWizardHistory(step, setStep);
  const [packages, setPackages] = useState([]);
  const [addons, setAddons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // Phones: hide the fixed price bar while a form control is focused, so the
  // iOS keyboard never fights a position:fixed bottom bar (plan C2).
  const [inputFocused, setInputFocused] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [success, setSuccess] = useState(null);
  const [resumed, setResumed] = useState(false); // true when state was restored
  const [hasDraftToken, setHasDraftToken] = useState(false); // triggers auto-save interval
  const { validate, fieldClass, inputClass, clearField, clearAll } = useFormValidation();

  const defaultForm = {
    guest_count: 50,
    event_duration_hours: 4,
    event_date: '',
    event_start_time: '17:00',
    event_type: '',
    event_type_category: '',
    event_type_custom: '',
    event_city: '',
    event_state: '',
    venue_name: '',
    venue_street: '',
    venue_zip: '',
    alcohol_provider: '',
    bar_type: '',
    needs_bar: false,
    package_id: '',
    addon_ids: [],
    addon_quantities: {},
    syrup_selections: [],
    client_name: '',
    client_email: '',
    client_phone: '',
    client_provides_glassware: false,
  };

  const [form, setForm] = useState(defaultForm);

  // Draft persistence refs
  const draftTokenRef = useRef(null);
  const formRef = useRef(form);
  const stepRef = useRef(step);
  formRef.current = form;
  stepRef.current = step;

  const steps = getSteps(form.alcohol_provider);

  const loadData = useCallback(async () => {
    setLoading(true);
    const fetchWithRetry = async (url, retries = 2) => {
      for (let i = 0; i <= retries; i++) {
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return await r.json();
        } catch (err) {
          if (i === retries) throw err;
          await new Promise(res => setTimeout(res, 1000 * (i + 1)));
        }
      }
    };
    // Fetch independently so one failure doesn't block the other
    const [pkgResult, addonResult] = await Promise.allSettled([
      fetchWithRetry(`${API_BASE}/api/proposals/public/packages`),
      fetchWithRetry(`${API_BASE}/api/proposals/public/addons`),
    ]);
    if (pkgResult.status === 'fulfilled' && Array.isArray(pkgResult.value)) {
      setPackages(pkgResult.value);
    }
    if (addonResult.status === 'fulfilled' && Array.isArray(addonResult.value)) {
      setAddons(addonResult.value);
    }
    if (pkgResult.status === 'rejected' && addonResult.status === 'rejected') {
      setError('Unable to load pricing data. Please refresh the page.');
    } else if (pkgResult.status === 'rejected') {
      setError('Unable to load packages. Please refresh the page.');
    } else if (addonResult.status === 'rejected') {
      setError('Unable to load add-ons. Please refresh the page.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Restore draft on mount — server token takes priority over localStorage
  useEffect(() => {
    const resumeToken = searchParams.get('resume');
    if (resumeToken) {
      // Resume from server (email link)
      fetch(`${API_BASE}/api/proposals/public/quote-draft/${resumeToken}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data && data.form_state) {
            setForm(f => ({ ...f, ...data.form_state }));
            replaceStep(data.current_step || 0);
            draftTokenRef.current = data.token;
            setHasDraftToken(true);
            setResumed(true);
            // Sync event type query for autocomplete
            if (data.form_state.event_type && data.form_state.event_type !== 'Other') {
              setEventTypeQuery(data.form_state.event_type);
            }
          }
        })
        .catch(() => {}); // Fall through to localStorage
    } else {
      // Resume from localStorage (same browser return)
      try {
        const saved = localStorage.getItem(DRAFT_KEY);
        if (saved) {
          const { form: savedForm, step: savedStep, token } = JSON.parse(saved);
          if (savedForm) {
            setForm(f => ({ ...f, ...savedForm }));
            replaceStep(savedStep || 0);
            if (token) {
              draftTokenRef.current = token;
              setHasDraftToken(true);
            }
            setResumed(true);
            if (savedForm.event_type && savedForm.event_type !== 'Other') {
              setEventTypeQuery(savedForm.event_type);
            }
          }
        }
      } catch { /* ignore corrupted localStorage */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save draft to localStorage helper
  const saveDraftLocal = useCallback((currentForm, currentStep, token) => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        form: currentForm,
        step: currentStep,
        token: token || null,
      }));
    } catch { /* localStorage full or disabled */ }
  }, []);

  // Save draft to server helper
  const saveDraftServer = useCallback(async () => {
    const token = draftTokenRef.current;
    if (!token) return;
    try {
      await fetch(`${API_BASE}/api/proposals/public/quote-draft/${token}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          form_state: formRef.current,
          current_step: stepRef.current,
        }),
      });
    } catch { /* best effort */ }
  }, []);

  // Auto-save to server every 60s when we have a draft token
  useEffect(() => {
    if (!hasDraftToken) return;
    const interval = setInterval(() => {
      if (draftTokenRef.current) saveDraftServer();
    }, 60000);
    return () => clearInterval(interval);
  }, [hasDraftToken, saveDraftServer]);

  // Save on page unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      // Always save to localStorage
      saveDraftLocal(formRef.current, stepRef.current, draftTokenRef.current);
      // Save to server if we have a token
      if (draftTokenRef.current) {
        try {
          fetch(`${API_BASE}/api/proposals/public/quote-draft/${draftTokenRef.current}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              form_state: formRef.current,
              current_step: stepRef.current,
            }),
            keepalive: true,
          });
        } catch { /* best effort */ }
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [saveDraftLocal]);

  // Dismiss the "welcome back" banner
  const dismissResume = () => setResumed(false);
  const editAnswers = () => {
    replaceStep(0);
    setResumed(false);
  };

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

  // Auto-deselect Flavor Blaster when glassware requirement is no longer met
  useEffect(() => {
    setForm(f => {
      const next = reconcileFlavorBlaster(f.addon_ids, addons, f.client_provides_glassware);
      return next === f.addon_ids ? f : { ...f, addon_ids: next };
    });
  }, [form.addon_ids, form.client_provides_glassware, addons]);

  const numBars = form.needs_bar ? 1 : 0;

  // Sequence-guard so a slow response from keystroke N-1 can't overwrite the
  // fresh response from keystroke N (rapid qty stepper +/- presses otherwise
  // race; whichever lands last wins, which can be the stale one).
  const previewSeqRef = useRef(0);
  const fetchPreview = useCallback(async () => {
    if (!form.package_id) { setPreview(null); return; }
    const seq = ++previewSeqRef.current;
    try {
      const res = await fetch(`${API_BASE}/api/proposals/public/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          package_id: Number(form.package_id),
          guest_count: Number(form.guest_count) || 50,
          duration_hours: Number(form.event_duration_hours) || 4,
          num_bars: numBars,
          addon_ids: stripIncludedAddons(form.addon_ids, addons).map(Number),
          addon_quantities: form.addon_quantities,
          syrup_selections: form.syrup_selections,
        }),
      });
      if (seq !== previewSeqRef.current) return;
      if (!res.ok) { setPreview(null); return; }
      const data = await res.json();
      if (seq !== previewSeqRef.current) return;
      if (data && data.total != null) setPreview(data);
      else setPreview(null);
    } catch {
      if (seq === previewSeqRef.current) setPreview(null);
    }
  }, [form.package_id, form.guest_count, form.event_duration_hours, numBars, form.addon_ids, form.addon_quantities, form.syrup_selections, addons]);

  // Debounce 250ms so the qty stepper '+'/'-' doesn't fire one POST per click.
  useEffect(() => {
    const t = setTimeout(fetchPreview, 250);
    return () => clearTimeout(t);
  }, [fetchPreview]);

  const update = (field, value) => { setForm(f => ({ ...f, [field]: value })); clearField(field); };

  const toggleAddon = (id) => {
    setForm(f => ({
      ...f,
      ...toggleAddonWithRules(
        { addonIds: f.addon_ids, syrupSelections: f.syrup_selections },
        id,
        addons,
      ),
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
      syrup_selections: [],
      // Enforce minimum 25 guests for hosted packages
      guest_count: enforceHostedMinimum(f.guest_count, value === 'hosted'),
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

  const guestCount = Number(form.guest_count) || 50;

  // Flavor Blaster glassware guardrail
  const realGlasswareAddon = addons.find(a => a.slug === 'real-glassware');
  const hasRealGlassware = realGlasswareAddon && form.addon_ids.includes(realGlasswareAddon.id);
  const glasswareRequirementMet = hasRealGlassware || form.client_provides_glassware;

  const { visibleAddons: filteredAddons } = filterAddons({
    addons,
    isHosted,
    packageCategory: selectedPkg?.category,
    addonIds: form.addon_ids,
    guestCount,
  });

  // Group add-ons by category
  const groupedAddons = ADDON_CATEGORIES
    .map(cat => ({
      ...cat,
      addons: filteredAddons.filter(a => a.category === cat.key),
    }))
    .filter(group => group.addons.length > 0);

  // Event type autocomplete state
  const [eventTypeQuery, setEventTypeQuery] = useState('');
  const [eventTypeOpen, setEventTypeOpen] = useState(false);
  const [eventTypeHighlight, setEventTypeHighlight] = useState(-1);
  const eventTypeRef = useRef(null);
  const eventTypeInputRef = useRef(null);

  const eventTypeFiltered = eventTypeQuery.length >= 1
    ? EVENT_TYPES.filter(et => {
        if (et.id === 'other') return true; // "Other" always visible
        return et.label.toLowerCase().includes(eventTypeQuery.toLowerCase());
      })
    : EVENT_TYPES;

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (eventTypeRef.current && !eventTypeRef.current.contains(e.target)) {
        setEventTypeOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectEventType = (et) => {
    setForm(f => ({
      ...f,
      event_type: et.label,
      event_type_category: et.category,
      event_type_custom: et.id === 'other' ? f.event_type_custom : '',
    }));
    setEventTypeQuery(et.label === 'Other' ? '' : et.label);
    setEventTypeOpen(false);
    setEventTypeHighlight(-1);
    clearField('event_type');
    if (et.id === 'other') {
      // Focus the custom input after a tick
      setTimeout(() => {
        const customInput = eventTypeRef.current?.querySelector('.wz-event-type-custom');
        if (customInput) customInput.focus();
      }, 50);
    }
  };

  const handleEventTypeKeyDown = (e) => {
    if (!eventTypeOpen) return;
    const list = eventTypeFiltered;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setEventTypeHighlight(h => Math.min(h + 1, list.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setEventTypeHighlight(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (eventTypeHighlight >= 0 && eventTypeHighlight < list.length) {
        selectEventType(list[eventTypeHighlight]);
      }
    } else if (e.key === 'Escape') {
      setEventTypeOpen(false);
    }
  };

  // Determine current step key
  const currentStepKey = steps[step]?.key;

  const getStepRules = () => {
    switch (currentStepKey) {
      case 'event': return [
        { field: 'guest_count', label: 'Guest Count', test: v => Number(v) >= (form.alcohol_provider === 'hosted' ? 25 : 1) },
        { field: 'event_duration_hours', label: 'Duration', test: v => Number(v) >= 1 },
        { field: 'event_date', label: 'Event Date' },
        { field: 'event_city', label: 'City' },
        { field: 'event_state', label: 'State' },
        { field: 'alcohol_provider', label: 'Alcohol Provider' },
        { field: 'event_type', label: 'Event Type' },
        { field: 'event_type_custom', label: 'Custom Event Type', test: () => form.event_type !== 'Other' || !!form.event_type_custom.trim() },
      ];
      case 'package': return [{ field: 'package_id', label: 'Package' }];
      case 'addons': return [];
      case 'review': return [];
      case 'contact': return [
        { field: 'client_name', label: 'Name' },
        { field: 'client_email', label: 'Email' },
      ];
      default: return [];
    }
  };

  const tryAdvance = async () => {
    const result = validate(getStepRules(), form);
    if (result.valid) {
      setError('');
      setFieldErrors({});
      clearAll();
      setResumed(false);
      const nextStep = step + 1;
      // Capture lead + create server draft when moving past contact step (skip if already captured)
      if (currentStepKey === 'contact' && !draftTokenRef.current) {
        try {
          const res = await fetch(`${API_BASE}/api/proposals/public/capture-lead`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: form.client_name.trim(),
              email: form.client_email.trim(),
              phone: form.client_phone || null,
              guest_count: Number(form.guest_count) || null,
              event_date: form.event_date || null,
              source: 'quote_wizard',
              form_state: form,
              current_step: nextStep,
            }),
          });
          const data = res.ok ? await res.json() : null;
          if (data && data.draft_token) {
            draftTokenRef.current = data.draft_token;
            setHasDraftToken(true);
            saveDraftLocal(form, nextStep, data.draft_token);
          }
        } catch { /* advance anyway — localStorage still works */ }
      } else {
        // Save to localStorage on every step advance
        saveDraftLocal(form, nextStep, draftTokenRef.current);
        // Save to server if we have a token
        if (draftTokenRef.current) saveDraftServer();
      }
      setStep(nextStep);
    } else {
      setError(result.message);
    }
  };

  // Skip the (long) extras step without selecting anything. Lossless: does NOT
  // clear form.addon_ids — user can return via the stepper/Back. Mirrors
  // tryAdvance's draft-save path; addons has no validation so none is needed.
  const skipExtras = () => {
    setError('');
    setFieldErrors({});
    clearAll();
    setResumed(false);
    const nextStep = step + 1;
    saveDraftLocal(form, nextStep, draftTokenRef.current);
    if (draftTokenRef.current) saveDraftServer();
    setStep(nextStep);
  };

  const handleSubmit = async () => {
    const result = validate(getStepRules(), form);
    if (!result.valid) {
      setError(result.message);
      return;
    }
    setError('');
    setFieldErrors({});
    clearAll();
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/proposals/public/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: form.client_name.trim(),
          client_email: form.client_email.trim(),
          client_phone: form.client_phone || null,
          event_type: form.event_type === 'Other' ? (form.event_type_custom.trim() || 'Other') : form.event_type || null,
          event_type_category: form.event_type_category || null,
          event_type_custom: form.event_type === 'Other' ? (form.event_type_custom.trim() || null) : null,
          event_date: form.event_date || null,
          event_start_time: form.event_start_time || null,
          event_duration_hours: Number(form.event_duration_hours) || 4,
          venue_name: form.venue_name?.trim() || null,
          venue_city: form.event_city,
          venue_state: form.event_state,
          venue_street: form.venue_street?.trim() || null,
          venue_zip: form.venue_zip?.trim() || null,
          guest_count: Number(form.guest_count) || 50,
          package_id: Number(form.package_id),
          num_bars: numBars,
          addon_ids: stripIncludedAddons(form.addon_ids, addons).map(Number),
          addon_quantities: form.addon_quantities,
          syrup_selections: form.syrup_selections,
          client_provides_glassware: form.client_provides_glassware || false,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const err = new Error(data.error || 'Failed to submit quote.');
        err.fieldErrors = data.fieldErrors;
        throw err;
      }
      localStorage.removeItem(DRAFT_KEY);
      draftTokenRef.current = null;
      toast.success('Quote submitted!');
      setSuccess(data);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <section className="wz-section" id="quote">
        <div className="wz-success">
          <div className="wz-success-icon">&#10003;</div>
          <h2>Your proposal is ready!</h2>
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

  if (loading) {
    return (
      <section className="wz-section" id="quote">
        <div className="ws-section-heading">
          <p className="ws-kicker">Get Your Quote</p>
          <h2>Instant pricing for your event</h2>
          <p className="ws-section-sub">Loading pricing data...</p>
        </div>
      </section>
    );
  }

  const ROMANS = ['I', 'II', 'III', 'IV', 'V'];

  // Only text-entry controls summon the phone keyboard; radios, checkboxes,
  // selects, and date wheels must NOT hide the bar (tapping a package card
  // focuses its radio, and losing the bar there was a verified regression).
  const summonsKeyboard = (t) => {
    if (!t) return false;
    if (t.tagName === 'TEXTAREA') return true;
    if (t.tagName !== 'INPUT') return false;
    return /^(text|email|tel|number|search|url|password)$/.test(t.type || 'text');
  };
  const trackFocus = (focused) => (e) => {
    if (summonsKeyboard(e.target)) setInputFocused(focused);
  };

  return (
    <section
      className="wz-section"
      id="quote"
      onFocusCapture={trackFocus(true)}
      onBlurCapture={trackFocus(false)}
    >
      {/* Page hero — Apothecary Press */}
      <div className="ws-press-pagehero wz-pagehero">
        <div className="ws-wrap">
          <div className="ornament" aria-hidden="true">⚗</div>
          <div className="ws-press-eyebrow">Rx · The Prescription</div>
          <h1 className="ws-press-pagehero-title">The Instant Quote.</h1>
          <p className="ws-press-pagehero-sub">
            Five minutes. Live pricing as you go. We'll send a real proposal. Sign and pay in one breath.
          </p>
        </div>
      </div>

      {/* Welcome back banner */}
      {resumed && (
        <div className="wz-resume-banner">
          <span>Welcome back! We saved your progress.</span>
          <div className="wz-resume-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={dismissResume}>Continue</button>
            <button type="button" className="btn btn-sm btn-secondary" onClick={editAnswers}>Edit Answers</button>
          </div>
        </div>
      )}

      {/* Stepper — segmented brass-bordered cells */}
      <div className="wz-stepper" role="navigation" aria-label="Quote progress">
        {steps.map((s, i) => {
          const active = i === step;
          const done = i < step;
          return (
            <button
              key={s.key}
              type="button"
              className={`wz-stepper-cell ${active ? 'active' : ''} ${done ? 'done' : ''}`}
              onClick={() => i < step && replaceStep(i)}
              disabled={i > step}
              aria-current={active ? 'step' : undefined}
            >
              <span className="wz-stepper-roman">Step {ROMANS[i] || (i + 1)}</span>
              <span className="wz-stepper-name">{s.label}</span>
            </button>
          );
        })}
      </div>

      {/* Compact stepper — swapped in for the cell strip below 720px (CSS).
          Same steps array, so labels can never drift from the desktop strip.
          Known tradeoff (spec): no multi-step jump-back on phones; the Back
          button and the Review step's edit links cover those flows. */}
      <div className="wz-stepper-compact" aria-label="Quote progress">
        <span className="wz-stepper-roman">Step {ROMANS[step] || step + 1} of {ROMANS[steps.length - 1] || steps.length}</span>
        <span className="wz-stepper-name">{steps[step].label}</span>
      </div>

      <div className="wz-body">
        <div className="wz-form-area">
          {/* Step: Event Details */}
          {currentStepKey === 'event' && (
            <EventDetailsStep
              form={form}
              setForm={setForm}
              update={update}
              fieldClass={fieldClass}
              inputClass={inputClass}
              fieldErrors={fieldErrors}
              handleAlcoholChange={handleAlcoholChange}
              eventTypeRef={eventTypeRef}
              eventTypeInputRef={eventTypeInputRef}
              eventTypeQuery={eventTypeQuery}
              setEventTypeQuery={setEventTypeQuery}
              eventTypeOpen={eventTypeOpen}
              setEventTypeOpen={setEventTypeOpen}
              eventTypeHighlight={eventTypeHighlight}
              setEventTypeHighlight={setEventTypeHighlight}
              eventTypeFiltered={eventTypeFiltered}
              selectEventType={selectEventType}
              handleEventTypeKeyDown={handleEventTypeKeyDown}
              clearField={clearField}
            />
          )}

          {/* Step: Package Selection (hosted only) */}
          {currentStepKey === 'package' && (
            <PackageStep
              form={form}
              update={update}
              handleBarTypeChange={handleBarTypeChange}
              filteredPackages={filteredPackages}
            />
          )}

          {/* Step: Add-ons */}
          {currentStepKey === 'addons' && (
            <ExtrasStep
              form={form}
              setForm={setForm}
              addons={addons}
              groupedAddons={groupedAddons}
              toggleAddon={toggleAddon}
              guestCount={guestCount}
              glasswareRequirementMet={glasswareRequirementMet}
              realGlasswareAddon={realGlasswareAddon}
              isIncludedByBundle={(slug) => isIncludedByBundle(slug, form.addon_ids, addons)}
              isUnavailableByBundle={(slug) => isUnavailableByBundle(slug, form.addon_ids, addons)}
              onSkipExtras={skipExtras}
              stepRoman={ROMANS[step]}
            />
          )}

          {/* Step: Review */}
          {currentStepKey === 'review' && (
            <ReviewStep
              form={form}
              replaceStep={replaceStep}
              selectedPkg={selectedPkg}
              addons={addons}
              stripIncludedAddons={(ids) => stripIncludedAddons(ids, addons)}
            />
          )}

          {/* Step: Contact Info */}
          {currentStepKey === 'contact' && (
            <YourInfoStep
              form={form}
              update={update}
              fieldClass={fieldClass}
              inputClass={inputClass}
              fieldErrors={fieldErrors}
            />
          )}
        </div>

        {/* Pricing sidebar — Apothecary Press parchment with brass frame.
            Hidden at <=900px (the WizardPriceBar replaces it there). */}
        <div className="wz-sidebar">
          <PrescriptionCard preview={preview} />
        </div>
      </div>

      <FormBanner error={error} fieldErrors={fieldErrors} />

      {/* Navigation */}
      <div className="wz-nav">
        {step > 0 && (
          <button className="btn btn-secondary" type="button" onClick={() => {
            setError('');
            setFieldErrors({});
            clearAll();
            // On the package step with a bar type selected, clear bar type instead of going back
            if (currentStepKey === 'package' && form.bar_type) {
              handleBarTypeChange('');
            } else {
              setStep(s => s - 1);
            }
          }}>
            ← Back
          </button>
        )}
        <div style={{ flex: 1 }} />
        {step < steps.length - 1 ? (
          <button className="btn btn-primary" type="button"
            onClick={tryAdvance}>
            Continue →
          </button>
        ) : (
          <button className="btn btn-primary" type="button" disabled={submitting}
            onClick={handleSubmit}>
            {submitting ? 'Submitting...' : 'Send proposal · See my quote'}
          </button>
        )}
      </div>

      {/* Phones (<=900px): fixed bottom bar carries the live price + the
          step's primary action; the in-flow primary above is hidden by CSS. */}
      <WizardPriceBar
        preview={preview}
        isFinalStep={step >= steps.length - 1}
        submitting={submitting}
        onContinue={tryAdvance}
        onSubmit={handleSubmit}
        hidden={inputFocused}
      />
    </section>
  );
}

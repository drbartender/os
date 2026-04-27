import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import FormBanner from '../../../components/FormBanner';
import { useToast } from '../../../context/ToastContext';
import { ADDON_CATEGORIES } from '../../../data/addonCategories';
import useFormValidation from '../../../hooks/useFormValidation';
import useWizardHistory from '../../../hooks/useWizardHistory';
import EVENT_TYPES from '../../../data/eventTypes';
import {
  BYOB_BUNDLE_SLUGS,
  MIXER_SLUGS,
  BUNDLE_INCLUDED,
  BUNDLE_UNAVAILABLE,
  BUNDLE_COVERED,
} from './bundleConfig';
import { getSteps, formatCurrency } from './helpers';
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

  const getSelectedBundleSlug = useCallback((ids) => {
    for (const id of ids) {
      const a = addons.find(x => x.id === id);
      if (a && BYOB_BUNDLE_SLUGS.includes(a.slug)) return a.slug;
    }
    return null;
  }, [addons]);

  // Drop addon_ids covered by the active bundle (used for pricing preview, submit, review)
  const stripIncludedAddons = useCallback((ids) => {
    const bundle = getSelectedBundleSlug(ids);
    if (!bundle) return ids;
    const covered = new Set(BUNDLE_COVERED[bundle]);
    return ids.filter(id => {
      const a = addons.find(x => x.id === id);
      return !a || !covered.has(a.slug) || BYOB_BUNDLE_SLUGS.includes(a.slug);
    });
  }, [addons, getSelectedBundleSlug]);

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
    const flavorBlaster = addons.find(a => a.slug === 'flavor-blaster-rental');
    const realGlassware = addons.find(a => a.slug === 'real-glassware');
    if (!flavorBlaster) return;
    const hasFB = form.addon_ids.includes(flavorBlaster.id);
    if (!hasFB) return;
    const hasGlassware = (realGlassware && form.addon_ids.includes(realGlassware.id)) || form.client_provides_glassware;
    if (!hasGlassware) {
      setForm(f => ({ ...f, addon_ids: f.addon_ids.filter(id => id !== flavorBlaster.id) }));
    }
  }, [form.addon_ids, form.client_provides_glassware, addons]);

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
          addon_ids: stripIncludedAddons(form.addon_ids).map(Number),
          addon_quantities: form.addon_quantities,
          syrup_selections: form.syrup_selections,
        }),
      });
      if (!res.ok) { setPreview(null); return; }
      const data = await res.json();
      if (data && data.total != null) setPreview(data);
      else setPreview(null);
    } catch { setPreview(null); }
  }, [form.package_id, form.guest_count, form.event_duration_hours, numBars, form.addon_ids, form.addon_quantities, form.syrup_selections, stripIncludedAddons]);

  useEffect(() => { fetchPreview(); }, [fetchPreview]);

  const update = (field, value) => { setForm(f => ({ ...f, [field]: value })); clearField(field); };

  const toggleAddon = (id) => {
    // No-op if this addon is blocked by the selected bundle (either included or unavailable)
    const clicked = addons.find(a => a.id === id);
    const bundle = getSelectedBundleSlug(form.addon_ids);
    if (clicked && bundle && !BYOB_BUNDLE_SLUGS.includes(clicked.slug) && BUNDLE_COVERED[bundle].includes(clicked.slug)) {
      return;
    }
    setForm(f => {
      const isRemoving = f.addon_ids.includes(id);
      let newIds;
      const updates = {};
      if (isRemoving) {
        const removedAddon = addons.find(a => a.id === id);
        const dependentIds = addons
          .filter(a => a.requires_addon_slug === removedAddon?.slug)
          .map(a => a.id);
        newIds = f.addon_ids.filter(a => a !== id && !dependentIds.includes(a));
        // Clear syrup selections when unchecking the syrup add-on
        if (removedAddon?.slug === 'handcrafted-syrups') {
          updates.syrup_selections = [];
        }
      } else {
        const addedAddon = addons.find(a => a.id === id);
        newIds = [...f.addon_ids, id];
        // BYOB bundles are mutually exclusive — remove other bundles when selecting one
        if (addedAddon && BYOB_BUNDLE_SLUGS.includes(addedAddon.slug)) {
          const otherBundleIds = addons
            .filter(a => BYOB_BUNDLE_SLUGS.includes(a.slug) && a.id !== id)
            .map(a => a.id);
          newIds = newIds.filter(a => !otherBundleIds.includes(a));
        }
        // Signature / Full Mixers are mutually exclusive — radio-swap
        if (addedAddon && MIXER_SLUGS.includes(addedAddon.slug)) {
          const otherMixerIds = addons
            .filter(a => MIXER_SLUGS.includes(a.slug) && a.id !== id)
            .map(a => a.id);
          newIds = newIds.filter(a => !otherMixerIds.includes(a));
        }
      }
      return { ...f, ...updates, addon_ids: newIds };
    });
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
      guest_count: value === 'hosted' && Number(f.guest_count) < 25 ? 25 : f.guest_count,
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

  // Helper: check if a specific addon slug is selected
  const hasAddon = (slug) => form.addon_ids.some(id => {
    const addon = addons.find(x => x.id === id);
    return addon && addon.slug === slug;
  });

  const selectedBundle = getSelectedBundleSlug(form.addon_ids);
  const isIncludedByBundle = (slug) =>
    !!selectedBundle && (BUNDLE_INCLUDED[selectedBundle] || []).includes(slug) && !BYOB_BUNDLE_SLUGS.includes(slug);
  const isUnavailableByBundle = (slug) =>
    !!selectedBundle && (BUNDLE_UNAVAILABLE[selectedBundle] || []).includes(slug);
  const guestCount = Number(form.guest_count) || 50;

  // Flavor Blaster glassware guardrail
  const realGlasswareAddon = addons.find(a => a.slug === 'real-glassware');
  const hasRealGlassware = realGlasswareAddon && form.addon_ids.includes(realGlasswareAddon.id);
  const glasswareRequirementMet = hasRealGlassware || form.client_provides_glassware;

  const filteredAddons = addons.filter(a => {
    // Basic applies_to check
    if (a.applies_to !== 'all' && (!selectedPkg || a.applies_to !== selectedPkg.category)) return false;

    // Garnish Package: BYOB only (already included in hosted and Full Compound)
    if (a.slug === 'garnish-package-only') {
      if (isHosted) return false;
    }

    // Mocktail Bar: for BYOB, requires Formula or Full Compound
    if (a.slug === 'mocktail-bar' && selectedPkg?.category === 'byob') {
      if (!hasAddon('the-formula') && !hasAddon('the-full-compound')) return false;
    }

    // Real Glassware & Coupe Upgrade: max 100 guests (public wizard only)
    if ((a.slug === 'real-glassware' || a.slug === 'champagne-coupe-upgrade') && guestCount > 100) return false;

    // Hide dependent add-ons until parent is selected
    if (a.requires_addon_slug) {
      const parentAddon = addons.find(x => x.slug === a.requires_addon_slug);
      if (!parentAddon || !form.addon_ids.includes(parentAddon.id)) return false;
    }

    // Hide the 3-pack variant (single is the entry point, picker handles quantity)
    if (a.slug === 'handcrafted-syrups-3pack') return false;
    // Parking fee is handled in the Potion Planning Lab, not here
    if (a.slug === 'parking-fee') return false;
    return true;
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

  // Track which add-on descriptions are manually expanded
  const [expandedAddons, setExpandedAddons] = useState(new Set());
  const toggleExpand = (id) => {
    setExpandedAddons(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
          event_location: [form.event_city, form.event_state].filter(Boolean).join(', ') || null,
          guest_count: Number(form.guest_count) || 50,
          package_id: Number(form.package_id),
          num_bars: numBars,
          addon_ids: stripIncludedAddons(form.addon_ids).map(Number),
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

  return (
    <section className="wz-section" id="quote">
      <div className="ws-section-heading">
        <p className="ws-kicker">Get Your Quote</p>
        <h2>Instant pricing for your event</h2>
        <p className="ws-section-sub">Answer a few questions and get a real quote — no waiting, no back-and-forth.</p>
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

      {/* Step indicators */}
      <div className="wz-steps">
        {steps.map((s, i) => (
          <button
            key={s.key}
            className={`wz-step-dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
            onClick={() => i < step && replaceStep(i)}
            disabled={i > step}
          >
            <span className="wz-step-num">{i < step ? '✓' : i + 1}</span>
            <span className="wz-step-label">{s.label}</span>
          </button>
        ))}
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
              update={update}
              groupedAddons={groupedAddons}
              toggleAddon={toggleAddon}
              guestCount={guestCount}
              glasswareRequirementMet={glasswareRequirementMet}
              realGlasswareAddon={realGlasswareAddon}
              expandedAddons={expandedAddons}
              toggleExpand={toggleExpand}
              isIncludedByBundle={isIncludedByBundle}
              isUnavailableByBundle={isUnavailableByBundle}
            />
          )}

          {/* Step: Review */}
          {currentStepKey === 'review' && (
            <ReviewStep
              form={form}
              replaceStep={replaceStep}
              selectedPkg={selectedPkg}
              addons={addons}
              stripIncludedAddons={stripIncludedAddons}
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
                {preview.floor_applied && (
                  <div className="wz-price-note">Small event minimum applies</div>
                )}
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
            Back
          </button>
        )}
        <div style={{ flex: 1 }} />
        {step < steps.length - 1 ? (
          <button className="btn btn-primary" type="button"
            onClick={tryAdvance}>
            Next
          </button>
        ) : (
          <button className="btn btn-primary" type="button" disabled={submitting}
            onClick={handleSubmit}>
            {submitting ? 'Submitting...' : 'Submit & See My Proposal'}
          </button>
        )}
      </div>
    </section>
  );
}

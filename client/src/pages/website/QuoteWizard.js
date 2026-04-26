import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import SyrupPicker from '../../components/SyrupPicker';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import { useToast } from '../../context/ToastContext';
import { getPackageBySlug } from '../../data/packages';
import { ADDON_CATEGORIES, ADDON_ICONS } from '../../data/addonCategories';
import useFormValidation from '../../hooks/useFormValidation';
import useWizardHistory from '../../hooks/useWizardHistory';
import EVENT_TYPES from '../../data/eventTypes';
import { formatPhoneInput, stripPhone } from '../../utils/formatPhone';
import TimePicker from '../../components/TimePicker';
import NumberStepper from '../../components/NumberStepper';

const API_BASE = process.env.REACT_APP_API_URL || '';
const DRAFT_KEY = 'drb_quote_draft';

// BYOB bundle definitions
const BYOB_BUNDLE_SLUGS = ['the-foundation', 'the-formula', 'the-full-compound'];
const MIXER_SLUGS = ['signature-mixers-only', 'full-mixers-only'];

// Items the bundle covers — shown auto-checked with "INCLUDED" pill
const BUNDLE_INCLUDED = {
  'the-foundation': ['ice-delivery-only', 'cups-disposables-only', 'bottled-water-only'],
  'the-formula': ['ice-delivery-only', 'cups-disposables-only', 'bottled-water-only', 'signature-mixers-only'],
  'the-full-compound': ['ice-delivery-only', 'cups-disposables-only', 'bottled-water-only', 'full-mixers-only', 'garnish-package-only'],
};

// Items disabled (but not "included") — the bundle supersedes or excludes them
const BUNDLE_UNAVAILABLE = {
  'the-formula': ['full-mixers-only'],            // Formula already has Signature Mixers
  'the-full-compound': ['signature-mixers-only'], // Full Compound's Full Mixers encompasses Signature
};

// Union of both lists — used to strip covered items from pricing/submit
const BUNDLE_COVERED = Object.fromEntries(
  BYOB_BUNDLE_SLUGS.map(b => [b, [...(BUNDLE_INCLUDED[b] || []), ...(BUNDLE_UNAVAILABLE[b] || [])]])
);

// Build the dynamic step list based on alcohol choice
function getSteps(alcoholProvider) {
  const steps = [{ key: 'event', label: 'Event Details' }];
  steps.push({ key: 'contact', label: 'Your Info' });
  if (alcoholProvider === 'hosted') {
    steps.push({ key: 'package', label: 'Package' });
  }
  steps.push({ key: 'addons', label: 'Extras' });
  steps.push({ key: 'review', label: 'Review' });
  return steps;
}

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

  // Short taglines shown on tile before expanding
  const ADDON_TAGLINES = {
    // BYOB bundles
    'the-foundation': 'Ice, water, cups & napkins — the essentials',
    'the-formula': 'Foundation + mixers, garnishes & bitters',
    'the-full-compound': 'The works — full mixers, premium garnishes & more',
    // Premium
    'champagne-toast': 'We provide the champagne and flutes',
    'real-glassware': 'Rocks glasses, coupes & wine glasses — no plastic',
    'flavor-blaster-rental': 'Aromatic bubbles that burst on the first sip',
    'smoked-cocktail-kit': 'Torch and wood chips — smoke any drink on demand',
    // Beverage
    'soft-drink-addon': 'Required when 10+ guests (or 20%) drink soda on their own',
    'mocktail-bar': 'We bring all the specialty ingredients',
    'pre-batched-mocktail': 'Simple, ready-to-pour NA option',
    'house-made-ginger-beer': 'Fresh-pressed, carbonated live at the bar',
    'carbonated-cocktails': 'Up to 2 signature cocktails fully infused with CO2 for a sparkling, effervescent finish',
    // Staffing
    'barback': 'Keeps your bartender at the bar, not restocking',
    'banquet-server': 'Circulate drinks, bus glasses & more',
    'additional-bartender': 'Beyond our recommended 1-per-100 ratio',
    // Logistics
    'parking-fee': 'Only if your venue charges for parking',
  };

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

  const formatCurrency = (amount) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

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
                <div className={`form-group${fieldClass('guest_count')}`}>
                  <label htmlFor="wz-guest_count" className="form-label">Guest Count *</label>
                  <input id="wz-guest_count" className={`form-input${inputClass('guest_count')}`} type="number" min={form.alcohol_provider === 'hosted' ? 25 : 1} max="1000"
                    value={form.guest_count} onChange={e => update('guest_count', e.target.value)}
                    aria-invalid={!!fieldErrors?.guest_count} />
                  <FieldError error={fieldErrors?.guest_count} />
                  {form.alcohol_provider === 'hosted' && <span className="form-hint">Minimum 25 guests for hosted packages</span>}
                </div>
                <div className={`form-group${fieldClass('event_duration_hours')}`}>
                  <label htmlFor="wz-event_duration_hours" className="form-label">Duration (hours) *</label>
                  <NumberStepper id="wz-event_duration_hours" className={`form-input${inputClass('event_duration_hours')}`}
                    min={1} max={12} step={0.5}
                    value={form.event_duration_hours} onChange={v => update('event_duration_hours', v)}
                    aria-invalid={!!fieldErrors?.event_duration_hours}
                    ariaLabelIncrease="Increase duration" ariaLabelDecrease="Decrease duration" />
                  <FieldError error={fieldErrors?.event_duration_hours} />
                </div>
                <div className={`form-group${fieldClass('event_date')}`}>
                  <label htmlFor="wz-event_date" className="form-label">Event Date *</label>
                  <input id="wz-event_date" className={`form-input${inputClass('event_date')}`} type="date" value={form.event_date}
                    min={new Date().toISOString().split('T')[0]}
                    onChange={e => update('event_date', e.target.value)}
                    aria-invalid={!!fieldErrors?.event_date} />
                  <FieldError error={fieldErrors?.event_date} />
                </div>
                <div className="form-group">
                  <label htmlFor="wz-event_start_time" className="form-label">Start Time</label>
                  <TimePicker
                    id="wz-event_start_time"
                    value={form.event_start_time}
                    onChange={(v) => update('event_start_time', v)}
                    minHour={8}
                    maxHour={22}
                  />
                </div>
                <div className={`form-group${fieldClass('event_city')}`}>
                  <label htmlFor="wz-event_city" className="form-label">City *</label>
                  <input id="wz-event_city" className={`form-input${inputClass('event_city')}`} value={form.event_city}
                    onChange={e => update('event_city', e.target.value)} placeholder="e.g. Chicago"
                    aria-invalid={!!fieldErrors?.event_city} />
                  <FieldError error={fieldErrors?.event_city} />
                </div>
                <div className={`form-group${fieldClass('event_state')}`}>
                  <label htmlFor="wz-event_state" className="form-label">State *</label>
                  <select id="wz-event_state" className={`form-select${inputClass('event_state')}`} value={form.event_state}
                    onChange={e => update('event_state', e.target.value)}
                    aria-invalid={!!fieldErrors?.event_state}>
                    <option value="">-- Select --</option>
                    <option value="Illinois">Illinois</option>
                    <option value="Indiana">Indiana</option>
                    <option value="Michigan">Michigan</option>
                    <option value="Minnesota">Minnesota</option>
                    <option value="Wisconsin">Wisconsin</option>
                  </select>
                  <FieldError error={fieldErrors?.event_state} />
                </div>

                {/* Alcohol provider */}
                <div className={`form-group${fieldClass('alcohol_provider')}`}>
                  <label htmlFor="wz-alcohol_provider" className="form-label">Who provides the alcohol? *</label>
                  <select id="wz-alcohol_provider" className={`form-select${inputClass('alcohol_provider')}`} value={form.alcohol_provider}
                    onChange={e => handleAlcoholChange(e.target.value)}
                    aria-invalid={!!fieldErrors?.alcohol_provider}>
                    <option value="">-- Select --</option>
                    <option value="mocktail">No alcohol (mocktails only)</option>
                    <option value="byob">I'll provide the alcohol</option>
                    <option value="hosted">Dr. Bartender provides the alcohol</option>
                  </select>
                  <FieldError error={fieldErrors?.alcohol_provider} />
                </div>

                <div className="form-group">
                  <label htmlFor="wz-needs_bar" className="form-label">Need a Portable Bar?</label>
                  <select id="wz-needs_bar" className="form-select" value={form.needs_bar ? 'yes' : 'no'}
                    onChange={e => update('needs_bar', e.target.value === 'yes')}>
                    <option value="no">No - venue has a bar</option>
                    <option value="yes">Yes - bring one</option>
                  </select>
                </div>

                {/* Event Type autocomplete */}
                <div className={`form-group${fieldClass('event_type')}`} style={{ gridColumn: '1 / -1', position: 'relative' }} ref={eventTypeRef}>
                  <label htmlFor="wz-event_type" className="form-label">Event Type *</label>
                  <input
                    id="wz-event_type"
                    ref={eventTypeInputRef}
                    className={`form-input${inputClass('event_type')}`}
                    value={eventTypeQuery}
                    onChange={e => {
                      setEventTypeQuery(e.target.value);
                      setEventTypeOpen(true);
                      setEventTypeHighlight(-1);
                      // Clear selection if user edits
                      if (form.event_type) {
                        setForm(f => ({ ...f, event_type: '', event_type_category: '', event_type_custom: '' }));
                      }
                    }}
                    onFocus={() => setEventTypeOpen(true)}
                    onKeyDown={handleEventTypeKeyDown}
                    placeholder="Start typing... e.g. Wedding, Birthday, Corporate"
                    autoComplete="off"
                    aria-invalid={!!fieldErrors?.event_type}
                  />
                  <FieldError error={fieldErrors?.event_type || fieldErrors?.event_type_custom} />
                  {eventTypeOpen && eventTypeFiltered.length > 0 && (
                    <ul className="wz-event-type-dropdown">
                      {eventTypeFiltered.map((et, i) => (
                        <li
                          key={et.id}
                          className={`wz-event-type-option${i === eventTypeHighlight ? ' highlighted' : ''}`}
                          onMouseDown={() => selectEventType(et)}
                          onMouseEnter={() => setEventTypeHighlight(i)}
                        >
                          {et.label}
                        </li>
                      ))}
                    </ul>
                  )}
                  {form.event_type === 'Other' && (
                    <input
                      className="form-input wz-event-type-custom"
                      value={form.event_type_custom}
                      onChange={e => update('event_type_custom', e.target.value)}
                      placeholder="Describe your event type"
                      style={{ marginTop: '0.5rem' }}
                    />
                  )}
                </div>
              </div>

              {/* Cocktail class link */}
              <p className="wz-class-link">
                Looking for a cocktail class? <a href="/classes">Book a mixology class</a>
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
                          {(() => {
                            const detail = getPackageBySlug(pkg.slug);
                            return detail ? (
                              <div className="wz-pkg-desc">{detail.tagline}</div>
                            ) : pkg.description ? (
                              <div className="wz-pkg-desc">{pkg.description}</div>
                            ) : null;
                          })()}
                          <div className="wz-pkg-price">
                            {pkg.pricing_type === 'per_guest' ? (
                              <>From ${Number(pkg.base_rate_4hr)}/guest</>
                            ) : (
                              <>From ${Number(pkg.base_rate_3hr || pkg.base_rate_4hr)}{pkg.base_rate_3hr ? '/3hr' : '/4hr'}</>
                            )}
                          </div>
                          {(() => {
                            const detail = getPackageBySlug(pkg.slug);
                            if (!detail) return null;
                            const isSelected = Number(form.package_id) === pkg.id;
                            if (isSelected) {
                              return (
                                <div className="wz-pkg-sections">
                                  <div className="wz-pkg-expand-hint">What's included</div>
                                  {detail.sections.map((section, si) => (
                                    <div key={si} className="wz-pkg-section">
                                      <div className="wz-pkg-section-heading">{section.heading}</div>
                                      <ul className="wz-pkg-section-list">
                                        {section.items.map((item, i) => <li key={i}>{item}</li>)}
                                      </ul>
                                    </div>
                                  ))}
                                </div>
                              );
                            }
                            return <div className="wz-pkg-expand-hint">Select to see what's included</div>;
                          })()}
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
              <h3>Customize your experience</h3>
              <p style={{ fontSize: '0.95rem', marginBottom: '1.25rem', color: 'var(--deep-brown)', opacity: 0.7 }}>
                Add extras to make your event unforgettable. All selections are optional.
              </p>
              {groupedAddons.length > 0 ? (
                groupedAddons.map(group => (
                  <div key={group.key} className="wz-addon-category">
                    <h4 className="wz-addon-category-heading">
                      <span className="wz-addon-category-icon">{group.icon}</span>
                      {group.label}
                    </h4>
                    {group.key === 'byob_support' && (
                      <p className="wz-addon-category-note">Only available with The Core Reaction package</p>
                    )}

                    {group.addons.length > 0 && (
                      <div className="wz-addon-list">
                        {group.addons.map(addon => {
                          const isSyrupAddon = addon.slug === 'handcrafted-syrups';
                          const hasQty = addon.slug === 'banquet-server' || addon.slug === 'barback' || addon.slug === 'pre-batched-mocktail' || addon.slug === 'additional-bartender';
                          const isSelected = form.addon_ids.includes(addon.id);
                          const isIncluded = isIncludedByBundle(addon.slug);
                          const isUnavailable = isUnavailableByBundle(addon.slug);
                          const displayChecked = isIncluded || (isSelected && !isUnavailable);
                          const isBlocked = isIncluded || isUnavailable;
                          const isExpanded = (isSelected && !isUnavailable) || expandedAddons.has(addon.id);
                          const isDependent = !!addon.requires_addon_slug;
                          const addonQty = form.addon_quantities[addon.id] || 1;

                          const priceLabel = (() => {
                            if (isSyrupAddon) return '$30/bottle \u00b7 3 for $75';
                            switch (addon.billing_type) {
                              case 'per_guest': return `$${Number(addon.rate)}/guest`;
                              case 'per_guest_timed': return `$${Number(addon.rate)}/guest`;
                              case 'per_hour': return `$${Number(addon.rate)}/hr`;
                              case 'per_staff': return `$${Number(addon.rate)}/staff member`;
                              case 'per_100_guests': return `$${Number(addon.rate)}/100 guests`;
                              case 'flat': return `$${Number(addon.rate)}`;
                              default: return `$${Number(addon.rate)}`;
                            }
                          })();

                          // Flavor Blaster: locked tile when glassware requirement not met
                          if (addon.slug === 'flavor-blaster-rental' && !glasswareRequirementMet) {
                            return (
                              <div key={addon.id} className="wz-addon-option locked">
                                <div className="wz-addon-row">
                                  <span className="wz-addon-icon">{ADDON_ICONS[addon.slug] || group.icon}</span>
                                  <div className="wz-addon-content">
                                    <div className="wz-addon-name">{addon.name}</div>
                                    <div className="wz-addon-locked-message">
                                      Aromatic finishing bubbles require proper glassware to form and present correctly. This enhancement is available with our real glassware upgrade.
                                    </div>
                                  </div>
                                </div>
                                <div className="wz-addon-unlock-actions">
                                  {guestCount <= 100 && realGlasswareAddon && (
                                    <button type="button" className="btn btn-primary btn-sm" onClick={() => toggleAddon(realGlasswareAddon.id)}>
                                      Add Real Glassware
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className={guestCount <= 100 && realGlasswareAddon ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}
                                    onClick={() => setForm(f => ({ ...f, client_provides_glassware: true }))}
                                  >
                                    I'll provide my own
                                  </button>
                                </div>
                              </div>
                            );
                          }

                          return (
                            <div
                              key={addon.id}
                              className={`wz-addon-option${isSelected && !isUnavailable ? ' selected' : ''}${isIncluded ? ' included' : ''}${isUnavailable ? ' unavailable' : ''}${isExpanded ? ' expanded' : ''}${isDependent ? ' dependent' : ''}`}
                            >
                              <div className="wz-addon-row" onClick={() => toggleAddon(addon.id)}>
                                <input
                                  type="checkbox"
                                  checked={displayChecked}
                                  disabled={isBlocked}
                                  onChange={() => toggleAddon(addon.id)}
                                  onClick={e => e.stopPropagation()}
                                />
                                <span className="wz-addon-icon">{ADDON_ICONS[addon.slug] || group.icon}</span>
                                <div className="wz-addon-content">
                                  <div className="wz-addon-name">{addon.name}</div>
                                  {ADDON_TAGLINES[addon.slug] && !isUnavailable && (
                                    <div className="wz-addon-tagline">{ADDON_TAGLINES[addon.slug]}</div>
                                  )}
                                  {isIncluded && <div className="wz-addon-included-label">INCLUDED</div>}
                                  {!isIncluded && !isUnavailable && <div className="wz-addon-price">{priceLabel}</div>}
                                </div>
                                {(addon.description || isSyrupAddon) && (
                                  <button
                                    type="button"
                                    className={`wz-addon-expand-btn${isExpanded ? ' open' : ''}`}
                                    onClick={e => { e.stopPropagation(); toggleExpand(addon.id); }}
                                    aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
                                  >
                                    <svg width="12" height="8" viewBox="0 0 12 8" fill="none">
                                      <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                  </button>
                                )}
                              </div>
                              {/* Quantity adjuster for banquet server / barback */}
                              {hasQty && isSelected && (
                                <div className="wz-addon-qty">
                                  <span>How many?</span>
                                  <div className="wz-addon-qty-controls">
                                    <button type="button" onClick={e => { e.stopPropagation(); setForm(f => ({ ...f, addon_quantities: { ...f.addon_quantities, [addon.id]: Math.max(1, addonQty - 1) } })); }} disabled={addonQty <= 1}>-</button>
                                    <span className="wz-addon-qty-value">{addonQty}</span>
                                    <button type="button" onClick={e => { e.stopPropagation(); setForm(f => ({ ...f, addon_quantities: { ...f.addon_quantities, [addon.id]: Math.min(10, addonQty + 1) } })); }}>+</button>
                                  </div>
                                </div>
                              )}
                              {addon.description && isExpanded && !isSyrupAddon && (
                                <div className="wz-addon-desc">{addon.description}</div>
                              )}
                              {/* Syrup picker — shown when syrup add-on is selected or expanded */}
                              {isSyrupAddon && isExpanded && (
                                <div className="wz-addon-syrup-section">
                                  {isSelected ? (
                                    <>
                                      <p className="wz-syrup-pick-note">
                                        Choose your flavors now, or skip and pick them later during your consultation.
                                      </p>
                                      <SyrupPicker
                                        selected={form.syrup_selections}
                                        onChange={(syrups) => update('syrup_selections', syrups)}
                                        compact
                                      />
                                    </>
                                  ) : (
                                    <div className="wz-addon-desc">
                                      {addon.description || 'Housemade cocktail syrups crafted with real ingredients. Choose from over 25 flavors. Each 750ml bottle makes 30-40 cocktails.'}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <p className="wz-no-addons">No add-ons available for this package. You can skip this step.</p>
              )}
            </div>
          )}

          {/* Step: Review */}
          {currentStepKey === 'review' && (
            <div className="wz-card">
              <h3>Review your proposal</h3>
              <div className="wz-review-summary">
                <div className="wz-review-section">
                  <div className="wz-review-heading">
                    <h4>Event Details</h4>
                    <button type="button" className="wz-review-edit" onClick={() => replaceStep(0)}>Edit</button>
                  </div>
                  <div className="wz-review-grid">
                    {form.event_type && <div><span className="wz-review-label">Event Type</span><span>{form.event_type === 'Other' ? form.event_type_custom : form.event_type}</span></div>}
                    <div><span className="wz-review-label">Guests</span><span>{form.guest_count}</span></div>
                    <div><span className="wz-review-label">Duration</span><span>{form.event_duration_hours} hours</span></div>
                    {form.event_date && <div><span className="wz-review-label">Date</span><span>{form.event_date}</span></div>}
                    {form.event_city && <div><span className="wz-review-label">Location</span><span>{[form.event_city, form.event_state].filter(Boolean).join(', ')}</span></div>}
                  </div>
                </div>
                <div className="wz-review-section">
                  <div className="wz-review-heading">
                    <h4>Contact</h4>
                    <button type="button" className="wz-review-edit" onClick={() => replaceStep(1)}>Edit</button>
                  </div>
                  <div className="wz-review-grid">
                    <div><span className="wz-review-label">Name</span><span>{form.client_name}</span></div>
                    <div><span className="wz-review-label">Email</span><span>{form.client_email}</span></div>
                    {form.client_phone && <div><span className="wz-review-label">Phone</span><span>{formatPhoneInput(form.client_phone)}</span></div>}
                  </div>
                </div>
                {selectedPkg && (
                  <div className="wz-review-section">
                    <h4>Package</h4>
                    <p>{selectedPkg.name}</p>
                  </div>
                )}
                {(stripIncludedAddons(form.addon_ids).length > 0 || form.client_provides_glassware) && (
                  <div className="wz-review-section">
                    <h4>Add-ons</h4>
                    <ul className="wz-review-addons">
                      {stripIncludedAddons(form.addon_ids).map(id => {
                        const addon = addons.find(a => a.id === id);
                        return addon ? <li key={id}>{addon.name}</li> : null;
                      })}
                      {form.client_provides_glassware && <li>Client providing own glassware</li>}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step: Contact Info */}
          {currentStepKey === 'contact' && (
            <div className="wz-card">
              <h3>Where should we send your proposal?</h3>
              <div className="wz-grid">
                <div className={`form-group${fieldClass('client_name')}`} style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="wz-client_name" className="form-label">Your Name *</label>
                  <input id="wz-client_name" className={`form-input${inputClass('client_name')}`} value={form.client_name}
                    onChange={e => update('client_name', e.target.value)} placeholder="Jane Smith"
                    aria-invalid={!!fieldErrors?.client_name} />
                  <FieldError error={fieldErrors?.client_name} />
                </div>
                <div className={`form-group${fieldClass('client_email')}`}>
                  <label htmlFor="wz-client_email" className="form-label">Email *</label>
                  <input id="wz-client_email" className={`form-input${inputClass('client_email')}`} type="email" value={form.client_email}
                    onChange={e => update('client_email', e.target.value)} placeholder="jane@example.com"
                    aria-invalid={!!fieldErrors?.client_email} />
                  <FieldError error={fieldErrors?.client_email} />
                </div>
                <div className="form-group">
                  <label htmlFor="wz-client_phone" className="form-label">Phone</label>
                  <input id="wz-client_phone" className="form-input" type="tel" value={formatPhoneInput(form.client_phone)}
                    onChange={e => update('client_phone', stripPhone(e.target.value))} placeholder="(312) 555-1234" />
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

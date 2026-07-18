import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import axios from 'axios';
import { API_BASE_URL as BASE_URL } from '../../../utils/api';
import FormBanner from '../../../components/FormBanner';
import { useToast } from '../../../context/ToastContext';
import { buildQueue, STEP_LABELS, requiredGaps } from './queue';
import { QUICK_PICKS, hostedActiveModules } from '../data/servingTypes';

// Planner v2 (spec 2026-07-18 §3.1/§3.2): pure information gathering. No
// payment UI, no upsells; any choice that creates a charge discloses it in
// place and lands on the event balance. Selling lives in the Enhancement Lab.
const WelcomeV2 = lazy(() => import('./steps/WelcomeV2'));
const QuickPickV2 = lazy(() => import('./steps/QuickPickV2'));
const DrinksV2 = lazy(() => import('./steps/DrinksV2'));
const HostedDrinksV2 = lazy(() => import('./steps/HostedDrinksV2'));
const SpiritsV2 = lazy(() => import('./steps/SpiritsV2'));
const BeerWineV2 = lazy(() => import('./steps/BeerWineV2'));
const CrowdV2 = lazy(() => import('./steps/CrowdV2'));
const MenuDesignV2 = lazy(() => import('./steps/MenuDesignV2'));
const DayOfV2 = lazy(() => import('./steps/DayOfV2'));
const ReviewV2 = lazy(() => import('./steps/ReviewV2'));
const CelebrationV2 = lazy(() => import('./steps/CelebrationV2'));

const DEFAULT_SELECTIONS = {
  signatureDrinks: [],
  customCocktails: [],
  mocktails: [],
  spirits: [],
  spiritsOther: '',
  mixersForSpirits: undefined,
  beerFromFullBar: [],
  wineFromFullBar: [],
  wineOtherFullBar: '',
  beerFromBeerWine: [],
  wineFromBeerWine: [],
  wineOtherBeerWine: '',
  addOns: {},
  menuStyle: null,
  menuTheme: '',
  drinkNaming: '',
  menuDesignNotes: '',
  companyLogo: '',
  additionalNotes: '',
  crowd: { drinkers: null, unsure: false, profile: null },
  barPlacement: null,
  powerAtBar: null,
  guestPreferences: {},
  logistics: { dayOfContact: { name: '', phone: '' }, parking: '', accessNotes: '', addBarRental: false },
};

// The admin recap (DrinkPlanSelections) picks its rich render path off
// selections.activeModules; without it every v2 plan renders as near-empty
// legacy. Derived, never user-set: hosted from the package bar type, BYOB
// from the quick pick (custom has none — legacy render is correct there).
function withActiveModules(sel, pick, isHosted, barType) {
  const am = isHosted
    ? hostedActiveModules(barType)
    : QUICK_PICKS.find((p) => p.key === pick)?.activeModules;
  return am ? { ...sel, activeModules: am } : sel;
}

export default function PlannerV2({ token, initialPlan }) {
  const toast = useToast();
  const plan = initialPlan;

  const [step, setStep] = useState(plan.status === 'submitted' || plan.status === 'reviewed' ? 'submitted' : 'welcome');
  const [quickPick, setQuickPick] = useState(plan.serving_type || null);
  const [selections, setSelections] = useState(() => {
    const saved = (plan.status === 'draft' || plan.status === 'submitted') && plan.selections
      ? plan.selections : {};
    // JSON clone, not structuredClone: iOS Safari < 15.4 lacks it and this is
    // a public, mobile-heavy surface.
    return { ...JSON.parse(JSON.stringify(DEFAULT_SELECTIONS)), ...saved };
  });
  const [catalog, setCatalog] = useState({ cocktails: [], cocktailCategories: [], mocktails: [], mocktailCategories: [] });
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [paidFromRedirect] = useState(() => new URLSearchParams(window.location.search).get('paid') === 'true');

  const isHosted = plan.package_category === 'hosted';
  const hostedReady = isHosted && plan.hosted_coverage && plan.hosted_coverage.has_contents === true;
  // Content-readiness switch (spec §7): a hosted package without entered
  // contents renders the LEGACY hosted flow. PlannerRouter can't know this
  // before the fetch, so the fallback lives here as a hard redirect of shape.
  const hostedShape = hostedReady
    ? (plan.package_slot_kind ? 'slots' : (plan.package_bar_type === 'beer_and_wine' ? 'display' : 'coverage'))
    : null;

  const queue = buildQueue({ isHosted, hostedShape, quickPick });
  // Pickable-pool size for the slots shape (empty pool = explicit none in the
  // required gate; hard slots draw from batchable cocktails, featured from
  // mocktails).
  const hostedPickableCount = hostedShape === 'slots'
    ? (plan.package_slot_kind === 'hard'
      ? (plan.hosted_coverage?.drinks || []).filter((d) => d.table === 'cocktails' && d.batchable).length
      : catalog.mocktails.length)
    : null;

  // Catalog fetch (names/categories for pickers + review)
  useEffect(() => {
    let off = false;
    Promise.all([
      axios.get(`${BASE_URL}/cocktails`),
      axios.get(`${BASE_URL}/mocktails`).catch(() => ({ data: { categories: [], mocktails: [] } })),
    ]).then(([c, m]) => {
      if (off) return;
      setCatalog({
        cocktails: c.data.cocktails || [],
        cocktailCategories: c.data.categories || [],
        mocktails: m.data.mocktails || [],
        mocktailCategories: m.data.categories || [],
      });
    }).catch(() => { /* pickers show empty states */ });
    return () => { off = true; };
  }, []);

  // ── Autosave (Next + silent 30s + beforeunload keepalive) ──────────
  const stateRef = useRef({});
  stateRef.current = { quickPick, selections, step };
  const submittingRef = useRef(false);

  const saveDraft = useCallback(async (silent = false) => {
    if (!token || submittingRef.current) return;
    if (!silent) setSaving(true);
    setSaveFailed(false);
    try {
      await axios.put(`${BASE_URL}/drink-plans/t/${token}`, {
        serving_type: stateRef.current.quickPick,
        selections: withActiveModules(stateRef.current.selections, stateRef.current.quickPick, isHosted, plan.package_bar_type),
        status: 'draft',
      });
    } catch (err) {
      console.error('Auto-save failed:', err);
      setSaveFailed(true);
    } finally {
      if (!silent) setSaving(false);
    }
  }, [token, isHosted, plan.package_bar_type]);

  useEffect(() => {
    if (step === 'submitted' || step === 'welcome') return undefined;
    const interval = setInterval(() => {
      const s = stateRef.current.step;
      if (s === 'submitted' || s === 'welcome') return;
      saveDraft(true);
    }, 30000);
    return () => clearInterval(interval);
  }, [step, saveDraft]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!token || stateRef.current.step === 'submitted') return;
      try {
        fetch(`${BASE_URL}/drink-plans/t/${token}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            serving_type: stateRef.current.quickPick,
            selections: stateRef.current.selections,
            status: 'draft',
          }),
          keepalive: true,
        });
      } catch (e) { /* best-effort */ }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [token]);

  // ── Navigation (browser back navigates steps, never leaves) ───────
  const goToStep = useCallback((next) => {
    setStep(next);
    window.history.pushState({ step: next }, '', '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handleBackRef = useRef(null);
  useEffect(() => {
    window.history.replaceState({ step: 'welcome' }, '', '');
    const onPop = (e) => {
      if (e.state?.step) {
        setStep(e.state.step);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        window.history.pushState({ step: stateRef.current.step }, '', '');
        handleBackRef.current?.();
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const stepIdx = queue.indexOf(step);
  const handleNext = () => {
    saveDraft();
    if (step === 'welcome') return goToStep(queue[0]);
    if (stepIdx !== -1 && stepIdx + 1 < queue.length) return goToStep(queue[stepIdx + 1]);
  };
  const handleBack = () => {
    if (step === 'welcome') return undefined;
    if (stepIdx > 0) return goToStep(queue[stepIdx - 1]);
    return goToStep('welcome');
  };
  handleBackRef.current = handleBack;

  const updateSelections = useCallback((field, value) => {
    setSelections((prev) => ({ ...prev, [field]: value }));
  }, []);

  // ── Submit ─────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    setError(null);
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await axios.put(`${BASE_URL}/drink-plans/t/${token}`, {
        serving_type: quickPick,
        selections: withActiveModules(selections, quickPick, isHosted, plan.package_bar_type),
        status: 'submitted',
      });
      toast.success('Formulas filed! Check your email.');
      setStep('submitted');
    } catch (err) {
      // eslint-disable-next-line no-restricted-syntax
      setError(err.response?.data?.error || 'Failed to submit. Please try again.');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────
  const progress = stepIdx !== -1 ? { n: stepIdx + 1, total: queue.length, label: STEP_LABELS[step] || '' } : null;
  const stepProps = {
    plan, token, selections, updateSelections, catalog,
    quickPick, setQuickPick, goToStep, handleNext, handleBack, queue,
    hostedShape,
  };

  if (step === 'submitted') {
    return (
      <div className="auth-page potion-app">
        <div className="page-container">
          <Suspense fallback={null}>
            <CelebrationV2 plan={plan} token={token} selections={selections} paidFromRedirect={paidFromRedirect} />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page potion-app">
      <div className="page-container">
        <header className="pp2-header">
          <div className="pp2-brand" aria-hidden="true"><span>Dr.</span><span>Bartender</span></div>
          <div className="pp2-header-meta">
            <div className="pp2-header-title">Potion Planning Lab</div>
            <div className="pp2-header-context">
              {[plan.client_name, plan.guest_count ? `${plan.guest_count} guests` : null,
                plan.package_category === 'hosted' ? plan.package_name : 'BYOB']
                .filter(Boolean).join(' · ')}
            </div>
          </div>
          <span
            className={`potion-save ${saveFailed ? 'failed' : (saving ? '' : 'saved')}`}
            role={saveFailed ? 'alert' : 'status'}
            aria-live={saveFailed ? 'assertive' : (saving ? 'polite' : 'off')}
          >
            {saveFailed ? 'Draft may not be saved. Check your connection.' : saving ? 'Saving…' : 'Saved'}
          </span>
        </header>

        {progress && (
          <div className="pp2-progress">
            <div className="potion-progress-counter" style={{ fontVariantNumeric: 'lining-nums' }}>
              Step {progress.n} of {progress.total} · {progress.label}
            </div>
            <div className="potion-rail" aria-hidden="true">
              {queue.map((q, i) => (
                <span key={q} className={`potion-rail-tick${i < progress.n - 1 ? ' done' : ''}${i === progress.n - 1 ? ' active' : ''}`} />
              ))}
            </div>
          </div>
        )}

        <div className="potion-step" key={step}>
          <Suspense fallback={<div style={{ padding: '3rem', textAlign: 'center', color: '#6b5a4e' }}>Loading…</div>}>
            {step === 'welcome' && <WelcomeV2 {...stepProps} onStart={handleNext} />}
            {step === 'quickPick' && <QuickPickV2 {...stepProps} />}
            {step === 'drinks' && <DrinksV2 {...stepProps} />}
            {step === 'hostedDrinks' && <HostedDrinksV2 {...stepProps} />}
            {step === 'spirits' && <SpiritsV2 {...stepProps} />}
            {step === 'beerWine' && <BeerWineV2 {...stepProps} />}
            {step === 'crowd' && <CrowdV2 {...stepProps} />}
            {step === 'menu' && <MenuDesignV2 {...stepProps} />}
            {step === 'dayof' && <DayOfV2 {...stepProps} />}
            {step === 'review' && (
              <ReviewV2
                {...stepProps}
                gaps={requiredGaps({ queue, selections, quickPick, hostedShape, hostedPickableCount })}
                onSubmit={handleSubmit}
                submitting={submitting}
              />
            )}
          </Suspense>
        </div>

        {error && <FormBanner error={error} />}

        {!['welcome', 'quickPick', 'review'].includes(step) && stepIdx !== -1 && (
          <div className="step-nav">
            <button className="btn btn-secondary" onClick={handleBack}>Back</button>
            <button className="btn btn-primary" onClick={handleNext}>Next</button>
          </div>
        )}
        {step === 'review' && (
          <div className="step-nav">
            <button className="btn btn-secondary" onClick={handleBack}>Back</button>
            <div />
          </div>
        )}
      </div>
    </div>
  );
}

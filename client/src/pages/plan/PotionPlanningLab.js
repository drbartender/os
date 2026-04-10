import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL as BASE_URL } from '../../utils/api';
import { QUICK_PICKS, MODULE_STEP_MAP, buildStepQueue, buildExplorationQueue, derivePhase } from './data/servingTypes';
import WelcomeStep from './steps/WelcomeStep';
import QuickPickStep from './steps/QuickPickStep';
import CustomSetupStep from './steps/CustomSetupStep';
import SignaturePickerStep from './steps/SignaturePickerStep';
import BeerWineStep from './steps/BeerWineStep';
import FullBarSpiritsStep from './steps/FullBarSpiritsStep';
import FullBarBeerWineStep from './steps/FullBarBeerWineStep';
import MocktailStep from './steps/MocktailStep';
import MenuDesignStep from './steps/MenuDesignStep';
import LogisticsStep from './steps/LogisticsStep';
import ConfirmationStep from './steps/ConfirmationStep';
// Exploration phase steps
import VibeStep from './steps/VibeStep';
import FlavorDirectionStep from './steps/FlavorDirectionStep';
import ExplorationBrowseStep from './steps/ExplorationBrowseStep';
import MocktailInterestStep from './steps/MocktailInterestStep';
import ExplorationSaveStep from './steps/ExplorationSaveStep';
import RefinementWelcomeStep from './steps/RefinementWelcomeStep';

const DEFAULT_ACTIVE_MODULES = { signatureDrinks: false, mocktails: false, fullBar: false, beerWineOnly: false };

const DEFAULT_SELECTIONS = {
  // Exploration data (Phase 1)
  exploration: {
    vibe: null,
    flavorDirections: [],
    dreamDrinkNotes: '',
    favoriteDrinks: [],
    mocktailInterest: null,
  },
  // Refinement data (Phase 2 — existing fields)
  signatureDrinks: [],
  signatureDrinkSpirits: [],
  customCocktails: [],
  mixersForSignatureDrinks: null,
  mocktails: [],
  mocktailNotes: '',
  spirits: [],
  spiritsOther: '',
  mixersForSpirits: null,
  beerFromFullBar: [],
  wineFromFullBar: [],
  wineOtherFullBar: '',
  beerWineBalanceFullBar: '',
  beerFromBeerWine: [],
  wineFromBeerWine: [],
  wineOtherBeerWine: '',
  beerWineBalanceBeerWine: '',
  syrupSelections: {},
  syrupSelfProvided: [],
  addOns: {},
  customMenuDesign: null,
  menuTheme: '',
  drinkNaming: '',
  menuDesignNotes: '',
  logistics: {
    dayOfContact: { name: '', phone: '' },
    parking: '',
    equipment: [],
    equipmentOther: '',
    accessNotes: '',
    addBarRental: false,
  },
};

export default function PotionPlanningLab() {
  const { token } = useParams();

  // Plan metadata
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  // Phase (derived from proposal status)
  const [phase, setPhase] = useState('exploration');

  // Cocktail menu
  const [cocktails, setCocktails] = useState([]);
  const [cocktailCategories, setCocktailCategories] = useState([]);

  // Mocktail menu
  const [mocktailItems, setMocktailItems] = useState([]);
  const [mocktailCategories, setMocktailCategories] = useState([]);

  // Ref for browser back button handler
  const handleBackRef = useRef(null);
  // Ref to prevent auto-save during submit
  const submittingRef = useRef(false);

  // Addon pricing + proposal context
  const [addonPricing, setAddonPricing] = useState([]);
  const [guestCount, setGuestCount] = useState(null);
  const [numBartenders, setNumBartenders] = useState(null);
  const [numBars, setNumBars] = useState(0);
  const [pricingSnapshot, setPricingSnapshot] = useState(null);
  const [proposalSyrups, setProposalSyrups] = useState([]);
  const [proposalPaymentInfo, setProposalPaymentInfo] = useState(null);

  // Check if returning from Stripe payment redirect
  const paidFromRedirect = new URLSearchParams(window.location.search).get('paid') === 'true';

  // Flow state
  const [step, setStep] = useState('welcome');
  const [quickPickChoice, setQuickPickChoice] = useState(null);
  const [activeModules, setActiveModules] = useState(DEFAULT_ACTIVE_MODULES);
  const [moduleQueue, setModuleQueue] = useState([]);
  const [explorationQueue, setExplorationQueue] = useState([]);

  // Form selections
  const [selections, setSelections] = useState(DEFAULT_SELECTIONS);

  // Load plan + cocktails + mocktails
  useEffect(() => {
    async function fetchPlan() {
      try {
        const [planRes, cocktailsRes, mocktailsRes, addonsRes] = await Promise.all([
          axios.get(`${BASE_URL}/drink-plans/t/${token}`),
          axios.get(`${BASE_URL}/cocktails`),
          axios.get(`${BASE_URL}/mocktails`).catch(() => ({ data: { categories: [], mocktails: [] } })),
          axios.get(`${BASE_URL}/proposals/public/addons`).catch(() => ({ data: [] })),
        ]);
        setCocktails(cocktailsRes.data.cocktails || []);
        setCocktailCategories(cocktailsRes.data.categories || []);
        setMocktailItems(mocktailsRes.data.mocktails || []);
        setMocktailCategories(mocktailsRes.data.categories || []);
        setAddonPricing(addonsRes.data || []);
        setPlan(planRes.data);

        // Derive phase from proposal status
        const derivedPhase = derivePhase(planRes.data.proposal_status);
        setPhase(derivedPhase);

        // Set up exploration queue
        if (derivedPhase === 'exploration') {
          setExplorationQueue(buildExplorationQueue());
        }

        // Extract proposal context (guest count, bartenders, pre-purchased syrups)
        const planData = planRes.data;
        if (planData.guest_count) setGuestCount(planData.guest_count);
        if (planData.num_bartenders) setNumBartenders(planData.num_bartenders);
        if (planData.num_bars) setNumBars(planData.num_bars);
        if (planData.pricing_snapshot) setPricingSnapshot(planData.pricing_snapshot);
        const pSyrups = planData.pricing_snapshot?.syrups?.selections || [];
        setProposalSyrups(pSyrups);

        // Extract proposal payment context
        if (planData.proposal_id) {
          setProposalPaymentInfo({
            totalPrice: planData.proposal_total_price,
            amountPaid: planData.proposal_amount_paid,
            eventDate: planData.proposal_event_date || planData.event_date,
            balanceDueDate: planData.proposal_balance_due_date,
          });
        }

        // Restore saved state if draft/submitted/exploration_saved
        const data = planRes.data;
        if (data.status === 'draft' || data.status === 'submitted' || data.status === 'exploration_saved') {
          const savedSel = data.selections || {};

          // Migrate legacy flat syrupSelections array to per-drink map
          if (Array.isArray(savedSel.syrupSelections)) {
            // Legacy flat array — place under '_general' key so they're preserved
            const flat = savedSel.syrupSelections;
            savedSel.syrupSelections = flat.length > 0 ? { _general: flat } : {};
          }

          // Merge proposal syrups into syrupSelections if not already saved
          const savedMap = savedSel.syrupSelections || {};
          const hasSavedSyrups = Object.keys(savedMap).length > 0;
          if (!hasSavedSyrups && pSyrups.length > 0) {
            savedSel.syrupSelections = { _general: [...pSyrups] };
          }

          // Phase 2 seeding: if entering refinement and exploration data exists, seed refinement fields
          if (derivedPhase === 'refinement' && savedSel.exploration?.favoriteDrinks?.length > 0 && !data.serving_type) {
            const expl = savedSel.exploration;
            if (expl.favoriteDrinks.length > 0 && (!savedSel.signatureDrinks || savedSel.signatureDrinks.length === 0)) {
              savedSel.signatureDrinks = [...expl.favoriteDrinks];
            }
          }

          // Detect new format (has activeModules in selections)
          if (savedSel.activeModules) {
            setQuickPickChoice(data.serving_type);
            setActiveModules(savedSel.activeModules);
            setModuleQueue(buildStepQueue(savedSel.activeModules));
            const { activeModules: _am, ...rest } = savedSel;
            setSelections(prev => ({ ...prev, ...rest }));
          } else if (data.serving_type) {
            // Legacy format
            const pick = QUICK_PICKS.find(p => p.key === data.serving_type);
            if (pick && pick.activeModules) {
              setQuickPickChoice(data.serving_type);
              setActiveModules(pick.activeModules);
              setModuleQueue(buildStepQueue(pick.activeModules));
            }
            setSelections(prev => ({ ...prev, ...savedSel }));
          } else {
            // No serving type yet — just restore selections (exploration data)
            setSelections(prev => ({ ...prev, ...savedSel }));
          }

          if (data.status === 'submitted') {
            setStep('submitted');
          } else if (derivedPhase === 'exploration' && data.status === 'exploration_saved') {
            // Re-entering exploration — show exploration save screen or let them re-explore
            setStep('welcome');
          } else if (derivedPhase === 'refinement') {
            // If already has a serving type and modules, stay at current state
            // Otherwise start at refinement welcome
            if (!data.serving_type) {
              setStep('refinementWelcome');
            }
          }
        }
      } catch (err) {
        setError(err.response?.data?.error || 'Could not load your drink plan.');
      } finally {
        setLoading(false);
      }
    }
    fetchPlan();
  }, [token]);

  // Browser back button support — navigate steps instead of leaving
  useEffect(() => {
    // Push initial state so the first back press doesn't leave
    window.history.replaceState({ step: 'welcome' }, '', '');

    const handlePopState = (e) => {
      if (e.state?.step) {
        setStep(e.state.step);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        // No state — user is trying to leave. Push them back and go to previous step.
        window.history.pushState({ step }, '', '');
        // Trigger in-app back navigation
        handleBackRef.current?.();
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []); // eslint-disable-line

  // Refs for periodic auto-save (so interval callback sees latest state)
  const selectionsRef = useRef(selections);
  const activeModulesRef = useRef(activeModules);
  const quickPickRef = useRef(quickPickChoice);
  const stepRef = useRef(step);
  selectionsRef.current = selections;
  activeModulesRef.current = activeModules;
  quickPickRef.current = quickPickChoice;
  stepRef.current = step;

  // Auto-save draft
  const saveDraft = useCallback(async (currentQuickPick, currentActiveModules, currentSelections) => {
    if (!token || submittingRef.current) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await axios.put(`${BASE_URL}/drink-plans/t/${token}`, {
        serving_type: currentQuickPick,
        selections: { ...currentSelections, activeModules: currentActiveModules },
        status: 'draft',
      });
    } catch (err) {
      console.error('Auto-save failed:', err);
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }, [token]);

  // Periodic auto-save every 30 seconds (crash recovery)
  useEffect(() => {
    if (!plan || step === 'submitted' || step === 'explorationSaved' || step === 'welcome') return;
    const interval = setInterval(() => {
      const s = stepRef.current;
      if (s === 'submitted' || s === 'explorationSaved' || s === 'welcome') return;
      saveDraft(quickPickRef.current, activeModulesRef.current, selectionsRef.current);
    }, 30000);
    return () => clearInterval(interval);
  }, [plan, step, saveDraft]);

  // Save on page unload (beforeunload)
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!token || stepRef.current === 'submitted' || stepRef.current === 'explorationSaved') return;
      const payload = JSON.stringify({
        serving_type: quickPickRef.current,
        selections: { ...selectionsRef.current, activeModules: activeModulesRef.current },
        status: 'draft',
      });
      try {
        fetch(`${BASE_URL}/drink-plans/t/${token}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        });
      } catch (e) { /* best-effort */ }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [token]);

  // Save exploration
  const handleExplorationSave = async () => {
    setSaving(true);
    try {
      await axios.put(`${BASE_URL}/drink-plans/t/${token}`, {
        selections: { ...selections, activeModules },
        status: 'exploration_saved',
      });
      setStep('explorationSaved');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // Submit drink plan to server (without changing step — used by payment flow)
  const submitDrinkPlan = async () => {
    submittingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await axios.put(`${BASE_URL}/drink-plans/t/${token}`, {
        serving_type: quickPickChoice,
        selections: { ...selections, activeModules },
        status: 'submitted',
      });
    } catch (err) {
      const serverMsg = err.response?.data?.error;
      const statusCode = err.response?.status;
      console.error('Submit failed:', statusCode, serverMsg, err);
      const msg = statusCode === 400
        ? (serverMsg || 'This plan may have already been submitted.')
        : (serverMsg || 'Failed to submit. Please try again.');
      throw new Error(msg);
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  // Submit final (refinement) — submit + show celebration
  const handleSubmit = async () => {
    try {
      await submitDrinkPlan();
      setStep('submitted');
    } catch (err) {
      setError(err.message);
    }
  };

  // Update a selection field
  const updateSelections = (field, value) => {
    setSelections(prev => ({ ...prev, [field]: value }));
  };

  // Update exploration sub-field
  const updateExploration = (field, value) => {
    setSelections(prev => ({
      ...prev,
      exploration: { ...prev.exploration, [field]: value },
    }));
  };

  // Toggle an addon on/off in selections.addOns
  const toggleAddOn = (slug, metadata = {}) => {
    setSelections(prev => {
      const newAddOns = { ...prev.addOns };
      if (newAddOns[slug]) {
        delete newAddOns[slug];
      } else {
        newAddOns[slug] = { enabled: true, ...metadata };
      }
      return { ...prev, addOns: newAddOns };
    });
  };

  // Update metadata on an existing addon
  const updateAddOnMeta = (slug, metadata) => {
    setSelections(prev => ({
      ...prev,
      addOns: {
        ...prev.addOns,
        [slug]: { ...prev.addOns[slug], ...metadata },
      },
    }));
  };

  // Toggle a syrup for a specific drink in per-drink syrupSelections map.
  // Special drinkId '_all' removes the syrup from every drink (used by summary views).
  const toggleSyrup = (drinkId, syrupId) => {
    setSelections(prev => {
      const map = (prev.syrupSelections && !Array.isArray(prev.syrupSelections))
        ? { ...prev.syrupSelections }
        : {}; // migrate from legacy flat array on first toggle

      if (drinkId === '_all') {
        // Remove syrup from every drink entry
        const updated = {};
        for (const [key, ids] of Object.entries(map)) {
          const filtered = ids.filter(s => s !== syrupId);
          if (filtered.length > 0) updated[key] = filtered;
        }
        return { ...prev, syrupSelections: updated };
      }

      const current = map[drinkId] || [];
      if (current.includes(syrupId)) {
        map[drinkId] = current.filter(s => s !== syrupId);
        if (map[drinkId].length === 0) delete map[drinkId];
      } else {
        map[drinkId] = [...current, syrupId];
      }
      return { ...prev, syrupSelections: map };
    });
  };

  // Update syrupSelfProvided array
  const updateSyrupSelfProvided = (newSelfProvided) => {
    setSelections(prev => ({ ...prev, syrupSelfProvided: newSelfProvided }));
  };

  // Navigation — push history so browser back button navigates steps
  const goToStep = (newStep) => {
    setStep(newStep);
    window.history.pushState({ step: newStep }, '', '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Quick pick selection (refinement only)
  const handleQuickPickSelect = (key) => {
    if (key === 'custom') {
      setQuickPickChoice('custom');
      goToStep('customSetup');
      return;
    }
    const pick = QUICK_PICKS.find(p => p.key === key);
    setQuickPickChoice(key);
    setActiveModules(pick.activeModules);
    const queue = buildStepQueue(pick.activeModules);
    setModuleQueue(queue);
    saveDraft(key, pick.activeModules, selections);
    goToStep(queue[0]);
  };

  // Custom setup confirm (refinement only)
  const handleCustomSetupConfirm = (computedModules) => {
    setActiveModules(computedModules);
    const queue = buildStepQueue(computedModules);
    setModuleQueue(queue);
    saveDraft('custom', computedModules, selections);
    goToStep(queue[0]);
  };

  // Generic next
  const handleNext = () => {
    saveDraft(quickPickChoice, activeModules, selections);

    // Exploration navigation
    if (phase === 'exploration') {
      if (step === 'welcome') return goToStep(explorationQueue[0] || 'stepVibe');
      const explorationIdx = explorationQueue.indexOf(step);
      if (explorationIdx !== -1) {
        const nextIdx = explorationIdx + 1;
        if (nextIdx < explorationQueue.length) {
          return goToStep(explorationQueue[nextIdx]);
        }
        return goToStep('explorationSave');
      }
      return;
    }

    // Refinement navigation
    if (step === 'welcome' || step === 'refinementWelcome') return goToStep('quickPick');

    const currentIdx = moduleQueue.indexOf(step);
    if (currentIdx !== -1) {
      const nextIdx = currentIdx + 1;
      if (nextIdx < moduleQueue.length) {
        return goToStep(moduleQueue[nextIdx]);
      }
      return goToStep('confirmation');
    }
  };

  // Skip to step after a given step in the queue
  const handleSkipToAfter = (stepToSkip) => {
    saveDraft(quickPickChoice, activeModules, selections);
    const idx = moduleQueue.indexOf(stepToSkip);
    if (idx !== -1 && idx + 1 < moduleQueue.length) {
      return goToStep(moduleQueue[idx + 1]);
    }
    return goToStep('confirmation');
  };

  // Back navigation
  const handleBack = () => {
    // Exploration back
    if (phase === 'exploration') {
      if (step === explorationQueue[0]) return goToStep('welcome');
      const explorationIdx = explorationQueue.indexOf(step);
      if (explorationIdx > 0) {
        return goToStep(explorationQueue[explorationIdx - 1]);
      }
      if (step === 'explorationSave') {
        return goToStep(explorationQueue[explorationQueue.length - 1]);
      }
      return;
    }

    // Refinement back
    if (step === 'quickPick') return goToStep(plan?.exploration_submitted_at ? 'refinementWelcome' : 'welcome');
    if (step === 'refinementWelcome') return; // no back from refinement welcome
    if (step === 'customSetup') return goToStep('quickPick');

    const currentIdx = moduleQueue.indexOf(step);
    if (currentIdx !== -1) {
      if (currentIdx > 0) {
        return goToStep(moduleQueue[currentIdx - 1]);
      }
      return goToStep(quickPickChoice === 'custom' ? 'customSetup' : 'quickPick');
    }

    if (step === 'confirmation') {
      return goToStep(moduleQueue[moduleQueue.length - 1]);
    }
  };

  // Keep ref updated for popstate handler
  handleBackRef.current = handleBack;

  // Compute step progress (refinement only)
  const totalSteps = moduleQueue.length + 1;
  const currentQueueIdx = moduleQueue.indexOf(step);
  const progressStep = phase === 'refinement' && currentQueueIdx !== -1
    ? currentQueueIdx + 1
    : (phase === 'refinement' && step === 'confirmation' ? totalSteps : null);

  // Loading / error states
  if (loading) {
    return (
      <div className="auth-page">
        <div className="page-container" style={{ textAlign: 'center', paddingTop: '4rem' }}>
          <div role="status" aria-live="polite">
            <div className="spinner" />
            <p className="text-muted mt-2">Loading your drink plan...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error && !plan) {
    return (
      <div className="auth-page">
        <div className="page-container" style={{ textAlign: 'center', paddingTop: '4rem' }}>
          <div className="card">
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>&#9879;&#65039;</div>
            <h2 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.75rem' }}>Something Went Wrong</h2>
            <p className="text-muted" style={{ marginBottom: '1rem' }}>{error}</p>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
              This link may have expired. Please contact Dr. Bartender for a new link.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Submitted celebration screen
  if (step === 'submitted') {
    return (
      <div className="auth-page">
        <div className="page-container" style={{ textAlign: 'center', paddingTop: '3rem' }}>
          <div className="card">
            <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }}>&#127881;</div>
            <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>Plan Submitted!</h2>
            <img
              src="/images/potion-bartender.png"
              alt="Dr. Bartender"
              style={{ maxWidth: '120px', margin: '1rem auto', display: 'block', opacity: 0.9 }}
            />
            <p className="text-muted" style={{ marginTop: '0.75rem' }}>
              Thank you, {plan?.client_name || 'friend'}! Your drink selections have been received.
            </p>
            {paidFromRedirect && (
              <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'rgba(46, 125, 50, 0.08)', borderRadius: '8px', border: '1px solid rgba(46, 125, 50, 0.2)' }}>
                <p style={{ fontWeight: 600, color: '#2e7d32', marginBottom: '0.25rem' }}>
                  Payment Received
                </p>
                <p className="text-muted text-small">
                  Your payment has been processed successfully. You'll receive a confirmation email shortly.
                </p>
              </div>
            )}
            <div style={{ marginTop: '1.25rem', padding: '0.75rem', background: 'rgba(193, 125, 60, 0.08)', borderRadius: '8px' }}>
              <p style={{ fontWeight: 600, color: 'var(--deep-brown)', marginBottom: '0.25rem' }}>
                What happens next?
              </p>
              <p className="text-muted text-small">
                {selections.customMenuDesign === true
                  ? "We'll use your selections to create a shopping list, custom menu, and BEO (Banquet Event Order) for your event. Expect to hear from us within 2 business days!"
                  : "We'll use your selections to create a shopping list and BEO (Banquet Event Order) for your event. Expect to hear from us within 2 business days!"}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Exploration saved screen
  if (step === 'explorationSaved') {
    return (
      <div className="auth-page">
        <div className="page-container" style={{ textAlign: 'center', paddingTop: '3rem' }}>
          <div className="card">
            <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }}>&#10024;</div>
            <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>Exploration Saved!</h2>
            <p className="text-muted" style={{ marginTop: '0.75rem' }}>
              We've saved your preferences, {plan?.client_name || 'friend'}. When you're ready
              to book, all your favorites will be waiting for you.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Steps that manage their own nav buttons (hide global nav)
  const selfNavigatingSteps = [MODULE_STEP_MAP.signatureDrinks, MODULE_STEP_MAP.mocktails];
  const hideGlobalNav = selfNavigatingSteps.includes(step);

  const showBack = !['welcome', 'quickPick', 'refinementWelcome'].includes(step) && !hideGlobalNav;
  const showNext = !['quickPick', 'customSetup', 'confirmation', 'submitted', 'explorationSave', 'explorationSaved'].includes(step) && !hideGlobalNav;

  // Button label
  const nextLabel = phase === 'exploration' ? 'Keep Going' : 'Next';

  // Render current step
  const renderStep = () => {
    switch (step) {
      case 'welcome':
        return <WelcomeStep plan={plan} phase={phase} />;
      case 'refinementWelcome':
        return (
          <RefinementWelcomeStep
            plan={plan}
            exploration={selections.exploration}
            guestCount={guestCount}
          />
        );

      // Exploration steps
      case 'stepVibe':
        return (
          <VibeStep
            value={selections.exploration.vibe}
            onChange={(val) => updateExploration('vibe', val)}
          />
        );
      case 'stepFlavorDirection':
        return (
          <FlavorDirectionStep
            selected={selections.exploration.flavorDirections}
            onChange={(val) => updateExploration('flavorDirections', val)}
            dreamNotes={selections.exploration.dreamDrinkNotes}
            onDreamNotesChange={(val) => updateExploration('dreamDrinkNotes', val)}
          />
        );
      case 'stepExplorationBrowse':
        return (
          <ExplorationBrowseStep
            cocktails={cocktails}
            categories={cocktailCategories}
            favoriteDrinks={selections.exploration.favoriteDrinks}
            onChange={(val) => updateExploration('favoriteDrinks', val)}
            addOns={selections.addOns || {}}
            toggleAddOn={toggleAddOn}
            addonPricing={addonPricing}
            syrupSelections={selections.syrupSelections || {}}
            onSyrupToggle={toggleSyrup}
          />
        );
      case 'stepMocktailInterest':
        return (
          <MocktailInterestStep
            value={selections.exploration.mocktailInterest}
            onChange={(val) => updateExploration('mocktailInterest', val)}
          />
        );
      case 'explorationSave':
        return (
          <ExplorationSaveStep
            exploration={selections.exploration}
            cocktails={cocktails}
            onSave={handleExplorationSave}
            saving={saving}
          />
        );

      // Refinement steps
      case 'quickPick':
        return (
          <QuickPickStep
            selected={quickPickChoice}
            onSelect={handleQuickPickSelect}
            exploration={selections.exploration}
          />
        );
      case 'customSetup':
        return <CustomSetupStep onConfirm={handleCustomSetupConfirm} />;
      case MODULE_STEP_MAP.signatureDrinks:
        return (
          <SignaturePickerStep
            selected={selections.signatureDrinks}
            onChange={(drinks) => updateSelections('signatureDrinks', drinks)}
            cocktails={cocktails}
            categories={cocktailCategories}
            isFullBarActive={activeModules.fullBar}
            isMocktailsActive={activeModules.mocktails}
            mixersForSignatureDrinks={selections.mixersForSignatureDrinks}
            onMixersChange={(val) => updateSelections('mixersForSignatureDrinks', val)}
            onSpiritsExtracted={(spirits) => updateSelections('signatureDrinkSpirits', spirits)}
            customCocktails={selections.customCocktails || []}
            onCustomCocktailsChange={(val) => updateSelections('customCocktails', val)}
            addOns={selections.addOns || {}}
            toggleAddOn={toggleAddOn}
            updateAddOnMeta={updateAddOnMeta}
            addonPricing={addonPricing}
            guestCount={guestCount}
            syrupSelections={selections.syrupSelections || {}}
            onSyrupToggle={toggleSyrup}
            syrupSelfProvided={selections.syrupSelfProvided || []}
            onSelfProvidedChange={updateSyrupSelfProvided}
            proposalSyrups={proposalSyrups}
            phase={phase}
            onNext={() => handleNext()}
            onBack={() => handleBack()}
            onSkipMocktails={() => handleSkipToAfter(MODULE_STEP_MAP.mocktails)}
          />
        );
      case MODULE_STEP_MAP.mocktails:
        return (
          <MocktailStep
            selected={selections.mocktails || []}
            onChange={(val) => updateSelections('mocktails', val)}
            mocktails={mocktailItems}
            categories={mocktailCategories}
            notes={selections.mocktailNotes}
            onNotesChange={(val) => updateSelections('mocktailNotes', val)}
            addOns={selections.addOns || {}}
            toggleAddOn={toggleAddOn}
            addonPricing={addonPricing}
            syrupSelections={selections.syrupSelections || {}}
            onSyrupToggle={toggleSyrup}
            proposalSyrups={proposalSyrups}
            phase={phase}
            skipGate={quickPickChoice === 'mocktails'}
            onNext={() => handleNext()}
            onBack={() => handleBack()}
          />
        );
      case MODULE_STEP_MAP.fullBarSpirits:
        return (
          <FullBarSpiritsStep
            selections={selections}
            onChange={updateSelections}
          />
        );
      case MODULE_STEP_MAP.fullBarBeerWine:
        return (
          <FullBarBeerWineStep
            selections={selections}
            onChange={updateSelections}
          />
        );
      case MODULE_STEP_MAP.beerWineOnly:
        return (
          <BeerWineStep
            selections={selections}
            onChange={updateSelections}
          />
        );
      case MODULE_STEP_MAP.menuDesign:
        return (
          <MenuDesignStep
            selections={selections}
            activeModules={activeModules}
            cocktails={cocktails}
            mocktails={mocktailItems}
            onChange={updateSelections}
          />
        );
      case MODULE_STEP_MAP.logistics:
        return (
          <LogisticsStep
            logistics={selections.logistics}
            onChange={(val) => updateSelections('logistics', val)}
            addOns={selections.addOns || {}}
            toggleAddOn={toggleAddOn}
            updateAddOnMeta={updateAddOnMeta}
            addonPricing={addonPricing}
            guestCount={guestCount}
            numBartenders={numBartenders}
            numBars={numBars}
            pricingSnapshot={pricingSnapshot}
          />
        );
      case 'confirmation':
        return (
          <ConfirmationStep
            plan={plan}
            quickPickChoice={quickPickChoice}
            activeModules={activeModules}
            selections={selections}
            cocktails={cocktails}
            mocktails={mocktailItems}
            addOns={selections.addOns || {}}
            addonPricing={addonPricing}
            guestCount={guestCount}
            numBars={numBars}
            pricingSnapshot={pricingSnapshot}
            proposalSyrups={proposalSyrups}
            onSubmit={handleSubmit}
            onSubmitForPayment={submitDrinkPlan}
            proposalPaymentInfo={proposalPaymentInfo}
            token={token}
            saving={saving}
            error={error}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="auth-page">
      <div className="page-container">
        {progressStep && (
          <div style={{ textAlign: 'center', marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--parchment)' }}>
            Step {progressStep} of {totalSteps}
          </div>
        )}

        {saving && (
          <div role="status" aria-live="polite" style={{ textAlign: 'center', padding: '0.25rem', opacity: 0.6, fontSize: '0.85rem' }}>
            Saving...
          </div>
        )}
        {saveFailed && !saving && (
          <div role="alert" style={{ textAlign: 'center', padding: '0.25rem', fontSize: '0.85rem', color: '#c0392b' }}>
            Draft may not be saved. Check your connection.
          </div>
        )}

        <div className="potion-step" key={step}>
          {renderStep()}
        </div>

        {(showBack || showNext) && (
          <div className="step-nav">
            {showBack ? (
              <button className="btn btn-secondary" onClick={handleBack}>Back</button>
            ) : <div />}
            {showNext ? (
              <button className="btn btn-primary" onClick={handleNext}>{nextLabel}</button>
            ) : <div />}
          </div>
        )}
      </div>
    </div>
  );
}

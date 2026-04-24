import React, { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL as BASE_URL } from '../../utils/api';
import FormBanner from '../../components/FormBanner';
import { useToast } from '../../context/ToastContext';
import { QUICK_PICKS, MODULE_STEP_MAP, buildStepQueue, buildExplorationQueue, derivePhase, buildHostedStepQueue, hostedActiveModules, HOSTED_GUEST_PREFS_STEP } from './data/servingTypes';
import { DRINK_UPGRADES, PER_DRINK_UPGRADE_SLUGS } from './data/drinkUpgrades';
// WelcomeStep renders first — keep eager to avoid a Suspense flash on initial load.
import WelcomeStep from './steps/WelcomeStep';
// All other step components are lazy-loaded: cuts ~18 chunks out of the initial bundle
// for a public-facing page where most visitors only traverse a subset of the steps.
const QuickPickStep = lazy(() => import('./steps/QuickPickStep'));
const CustomSetupStep = lazy(() => import('./steps/CustomSetupStep'));
const SignaturePickerStep = lazy(() => import('./steps/SignaturePickerStep'));
const BeerWineStep = lazy(() => import('./steps/BeerWineStep'));
const FullBarSpiritsStep = lazy(() => import('./steps/FullBarSpiritsStep'));
const FullBarBeerWineStep = lazy(() => import('./steps/FullBarBeerWineStep'));
const MocktailStep = lazy(() => import('./steps/MocktailStep'));
const MenuDesignStep = lazy(() => import('./steps/MenuDesignStep'));
const LogisticsStep = lazy(() => import('./steps/LogisticsStep'));
const ConfirmationStep = lazy(() => import('./steps/ConfirmationStep'));
// Exploration phase steps
const VibeStep = lazy(() => import('./steps/VibeStep'));
const FlavorDirectionStep = lazy(() => import('./steps/FlavorDirectionStep'));
const ExplorationBrowseStep = lazy(() => import('./steps/ExplorationBrowseStep'));
const MocktailInterestStep = lazy(() => import('./steps/MocktailInterestStep'));
const ExplorationSaveStep = lazy(() => import('./steps/ExplorationSaveStep'));
const RefinementWelcomeStep = lazy(() => import('./steps/RefinementWelcomeStep'));
const HostedGuestPrefsStep = lazy(() => import('./steps/HostedGuestPrefsStep'));

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
  const toast = useToast();

  // Plan metadata
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
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

  // Check if returning from Stripe payment redirect. useMemo so we don't reparse
  // window.location.search on every render of this large component.
  const paidFromRedirect = useMemo(
    () => new URLSearchParams(window.location.search).get('paid') === 'true',
    []
  );

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

          // Migrate legacy per-drink upgrade addOns: addOns[slug].enabled=true with no drinks[]
          // means the addon was toggled on globally. Infer the drinks array from selected
          // applicable drinks so the per-drink display works without erasing the user's intent.
          if (savedSel.addOns) {
            const sigDrinks = savedSel.signatureDrinks || [];
            const favDrinks = savedSel.exploration?.favoriteDrinks || [];
            const allDrinks = [...new Set([...sigDrinks, ...favDrinks])];
            for (const slug of PER_DRINK_UPGRADE_SLUGS) {
              const addon = savedSel.addOns[slug];
              if (addon?.enabled && !Array.isArray(addon.drinks)) {
                const upgrade = DRINK_UPGRADES.find(u => u.addonSlug === slug);
                if (!upgrade) continue;
                let inferred = allDrinks.filter(d => upgrade.applicableDrinks.includes(d));
                if (upgrade.maxDrinks && inferred.length > upgrade.maxDrinks) {
                  inferred = inferred.slice(0, upgrade.maxDrinks);
                }
                if (inferred.length === 0) {
                  delete savedSel.addOns[slug];
                } else {
                  savedSel.addOns[slug] = { ...addon, drinks: inferred };
                }
              }
            }
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
              if (planData.package_category === 'hosted') {
                // Hosted package — skip QuickPick, derive queue directly from bar_type
                const barType = planData.package_bar_type || 'full_bar';
                setQuickPickChoice(barType);
                setActiveModules(hostedActiveModules(barType));
                setModuleQueue(buildHostedStepQueue(barType));
              }
              setStep('refinementWelcome');
            }
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-restricted-syntax
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

  // Auto-save draft. Pass silent=true to skip the visible "Saving…" indicator —
  // the 30s background interval uses this so it doesn't toggle layout every cycle.
  const saveDraft = useCallback(async (currentQuickPick, currentActiveModules, currentSelections, silent = false) => {
    if (!token || submittingRef.current) return;
    if (!silent) setSaving(true);
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
      if (!silent) setSaving(false);
    }
  }, [token]);

  // Periodic auto-save every 30 seconds (crash recovery, silent — no UI flash)
  useEffect(() => {
    if (!plan || step === 'submitted' || step === 'explorationSaved' || step === 'welcome') return;
    const interval = setInterval(() => {
      const s = stepRef.current;
      if (s === 'submitted' || s === 'explorationSaved' || s === 'welcome') return;
      saveDraft(quickPickRef.current, activeModulesRef.current, selectionsRef.current, true);
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
    setError(null);
    setFieldErrors({});
    try {
      await axios.put(`${BASE_URL}/drink-plans/t/${token}`, {
        selections: { ...selections, activeModules },
        status: 'exploration_saved',
      });
      toast.success('Your exploration was saved!');
      setStep('explorationSaved');
    } catch (err) {
      // eslint-disable-next-line no-restricted-syntax
      const data = err.response?.data;
      setError(data?.error || 'Failed to save. Please try again.');
      setFieldErrors(data?.fieldErrors || {});
    } finally {
      setSaving(false);
    }
  };

  // Submit drink plan to server (without changing step — used by payment flow)
  // paidSeparately=true when extras will be charged via Stripe on the same turn:
  // tells the server to skip refreshing the Balance invoice with the new extras
  // (they will land on a separate "Drink Plan Extras" invoice via the webhook).
  const submitDrinkPlan = async (paidSeparately = false) => {
    submittingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await axios.put(`${BASE_URL}/drink-plans/t/${token}`, {
        serving_type: quickPickChoice,
        selections: { ...selections, activeModules },
        status: 'submitted',
        paid_separately: paidSeparately,
      });
    } catch (err) {
      // eslint-disable-next-line no-restricted-syntax
      const serverMsg = err.response?.data?.error;
      // eslint-disable-next-line no-restricted-syntax
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
    setError(null);
    setFieldErrors({});
    try {
      await submitDrinkPlan();
      toast.success('Plan submitted! Check your email.');
      setStep('submitted');
    } catch (err) {
      setError(err.message);
      setFieldErrors(err.fieldErrors || {});
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

  // Toggle a per-drink upgrade on/off for a specific drink.
  // Returns true if the toggle succeeded; false if blocked by a maxDrinks limit
  // (caller is responsible for surfacing the toast — this lives outside React state).
  const toggleAddOnForDrink = (slug, drinkId) => {
    const upgrade = DRINK_UPGRADES.find(u => u.addonSlug === slug);
    const maxDrinks = upgrade?.maxDrinks;
    let blocked = false;
    setSelections(prev => {
      const newAddOns = { ...prev.addOns };
      const existing = newAddOns[slug];
      const currentDrinks = Array.isArray(existing?.drinks) ? existing.drinks : [];
      const has = currentDrinks.includes(drinkId);
      if (has) {
        const next = currentDrinks.filter(d => d !== drinkId);
        if (next.length === 0) {
          delete newAddOns[slug];
        } else {
          const updated = { ...existing, enabled: true, drinks: next };
          if (updated.bubbles) {
            const nextBubbles = { ...updated.bubbles };
            delete nextBubbles[drinkId];
            updated.bubbles = nextBubbles;
          }
          newAddOns[slug] = updated;
        }
      } else {
        if (maxDrinks && currentDrinks.length >= maxDrinks) {
          blocked = true;
          return prev;
        }
        newAddOns[slug] = {
          ...(existing || {}),
          enabled: true,
          drinks: [...currentDrinks, drinkId],
        };
      }
      return { ...prev, addOns: newAddOns };
    });
    return !blocked;
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

  // Remove the given drink IDs from every per-drink addon's drinks[] array.
  // If an addon's drinks list becomes empty, the addon is disabled (deleted).
  // Used when the user deselects a signature/favorite drink so we don't keep
  // billing for an upgrade that has no drinks left to apply it to.
  const pruneAddOnsForRemovedDrinks = (addOns, removedIds) => {
    if (!removedIds.length) return addOns;
    const next = { ...addOns };
    for (const slug of Object.keys(next)) {
      const addon = next[slug];
      if (!addon) continue;

      // Legacy per-drink addons (carbonation, smoke, smoke-bubble) — prune drinks[]
      if (Array.isArray(addon.drinks)) {
        const filtered = addon.drinks.filter(d => !removedIds.includes(d));
        if (filtered.length === 0) {
          delete next[slug];
          continue;
        }
        if (filtered.length !== addon.drinks.length) {
          const updated = { ...addon, drinks: filtered };
          if (updated.bubbles) {
            const nextBubbles = { ...updated.bubbles };
            for (const id of removedIds) delete nextBubbles[id];
            updated.bubbles = nextBubbles;
          }
          next[slug] = updated;
        }
      }

      // Auto-added specialty addons — prune triggeredBy[]
      if (Array.isArray(addon.triggeredBy)) {
        const filtered = addon.triggeredBy.filter(d => !removedIds.includes(d));
        if (filtered.length === 0 && addon.autoAdded) {
          delete next[slug];
          continue;
        }
        if (filtered.length !== addon.triggeredBy.length) {
          next[slug] = { ...addon, triggeredBy: filtered };
        }
      }
    }
    return next;
  };

  const updateSignatureDrinks = (drinks) => {
    setSelections(prev => {
      const removed = (prev.signatureDrinks || []).filter(d => !drinks.includes(d));
      return {
        ...prev,
        signatureDrinks: drinks,
        addOns: pruneAddOnsForRemovedDrinks(prev.addOns || {}, removed),
      };
    });
  };

  const updateFavoriteDrinks = (drinks) => {
    setSelections(prev => {
      const removed = (prev.exploration?.favoriteDrinks || []).filter(d => !drinks.includes(d));
      return {
        ...prev,
        exploration: { ...prev.exploration, favoriteDrinks: drinks },
        addOns: pruneAddOnsForRemovedDrinks(prev.addOns || {}, removed),
      };
    });
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
    if (step === 'welcome' || step === 'refinementWelcome') {
      // Hosted packages skip the QuickPick — queue was pre-built from bar_type.
      if (plan?.package_category === 'hosted') return goToStep(moduleQueue[0]);
      if (plan?.package_bar_type === 'mocktail') return goToStep(moduleQueue[0]);
      return goToStep('quickPick');
    }

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
      // Hosted packages never show QuickPick; back from first step goes to welcome.
      if (plan?.package_category === 'hosted') {
        return goToStep(plan?.exploration_submitted_at ? 'refinementWelcome' : 'welcome');
      }
      if (plan?.package_bar_type === 'mocktail') {
        return goToStep(plan?.exploration_submitted_at ? 'refinementWelcome' : 'welcome');
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
            onChange={updateFavoriteDrinks}
            addOns={selections.addOns || {}}
            toggleAddOn={toggleAddOn}
            toggleAddOnForDrink={toggleAddOnForDrink}
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
            onChange={updateSignatureDrinks}
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
            toggleAddOnForDrink={toggleAddOnForDrink}
            updateAddOnMeta={updateAddOnMeta}
            addonPricing={addonPricing}
            guestCount={guestCount}
            syrupSelections={selections.syrupSelections || {}}
            onSyrupToggle={toggleSyrup}
            syrupSelfProvided={selections.syrupSelfProvided || []}
            onSelfProvidedChange={updateSyrupSelfProvided}
            proposalSyrups={proposalSyrups}
            phase={phase}
            plan={plan}
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
            plan={plan}
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
      case HOSTED_GUEST_PREFS_STEP:
        return (
          <HostedGuestPrefsStep
            plan={plan}
            selections={selections}
            onChange={updateSelections}
            addOns={selections.addOns || {}}
            toggleAddOn={toggleAddOn}
            addonPricing={addonPricing}
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
            plan={plan}
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
            onSubmitForPayment={() => submitDrinkPlan(true)}
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

        {/* Reserve vertical space so the indicator (when it appears for
            manual saves or intermittent save failures) doesn't shift layout. */}
        <div style={{ minHeight: '1.5rem', textAlign: 'center', padding: '0.25rem', fontSize: '0.85rem' }}>
          {saving && (
            <span role="status" aria-live="polite" style={{ opacity: 0.6 }}>Saving…</span>
          )}
          {saveFailed && !saving && (
            <span role="alert" style={{ color: '#c0392b' }}>Draft may not be saved. Check your connection.</span>
          )}
        </div>

        <div className="potion-step" key={step}>
          <Suspense fallback={<div style={{ padding: '3rem', textAlign: 'center', color: '#6b5a4e' }}>Loading…</div>}>
            {renderStep()}
          </Suspense>
        </div>

        {/* Surface submit/save errors near the navigation buttons */}
        {plan && step !== 'submitted' && step !== 'explorationSaved' && (
          <FormBanner error={error} fieldErrors={fieldErrors} />
        )}

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

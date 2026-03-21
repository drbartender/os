import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL as BASE_URL } from '../../utils/api';
import { QUICK_PICKS, MODULE_STEP_MAP, buildStepQueue } from './data/servingTypes';
import WelcomeStep from './steps/WelcomeStep';
import QuickPickStep from './steps/QuickPickStep';
import CustomSetupStep from './steps/CustomSetupStep';
import SignaturePickerStep from './steps/SignaturePickerStep';
import BeerWineStep from './steps/BeerWineStep';
import FullBarStep from './steps/FullBarStep';
import MocktailStep from './steps/MocktailStep';
import MenuDesignStep from './steps/MenuDesignStep';
import LogisticsStep from './steps/LogisticsStep';
import ConfirmationStep from './steps/ConfirmationStep';

const DEFAULT_ACTIVE_MODULES = { signatureDrinks: false, mocktails: false, fullBar: false, beerWineOnly: false };

const DEFAULT_SELECTIONS = {
  signatureDrinks: [],
  signatureDrinkSpirits: [],
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
  },
};

export default function PotionPlanningLab() {
  const { token } = useParams();

  // Plan metadata
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  // Cocktail menu
  const [cocktails, setCocktails] = useState([]);
  const [cocktailCategories, setCocktailCategories] = useState([]);

  // Mocktail menu
  const [mocktailItems, setMocktailItems] = useState([]);
  const [mocktailCategories, setMocktailCategories] = useState([]);

  // Flow state
  const [step, setStep] = useState('welcome');
  const [quickPickChoice, setQuickPickChoice] = useState(null);
  const [activeModules, setActiveModules] = useState(DEFAULT_ACTIVE_MODULES);
  const [moduleQueue, setModuleQueue] = useState([]);

  // Form selections
  const [selections, setSelections] = useState(DEFAULT_SELECTIONS);

  // Load plan + cocktails + mocktails
  useEffect(() => {
    async function fetchPlan() {
      try {
        const [planRes, cocktailsRes, mocktailsRes] = await Promise.all([
          axios.get(`${BASE_URL}/drink-plans/t/${token}`),
          axios.get(`${BASE_URL}/cocktails`),
          axios.get(`${BASE_URL}/mocktails`).catch(() => ({ data: { categories: [], mocktails: [] } })),
        ]);
        setCocktails(cocktailsRes.data.cocktails || []);
        setCocktailCategories(cocktailsRes.data.categories || []);
        setMocktailItems(mocktailsRes.data.mocktails || []);
        setMocktailCategories(mocktailsRes.data.categories || []);
        setPlan(planRes.data);

        // Restore saved state if draft/submitted
        const data = planRes.data;
        if (data.status === 'draft' || data.status === 'submitted') {
          const savedSel = data.selections || {};

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
          }

          if (data.status === 'submitted') {
            setStep('submitted');
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

  // Auto-save draft
  const saveDraft = useCallback(async (currentQuickPick, currentActiveModules, currentSelections) => {
    if (!token) return;
    setSaving(true);
    try {
      await axios.put(`${BASE_URL}/drink-plans/t/${token}`, {
        serving_type: currentQuickPick,
        selections: { ...currentSelections, activeModules: currentActiveModules },
        status: 'draft',
      });
    } catch (err) {
      console.error('Auto-save failed:', err);
    } finally {
      setSaving(false);
    }
  }, [token]);

  // Submit final
  const handleSubmit = async () => {
    setSaving(true);
    try {
      await axios.put(`${BASE_URL}/drink-plans/t/${token}`, {
        serving_type: quickPickChoice,
        selections: { ...selections, activeModules },
        status: 'submitted',
      });
      setStep('submitted');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to submit. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // Update a selection field
  const updateSelections = (field, value) => {
    setSelections(prev => ({ ...prev, [field]: value }));
  };

  // Navigation
  const goToStep = (newStep) => {
    setStep(newStep);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Quick pick selection
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

  // Custom setup confirm
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

    if (step === 'welcome') return goToStep('quickPick');

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
    if (step === 'quickPick') return goToStep('welcome');
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

  // Compute step progress
  const totalSteps = moduleQueue.length + 1;
  const currentQueueIdx = moduleQueue.indexOf(step);
  const progressStep = currentQueueIdx !== -1 ? currentQueueIdx + 1 : (step === 'confirmation' ? totalSteps : null);

  // Loading / error states
  if (loading) {
    return (
      <div className="auth-page">
        <div className="page-container" style={{ textAlign: 'center', paddingTop: '4rem' }}>
          <div className="spinner" />
          <p className="text-muted mt-2">Loading your drink plan...</p>
        </div>
      </div>
    );
  }

  if (error && !plan) {
    return (
      <div className="auth-page">
        <div className="page-container" style={{ textAlign: 'center', paddingTop: '4rem' }}>
          <div className="card">
            <h2>Oops!</h2>
            <p className="text-muted">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  // Already submitted
  if (step === 'submitted') {
    return (
      <div className="auth-page">
        <div className="page-container" style={{ textAlign: 'center', paddingTop: '4rem' }}>
          <div className="card">
            <h2 style={{ fontFamily: 'var(--font-display)' }}>Plan Submitted!</h2>
            <p className="text-muted mt-1">
              Thank you, {plan?.client_name || 'friend'}! Your drink selections have been received.
              We'll use these to craft the perfect bar experience for your event.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Steps that manage their own nav buttons (hide global nav)
  const selfNavigatingSteps = [MODULE_STEP_MAP.signatureDrinks, MODULE_STEP_MAP.mocktails];
  const hideGlobalNav = selfNavigatingSteps.includes(step);

  const showBack = !['welcome', 'quickPick'].includes(step) && !hideGlobalNav;
  const showNext = !['quickPick', 'customSetup', 'confirmation', 'submitted'].includes(step) && !hideGlobalNav;

  // Render current step
  const renderStep = () => {
    switch (step) {
      case 'welcome':
        return <WelcomeStep plan={plan} />;
      case 'quickPick':
        return <QuickPickStep selected={quickPickChoice} onSelect={handleQuickPickSelect} />;
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
            onNext={() => handleNext()}
            onBack={() => handleBack()}
          />
        );
      case MODULE_STEP_MAP.fullBar:
        return (
          <FullBarStep
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
            onSubmit={handleSubmit}
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
          <div style={{ textAlign: 'center', marginBottom: '0.5rem', fontSize: '0.85rem', opacity: 0.6 }}>
            Step {progressStep} of {totalSteps}
          </div>
        )}

        {saving && (
          <div style={{ textAlign: 'center', padding: '0.25rem', opacity: 0.6, fontSize: '0.85rem' }}>
            Saving...
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
              <button className="btn" onClick={handleNext}>Next</button>
            ) : <div />}
          </div>
        )}
      </div>
    </div>
  );
}

import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import { SERVING_TYPES, MODULE_STEP_MAP } from './data/servingTypes';
import WelcomeStep from './steps/WelcomeStep';
import ServingTypeStep from './steps/ServingTypeStep';
import SignaturePickerStep from './steps/SignaturePickerStep';
import BeerWineStep from './steps/BeerWineStep';
import FullBarStep from './steps/FullBarStep';
import MocktailStep from './steps/MocktailStep';
import LogisticsStep from './steps/LogisticsStep';
import ConfirmationStep from './steps/ConfirmationStep';

const BASE_URL = process.env.REACT_APP_API_URL
  ? `${process.env.REACT_APP_API_URL}/api`
  : '/api';

export default function PotionPlanningLab() {
  const { token } = useParams();

  // Plan metadata from the server
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  // Cocktail menu (fetched once, shared across steps)
  const [cocktails, setCocktails] = useState([]);
  const [cocktailCategories, setCocktailCategories] = useState([]);

  // Flow state
  const [step, setStep] = useState('welcome');
  const [servingType, setServingType] = useState(null);
  const [moduleQueue, setModuleQueue] = useState([]);

  // Form selections
  const [selections, setSelections] = useState({
    signatureCocktails: [],
    spirits: [],
    barFocus: '',
    wineStyles: [],
    beerStyles: [],
    beerWineBalance: '',
    beerWineNotes: '',
    fullBarNotes: '',
    mocktailNotes: '',
    logisticsNotes: '',
  });

  // Load plan data and cocktail menu in parallel
  useEffect(() => {
    async function fetchPlan() {
      try {
        const [planRes, cocktailsRes] = await Promise.all([
          axios.get(`${BASE_URL}/drink-plans/t/${token}`),
          axios.get(`${BASE_URL}/cocktails`),
        ]);
        const res = planRes;
        setCocktails(cocktailsRes.data.cocktails || []);
        setCocktailCategories(cocktailsRes.data.categories || []);
        setPlan(res.data);
        // Restore saved state if draft
        if (res.data.status === 'draft' || res.data.status === 'submitted') {
          if (res.data.serving_type) setServingType(res.data.serving_type);
          if (res.data.selections && Object.keys(res.data.selections).length > 0) {
            setSelections(prev => ({ ...prev, ...res.data.selections }));
          }
          if (res.data.status === 'submitted') {
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
  const saveDraft = useCallback(async (currentServingType, currentSelections) => {
    if (!token) return;
    setSaving(true);
    try {
      await axios.put(`${BASE_URL}/drink-plans/t/${token}`, {
        serving_type: currentServingType,
        selections: currentSelections,
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
        serving_type: servingType,
        selections,
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

  const handleServingTypeSelect = (typeKey) => {
    setServingType(typeKey);
    const type = SERVING_TYPES.find(t => t.key === typeKey);
    const queue = type.modules.map(m => MODULE_STEP_MAP[m]);
    setModuleQueue(queue);
    saveDraft(typeKey, selections);
    goToStep(queue[0]);
  };

  const handleNext = () => {
    // Save on each step transition
    saveDraft(servingType, selections);

    if (step === 'welcome') return goToStep('servingType');

    // If in a module, advance to next module or logistics
    const currentQueueIndex = moduleQueue.indexOf(step);
    if (currentQueueIndex !== -1) {
      const nextIndex = currentQueueIndex + 1;
      if (nextIndex < moduleQueue.length) {
        return goToStep(moduleQueue[nextIndex]);
      }
      return goToStep('logistics');
    }

    if (step === 'logistics') return goToStep('confirmation');
  };

  const handleBack = () => {
    if (step === 'servingType') return goToStep('welcome');

    const currentQueueIndex = moduleQueue.indexOf(step);
    if (currentQueueIndex !== -1) {
      if (currentQueueIndex > 0) {
        return goToStep(moduleQueue[currentQueueIndex - 1]);
      }
      return goToStep('servingType');
    }

    if (step === 'logistics') {
      return goToStep(moduleQueue[moduleQueue.length - 1]);
    }

    if (step === 'confirmation') return goToStep('logistics');
  };

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

  // Show/hide nav buttons
  const showBack = !['welcome', 'servingType'].includes(step);
  const showNext = !['servingType', 'confirmation', 'submitted'].includes(step);

  // Render current step
  const renderStep = () => {
    switch (step) {
      case 'welcome':
        return <WelcomeStep plan={plan} />;
      case 'servingType':
        return <ServingTypeStep selected={servingType} onSelect={handleServingTypeSelect} />;
      case 'moduleSignature':
        return (
          <SignaturePickerStep
            selected={selections.signatureCocktails}
            onChange={(drinks) => updateSelections('signatureCocktails', drinks)}
            servingType={servingType}
            cocktails={cocktails}
            categories={cocktailCategories}
          />
        );
      case 'moduleBeerWine':
        return (
          <BeerWineStep
            selections={selections}
            onChange={updateSelections}
          />
        );
      case 'moduleFullBar':
        return (
          <FullBarStep
            selections={selections}
            onChange={updateSelections}
          />
        );
      case 'moduleMocktail':
        return (
          <MocktailStep
            notes={selections.mocktailNotes}
            onChange={(val) => updateSelections('mocktailNotes', val)}
          />
        );
      case 'logistics':
        return (
          <LogisticsStep
            notes={selections.logisticsNotes}
            onChange={(val) => updateSelections('logisticsNotes', val)}
          />
        );
      case 'confirmation':
        return (
          <ConfirmationStep
            plan={plan}
            servingType={servingType}
            selections={selections}
            cocktails={cocktails}
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
        {/* Saving indicator */}
        {saving && (
          <div style={{ textAlign: 'center', padding: '0.25rem', opacity: 0.6, fontSize: '0.85rem' }}>
            Saving...
          </div>
        )}

        {/* Step content */}
        <div className="potion-step" key={step}>
          {renderStep()}
        </div>

        {/* Navigation */}
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

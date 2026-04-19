import { useEffect } from 'react';

export default function useWizardHistory(step, setStep) {
  useEffect(() => {
    window.history.replaceState({ wizardStep: step }, '', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (window.history.state?.wizardStep !== step) {
      window.history.pushState({ wizardStep: step }, '', '');
    }
  }, [step]);

  useEffect(() => {
    const handler = (e) => {
      if (typeof e.state?.wizardStep === 'number') {
        setStep(e.state.wizardStep);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [setStep]);
}

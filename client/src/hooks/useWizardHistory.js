import { useEffect, useRef } from 'react';

// Sync wizard step ↔ browser back/forward. Preserves the current URL (including
// query params like ?utm=, ?resume=) by passing window.location.href to
// pushState/replaceState instead of ''.
//
// Returns a `replaceStep` helper for programmatic jumps (edit-answer buttons,
// step resets) that shouldn't add a new history entry.
export default function useWizardHistory(step, setStep) {
  const replacingRef = useRef(false);

  useEffect(() => {
    window.history.replaceState({ wizardStep: step }, '', window.location.href);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (window.history.state?.wizardStep === step) return;
    if (replacingRef.current) {
      window.history.replaceState({ wizardStep: step }, '', window.location.href);
      replacingRef.current = false;
    } else {
      window.history.pushState({ wizardStep: step }, '', window.location.href);
    }
  }, [step]);

  useEffect(() => {
    const handler = (e) => {
      const s = e.state?.wizardStep;
      if (Number.isInteger(s) && s >= 0) {
        setStep(s);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [setStep]);

  // Programmatic jumps that shouldn't add a history entry (e.g. "Edit answers"
  // from the review step, back-dot clicks in the stepper).
  const replaceStep = (next) => {
    if (next === step) return; // no-op guard: ref would leak to next real change
    replacingRef.current = true;
    setStep(next);
  };

  return { replaceStep };
}

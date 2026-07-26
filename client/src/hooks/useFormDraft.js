import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../utils/api';

const DEBOUNCE_MS = 1500;

// A stored draft counts as real only if it holds at least one answer. An object
// of empty strings is what an untouched form serialises to, and announcing a
// restore for that is worse than saying nothing.
export function hasContent(data) {
  if (!data || typeof data !== 'object') return false;
  return Object.values(data).some(v => {
    if (v === '' || v === null || v === undefined || v === false) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  });
}

/**
 * Autosave a long onboarding form against the user's account.
 *
 * Server-side rather than localStorage because the failure this exists to
 * prevent (incident 2026-07-23) involved someone moving from a phone to a
 * laptop mid-form. Browser-local state does not survive that.
 *
 * `snapshot` is whatever the caller wants preserved, as one serializable object.
 * It is deliberately not "the form state hook": Application.js spreads its
 * answers across five useState hooks, and drafting only one of them would
 * restore the typed answers while losing every checkbox.
 *
 * Saving is best-effort and silent. A draft save that fails must never
 * interrupt someone who is mid-form: the submit is what matters, this is a
 * safety net under it.
 */
export default function useFormDraft(formKey, snapshot, applyDraft, { enabled = true } = {}) {
  const [ready, setReady] = useState(false);
  const [restoredAt, setRestoredAt] = useState(null);
  const applyRef = useRef(applyDraft);
  const clearedRef = useRef(false);
  const baselineRef = useRef(null);
  const timerRef = useRef(null);
  applyRef.current = applyDraft;

  // Load once, and not before `enabled`.
  //
  // `enabled` exists for ContractorProfile, which independently fetches saved
  // profile data on mount. Two unsequenced fetches race, and whichever lands
  // last wins, so a slow /contractor response would silently clobber a restored
  // draft. Gating the draft load on the profile load makes the overlay order
  // deterministic instead of a coin flip.
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    api.get(`/progress/draft/${formKey}`)
      .then(res => {
        if (cancelled) return;
        const { data, updated_at } = res.data || {};
        if (hasContent(data)) {
          applyRef.current(data);
          setRestoredAt(updated_at || null);
        }
      })
      .catch(() => { /* no draft is not an error worth showing */ })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [formKey, enabled]);

  // Save only what the user actually changed.
  //
  // Without the baseline, this effect fires the moment `ready` flips and
  // persists the untouched initial form. That empty row then reads back as a
  // real draft on the next visit and the page announces "we saved your answers
  // from 3:42 PM" to someone who never typed a character.
  useEffect(() => {
    if (!ready || clearedRef.current) return undefined;
    const serialized = JSON.stringify(snapshot);
    if (baselineRef.current === null) {
      baselineRef.current = serialized;   // First pass after load: adopt, do not save.
      return undefined;
    }
    if (serialized === baselineRef.current) return undefined;  // Edited back to where it started.
    const t = setTimeout(() => {
      // Re-check HERE, where the request is actually issued, not only in the
      // effect body above. Setting clearedRef does not re-render, so the effect
      // never re-runs during submit and its cleanup never fires. Without this
      // guard a save armed just before submit lands AFTER clearDraft's DELETE and
      // re-INSERTs the row through the ON CONFLICT upsert, leaving a draft that
      // nothing removes and a "We saved your answers from ..." banner on a form
      // the user already submitted.
      if (clearedRef.current) return;
      api.put(`/progress/draft/${formKey}`, { data: snapshot }).catch(() => {});
    }, DEBOUNCE_MS);
    timerRef.current = t;
    return () => clearTimeout(t);
  }, [ready, formKey, snapshot]);

  const clearDraft = useCallback(async () => {
    clearedRef.current = true;
    // Cancel the armed save as well as flagging it. The guard in the callback is
    // the backstop; this is the actual cancellation, and it also stops the timer
    // holding a reference to a stale snapshot.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    try {
      await api.delete(`/progress/draft/${formKey}`);
    } catch (err) { /* the form already submitted; a stale draft is harmless */ }
  }, [formKey]);

  return { ready, restoredAt, clearDraft };
}

import { useEffect, useRef, useState } from 'react';
import { isPaidState } from './paidState';
import { pollPaymentState } from './settlePoll';

// Owns the post-redirect phase: 'idle' | 'settling' | 'paid' | 'fallback'.
//
// Latched on a ref keyed by proposal id so the settle runs ONCE per loaded
// proposal, and cancelled ONLY on unmount. An earlier draft kept the phase in
// the effect's dependency array and set it inside the effect; React then ran
// the cleanup on the resulting re-render, flipped the cancel flag, and the
// poll it had just started returned early, pinning the page on the spinner
// forever. useSettle.test.js pins that this cannot recur.
// The phase is decided by the poll and the refetch, never by a caller's
// callback: a throwing callback is logged and the phase still lands.
function safely(name, fn) {
  try { fn(); } catch (err) { console.error(`useSettle ${name} failed (non-blocking):`, err); }
}

export function useSettle({
  active, proposal, fetchState, fetchProposal, onSettled, onFallback,
  attempts = 13, intervalMs = 1500,
}) {
  const [phase, setPhase] = useState('idle');
  const startedFor = useRef(null);
  const mounted = useRef(true);
  const latest = useRef({ fetchState, fetchProposal, onSettled, onFallback });
  latest.current = { fetchState, fetchProposal, onSettled, onFallback };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const proposalId = proposal ? proposal.id : null;
  const status = proposal ? proposal.status : null;

  useEffect(() => {
    if (!active || proposalId == null) return;
    if (startedFor.current === proposalId) return;
    startedFor.current = proposalId;

    if (isPaidState(status)) {
      setPhase('paid');
      return;
    }
    setPhase('settling');
    (async () => {
      const { state, reason } = await pollPaymentState({
        fetchState: () => latest.current.fetchState(),
        attempts, intervalMs,
        isCancelled: () => !mounted.current,
      });
      if (!mounted.current) return;
      if (!state) {
        if (reason !== 'cancelled') {
          setPhase('fallback');
          safely('onFallback', () => latest.current.onFallback(reason));
        }
        return;
      }
      let fresh;
      try {
        fresh = await latest.current.fetchProposal();
      } catch {
        if (!mounted.current) return;
        setPhase('fallback');
        safely('onFallback', () => latest.current.onFallback('refetch_failed'));
        return;
      }
      if (!mounted.current) return;
      // The poll said paid and the refetch landed, so 'paid' is the truth even
      // if the caller's callback throws; only the refetch can earn 'fallback'.
      safely('onSettled', () => latest.current.onSettled(fresh));
      setPhase('paid');
    })();
  }, [active, proposalId, status, attempts, intervalMs]);

  return phase;
}

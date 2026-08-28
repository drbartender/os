import { isPaidState } from './paidState';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounded poll for the proposal's payment state after a checkout redirect.
// 13 attempts at 1.5s is about 20 seconds, the budget spec §3b gives the
// webhook before the page gives up. A 5xx or a network error is a miss (the
// thing being waited on is the webhook, not the network). Any 4xx stops the
// poll at once: 404 means the proposal was swept, 429 means the limiter, and
// neither will change by asking again.
export async function pollPaymentState({
  fetchState,
  attempts = 13,
  intervalMs = 1500,
  sleep = defaultSleep,
  isCancelled = () => false,
}) {
  for (let i = 0; i < attempts; i += 1) {
    if (isCancelled()) return { state: null, reason: 'cancelled' };
    try {
      const state = await fetchState();
      if (state && isPaidState(state.status)) return { state, reason: 'settled' };
    } catch (err) {
      // eslint-disable-next-line no-restricted-syntax -- fetchState is raw axios (this public token route bypasses the api instance); err.status covers the api-instance shape too
      const status = (err && err.response && err.response.status) || (err && err.status);
      if (status >= 400 && status < 500) return { state: null, reason: 'blocked' };
    }
    if (isCancelled()) return { state: null, reason: 'cancelled' };
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return { state: null, reason: 'exhausted' };
}

import axios from 'axios';
import { API_BASE_URL as BASE_URL } from '../../../utils/api';

// The ONE write behind the options ladder. Both the drawer (committing a rung
// or the anchor's extras) and the landed banner (undo) post through here, so
// the body shape and the error taxonomy exist in exactly one place.
//
// Raw axios + BASE_URL: public token page, no JWT, matching ProposalView.

export const SWITCH_CONFLICT = 'TOTAL_CHANGED';

/**
 * @returns {{ok: true, payload}}                      committed
 *        | {ok: false, conflict: true, quote, error}  409, prices moved
 *        | {ok: false, refused: true, error}          a guard said no
 *        | {ok: false, unknown: true}                 no answer; caller must reconcile
 */
export async function postSwitch(token, body) {
  try {
    const res = await axios.post(`${BASE_URL}/proposals/t/${token}/switch`, body);
    return { ok: true, payload: res.data };
  } catch (err) {
    // Raw axios on purpose: this is a PUBLIC token page with no JWT, so it
    // never goes through utils/api.js and that interceptor never runs.
    // err.response is the only place the 409's fresh quote lives. Same reason
    // ProposalView and PackageMatrix use raw axios.
    // eslint-disable-next-line no-restricted-syntax
    const res = err && err.response;
    if (!res) {
      // Timeout or a lost response. We do NOT know whether the write landed, so
      // the caller must refetch rather than guess; the sign-time total assertion
      // is the backstop if it somehow misses.
      return { ok: false, unknown: true };
    }
    // A gateway timeout carries a response object but no app JSON, and the
    // write may well have COMMITTED before the proxy gave up. That is the
    // unknown case, not a refusal: telling a client "we could not make that
    // change" about a switch that landed is a false statement about their money.
    if (res.status === 502 || res.status === 504) return { ok: false, unknown: true };
    const data = res.data || {};
    if (res.status === 409 && data.code === SWITCH_CONFLICT) {
      return { ok: false, conflict: true, quote: data.quote, error: data.error };
    }
    return {
      ok: false,
      refused: true,
      error: data.error || 'We could not make that change just now.',
    };
  }
}

export default postSwitch;

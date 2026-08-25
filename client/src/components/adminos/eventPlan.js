// Derivations for the two rebuilt cells on the admin Events list (2026-08-25):
// the Plan queue and the payment Status. Both are pure so the state machine can
// be tested without rendering a table, and both read the admin GET /shifts feed.
//
// The organizing question, per Dallas: "am I waiting, or is the client, and on
// what." Owner is the axis the colour encodes; the tags say what is owed.

import { fmt$, fmtDate, ctDay, dayDiff } from './format';
import { isCancelledEvent } from './shifts';

/**
 * The Plan cell's state.
 *
 * Returns `{ owner, tags }` where owner is:
 *   'client'  the ball is in their court, nothing for you to do  (grey)
 *   'you'     these are yours to produce                          (amber)
 *   'done'    both deliverables are settled                       (green)
 *   null      the column is meaningless on this row               (dash)
 *
 * The whole column is a WORK QUEUE, not a record. Every state in it is
 * something owed BEFORE the party, so a past event says nothing at all: the
 * dash is deliberate and covers ~36 historical rows that would otherwise
 * clamour for a planner nobody will ever fill out. Same for a cancelled event,
 * and for the handful of legacy proposal-less rows left over from manual event
 * creation (removed 2026-08-25).
 *
 * `todayYmd` is the same override `dayDiff` takes, so the column goes dark on
 * exactly the rows the Past tab collects. Tests pin it; the page does not pass
 * it and compares against the browser's day, matching the tab filter.
 */
export function eventPlanState(e, todayYmd) {
  const nothing = { owner: null, tags: [] };
  if (!e || !e.proposal_id) return nothing;
  if (isCancelledEvent(e)) return nothing;
  if (e.event_date && dayDiff(e.event_date.slice(0, 10), todayYmd) < 0) return nothing;

  const listStatus = e.shopping_list_status;

  // Nothing in hand yet. shopping_list_status is the whole client-input signal:
  // the generator runs the instant a planner is submitted or an admin fills the
  // consult form, so a null here means neither has happened. A booked consult
  // replaces the planner ask, because they are not going to fill one out.
  if (!listStatus) {
    const day = ctDay(e.consult_at);
    if (!day) return { owner: 'client', tags: ['Planner'] };
    // Consult status is dead data (every prod row reads 'scheduled' and none has
    // ever transitioned), so the date is the only thing that can be judged. A
    // date that has come and gone with nothing written up is admin's move, and
    // it cannot distinguish "we met and I owe the write-up" from a no-show.
    if (dayDiff(day, todayYmd) < 0) return { owner: 'you', tags: ['Consult passed'] };
    return { owner: 'client', tags: [`Consult ${fmtDate(day)}`] };
  }

  // Input has landed, so BOTH deliverables unlock at once. They are parallel,
  // not sequential: showing only the list would hide the menu on every row
  // where work is actually owed.
  const tags = [];
  if (listStatus !== 'approved') tags.push('Shopping List');
  if (!e.menu_done) tags.push('Menu Design');
  return tags.length ? { owner: 'you', tags } : { owner: 'done', tags: [] };
}

/**
 * The Status cell's state: `{ kind, label }` with kind in
 * 'paid' | 'owed' | 'cancelled' | 'none'.
 *
 * The only money on this list. Total and Balance were dropped because an event
 * only exists once someone has paid something, so the single fact worth a
 * column is whether they are square or not.
 */
export function eventPaymentState(e) {
  const none = { kind: 'none', label: '—' };
  if (!e || !e.proposal_id) return none;
  // BEFORE the payment maths, always. A booking refunded to zero and archived
  // computes as paid >= total and would otherwise wear a green chip over money
  // that came back out.
  if (isCancelledEvent(e)) return { kind: 'cancelled', label: 'Cancelled' };

  const total = Number(e.proposal_total || 0);
  const paid = Number(e.proposal_amount_paid || e.amount_paid || 0);
  // A live booking with no total is not a paid booking, it is a booking whose
  // total went somewhere. The refund demote ladder can leave one behind.
  if (total <= 0) return none;
  if (paid >= total) return { kind: 'paid', label: 'Paid in Full' };
  return { kind: 'owed', label: fmt$(total - paid) };
}

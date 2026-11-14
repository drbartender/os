import {
  eventPlanState, eventPaymentState, eventBalanceDue, planTagOwner, MENU_WITH_CLIENT_TAG,
} from './eventPlan';

// Every case pins `today` so a passing suite never depends on the wall clock.
const TODAY = '2026-08-25';
const base = (over = {}) => ({
  proposal_id: 7,
  event_date: '2026-09-12',
  proposal_status: 'confirmed',
  status: 'open',
  shopping_list_status: null,
  consult_at: null,
  menu_done: false,
  ...over,
});

describe('eventPlanState', () => {
  it('goes dark once the event date has passed', () => {
    const s = eventPlanState(base({ event_date: '2026-08-24' }), TODAY);
    expect(s).toEqual({ owner: null, tags: [] });
  });

  it('stays lit on the day of the event', () => {
    const s = eventPlanState(base({ event_date: TODAY }), TODAY);
    expect(s.owner).toBe('client');
  });

  it('goes dark on a cancelled event', () => {
    const s = eventPlanState(base({ proposal_status: 'archived' }), TODAY);
    expect(s).toEqual({ owner: null, tags: [] });
  });

  it('goes dark on a row with no proposal', () => {
    const s = eventPlanState(base({ proposal_id: null }), TODAY);
    expect(s).toEqual({ owner: null, tags: [] });
  });

  it('waits on the client for the planner when nothing is in hand', () => {
    expect(eventPlanState(base(), TODAY)).toEqual({
      owner: 'client',
      tags: ['Planner'],
    });
  });

  it('waits on the client for a booked consult instead of the planner', () => {
    const s = eventPlanState(base({ consult_at: '2026-09-03T15:00:00.000Z' }), TODAY);
    expect(s.owner).toBe('client');
    expect(s.tags).toHaveLength(1);
    expect(s.tags[0]).toMatch(/^Consult Sep 3$/);
  });

  it('hands a passed consult back to admin when nothing was written up', () => {
    const s = eventPlanState(base({ consult_at: '2026-08-20T15:00:00.000Z' }), TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Consult passed'] });
  });

  it('owes both deliverables the moment input lands', () => {
    const s = eventPlanState(base({ shopping_list_status: 'pending_review' }), TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Shopping List', 'Menu Design'] });
  });

  it('drops the menu tag when the menu is already settled', () => {
    const s = eventPlanState(
      base({ shopping_list_status: 'pending_review', menu_done: true }), TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Shopping List'] });
  });

  it('drops the list tag once the list is approved', () => {
    const s = eventPlanState(base({ shopping_list_status: 'approved' }), TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Menu Design'] });
  });

  it('is done when both deliverables are settled', () => {
    const s = eventPlanState(
      base({ shopping_list_status: 'approved', menu_done: true }), TODAY);
    expect(s).toEqual({ owner: 'done', tags: [] });
  });

  // Input in hand supersedes the consult: once the write-up exists there is
  // nothing left to wait on the meeting for, whether it has happened or not.
  it('ignores a pending consult once the list exists', () => {
    const s = eventPlanState(
      base({ consult_at: '2026-09-03T15:00:00.000Z', shopping_list_status: 'pending_review' }),
      TODAY);
    expect(s.owner).toBe('you');
    expect(s.tags).toContain('Shopping List');
  });

  it('ignores a cancelled consult and keeps waiting on the planner', () => {
    const s = eventPlanState(base({ consult_at: null }), TODAY);
    expect(s.tags).toEqual(['Planner']);
  });
});

describe('eventPaymentState', () => {
  const pay = (over = {}) => base({ proposal_total: 1200, proposal_amount_paid: 400, ...over });

  it('reports the outstanding balance', () => {
    expect(eventPaymentState(pay())).toEqual({ kind: 'owed', label: '$800' });
  });

  it('reports paid in full when the balance is settled', () => {
    expect(eventPaymentState(pay({ proposal_amount_paid: 1200 })))
      .toEqual({ kind: 'paid', label: 'Paid in Full' });
  });

  it('reports paid in full when an overpayment lands', () => {
    expect(eventPaymentState(pay({ proposal_amount_paid: 1500 })).kind).toBe('paid');
  });

  it('calls a cancelled event cancelled, never paid in full', () => {
    const s = eventPaymentState(pay({ proposal_status: 'archived', proposal_amount_paid: 1200 }));
    expect(s).toEqual({ kind: 'cancelled', label: 'Cancelled' });
  });

  // The refund ladder can zero a booking's total. Reading that as "Paid in Full"
  // would put a green chip on money that came back out.
  it('stays blank on a zero-total booking rather than claiming paid', () => {
    expect(eventPaymentState(pay({ proposal_total: 0, proposal_amount_paid: 0 })))
      .toEqual({ kind: 'none', label: '—' });
  });

  it('stays blank on a row with no proposal', () => {
    expect(eventPaymentState(base({ proposal_id: null })))
      .toEqual({ kind: 'none', label: '—' });
  });

  it('rounds the balance to whole dollars with a thousands separator', () => {
    expect(eventPaymentState(pay({ proposal_total: 2325.4, proposal_amount_paid: 0 })).label)
      .toBe('$2,325');
  });
});

// A hosted package never owes the client a shopping list (DRB stocks the bar),
// so on a hosted row the only deliverable is the menu and "input landed" is
// read off plan_input_landed (submitted or consult-filled), not off a list that
// is never generated. Found 2026-09-10: a hosted client two days out read as
// owing a shopping list; nulling the row instead would have read as "waiting on
// the planner" on a plan he had already finished.
describe('eventPlanState on a hosted package', () => {
  const hosted = (over = {}) => base({ package_category: 'hosted', plan_input_landed: false, ...over });

  it('waits on the planner until input lands, same as BYOB', () => {
    const s = eventPlanState(hosted(), TODAY);
    expect(s).toEqual({ owner: 'client', tags: ['Planner'] });
  });

  it('owes only the menu once input lands', () => {
    const s = eventPlanState(hosted({ plan_input_landed: true }), TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Menu Design'] });
  });

  it('is done once the menu is settled', () => {
    const s = eventPlanState(hosted({ plan_input_landed: true, menu_done: true }), TODAY);
    expect(s).toEqual({ owner: 'done', tags: [] });
  });

  it('never owes a shopping list, even when a stale list row exists', () => {
    const s = eventPlanState(
      hosted({ plan_input_landed: true, shopping_list_status: 'pending_review' }), TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Menu Design'] });
  });

  it('still hands a passed consult back to admin before input lands', () => {
    const s = eventPlanState(hosted({ consult_at: '2026-08-20T15:00:00.000Z' }), TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Consult passed'] });
  });

  it('reads a stale list row as input landed even when the flag is false', () => {
    const s = eventPlanState(hosted({ shopping_list_status: 'pending_review' }), TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Menu Design'] });
  });

  it('a cocktail class is seeded hosted but still owes the list', () => {
    const s = eventPlanState(
      hosted({ package_bar_type: 'class', plan_input_landed: true, shopping_list_status: 'pending_review' }), TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Shopping List', 'Menu Design'] });
  });
});

// plan_input_landed is a second input signal for EVERY row, not just hosted:
// the auto-gen after a BYOB submit is best-effort, so a submitted plan whose
// generation skipped or threw has no list and used to read "waiting on the
// planner" forever, hiding both deliverables the admin actually owed.
describe('eventPlanState on a BYOB row with input but no list', () => {
  it('owes both deliverables once the plan is submitted, list or no list', () => {
    const s = eventPlanState(base({ package_category: 'byob', plan_input_landed: true }), TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Shopping List', 'Menu Design'] });
  });

  it('still waits on the planner when nothing has landed', () => {
    const s = eventPlanState(base({ package_category: 'byob', plan_input_landed: false }), TODAY);
    expect(s).toEqual({ owner: 'client', tags: ['Planner'] });
  });
});

// While a held print file waits on an unanswered proof the next move is the
// client's (spec 2026-10-19 section 14): the feed's menu_with_client swaps the
// menu tag for "Menu with client", and when nothing else is owed the row is
// theirs. A change request or a held file the client approved is the owner's
// move again, which the feed carries as menu_with_client false.
describe('eventPlanState with the menu proof out to the client', () => {
  it('shows Menu with client and hands the row to the client when that is all that is owed', () => {
    const s = eventPlanState(base({ shopping_list_status: 'approved', menu_with_client: true }), TODAY);
    expect(s).toEqual({ owner: 'client', tags: ['Menu with client'] });
  });

  it('does the same on a hosted row, which owes no shopping list', () => {
    const s = eventPlanState(
      base({ package_category: 'hosted', plan_input_landed: true, menu_with_client: true }), TODAY);
    expect(s).toEqual({ owner: 'client', tags: ['Menu with client'] });
  });

  it('keeps the tag when an older released file already makes menu_done true', () => {
    const s = eventPlanState(
      base({ shopping_list_status: 'approved', menu_done: true, menu_with_client: true }), TODAY);
    expect(s).toEqual({ owner: 'client', tags: ['Menu with client'] });
  });

  it('reads Menu Design and you again for a change request', () => {
    const s = eventPlanState(
      base({ shopping_list_status: 'approved', menu_done: false, menu_with_client: false }), TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Menu Design'] });
  });

  it('still makes the owner you while the Shopping List is owed', () => {
    const s = eventPlanState(base({ shopping_list_status: 'pending_review', menu_with_client: true }), TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Shopping List', 'Menu with client'] });
  });
});

// The client answered the held file's proof (menu_answer_waiting): a change
// request owes edits, a Looks great still needs the owner's Release (Client
// approved, spec 10.7). Either way it is the owner's move, and an older
// released file that keeps menu_done true must not hide it as Done.
describe('eventPlanState with the client\'s answer waiting on a held menu', () => {
  it('shows Menu Design and you even when an older released file makes menu_done true', () => {
    const s = eventPlanState(
      base({ shopping_list_status: 'approved', menu_done: true, menu_answer_waiting: true }), TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Menu Design'] });
  });

  it('shows Menu Design and you with no older file', () => {
    const s = eventPlanState(
      base({ shopping_list_status: 'approved', menu_done: false, menu_answer_waiting: true }), TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Menu Design'] });
  });

  it('shows both tags, and you, while the Shopping List is also owed', () => {
    const s = eventPlanState(
      base({ shopping_list_status: 'pending_review', menu_done: true, menu_answer_waiting: true }), TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Shopping List', 'Menu Design'] });
  });

  it('never shows Menu with client and Menu Design together, whatever the flags say', () => {
    for (const menuDone of [false, true]) {
      for (const withClient of [false, true]) {
        for (const answerWaiting of [false, true]) {
          const { tags } = eventPlanState(base({
            shopping_list_status: 'approved',
            menu_done: menuDone, menu_with_client: withClient, menu_answer_waiting: answerWaiting,
          }), TODAY);
          const menuTags = tags.filter((t) => t === 'Menu Design' || t === 'Menu with client');
          expect(menuTags.length).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('reads the owner\'s move when the flags ever disagree, never the client\'s', () => {
    const s = eventPlanState(
      base({ shopping_list_status: 'approved', menu_done: true, menu_with_client: true, menu_answer_waiting: true }),
      TODAY);
    expect(s).toEqual({ owner: 'you', tags: ['Menu Design'] });
  });
});

// Whose move each Plan tag is, for its chip's colour: "Menu with client" is
// always the client's, whatever the row's owner; every other tag is the row's.
describe('planTagOwner', () => {
  it('names the tag string the Plan state emits', () => {
    expect(MENU_WITH_CLIENT_TAG).toBe('Menu with client');
    const s = eventPlanState(base({ shopping_list_status: 'approved', menu_with_client: true }), TODAY);
    expect(s.tags).toEqual([MENU_WITH_CLIENT_TAG]);
  });

  it('makes Menu with client the client\'s on a row that is yours', () => {
    const { owner, tags } = eventPlanState(base({ shopping_list_status: 'pending_review', menu_with_client: true }), TODAY);
    expect(owner).toBe('you');
    expect(tags.map((t) => planTagOwner(t, owner))).toEqual(['you', 'client']);
  });

  it('keeps every other tag on the row\'s owner', () => {
    expect(planTagOwner('Shopping List', 'you')).toBe('you');
    expect(planTagOwner('Menu Design', 'you')).toBe('you');
    expect(planTagOwner('Consult passed', 'you')).toBe('you');
    expect(planTagOwner('Planner', 'client')).toBe('client');
    expect(planTagOwner(MENU_WITH_CLIENT_TAG, 'client')).toBe('client');
  });
});

// The line under an owed Status chip on the desktop Events list (Dallas,
// 2026-10-06: the due date under the balance, past due in red). The DATE
// arrives serialized like event_date, so the helper slices YYYY-MM-DD off it.
describe('eventBalanceDue', () => {
  const owed = (over = {}) => base({
    proposal_total: 1200, proposal_amount_paid: 400,
    proposal_balance_due_date: '2026-08-29T05:00:00.000Z', ...over,
  });

  it('gives the due day, not yet past due, when it is ahead', () => {
    expect(eventBalanceDue(owed(), TODAY)).toEqual({ ymd: '2026-08-29', pastDue: false });
  });

  it('is not past due on the due day itself', () => {
    expect(eventBalanceDue(owed({ proposal_balance_due_date: '2026-08-25' }), TODAY).pastDue).toBe(false);
  });

  it('is past due the day after', () => {
    expect(eventBalanceDue(owed({ proposal_balance_due_date: '2026-08-24' }), TODAY))
      .toEqual({ ymd: '2026-08-24', pastDue: true });
  });

  it('shows nothing once the balance is paid, however late the date', () => {
    expect(eventBalanceDue(owed({ proposal_amount_paid: 1200, proposal_balance_due_date: '2026-08-01' }), TODAY)).toBeNull();
  });

  it('shows nothing on a cancelled event or a row with no proposal', () => {
    expect(eventBalanceDue(owed({ proposal_status: 'archived' }), TODAY)).toBeNull();
    expect(eventBalanceDue(owed({ proposal_id: null }), TODAY)).toBeNull();
  });

  it('shows nothing when the proposal carries no due date (or a malformed one)', () => {
    for (const bad of [null, undefined, '', 'soon', 42]) {
      expect(eventBalanceDue(owed({ proposal_balance_due_date: bad }), TODAY)).toBeNull();
    }
  });
});

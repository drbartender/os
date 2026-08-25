import { eventPlanState, eventPaymentState } from './eventPlan';

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

import {
  buildStaffingItems, buildClientItems, buildSalesItems,
  computeTabs, defaultTabKey, queueItemHref,
} from './queueItems';
import { buildPrepItems } from './PrepQueue';

const now = Date.parse('2026-07-14T12:00:00Z');
const hrs = (n) => new Date(now - n * 3600e3).toISOString();

// Local-date helper for dayDiff-based fixtures (staffing, prep): days from
// today in YYYY-MM-DD, matching how event_date reaches the client.
const ymdFromToday = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('buildSalesItems (sent-unviewed 72h)', () => {
  test('sent 73h ago becomes an info item targeting the proposal', () => {
    const items = buildSalesItems(
      [{ id: 1, status: 'sent', sent_at: hrs(73), client_name: 'Ana', total_price: 500 }], now
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ target: 'proposal', ref: 1, priority: 'info' });
    expect(items[0].title).toContain('Ana');
  });

  test('sent 71h ago is inside the window and excluded', () => {
    expect(buildSalesItems([{ id: 2, status: 'sent', sent_at: hrs(71) }], now)).toHaveLength(0);
  });

  test('viewed proposals never surface regardless of age', () => {
    expect(buildSalesItems([{ id: 3, status: 'viewed', sent_at: hrs(200) }], now)).toHaveLength(0);
  });

  test('a proposal with no client name or email falls back to Client, never "null"', () => {
    const items = buildSalesItems([{ id: 4, status: 'sent', sent_at: hrs(100) }], now);
    expect(items[0].title).toBe('Client proposal unviewed');
  });
});

describe('buildClientItems', () => {
  const cr = (over = {}) => ({
    id: 10, proposal_id: 77, client_name: 'Ruta', event_type: 'wedding',
    event_date: '2026-08-01', edit_window: 'outside_t14', ...over,
  });

  test('inside_t14 change request is danger; otherwise warn', () => {
    expect(buildClientItems([cr({ edit_window: 'inside_t14' })], [])[0].priority).toBe('danger');
    expect(buildClientItems([cr()], [])[0].priority).toBe('warn');
  });

  test('change request targets its proposal', () => {
    expect(buildClientItems([cr()], [])[0]).toMatchObject({ target: 'proposal', ref: 77 });
  });

  test('only conversations with unread become items, shaped for the thread link', () => {
    const items = buildClientItems([], [
      { client_id: 5, name: 'Sam', unread_count: 2 },
      { client_id: 6, name: 'Quiet', unread_count: 0 },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ target: 'sms', ref: 5, priority: 'warn', meta: '2' });
  });

  test('change requests list before SMS items', () => {
    const items = buildClientItems([cr()], [{ client_id: 5, name: 'Sam', unread_count: 1 }]);
    expect(items.map(i => i.type)).toEqual(['change-request', 'sms']);
  });
});

describe('buildStaffingItems', () => {
  const shift = (days, over = {}) => ({
    id: 1, event_date: `${ymdFromToday(days)}T00:00:00.000Z`, client_name: 'Eve',
    positions_needed: '["Bartender","Bartender"]', approved_count: 0, ...over,
  });

  test('event under 7 days out is danger; 7+ is warn', () => {
    expect(buildStaffingItems([shift(3)], 0)[0].priority).toBe('danger');
    expect(buildStaffingItems([shift(10)], 0)[0].priority).toBe('warn');
  });

  // The 14-day horizon (2026-08-17). /events stays the full forward view; this
  // card is only the part of it that is actionable now.
  test('an event exactly 14 days out still surfaces', () => {
    expect(buildStaffingItems([shift(14)], 0)).toHaveLength(1);
  });

  test('an event 15 days out is past the horizon and drops out', () => {
    expect(buildStaffingItems([shift(15)], 0)).toHaveLength(0);
  });

  test('the horizon keeps near events and drops far ones from the same list', () => {
    const items = buildStaffingItems(
      [shift(2, { id: 1 }), shift(20, { id: 2 }), shift(9, { id: 3 }), shift(60, { id: 4 })], 0
    );
    expect(items.map(i => i.id)).toEqual(['unstaffed-1', 'unstaffed-3']);
  });

  test('no cap: five unstaffed events yield five items', () => {
    const items = buildStaffingItems([1, 2, 3, 4, 5].map(i => shift(10, { id: i })), 0);
    expect(items).toHaveLength(5);
  });

  test('applications rollup appears only when count > 0', () => {
    expect(buildStaffingItems([], 0)).toHaveLength(0);
    const items = buildStaffingItems([], 2);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ target: 'hiring', priority: 'info' });
  });

  const risk = (user_id, name, next_shift_date = null, next_shift_id = null) =>
    ({ user_id, name, next_shift_date, next_shift_id });

  test('emits one named row per uncertified worker', () => {
    const items = buildStaffingItems([], 0, [
      risk(55, 'Loryn', ymdFromToday(5)),
      risk(241, 'Debbie'),
    ]).filter(i => i.type === 'documents');

    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Loryn has no alcohol certification');
    expect(items[1].title).toBe('Debbie has no alcohol certification');
  });

  test('escalates someone who is actually booked', () => {
    const [booked] = buildStaffingItems([], 0, [risk(55, 'Loryn', ymdFromToday(5), 347)])
      .filter(i => i.type === 'documents');
    expect(booked.priority).toBe('danger');
    expect(booked.sub).toMatch(/working/i);
  });

  // The horizon de-escalates rather than filters here: a cert takes lead time
  // to obtain, so the person must never fall off the tab, they just stop
  // outranking the events happening this week.
  test('a booking past the horizon falls back to the standing eligible row', () => {
    const [far] = buildStaffingItems([], 0, [risk(55, 'Loryn', ymdFromToday(30), 347)])
      .filter(i => i.type === 'documents');
    expect(far).toBeTruthy();
    expect(far.priority).toBe('warn');
    expect(far.sub).toMatch(/can be assigned/i);
    expect(far.meta).toBe('eligible');
  });

  test('a booking exactly 14 days out is still an escalation', () => {
    const [edge] = buildStaffingItems([], 0, [risk(55, 'Loryn', ymdFromToday(14), 347)])
      .filter(i => i.type === 'documents');
    expect(edge.priority).toBe('danger');
  });

  // The de-escalation compares against STAFFING_HORIZON_DAYS INDEPENDENTLY of
  // the event filter, so the boundary needs pinning on both sides here too.
  // With only 14 and 30 covered, an off-by-one on this comparison alone (<= 15)
  // passed the whole suite.
  test('a booking 15 days out is past the horizon and de-escalates', () => {
    const [past] = buildStaffingItems([], 0, [risk(55, 'Loryn', ymdFromToday(15), 347)])
      .filter(i => i.type === 'documents');
    expect(past.priority).toBe('warn');
    expect(past.meta).toBe('eligible');
  });

  test('leaves an eligible but unbooked worker at warn', () => {
    const [idle] = buildStaffingItems([], 0, [risk(241, 'Debbie')])
      .filter(i => i.type === 'documents');
    expect(idle.priority).toBe('warn');
    expect(idle.sub).toMatch(/can be assigned/i);
  });

  test('links each row to that person, not to a list they may not appear on', () => {
    const [row] = buildStaffingItems([], 0, [risk(241, 'Debbie')])
      .filter(i => i.type === 'documents');
    expect(row.target).toBe('user');
    expect(row.ref).toBe(241);
  });

  // The empty [] in the third slot is LOAD-BEARING: it is the existing
  // `uncertified` parameter. Notices passed third would render as
  // "undefined has no alcohol certification" documents rows.
  test('buildStaffingItems emits an info-priority name notice per unreviewed name', () => {
    const items = buildStaffingItems([], 0, [], [
      { user_id: 7, legal_name: 'Nevver Sayles', preferred_name: 'TwistidTreets', display_name: 'TwistidTreets S.' },
    ], () => {});
    const row = items.find((i) => i.type === 'name-notice');
    expect(row).toBeTruthy();
    expect(row.priority).toBe('info');
    expect(row.title).toBe('Nevver Sayles goes by TwistidTreets');
    expect(row.target).toBe('user');
    expect(row.ref).toBe(7);
  });

  test('the name notice meta action acks that user and never navigates', () => {
    const acked = [];
    const [row] = buildStaffingItems([], 0, [], [
      { user_id: 7, legal_name: 'Nevver Sayles', preferred_name: 'TwistidTreets', display_name: 'TwistidTreets S.' },
    ], (id) => acked.push(id)).filter(i => i.type === 'name-notice');
    expect(row.meta).toBe('Got it');
    row.metaAction();
    expect(acked).toEqual([7]);
  });

  test('gives each row a stable unique id', () => {
    const items = buildStaffingItems([], 0, [risk(55, 'Loryn'), risk(241, 'Debbie')])
      .filter(i => i.type === 'documents');
    expect(new Set(items.map(i => i.id)).size).toBe(2);
  });

  test('emits nothing when nobody is uncertified', () => {
    expect(buildStaffingItems([], 0, []).some(i => i.type === 'documents')).toBe(false);
  });

  test('treats a missing third argument as nobody uncertified', () => {
    expect(buildStaffingItems([], 0).some(i => i.type === 'documents')).toBe(false);
  });

  // Regression guard for the crowding-out defect. NeedsYouStrip renders only
  // the first TAB_CAP (6) items in array order, so an urgent row appended last
  // disappears into an overflow link pointing at /events.
  test('floats danger rows above warn rows regardless of insertion order', () => {
    const sixWarnEvents = [1, 2, 3, 4, 5, 6].map(i => shift(10, { id: i })); // days=10 => warn
    const items = buildStaffingItems(sixWarnEvents, 0, [
      risk(55, 'Loryn', ymdFromToday(5), 347),   // danger: booked inside the horizon
    ]);
    expect(items[0].type).toBe('documents');
    expect(items.slice(0, 6).some(i => i.type === 'documents')).toBe(true);
  });

  test('keeps equal-priority rows in their original order', () => {
    const items = buildStaffingItems([], 0, [risk(55, 'Loryn'), risk(241, 'Debbie')])
      .filter(i => i.type === 'documents');
    expect(items.map(i => i.ref)).toEqual([55, 241]);
  });
});

describe('queueItemHref', () => {
  test('routes a user-target row to that user detail page', () => {
    expect(queueItemHref({ target: 'user', ref: 241 })).toBe('/staffing/users/241');
  });
  test('still routes the pre-existing targets', () => {
    expect(queueItemHref({ target: 'event', ref: 9 })).toBe('/events/9');
    expect(queueItemHref({ target: 'hiring', ref: null })).toBeNull();
  });
});

describe('buildPrepItems (cap removed)', () => {
  test('returns every qualifying plan with no overflow item', () => {
    const plans = [1, 2, 3, 4, 5, 6, 7].map(i => ({
      id: i, status: 'submitted', shopping_list_status: null,
      client_name: `C${i}`, event_date: ymdFromToday(20),
    }));
    const items = buildPrepItems(plans);
    expect(items).toHaveLength(7);
    expect(items.find(i => i.id === 'prep-overflow')).toBeUndefined();
  });
});

describe('computeTabs', () => {
  const item = (priority) => ({ id: 'x', type: 'unstaffed', priority, title: 't', sub: 's', meta: 'm', target: 'shift', ref: 1 });
  const base = { staffing: [], prep: [], clients: [], sales: [] };

  test('dot is the worst priority within the tab', () => {
    const tabs = computeTabs({ ...base, staffing: [item('warn'), item('danger'), item('info')] });
    expect(tabs.find(t => t.key === 'staffing').dot).toBe('danger');
  });

  test('sales tab is absent when empty, present when non-empty', () => {
    expect(computeTabs(base).map(t => t.key)).toEqual(['staffing', 'prep', 'clients']);
    expect(computeTabs({ ...base, sales: [item('info')] }).map(t => t.key)).toContain('sales');
  });

  // Money came out 2026-08-17: unmatched payouts are the Band 2 Payouts
  // badge's job, and payroll is its own Band 1 card.
  test('there is no money tab', () => {
    expect(computeTabs(base).some(t => t.key === 'money')).toBe(false);
  });

  test('hasBody is purely a question of items now', () => {
    expect(computeTabs(base).every(t => t.hasBody === false)).toBe(true);
    expect(computeTabs({ ...base, staffing: [item('info')] }).find(t => t.key === 'staffing').hasBody).toBe(true);
  });
});

describe('defaultTabKey', () => {
  const item = (priority) => ({ id: 'x', type: 'unstaffed', priority, title: 't', sub: 's', meta: 'm', target: 'shift', ref: 1 });
  const base = { staffing: [], prep: [], clients: [], sales: [] };

  test('worst-priority tab wins: danger in clients beats warn in staffing', () => {
    const tabs = computeTabs({ ...base, staffing: [item('warn')], clients: [item('danger')] });
    expect(defaultTabKey(tabs)).toBe('clients');
  });

  test('ties resolve by fixed order: warn in staffing and prep goes to staffing', () => {
    const tabs = computeTabs({ ...base, staffing: [item('warn')], prep: [item('warn')] });
    expect(defaultTabKey(tabs)).toBe('staffing');
  });

  test('all empty is null, which collapses the card for admin and manager alike', () => {
    expect(defaultTabKey(computeTabs(base))).toBeNull();
  });
});

import {
  buildStaffingItems, buildClientItems, buildSalesItems, buildMoneyItems,
  computeTabs, defaultTabKey,
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
});

describe('buildMoneyItems', () => {
  test('zero unmatched payouts yields no items', () => {
    expect(buildMoneyItems(0)).toHaveLength(0);
  });

  test('unmatched payouts yield one warn item targeting payouts', () => {
    const items = buildMoneyItems(3);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ target: 'payouts', priority: 'warn', meta: '3' });
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
  const base = { staffing: [], prep: [], clients: [], money: [], sales: [], payrollOverdue: false, isAdmin: true };

  test('dot is the worst priority within the tab', () => {
    const tabs = computeTabs({ ...base, staffing: [item('warn'), item('danger'), item('info')] });
    expect(tabs.find(t => t.key === 'staffing').dot).toBe('danger');
  });

  test('payroll overdue forces a danger dot on money even with zero items', () => {
    const money = computeTabs({ ...base, payrollOverdue: true }).find(t => t.key === 'money');
    expect(money.count).toBe(0);
    expect(money.dot).toBe('danger');
  });

  test('sales tab is absent when empty, present when non-empty', () => {
    expect(computeTabs(base).map(t => t.key)).toEqual(['staffing', 'prep', 'clients', 'money']);
    expect(computeTabs({ ...base, sales: [item('info')] }).map(t => t.key)).toContain('sales');
  });

  test('money hasBody follows isAdmin at zero items', () => {
    expect(computeTabs(base).find(t => t.key === 'money').hasBody).toBe(true);
    expect(computeTabs({ ...base, isAdmin: false }).find(t => t.key === 'money').hasBody).toBe(false);
  });
});

describe('defaultTabKey', () => {
  const item = (priority) => ({ id: 'x', type: 'unstaffed', priority, title: 't', sub: 's', meta: 'm', target: 'shift', ref: 1 });
  const base = { staffing: [], prep: [], clients: [], money: [], sales: [], payrollOverdue: false, isAdmin: true };

  test('worst-priority tab wins: danger in clients beats warn in staffing', () => {
    const tabs = computeTabs({ ...base, staffing: [item('warn')], clients: [item('danger')] });
    expect(defaultTabKey(tabs, true)).toBe('clients');
  });

  test('ties resolve by fixed order: warn in staffing and prep goes to staffing', () => {
    const tabs = computeTabs({ ...base, staffing: [item('warn')], prep: [item('warn')] });
    expect(defaultTabKey(tabs, true)).toBe('staffing');
  });

  test('payroll overdue alone lands on money', () => {
    const tabs = computeTabs({ ...base, payrollOverdue: true });
    expect(defaultTabKey(tabs, true)).toBe('money');
  });

  test('all empty: money for admins, null for managers', () => {
    expect(defaultTabKey(computeTabs(base), true)).toBe('money');
    expect(defaultTabKey(computeTabs({ ...base, isAdmin: false }), false)).toBeNull();
  });
});

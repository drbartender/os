import { groupShiftRows, railParts, placeOf } from './eventCards';
import { buildShiftView } from './staffingSheet';

const row = (over = {}) => ({
  id: 1, proposal_id: 10, event_key: 'p10', client_name: 'Henderson', event_type: 'wedding-reception', event_type_custom: null,
  event_date: '2026-08-15', start_time: '18:00', end_time: '23:00', event_duration_hours: 5, location: 'Grove on the River',
  venue_city: 'Rockford', venue_state: 'Illinois',
  proposal_guest_count: 140, positions_needed: '["Bartender","Bartender","Bartender"]',
  approved_count: 2, pending_count: 2, status: 'open', proposal_status: 'deposit_paid',
  bar_required: true, supply_run_required: true, ...over,
});

test('two rows with one proposal become one card with slots, filled and pending summed', () => {
  const cards = groupShiftRows([
    row(),
    row({ id: 2, positions_needed: '["Banquet Server"]', approved_count: 1, pending_count: 0, start_time: '17:00', end_time: '22:00', bar_required: false, supply_run_required: false }),
  ], { todayYmd: '2026-08-14' });
  expect(cards).toHaveLength(1);
  const c = cards[0];
  expect(c).toMatchObject({ key: 'p10', manual: false, id: 10, shiftCount: 2, slots: 4, filled: 3, open: 1, pending: 2, full: false, cancelled: false, barRental: true, supplies: true, isToday: false });
  expect(c.shiftIds).toEqual([1, 2]);
  expect(c.clientName).toBe('Henderson');
  expect(c.kind).toBe('Wedding Reception');
  expect(c.timeRange).toBe('18:00–23:00 · 5h');   // first shift's range
  expect(c.venue).toBe('Grove on the River');   // the full address, for the detail header
  expect(c.place).toBe('Rockford, IL');          // the town, for the list line
  expect(c.guests).toBe(140);
  expect(c.tapTarget).toEqual({ kind: 'event', id: 10 });
});

test('place is "City, ST" off the structured venue; codes pass through; no city means no place', () => {
  expect(placeOf({ venue_city: 'Rockford', venue_state: 'Illinois' })).toBe('Rockford, IL');
  expect(placeOf({ venue_city: 'Merrillville', venue_state: 'IN' })).toBe('Merrillville, IN');
  expect(placeOf({ venue_city: 'Chicago', venue_state: null })).toBe('Chicago');
  expect(placeOf({ venue_city: null, venue_state: 'Illinois' })).toBe('');
  expect(placeOf({ venue_city: ' Peoria ', venue_state: 'Somewhere Else' })).toBe('Peoria, Somewhere Else');
  // A manual shift has no proposal, so no structured venue: the card keeps its
  // free-text location for the list line.
  const [manual] = groupShiftRows([row({ id: 7, proposal_id: null, event_key: 's7', venue_city: null, venue_state: null })]);
  expect(manual.place).toBe('');
  expect(manual.venue).toBe('Grove on the River');
});

test('a manual shift is its own card and taps into the shift', () => {
  const [c] = groupShiftRows([row({ id: 7, proposal_id: null, event_key: 's7', client_name: 'Night Market pop-up', event_type: null, proposal_guest_count: null, proposal_status: null })]);
  expect(c).toMatchObject({ key: 's7', manual: true, id: 7, clientName: 'Night Market pop-up', kind: 'Manual shift', guests: null, tapTarget: { kind: 'shift', id: 7 } });
});

test('a nameless manual shift is named by its venue, and never says Manual shift twice', () => {
  const manual = (over) => row({ id: 7, proposal_id: null, event_key: 's7', client_name: null, event_type: null, event_type_custom: null, proposal_guest_count: null, proposal_status: null, ...over });
  const [venued] = groupShiftRows([manual({ location: 'Grant Park' })]);
  expect(venued).toMatchObject({ manual: true, clientName: 'Grant Park', kind: 'Manual shift' });
  // Nothing left to name it with: the fallback is the title, and the kind goes
  // empty so the card renders no separator rather than repeating itself.
  const [bare] = groupShiftRows([manual({ location: null })]);
  expect(bare).toMatchObject({ manual: true, clientName: 'Manual shift', kind: '' });
});

test('rows without event_key still group by proposal_id, or by shift id when manual', () => {
  const cards = groupShiftRows([row({ event_key: undefined }), row({ id: 2, event_key: undefined }), row({ id: 3, event_key: undefined, proposal_id: null })]);
  expect(cards.map(c => c.key)).toEqual(['p10', 's3']);
});

test('balance: the open amount in whole dollars, as the desktop Status cell says it', () => {
  const [c] = groupShiftRows([row({ proposal_total: '937.50', proposal_amount_paid: '100.00' })]);
  expect(c.balance).toBe('$838');
  const [d] = groupShiftRows([row({ proposal_total: '420', proposal_amount_paid: null, amount_paid: '350' })]);
  expect(d.balance).toBe('$70');
});

test('balance: none when paid in full, overpaid, cancelled, manual, or with no total', () => {
  const bal = (over) => groupShiftRows([row(over)])[0].balance;
  expect(bal({ proposal_total: '500', proposal_amount_paid: '500' })).toBeNull();
  expect(bal({ proposal_total: '500', proposal_amount_paid: '600' })).toBeNull();
  expect(bal({ proposal_total: '500', proposal_amount_paid: '100', proposal_status: 'archived' })).toBeNull();
  expect(bal({ proposal_total: '500', proposal_amount_paid: '100', status: 'cancelled' })).toBeNull();
  expect(bal({ proposal_total: '0', proposal_amount_paid: '0' })).toBeNull();
  expect(bal({ proposal_total: null })).toBeNull();
  expect(bal({ id: 3, proposal_id: null, event_key: null, proposal_total: '500', proposal_amount_paid: '0' })).toBeNull();
});

test('balance: one cancelled shift of a two-shift event does not hide it', () => {
  const [c] = groupShiftRows([
    row({ status: 'cancelled', proposal_total: '800', proposal_amount_paid: '100' }),
    row({ id: 2, proposal_total: '800', proposal_amount_paid: '100' }),
  ]);
  expect(c.cancelled).toBe(false);
  expect(c.balance).toBe('$700');
});

test('cancelled: every shift cancelled or the proposal archived, and open/pending zero out', () => {
  const [c] = groupShiftRows([row({ status: 'cancelled', approved_count: 1 })]);
  expect(c).toMatchObject({ cancelled: true, open: 0, pending: 0, filled: 1 });
  const [d] = groupShiftRows([row({ proposal_status: 'archived' })]);
  expect(d.cancelled).toBe(true);
});

test('an empty roster counts as one slot (neededCount law) and full is filled >= slots', () => {
  const [c] = groupShiftRows([row({ positions_needed: '[]', approved_count: 1, pending_count: 0 })]);
  expect(c).toMatchObject({ slots: 1, filled: 1, open: 0, full: true });
});

test('isToday follows the caller clock and railParts formats the rail', () => {
  const [c] = groupShiftRows([row()], { todayYmd: '2026-08-15' });
  expect(c.isToday).toBe(true);
  expect(railParts('2026-08-14')).toEqual({ dow: 'FRI', day: '14', mon: 'AUG' });
  expect(railParts('2026-09-05')).toEqual({ dow: 'SAT', day: '05', mon: 'SEP' });
});

test('filled never exceeds slots and feed order is preserved', () => {
  const cards = groupShiftRows([row({ id: 9, proposal_id: 99, event_key: 'p99', approved_count: 5 }), row()]);
  expect(cards.map(c => c.key)).toEqual(['p99', 'p10']);
  expect(cards[0].filled).toBe(3);
});

// The list counts BY ROLE, the event detail's rule, so the two fractions agree
// (Dallas, 2026-09-30): an extra bartender never fills an open barback slot.
describe('staffing is counted by role', () => {
  const mixed = '["Bartender","Bartender","Barback"]';

  test('an over-filled role does not fill another role\'s open slot', () => {
    const [c] = groupShiftRows([row({ positions_needed: mixed, approved_count: 3, approved_by_role: { Bartender: 3 } })]);
    expect(c).toMatchObject({ slots: 3, filled: 2, open: 1, full: false });
  });

  test('an approval in a role the roster never declared fills nothing', () => {
    const [c] = groupShiftRows([row({ positions_needed: '["Bartender"]', approved_count: 1, approved_by_role: { Barback: 1 } })]);
    expect(c).toMatchObject({ slots: 1, filled: 0, open: 1 });
  });

  test('an approval with no role on file takes the first role with room', () => {
    // approved_by_role counts only rows with a role; the one missing is roleless.
    const [c] = groupShiftRows([row({ positions_needed: mixed, approved_count: 3, approved_by_role: { Bartender: 2 } })]);
    expect(c).toMatchObject({ slots: 3, filled: 3, open: 0, full: true });
    // A role text this app cannot read counts as roleless too.
    const [d] = groupShiftRows([row({ positions_needed: mixed, approved_count: 3, approved_by_role: '{"Bartender":2,"mixologist":1}' })]);
    expect(d).toMatchObject({ filled: 3, open: 0 });
  });

  test('a row with no aggregate lands every approval on the roster in order', () => {
    const [c] = groupShiftRows([row({ positions_needed: mixed, approved_count: 2 })]);
    expect(c).toMatchObject({ slots: 3, filled: 2, open: 1 });
  });

  test('a cancelled shift leaves the sum of a live event, as on the detail', () => {
    const [c] = groupShiftRows([
      row({ id: 1, positions_needed: '["Bartender","Bartender"]', approved_count: 2, approved_by_role: { Bartender: 2 } }),
      row({ id: 2, status: 'cancelled', positions_needed: '["Barback"]', approved_count: 0, start_time: '12:00' }),
    ]);
    expect(c).toMatchObject({ cancelled: false, slots: 2, filled: 2, open: 0, full: true });
  });

  test('the list and the phone staffing card give one event the same fraction', () => {
    const shift = { id: 1, positions_needed: mixed, status: 'open' };
    const requests = [
      { request_id: 1, user_id: 1, name: 'A', status: 'approved', position: 'Bartender' },
      { request_id: 2, user_id: 2, name: 'B', status: 'approved', position: 'Bartender' },
      { request_id: 3, user_id: 3, name: 'C', status: 'approved', position: 'Bartender' },
      { request_id: 4, user_id: 4, name: 'D', status: 'approved', position: null },
    ];
    const view = buildShiftView(shift, requests);
    const [card] = groupShiftRows([row({ positions_needed: mixed, approved_count: 4, approved_by_role: { Bartender: 3 } })]);
    expect(`${card.filled}/${card.slots}`).toBe(view.count);
    expect(view.count).toBe('3/3');
  });
});

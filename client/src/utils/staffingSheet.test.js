import '@testing-library/jest-dom';
import {
  initialsOf, staffMeta, normalizeRequest, buildShiftView, roleStep, candidatesOf, confirmCopy, READ_ONLY_NOTE,
} from './staffingSheet';

const shift = (over = {}) => ({
  id: 17, status: 'open', proposal_status: 'deposit_paid', finished: false,
  positions_needed: '["Bartender","Bartender","Bartender"]', ...over,
});
// A detail-shaped request row (sr.* plus staff_name).
const req = (id, over = {}) => ({
  id, user_id: 100 + id, staff_name: `Person ${id}`, status: 'pending', position: null, dropped_at: null,
  requested_positions: '["Bartender"]', home_distance_miles: 6.8, events_worked: 14, ...over,
});
const approved = (id, role = 'Bartender', over = {}) => req(id, { status: 'approved', position: role, ...over });

describe('staffMeta', () => {
  test('both facts', () => {
    expect(staffMeta({ eventsWorked: 14, miles: 6.8 })).toBe('14 events · 7 mi');
  });
  test('staffMeta omits what is missing', () => {
    expect(staffMeta({ eventsWorked: 14, miles: null })).toBe('14 events');
    expect(staffMeta({ eventsWorked: null, miles: 2 })).toBe('2 mi');
    expect(staffMeta({ eventsWorked: 14, miles: undefined })).toBe('14 events');
    expect(staffMeta({ eventsWorked: 14, miles: '' })).toBe('14 events');
    expect(staffMeta({ eventsWorked: 14, miles: 'far' })).toBe('14 events');
    expect(staffMeta({ eventsWorked: 14, miles: '  ' })).toBe('14 events');
    expect(staffMeta({ eventsWorked: 14, miles: [] })).toBe('14 events');
    expect(staffMeta({ eventsWorked: true, miles: false })).toBe('');
    expect(staffMeta({ eventsWorked: '14', miles: '6.8' })).toBe('14 events · 7 mi');
    expect(staffMeta({ eventsWorked: undefined, miles: undefined })).toBe('');
    expect(staffMeta({})).toBe('');
    expect(staffMeta()).toBe('');
  });
  test('zero is a fact, one is singular, zero miles is a distance', () => {
    expect(staffMeta({ eventsWorked: 0, miles: null })).toBe('0 events');
    expect(staffMeta({ eventsWorked: 1, miles: null })).toBe('1 event');
    expect(staffMeta({ eventsWorked: 3, miles: 0 })).toBe('3 events · 0 mi');
    // Whole miles, always: a tenth of a mile to ten venues places a home to the block.
    expect(staffMeta({ eventsWorked: 3, miles: 6.44 })).toBe('3 events · 6 mi');
    expect(staffMeta({ eventsWorked: 3, miles: 0.3 })).toBe('3 events · 0 mi');
  });
});

test('initialsOf takes two letters and survives an empty name', () => {
  expect(initialsOf('Lena Park')).toBe('LP');
  expect(initialsOf('  mara  de la reyes ')).toBe('MD');
  expect(initialsOf('Sam')).toBe('S');
  expect(initialsOf('')).toBe('?');
  expect(initialsOf(null)).toBe('?');
});

test('normalizeRequest reads a detail row and a by-proposal requester alike', () => {
  const a = normalizeRequest(req(3));
  const b = normalizeRequest({ request_id: 3, user_id: 103, name: 'Person 3', status: 'pending', position: null,
    dropped_at: null, requested_positions: ['Bartender'], home_distance_miles: 6.8, events_worked: 14 });
  expect(a).toEqual(b);
  expect(a).toEqual({ requestId: 3, userId: 103, name: 'Person 3', status: 'pending', position: null,
    dropped: false, rankedRoles: ['Bartender'], miles: 6.8, eventsWorked: 14, coverFor: null, strayRole: null });
  expect(normalizeRequest(req(4, { replaced_by_request_id: 9 })).coverFor).toBe(9);
  expect(normalizeRequest(req(5, { position: 'barback' }))).toMatchObject({ position: 'Barback', strayRole: null });
  expect(normalizeRequest(req(6, { position: ' Sommelier ' }))).toMatchObject({ position: null, strayRole: 'Sommelier' });
  expect(normalizeRequest(req(7, { position: '   ' }))).toMatchObject({ position: null, strayRole: null });
});

describe('buildShiftView', () => {
  test('two of three filled, one applicant for the open slot', () => {
    const v = buildShiftView(shift(), [approved(2, 'Bartender', { staff_name: 'Sam Ortiz' }), approved(1, 'Bartender', { staff_name: 'Lena Park' }), req(3)]);
    expect(v).toMatchObject({ shiftId: 17, slots: 3, filled: 2, open: 1, full: false, count: '2/3', rosterless: false, closedReason: null });
    expect(v.openRoles).toEqual([{ role: 'Bartender', open: 1 }]);
    expect(v.openLabel).toBe('Bartender × 1');
    expect(v.mix).toBe('Bartender 2/3');
    expect(v.rolesLabel).toBe('Bartenders');
    expect(v.pills).toEqual(['filled', 'filled', 'pending']);
    expect(v.rows.map((r) => [r.name, r.kind])).toEqual([['Lena Park', 'rostered'], ['Sam Ortiz', 'rostered'], ['Person 3', 'applicant']]);
    expect(v.rows[0].meta).toBe('Bartender');
    expect(v.rows[2].meta).toBe('Bartender · 14 events · 7 mi');
    expect(v.rows[2].resolvableRole).toBe('Bartender');
  });

  test('a rostered person who was just assigned says so', () => {
    const v = buildShiftView(shift(), [approved(1)], { justAssigned: [101] });
    expect(v.rows[0].meta).toBe('Bartender · just assigned');
    expect(buildShiftView(shift(), [approved(1)], { justAssigned: ['101'] }).rows[0].meta).toBe('Bartender · just assigned');
    expect(buildShiftView(shift(), [approved(1)], { justAssigned: null }).rows[0].meta).toBe('Bartender');
  });

  test('an approved request with dropped_at set is NOT on the roster and does not fill a slot', () => {
    const v = buildShiftView(shift(), [approved(1), approved(2, 'Bartender', { dropped_at: '2026-09-01T00:00:00Z' })]);
    expect(v.filled).toBe(1);
    expect(v.open).toBe(2);
    expect(v.rows.map((r) => r.requestId)).toEqual([1]);
  });

  test('an approval with no role on file still fills a slot, so the phone never offers it again', () => {
    const s = shift({ positions_needed: '["Bartender","Bartender"]' });
    const v = buildShiftView(s, [approved(1, 'Bartender'), approved(2, null)]);
    expect(v).toMatchObject({ slots: 2, filled: 2, open: 0, full: true, count: '2/2', mix: 'Bartender 2/2' });
    expect(v.openRoles).toEqual([]);
    expect(v.rows.map((r) => [r.requestId, r.meta])).toEqual([[1, 'Bartender'], [2, 'Staff']]);
    // Two roles: the unplaced approval takes the first one with room.
    const two = buildShiftView(shift({ positions_needed: '["Bartender","Barback"]' }), [approved(1, 'Bartender'), approved(2, 'not a role')]);
    expect(two.openRoles).toEqual([]);
    expect(two.mix).toBe('Bartender 1/1 · Barback 1/1');
  });

  test('an approved role the roster never declared does not fill a declared slot (desktop parity)', () => {
    const v = buildShiftView(shift({ positions_needed: '["Bartender","Bartender"]' }), [approved(1, 'Barback')]);
    expect(v).toMatchObject({ filled: 0, open: 2, count: '0/2' });
    expect(v.rows[0].meta).toBe('Barback');
  });

  test('a denied request is not a row', () => {
    const v = buildShiftView(shift(), [req(1, { status: 'denied' }), req(2)]);
    expect(v.rows.map((r) => r.requestId)).toEqual([2]);
  });

  test('an applicant whose ranked roles are all full is waitlisted, after the actionable ones', () => {
    const s = shift({ positions_needed: '["Bartender","Barback"]' });
    const v = buildShiftView(s, [
      approved(1, 'Bartender'),
      req(2, { requested_positions: '["Bartender"]' }),
      req(3, { requested_positions: '["Barback","Bartender"]' }),
    ]);
    expect(v.openRoles).toEqual([{ role: 'Barback', open: 1 }]);
    expect(v.mix).toBe('Bartender 1/1 · Barback 0/1');
    expect(v.rolesLabel).toBe('Bartenders + Barbacks');
    expect(v.rows.map((r) => [r.requestId, r.kind])).toEqual([[1, 'rostered'], [3, 'applicant'], [2, 'waitlisted']]);
    expect(v.rows[1].meta).toBe('Barback › Bartender · 14 events · 7 mi');
    expect(v.pills).toEqual(['filled', 'pending']);
  });

  test('an empty or unparseable ranked list reads "Any role" and classifies like the desktop', () => {
    const v = buildShiftView(shift(), [req(1, { requested_positions: '[]' }), req(2, { requested_positions: 'not json' }), req(3, { requested_positions: null })]);
    v.rows.forEach((r) => {
      expect(r.kind).toBe('applicant');
      expect(r.resolvableRole).toBe('Bartender');
      expect(r.meta).toBe('Any role · 14 events · 7 mi');
    });
  });

  test('a pending row that carries a role asked for that role, never "Any role"', () => {
    const s = shift({ positions_needed: '["Bartender","Bartender","Barback"]' });
    const v = buildShiftView(s, [
      approved(1, 'Bartender'),
      approved(2, 'Barback', { staff_name: 'Lena Park', cover_requested_at: '2026-09-20T15:00:00Z' }),
      req(3, { position: 'Barback', requested_positions: '[]', replaced_by_request_id: 2 }),
      req(4, { position: 'barback', requested_positions: null }),
      req(5, { position: 'Bartender', requested_positions: '[]', replaced_by_request_id: 77 }),
      req(6, { position: 'Sommelier', requested_positions: '[]' }),
    ]);
    expect(v.openRoles).toEqual([{ role: 'Bartender', open: 1 }]);
    const row = (id) => v.rows.find((r) => r.requestId === id);
    // A cover claim for a full role waits, and says whose cover it is.
    expect(row(3)).toMatchObject({ kind: 'waitlisted', resolvableRole: null, coverFor: 2 });
    expect(row(3).meta).toBe('Covering Lena Park · Barback · 14 events · 7 mi');
    // The same row without the cover link (a by-proposal requester) classifies the same.
    expect(row(4)).toMatchObject({ kind: 'waitlisted', resolvableRole: null, coverFor: null });
    expect(row(4).meta).toBe('Barback · 14 events · 7 mi');
    // A claim for an open role is actionable into THAT role; an unknown original still reads.
    expect(row(5)).toMatchObject({ kind: 'applicant', resolvableRole: 'Bartender' });
    expect(row(5).meta).toBe('Covering a teammate · Bartender · 14 events · 7 mi');
    // Text that is not a role this app knows is still a commitment: it waits.
    expect(row(6)).toMatchObject({ kind: 'waitlisted', resolvableRole: null, position: null, strayRole: 'Sommelier' });
    expect(row(6).meta).toBe('Sommelier · 14 events · 7 mi');
    expect(v.pills).toEqual(['filled', 'filled', 'pending']);
  });

  test('an over-filled role never yields a negative open count or a fraction above the slots', () => {
    const s = shift({ positions_needed: '["Bartender","Bartender"]' });
    const v = buildShiftView(s, [approved(1), approved(2), approved(3)]);
    expect(v).toMatchObject({ slots: 2, filled: 2, open: 0, full: true, count: '2/2' });
    expect(v.openRoles).toEqual([]);
  });

  test('the legacy object-shaped roster expands to its count', () => {
    const v = buildShiftView(shift({ positions_needed: '[{"position":"bartender","count":2}]' }), []);
    expect(v).toMatchObject({ slots: 2, open: 2, count: '0/2' });
    expect(v.openRoles).toEqual([{ role: 'Bartender', open: 2 }]);
  });

  test('a shift with no declared roles is rosterless: one slot by law, nothing approvable', () => {
    const v = buildShiftView(shift({ positions_needed: '[]' }), [req(1)]);
    expect(v).toMatchObject({ rosterless: true, slots: 1, filled: 0, open: 1, count: '0/1', mix: '', rolesLabel: 'Staff' });
    expect(v.openRoles).toEqual([]);
    expect(v.rows[0].kind).toBe('waitlisted');
    expect(roleStep(v, v.rows[0])).toEqual({ kind: 'blocked' });
  });

  test('closedReason: finished is past; a cancelled shift or an archived proposal is cancelled and wins', () => {
    expect(buildShiftView(shift({ finished: true }), []).closedReason).toBe('past');
    expect(buildShiftView(shift({ status: 'cancelled' }), []).closedReason).toBe('cancelled');
    expect(buildShiftView(shift({ proposal_status: 'archived' }), []).closedReason).toBe('cancelled');
    expect(buildShiftView(shift({ status: 'cancelled', finished: true }), []).closedReason).toBe('cancelled');
  });

  test('null inputs do not throw', () => {
    expect(buildShiftView(null, null)).toMatchObject({ rosterless: true, rows: [], slots: 1 });
  });
});

describe('roleStep: the role that will be written is always one the screen showed', () => {
  const twoRoles = shift({ positions_needed: '["Bartender","Barback"]' });

  test('nothing open blocks everyone', () => {
    const v = buildShiftView(shift({ positions_needed: '["Bartender"]' }), [approved(1), req(2)]);
    expect(roleStep(v, v.rows[1])).toEqual({ kind: 'blocked' });
    expect(roleStep(v, { kind: 'candidate' })).toEqual({ kind: 'blocked' });
  });

  test('an applicant with exactly one open role, which they ranked, approves directly into it', () => {
    const v = buildShiftView(shift(), [req(1)]);
    expect(roleStep(v, v.rows[0])).toEqual({ kind: 'direct', role: 'Bartender' });
  });

  test('an "Any role" applicant with no role on file approves directly into the one open role', () => {
    const v = buildShiftView(twoRoles, [approved(1, 'Bartender'), req(2, { position: null, requested_positions: '[]' })]);
    expect(v.rows[1]).toMatchObject({ kind: 'applicant', resolvableRole: 'Barback' });
    expect(roleStep(v, v.rows[1])).toEqual({ kind: 'direct', role: 'Barback' });
  });

  test('a cover claim never takes one tap into a role the claimer did not commit to', () => {
    // Roster Bartender, Bartender, Barback. The Barback slot is held by the
    // teammate being covered, so the only open role is Bartender.
    const s = shift({ positions_needed: '["Bartender","Bartender","Barback"]' });
    const v = buildShiftView(s, [
      approved(1, 'Bartender'),
      approved(2, 'Barback'),
      req(3, { position: 'Barback', requested_positions: '[]', replaced_by_request_id: 2 }),
    ]);
    expect(roleStep(v, v.rows[2])).toEqual({ kind: 'pick', roles: [{ role: 'Bartender', open: 1 }] });
  });

  test('a cover claim is read by the role written on it, not by a ranked list left from an older request', () => {
    // The claimer once asked for Bartender on this shift; the claim says Barback.
    const s = shift({ positions_needed: '["Bartender","Bartender","Barback"]' });
    const v = buildShiftView(s, [
      approved(1, 'Bartender'),
      approved(2, 'Barback', { staff_name: 'Lena Park' }),
      req(3, { position: 'Barback', requested_positions: '["Bartender"]', replaced_by_request_id: 2 }),
    ]);
    expect(v.openRoles).toEqual([{ role: 'Bartender', open: 1 }]);
    expect(v.rows[2]).toMatchObject({ kind: 'waitlisted', resolvableRole: null });
    expect(v.rows[2].meta).toBe('Covering Lena Park · Barback · 14 events · 7 mi');
    expect(roleStep(v, v.rows[2])).toEqual({ kind: 'pick', roles: [{ role: 'Bartender', open: 1 }] });
  });

  test('a row that was reset to pending keeps its ranked list: the list wins over the old role', () => {
    const v = buildShiftView(twoRoles, [req(1, { position: 'Barback', requested_positions: '["Bartender"]' })]);
    expect(v.rows[0]).toMatchObject({ kind: 'applicant', resolvableRole: 'Bartender' });
    expect(v.rows[0].meta).toBe('Bartender · 14 events · 7 mi');
  });

  test('role text this app cannot read never takes one tap', () => {
    const v = buildShiftView(shift(), [req(1, { position: 'Sommelier', requested_positions: '[]' })]);
    expect(v.openRoles).toEqual([{ role: 'Bartender', open: 3 }]);
    expect(roleStep(v, v.rows[0])).toEqual({ kind: 'pick', roles: [{ role: 'Bartender', open: 3 }] });
  });

  test('a row that carries a role and a ranked list that resolves elsewhere always picks', () => {
    // The two-step swap: the covered teammate was removed, which clears the
    // claim's link. The claim wrote Barback; the list left from an older
    // request says Bartender, and Bartender is the one open role.
    const s = shift({ positions_needed: '["Bartender","Barback"]' });
    const v = buildShiftView(s, [
      approved(9, 'Barback'),
      req(3, { position: 'Barback', requested_positions: '["Bartender"]', replaced_by_request_id: null }),
    ]);
    expect(v.openRoles).toEqual([{ role: 'Bartender', open: 1 }]);
    expect(v.rows[1]).toMatchObject({ kind: 'applicant', resolvableRole: 'Bartender', unsure: true });
    expect(roleStep(v, v.rows[1])).toEqual({ kind: 'pick', roles: [{ role: 'Bartender', open: 1 }] });
    // The same row whose list resolves to its own role says one thing.
    const agree = buildShiftView(s, [approved(9, 'Barback'), req(3, { position: 'Bartender', requested_positions: '["Bartender"]' })]);
    expect(agree.rows[1].unsure).toBe(false);
    expect(roleStep(agree, agree.rows[1])).toEqual({ kind: 'direct', role: 'Bartender' });
  });

  test('a cover link on a row with NO role changes nothing: the ranked list is the request', () => {
    // An ordinary re-request after a claim keeps the old link (the re-request
    // upsert does not clear it) and nulls the role.
    const s = shift({ positions_needed: '["Bartender","Barback"]' });
    const v = buildShiftView(s, [
      approved(9, 'Barback'),
      req(3, { position: null, requested_positions: '["Barback"]', replaced_by_request_id: 77 }),
    ]);
    expect(v.rows[1]).toMatchObject({ kind: 'waitlisted', resolvableRole: null, unsure: false });
    expect(v.rows[1].meta).toBe('Covering a teammate · Barback · 14 events · 7 mi');
    expect(roleStep(v, v.rows[1])).toEqual({ kind: 'pick', roles: [{ role: 'Bartender', open: 1 }] });
  });

  test('two open roles pick even when the applicant ranked the first of them', () => {
    const v = buildShiftView(twoRoles, [req(1, { requested_positions: '["Bartender"]' })]);
    expect(v.rows[0].resolvableRole).toBe('Bartender');
    expect(roleStep(v, v.rows[0]).kind).toBe('pick');
  });

  test('a cover claim for the one open role approves directly into the role it committed to', () => {
    // The original was removed first, which is how a swap is done by hand.
    const s = shift({ positions_needed: '["Bartender","Barback"]' });
    const v = buildShiftView(s, [
      approved(1, 'Bartender'),
      req(3, { position: 'Barback', requested_positions: '[]', replaced_by_request_id: 2 }),
    ]);
    expect(roleStep(v, v.rows[1])).toEqual({ kind: 'direct', role: 'Barback' });
  });

  test('a row built from an older roster picks: its role is no longer the one open role', () => {
    const before = buildShiftView(twoRoles, [approved(1, 'Bartender'), req(2, { requested_positions: '["Barback"]' })]);
    const stale = before.rows[1];
    expect(stale.resolvableRole).toBe('Barback');
    const now = buildShiftView(twoRoles, [approved(9, 'Barback'), req(2, { requested_positions: '["Barback"]' })]);
    expect(now.openRoles).toEqual([{ role: 'Bartender', open: 1 }]);
    expect(roleStep(now, stale)).toEqual({ kind: 'pick', roles: [{ role: 'Bartender', open: 1 }] });
  });

  test('an applicant with two open roles picks', () => {
    const v = buildShiftView(twoRoles, [req(1, { requested_positions: '["Barback","Bartender"]' })]);
    expect(roleStep(v, v.rows[0])).toEqual({ kind: 'pick', roles: [{ role: 'Bartender', open: 1 }, { role: 'Barback', open: 1 }] });
  });

  test('a waitlisted applicant picks even when only one role is open: it is a role they did not ask for', () => {
    const v = buildShiftView(twoRoles, [approved(1, 'Bartender'), req(2, { requested_positions: '["Bartender"]' })]);
    expect(v.rows[1].kind).toBe('waitlisted');
    expect(roleStep(v, v.rows[1])).toEqual({ kind: 'pick', roles: [{ role: 'Barback', open: 1 }] });
  });

  test('a candidate always picks, even with one open role', () => {
    const v = buildShiftView(shift(), []);
    expect(roleStep(v, { kind: 'candidate' })).toEqual({ kind: 'pick', roles: [{ role: 'Bartender', open: 3 }] });
  });

  test('a closed shift blocks everyone even with open roles', () => {
    const v = buildShiftView(shift({ finished: true }), [req(1)]);
    expect(v.openRoles.length).toBe(1);
    expect(roleStep(v, v.rows[0])).toEqual({ kind: 'blocked' });
    expect(roleStep(v, { kind: 'candidate' })).toEqual({ kind: 'blocked' });
  });

  test('every role a step can return is canonical', () => {
    const v = buildShiftView(shift({ positions_needed: '["bartender","server","BARBACK"]' }), [req(1, { requested_positions: '["server"]' })]);
    const step = roleStep(v, v.rows[0]);
    expect(step.kind).toBe('pick');
    expect(step.roles.map((r) => r.role)).toEqual(['Bartender', 'Banquet Server', 'Barback']);
  });
});

describe('candidatesOf', () => {
  const staff = [
    { id: 9, display_name: 'Tess Marsh', events_worked: 9, home_distance_miles: 8.1 },
    { id: 5, display_name: null, preferred_name: 'Ana Flores', events_worked: 33, home_distance_miles: null },
    { id: 101, display_name: 'Person 1', events_worked: 1, home_distance_miles: 1 },
    { id: 7, display_name: null, preferred_name: null, email: 'zed@example.com' },
  ];
  const view = buildShiftView(shift(), [approved(1)]);

  test('alphabetical, without anyone already on the shift, with plain meta', () => {
    const c = candidatesOf(staff, view, '');
    expect(c.map((x) => x.name)).toEqual(['Ana Flores', 'Tess Marsh', 'zed@example.com']);
    expect(c[0]).toMatchObject({ key: 'c5', kind: 'candidate', userId: 5, initials: 'AF', meta: '33 events' });
    expect(c[1].meta).toBe('9 events · 8 mi');
    expect(c[2].meta).toBe('');
  });

  test('search is case-insensitive and trims', () => {
    expect(candidatesOf(staff, view, '  tESS ').map((x) => x.name)).toEqual(['Tess Marsh']);
    expect(candidatesOf(staff, view, 'nobody')).toEqual([]);
  });

  test('a person whose request was denied or dropped is a candidate again', () => {
    const v = buildShiftView(shift(), [req(1, { status: 'denied' })]);
    expect(candidatesOf(staff, v, '').map((x) => x.userId)).toContain(101);
  });

  test('a missing staff list is an empty list', () => {
    expect(candidatesOf(null, view, '')).toEqual([]);
  });
});

test('confirmCopy names the consequences and never promises a notification', () => {
  expect(confirmCopy('remove', 'Lena Park')).toEqual({
    copy: 'Remove Lena Park from this shift? Payroll re-accrues and any out-of-area lock is released. They are not notified.',
    label: 'Remove',
  });
  const deny = confirmCopy('deny', 'Jo Ellis');
  expect(deny).toEqual({ copy: 'Deny Jo Ellis’s application? The request closes. They are not notified.', label: 'Deny' });
  expect(deny.copy).not.toMatch(/are notified and/);
  expect(() => confirmCopy('approve', 'Jo Ellis')).toThrow('confirmCopy: unknown kind "approve"');
  expect(() => confirmCopy(undefined, 'Jo Ellis')).toThrow();
});

test('the read-only notes carry no dash glyph', () => {
  expect(READ_ONLY_NOTE).toEqual({
    cancelled: 'Cancelled · roster is read-only',
    past: 'Past event · roster is read-only',
    rosterless: 'No roles are declared on this shift. Staff it from desktop view.',
  });
});

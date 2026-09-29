import '@testing-library/jest-dom';
import {
  headerOf, whenOf, setupOf, contactsOf, staffingOf, financialsOf, earliestStale, closedWord,
} from './eventDetailView';
import { railParts } from './eventCards';
import { ctDay } from '../components/adminos/format';

const proposal = (over = {}) => ({
  id: 13, status: 'deposit_paid', client_name: 'Alexis Henderson', client_phone: '3125550184',
  client_email: 'alexis.hend@gmail.com', event_type: 'wedding-reception', event_type_custom: null,
  event_date: '2999-08-15T00:00:00.000Z', event_start_time: '18:00', event_duration_hours: '5',
  event_location: 'Grove on the River, 12 River Rd, Rockford, Illinois 61101',
  venue_street: '12 River Rd', venue_city: 'Rockford', venue_state: 'Illinois', venue_zip: '61101',
  guest_count: 140, setup_time_display: '17:15', setup_minutes_before: null,
  total_price: '3650.00', amount_paid: '1900.00', balance_due_date: '2999-08-08',
  package_name: 'Signature bar',
  pricing_snapshot: { total: 3650, breakdown: [
    { label: 'Signature bar', amount: 2800 },
    { label: 'Mobile bar rental', amount: 450 },
    { label: 'Loyalty discount', amount: -50 },
    { label: 'Champagne service', amount: 450.5 },
  ] },
  ...over,
});
const shift = (id, over = {}) => ({
  id, status: 'open', finished: false, event_date: '2999-08-15', start_time: '18:00',
  positions_needed: '["Bartender","Bartender"]', requesters: [], ...over,
});
const person = (id, over = {}) => ({
  request_id: id, user_id: 100 + id, name: `Person ${id}`, status: 'approved', position: 'Bartender',
  dropped_at: null, requested_positions: '["Bartender"]', home_distance_miles: 2.4, events_worked: 87, ...over,
});

describe('headerOf', () => {
  test('client, kind, guests, venue and an address-only map query', () => {
    expect(headerOf(proposal())).toEqual({
      title: 'Alexis Henderson',
      kind: 'Wedding Reception',
      guests: 140,
      venue: 'Grove on the River, 12 River Rd, Rockford, Illinois 61101',
      mapHref: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('12 River Rd, Rockford, Illinois 61101')}`,
    });
  });
  test('a legacy free-text location is its own map query', () => {
    const h = headerOf(proposal({ venue_street: null, venue_city: null, venue_state: null, venue_zip: null, event_location: 'The Whistler' }));
    expect(h.mapHref).toBe(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('The Whistler')}`);
  });
  test('no location, no link; no name, a plain title; no guests, null', () => {
    const h = headerOf(proposal({ event_location: '  ', venue_street: null, client_name: null, guest_count: null }));
    expect(h).toMatchObject({ title: 'Event', venue: '', mapHref: null, guests: null });
  });
});

describe('whenOf', () => {
  const rail = railParts('2999-08-15');
  test('date and the 24h range with its duration', () => {
    expect(whenOf(proposal(), { todayYmd: '2999-08-01' })).toEqual({ text: `${rail.dow} ${rail.mon} ${rail.day} · 18:00–23:00 · 5h`, isToday: false });
  });
  test('today is flagged by the Chicago day the caller passes', () => {
    expect(whenOf(proposal(), { todayYmd: '2999-08-15' }).isToday).toBe(true);
  });
  test('another year says so, because the rail has no year', () => {
    expect(whenOf(proposal(), { todayYmd: '2998-12-30' }).text).toBe(`${rail.dow} ${rail.mon} ${rail.day} 2999 · 18:00–23:00 · 5h`);
  });
  test('no start time leaves the date alone; no date leaves the time alone; neither is empty', () => {
    expect(whenOf(proposal({ event_start_time: null }), { todayYmd: '2999-08-01' }).text).toBe(`${rail.dow} ${rail.mon} ${rail.day}`);
    expect(whenOf(proposal({ event_date: null }), { todayYmd: '2999-08-01' })).toEqual({ text: '18:00–23:00 · 5h', isToday: false });
    // A date that cannot be read is no date, and it is not today.
    expect(whenOf(proposal({ event_date: '2999-13-45' }), { todayYmd: '2999-08-01' })).toEqual({ text: '18:00–23:00 · 5h', isToday: false });
  });
  test('today is Chicago today on a phone set to another zone', () => {
    const zone = process.env.TZ;
    process.env.TZ = 'UTC';
    jest.useFakeTimers().setSystemTime(new Date('2999-08-16T03:30:00Z'));   // 22:30 on the 15th in Chicago
    try {
      expect(whenOf(proposal()).isToday).toBe(true);
      jest.setSystemTime(new Date('3000-01-01T03:00:00Z'));                  // still Dec 31 2999 in Chicago
      const eve = whenOf(proposal({ event_date: '2999-12-31' }));
      expect(eve.isToday).toBe(true);
      expect(eve.text).not.toMatch(/2999/);
    } finally {
      jest.useRealTimers();
      if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    }
  });
  test('with no day passed, today and the year are the Chicago day, not the phone clock', () => {
    const today = ctDay(new Date());
    const rail = railParts(today);
    expect(whenOf(proposal({ event_date: today }))).toEqual({ text: `${rail.dow} ${rail.mon} ${rail.day} · 18:00–23:00 · 5h`, isToday: true });
    expect(whenOf(proposal()).text).toMatch(/ 2999 · 18:00/);
    expect(whenOf(proposal({ event_date: null, event_start_time: null })).text).toBe('');
  });
});

describe('setupOf', () => {
  test('the server clock time plus how long before service that is', () => {
    expect(setupOf(proposal())).toBe('from 17:15 · 45 min before');
    expect(setupOf(proposal({ setup_time_display: '16:30' }))).toBe('from 16:30 · 90 min before');
  });
  test('a 12h start time still yields the gap', () => {
    expect(setupOf(proposal({ event_start_time: '6:00 PM', setup_time_display: '17:00' }))).toBe('from 17:00 · 60 min before');
  });
  test('setup before midnight for a service after it', () => {
    expect(setupOf(proposal({ event_start_time: '00:30', setup_time_display: '23:30' }))).toBe('from 23:30 · 60 min before');
  });
  test('no setup time, no line; an unreadable start, the time alone', () => {
    expect(setupOf(proposal({ setup_time_display: null }))).toBeNull();
    expect(setupOf(proposal({ event_start_time: 'evening' }))).toBe('from 17:15');
  });
});

describe('contactsOf', () => {
  const dayOf = (name, phone) => ({ day_of_contact: { name, phone } });

  test('client phone and email become tap targets', () => {
    const c = contactsOf(proposal(), null);
    expect(c.client).toEqual({
      phone: '(312) 555-0184', telHref: 'tel:3125550184', smsHref: 'sms:3125550184',
      email: 'alexis.hend@gmail.com', mailHref: 'mailto:alexis.hend@gmail.com',
    });
    expect(c.dayOf).toBeNull();
    expect(c.summary).toBe('day-of pending');
  });
  test('the day-of contact comes from the projection, name and phone only', () => {
    const c = contactsOf(proposal(), dayOf(' Marcus Keller ', '(312) 555-0142'));
    expect(c.dayOf).toEqual({ name: 'Marcus Keller', phone: '(312) 555-0142', telHref: 'tel:3125550142', smsHref: 'sms:3125550142' });
    expect(c.summary).toBe('day-of set');
  });
  test('a day-of phone stored as bare digits is shown formatted, like the client number', () => {
    const c = contactsOf(proposal(), dayOf('Marcus Keller', '3125550142'));
    expect(c.dayOf).toEqual({ name: 'Marcus Keller', phone: '(312) 555-0142', telHref: 'tel:3125550142', smsHref: 'sms:3125550142' });
  });
  test('a day-of contact with a name and no phone has no links', () => {
    const c = contactsOf(proposal(), dayOf('Priya Shah', ''));
    expect(c.dayOf).toEqual({ name: 'Priya Shah', phone: '', telHref: null, smsHref: null });
  });
  test('an empty name means no day-of contact, whatever else is there', () => {
    for (const body of [
      dayOf('  ', '3125550142'), dayOf(null, '3125550142'), { day_of_contact: null }, { day_of_contact: 'Marcus' },
      {}, null, undefined, 'a string',
    ]) expect(contactsOf(proposal(), body).dayOf).toBeNull();
  });
  test('the full drink plan shape is NOT read: the phone takes the projection or nothing', () => {
    const fullPlan = { token: 'secret', admin_notes: 'x', selections: { logistics: { dayOfContact: { name: 'Marcus Keller', phone: '3125550142' }, accessNotes: 'gate 4471' } } };
    expect(contactsOf(proposal(), fullPlan).dayOf).toBeNull();
  });
  test('a number a phone cannot dial as written is shown as stored, with no link', () => {
    const client = (raw) => contactsOf(proposal({ client_phone: raw }), null).client;
    for (const raw of ['312-555-0142 ext 5', '3125550142 / 3125550199', '1-800-FLOWERS', '555-0142', '23125550142', '+12']) {
      expect(client(raw)).toMatchObject({ phone: raw, telHref: null, smsHref: null });
    }
    expect(client('1 (312) 555-0142')).toMatchObject({ telHref: 'tel:13125550142', smsHref: 'sms:13125550142' });
    expect(client('+1 (312) 555-0142')).toMatchObject({ phone: '(312) 555-0142', telHref: 'tel:+13125550142' });
    // + and ten digits is NOT a US number: it dials abroad, so it reads as stored.
    expect(client('+2125550142')).toMatchObject({ phone: '+2125550142', telHref: 'tel:+2125550142' });
    expect(client('312.555.0142')).toMatchObject({ phone: '(312) 555-0142', telHref: 'tel:3125550142' });
    expect(contactsOf(proposal(), dayOf('Marcus Keller', 'ask at the bar')).dayOf)
      .toEqual({ name: 'Marcus Keller', phone: 'ask at the bar', telHref: null, smsHref: null });
  });
  const client = (email) => contactsOf(proposal({ client_email: email }), null).client;
  test('an address that carries a query or a second recipient is shown and not linked', () => {
    for (const email of [
      'a@b.co?subject=Refund&body=x', 'a@b.co?bcc=evil%40x.co', 'a@b.co, c@d.co', 'a@b.co c@d.co', 'a%40b.co',
      'a@b.co;c@d.co', 'a@b.co,c@d.co', 'a@b@c.co', 'a@b', 'a@b.co\nbcc:x@y.co', 'Jo <a@b.co>',
    ]) {
      expect(client(email)).toMatchObject({ email, mailHref: null });
    }
  });
  test('a plain address is linked, and what is linked is encoded', () => {
    expect(client('alexis.hend@gmail.com').mailHref).toBe('mailto:alexis.hend@gmail.com');
    expect(client('a.b+tag@sub.example.co').mailHref).toBe('mailto:a.b+tag@sub.example.co');
    expect(client("o'brien@example.ie").mailHref).toBe("mailto:o'brien@example.ie");
    // Stored with spaces round it: shown and linked without them.
    expect(client('  a@b.co ')).toMatchObject({ email: 'a@b.co', mailHref: 'mailto:a@b.co' });
    // Real addresses the old deny list refused.
    expect(client('tom&jerry@example.com').mailHref).toBe('mailto:tom%26jerry@example.com');
    expect(client('user%dept@example.com').mailHref).toBe('mailto:user%25dept@example.com');
    // A query in the LOCAL part is part of the address, and arrives as one.
    expect(client('x?subject=hi@b.co').mailHref).toBe('mailto:x%3Fsubject%3Dhi@b.co');
  });
  test('an international number keeps its plus; a client with nothing on file has no links', () => {
    expect(contactsOf(proposal({ client_phone: '+44 20 7946 0958' }), null).client.telHref).toBe('tel:+442079460958');
    expect(contactsOf(proposal({ client_phone: null, client_email: null }), null).client)
      .toEqual({ phone: '', telHref: null, smsHref: null, email: '', mailHref: null });
  });
});

describe('staffingOf', () => {
  test('one shift: no head, the event fraction, open', () => {
    const s = staffingOf([shift(1, { requesters: [person(1)] })], proposal());
    expect(s.count).toBe('1/2');
    expect(s.state).toBe('open');
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]).toMatchObject({ shiftId: 1, showHead: false });
    expect(s.groups[0].view.rows.map((r) => r.name)).toEqual(['Person 1']);
  });
  test('two shifts on one day: a head each, told apart by time and roles', () => {
    const s = staffingOf([
      shift(1, { start_time: '16:00', positions_needed: '["Bartender","Bartender","Bartender"]', requesters: [person(1), person(2), person(3)] }),
      shift(2, { start_time: '17:00', positions_needed: '["Banquet Server"]', requesters: [] }),
    ], proposal());
    expect(s.groups.map((g) => [g.showHead, g.label])).toEqual([[true, '16:00 · Bartenders'], [true, '17:00 · Banquet Servers']]);
    expect(s.count).toBe('3/4');
    expect(s.state).toBe('open');
  });
  test('two shifts on two days carry the date in the head', () => {
    const a = railParts('2999-08-15'); const b = railParts('2999-08-16');
    const s = staffingOf([shift(1), shift(2, { event_date: '2999-08-16T00:00:00.000Z' })], proposal());
    expect(s.groups.map((g) => g.label)).toEqual([
      `${a.dow} ${a.mon} ${a.day} · 18:00 · Bartenders`, `${b.dow} ${b.mon} ${b.day} · 18:00 · Bartenders`,
    ]);
  });
  test('a shift with no date is not a day: the dated shift beside it carries no date', () => {
    const s = staffingOf([shift(1), shift(2, { event_date: null, start_time: '19:00' })], proposal());
    expect(s.groups.map((g) => g.label)).toEqual(['18:00 · Bartenders', '19:00 · Bartenders']);
  });
  test('a cancelled shift beside a live one leaves the head sum to the live one', () => {
    const s = staffingOf([
      shift(1, { status: 'cancelled', requesters: [] }),
      shift(2, { start_time: '19:00', requesters: [person(1), person(2)] }),
    ], proposal());
    expect(s).toMatchObject({ count: '2/2', state: 'full' });
    expect(s.groups[0].view.closedReason).toBe('cancelled');
  });
  test('two shifts, one finished and one open: the section is open', () => {
    const s = staffingOf([
      shift(1, { finished: true, requesters: [person(1), person(2)] }),
      shift(2, { event_date: '2999-08-16', requesters: [person(3)] }),
    ], proposal());
    expect(s).toMatchObject({ count: '3/4', state: 'open' });
  });
  test('a cover claim on the card is read as the sheet reads it: by its own role, naming who it covers', () => {
    const s = staffingOf([shift(1, { positions_needed: '["Bartender","Barback"]', requesters: [
      person(1, { position: 'Barback', name: 'Lena Park' }),
      // Claims Lena's Barback slot; the ranked list is left from an older request.
      person(2, { status: 'pending', position: 'Barback', requested_positions: '["Bartender"]', replaced_by_request_id: 1 }),
    ] })], proposal());
    const claim = s.groups[0].view.rows.find((r) => r.requestId === 2);
    // Barback is full (Lena holds it), so the claim waits. Read by its ranked
    // list it would be an applicant for the open Bartender slot.
    expect(claim).toMatchObject({ kind: 'waitlisted', coverFor: 1 });
    expect(claim.meta).toBe('Covering Lena Park · Barback · 87 events · 2 mi');
  });
  test('fully staffed', () => {
    expect(staffingOf([shift(1, { requesters: [person(1), person(2)] })], proposal())).toMatchObject({ count: '2/2', state: 'full' });
  });
  test('an archived proposal closes every shift and shows no fraction', () => {
    const s = staffingOf([shift(1, { requesters: [person(1)] })], proposal({ status: 'archived' }));
    expect(s).toMatchObject({ count: '', state: 'closed' });
    expect(s.groups[0].view.closedReason).toBe('cancelled');
  });
  test('a finished event is closed and keeps its fraction', () => {
    expect(staffingOf([shift(1, { finished: true, requesters: [person(1)] })], proposal())).toMatchObject({ count: '1/2', state: 'closed' });
  });
  test('no shifts and a missing list are empty, not errors', () => {
    expect(staffingOf([], proposal())).toEqual({ count: '', state: 'open', groups: [] });
    expect(staffingOf(null, proposal())).toEqual({ count: '', state: 'open', groups: [] });
  });
});

describe('financialsOf', () => {
  const invoices = (list, pending = []) => ({ invoices: list, pending_payments: pending });
  const inv = (id, over = {}) => ({ id, invoice_number: `INV-0${id}`, label: 'Deposit', amount_due: 10000, amount_paid: 10000, status: 'paid', due_date: null, ...over });

  test('lines from the snapshot, to the cent, a discount as a negative', () => {
    const f = financialsOf(proposal(), invoices([]));
    expect(f.lines).toEqual([
      { label: 'Signature bar', amount: '$2,800.00' },
      { label: 'Mobile bar rental', amount: '$450.00' },
      { label: 'Loyalty discount', amount: `${String.fromCharCode(0x2212)}$50.00` },
      { label: 'Champagne service', amount: '$450.50' },
    ]);
    expect(f.total).toBe('$3,650.00');
  });

  test('the total is the proposal row, not the snapshot, when they disagree', () => {
    expect(financialsOf(proposal({ total_price: '3700.00' }), invoices([])).total).toBe('$3,700.00');
  });

  test('a proposal with no pricing snapshot still renders a total', () => {
    for (const snap of [null, undefined, {}, { breakdown: [] }, 'not json']) {
      const f = financialsOf(proposal({ pricing_snapshot: snap }), invoices([]));
      expect(f.lines).toEqual([{ label: 'Signature bar', amount: '$3,650.00' }]);
      expect(f.total).toBe('$3,650.00');
    }
    expect(financialsOf(proposal({ pricing_snapshot: null, package_name: null }), invoices([])).lines[0].label).toBe('Package');
  });

  test('a snapshot that arrives as a JSON string is read', () => {
    const f = financialsOf(proposal({ pricing_snapshot: JSON.stringify({ breakdown: [{ label: 'Classic bar', amount: 1600 }] }) }), invoices([]));
    expect(f.lines).toEqual([{ label: 'Classic bar', amount: '$1,600.00' }]);
  });

  test('payments are the invoices that took money, in cents, void ones skipped', () => {
    const f = financialsOf(proposal(), invoices([
      inv(1),
      inv(2, { label: 'Balance 1 of 2', amount_due: 355000, amount_paid: 180000, status: 'partially_paid' }),
      inv(3, { label: 'Balance 2 of 2', amount_due: 175000, amount_paid: 0, status: 'sent' }),
      inv(4, { label: 'Voided', amount_paid: 5000, status: 'void' }),
    ]));
    expect(f.payments).toEqual([
      { key: 'i1', label: 'Deposit', sub: 'paid', amount: '$100.00' },
      { key: 'i2', label: 'Balance 1 of 2', sub: 'part paid · $1,800.00 of $3,550.00', amount: '$1,800.00' },
    ]);
  });

  test('money taken off-platform is a payment row, so a client who paid never reads "no payments"', () => {
    // Prod 607: $100 collected in CheckCherry, counted in amount_paid, on no invoice.
    const f = financialsOf(proposal({ status: 'confirmed', total_price: '2425.00', amount_paid: '100.00', external_paid: '100.00' }), invoices([]));
    expect(f.payments).toEqual([{ key: 'ext', label: 'Off-platform', sub: 'collected in CheckCherry', amount: '$100.00' }]);
    expect(f.balance.amount).toBe('$2,325.00');
    // Beside invoice money it comes first, and nothing is counted twice: the total paid is the row's.
    const both = financialsOf(proposal({ external_paid: '100.00' }), invoices([inv(1)]));
    expect(both.payments.map((x) => x.key)).toEqual(['ext', 'i1']);
    expect(both.paidToDate).toBe('$1,900.00');
    for (const none of [null, undefined, '', '0', '0.00', 'n/a', -5]) {
      expect(financialsOf(proposal({ external_paid: none }), invoices([])).payments).toEqual([]);
    }
    // Unread invoices: still null, never a list that looks complete.
    expect(financialsOf(proposal({ external_paid: '100.00' }), null).payments).toBeNull();
  });

  test('money on no row: the total is stated, and "no payments" is said only when nothing was paid', () => {
    // Paid in full before invoices existed: amount_paid is set, no invoice carries it.
    const old = financialsOf(proposal({ status: 'completed', amount_paid: '3650.00' }), invoices([]));
    expect(old).toMatchObject({ payments: [], noPayments: false, showPaidToDate: true, paidToDate: '$3,650.00', paidInFull: true });
    // Part of it on an invoice, part on none.
    const part = financialsOf(proposal(), invoices([inv(1)]));
    expect(part).toMatchObject({ noPayments: false, showPaidToDate: true, paidToDate: '$1,900.00' });
    // The rows add up: no extra row.
    const whole = financialsOf(proposal({ amount_paid: '200.00', external_paid: '100.00' }), invoices([inv(1)]));
    expect(whole).toMatchObject({ noPayments: false, showPaidToDate: false });
    // Nothing paid at all.
    const none = financialsOf(proposal({ amount_paid: '0.00' }), invoices([]));
    expect(none).toMatchObject({ payments: [], noPayments: true, showPaidToDate: false });
    // Nothing paid, but a bank debit is on its way: that is not "no payments".
    const onItsWay = financialsOf(proposal({ amount_paid: '0.00' }), invoices([], [{ amount_cents: 10000, started_at: '2999-08-05T15:00:00.000Z', invoice_number: 'INV-1' }]));
    expect(onItsWay.noPayments).toBe(false);
    // A void invoice's money is not listed money.
    const voided = financialsOf(proposal({ amount_paid: '100.00' }), invoices([inv(4, { amount_paid: 10000, status: 'void' })]));
    expect(voided).toMatchObject({ payments: [], noPayments: false, showPaidToDate: true });
    // Unread invoices: the total is all there is.
    expect(financialsOf(proposal(), null)).toMatchObject({ noPayments: false, showPaidToDate: true });
  });

  test('overpaid is the server figure, in cents, and outranks Paid', () => {
    const over = { status: 'balance_paid', amount_paid: '3700.00', overpayment_cents: 5000 };
    const f = financialsOf(proposal({ ...over, max_overpayment_refundable_cents: 5000 }), invoices([inv(1)]));
    expect(f.chip).toEqual({ kind: 'warn', label: 'Overpaid' });
    expect(f.overpaid).toEqual({ amount: '$50.00', sub: 'refund it from desktop view' });
    // Money taken outside Stripe cannot be refunded there: the desktop says so, and so does the phone.
    for (const none of [0, null, undefined, 'n/a']) {
      expect(financialsOf(proposal({ ...over, max_overpayment_refundable_cents: none }), invoices([inv(1)])).overpaid.sub).toBe('return it by hand');
    }
    // A bank debit in flight outranks it on the chip; the row still shows.
    const both = financialsOf(proposal(over), invoices([inv(1)], [{ amount_cents: 5000, started_at: '2999-08-05T15:00:00.000Z', invoice_number: 'INV-9' }]));
    expect(both.chip).toEqual({ kind: 'info', label: 'Processing' });
    expect(both.overpaid.amount).toBe('$50.00');
    expect(f.balance).toBeNull();
    // Paid more than the total, but the server nets it to nothing (a paid extras invoice): not overpaid.
    const netted = financialsOf(proposal({ status: 'balance_paid', amount_paid: '3700.00', overpayment_cents: 0 }), invoices([inv(1)]));
    expect(netted).toMatchObject({ overpaid: null, chip: { kind: 'ok', label: 'Paid' } });
    for (const none of [null, undefined, 'n/a', -1]) {
      expect(financialsOf(proposal({ overpayment_cents: none }), invoices([])).overpaid).toBeNull();
    }
  });

  test('a balance shows what is owed and when', () => {
    const f = financialsOf(proposal(), invoices([inv(1)]));
    expect(f.balance).toEqual({ label: 'Balance due', amount: '$1,750.00', sub: 'due AUG 8', inFlight: false });
    expect(f.paidInFull).toBe(false);
    expect(f.paidToDate).toBe('$1,900.00');
    expect(f.chip).toEqual({ kind: 'warn', label: 'Balance due' });
  });

  test('no due date says so', () => {
    expect(financialsOf(proposal({ balance_due_date: null }), invoices([])).balance.sub).toBe('due date not set');
  });

  test('paid in full needs a paid status AND no balance, like the desktop panel', () => {
    const paid = financialsOf(proposal({ status: 'balance_paid', amount_paid: '3650.00' }), invoices([inv(1)]));
    expect(paid).toMatchObject({ paidInFull: true, balance: null, chip: { kind: 'ok', label: 'Paid' } });
    // A refund can leave a confirmed event with money owed again.
    const refunded = financialsOf(proposal({ status: 'confirmed', amount_paid: '3000.00' }), invoices([]));
    expect(refunded).toMatchObject({ paidInFull: false, chip: { kind: 'warn', label: 'Balance due' } });
    expect(refunded.balance.amount).toBe('$650.00');
    // Nothing owed, but not a paid status: say only what is true.
    const odd = financialsOf(proposal({ status: 'deposit_paid', amount_paid: '3650.00' }), invoices([]));
    expect(odd).toMatchObject({ paidInFull: false, balance: null, chip: { kind: 'neutral', label: 'No balance' } });
  });

  test('a payment in flight wins the chip and marks the balance', () => {
    const f = financialsOf(proposal(), invoices([inv(1)], [
      { amount_cents: 175000, started_at: '2999-08-05T15:00:00.000Z', invoice_id: 2, invoice_number: 'INV-0363' },
    ]));
    expect(f.chip).toEqual({ kind: 'info', label: 'Processing' });
    expect(f.pending).toHaveLength(1);
    expect(f.pending[0]).toMatchObject({ key: 'p0', label: 'Bank payment processing', amount: '$1,750.00' });
    expect(f.pending[0].sub).toMatch(/^started [A-Z]{3} \d{1,2} · INV-0363$/);
    expect(f.balance).toMatchObject({ amount: '$1,750.00', inFlight: true });
    expect(f.balance.sub).toBe('due AUG 8 · bank payment in flight');
  });

  test('bad money and bad dates never render a dash glyph', () => {
    const f = financialsOf(
      proposal({ balance_due_date: 'soon', pricing_snapshot: { breakdown: [{ label: 'Odd line', amount: 'n/a' }] } }),
      invoices([inv(1, { amount_due: null, amount_paid: 5000, status: 'partially_paid' })], [{ amount_cents: null, started_at: null, invoice_number: null }])
    );
    expect(JSON.stringify(f).includes(String.fromCharCode(0x2014))).toBe(false);
    expect(f.balance.sub).toBe('due date not set · bank payment in flight');
    expect(f.lines).toEqual([{ label: 'Odd line', amount: '$0.00' }]);
    expect(f.pending[0].amount).toBe('$0.00');
  });

  test('a payment in flight with no invoice number and no readable date still renders', () => {
    const f = financialsOf(proposal(), invoices([], [{ amount_cents: 40000, started_at: 'nonsense', invoice_id: null, invoice_number: null }]));
    expect(f.pending[0]).toEqual({ key: 'p0', label: 'Bank payment processing', sub: '', amount: '$400.00' });
  });

  test('the invoices read being unavailable is not "no payments"', () => {
    for (const payload of [null, undefined, {}]) {
      const f = financialsOf(proposal(), payload);
      expect(f.payments).toBeNull();
      expect(f.pending).toEqual([]);
      expect(f.paidToDate).toBe('$1,900.00');
      // Whether a bank debit is in flight is unknown, so nothing is called due.
      expect(f.chip).toBeNull();
      expect(f.balance).toEqual({ label: 'Balance', amount: '$1,750.00', sub: 'due AUG 8 · payment detail not loaded', inFlight: false });
    }
    // What the proposal row alone can say is still said.
    expect(financialsOf(proposal({ status: 'balance_paid', amount_paid: '3650.00' }), null).chip).toEqual({ kind: 'ok', label: 'Paid' });
    expect(financialsOf(proposal({ status: 'archived' }), null).chip).toEqual({ kind: 'neutral', label: 'Cancelled' });
  });

  test('an archived event reads Cancelled whatever the money says, and claims no balance due', () => {
    const f = financialsOf(proposal({ status: 'archived', overpayment_cents: 5000, max_overpayment_refundable_cents: 5000 }), invoices([inv(1)]));
    expect(f.chip).toEqual({ kind: 'neutral', label: 'Cancelled' });
    // Archived for a reason that is not a cancellation is not called one.
    for (const reason of ['client_cancelled', 'we_cancelled', null, undefined, '']) {
      expect(closedWord({ status: 'archived', archive_reason: reason })).toBe('Cancelled');
    }
    for (const reason of ['event_passed', 'event_completed', 'no_hire', 'option_not_chosen', 'other']) {
      expect(closedWord({ status: 'archived', archive_reason: reason })).toBe('Archived');
      expect(financialsOf(proposal({ status: 'archived', archive_reason: reason }), invoices([])).chip.label).toBe('Archived');
    }
    expect(closedWord(proposal())).toBeNull();
    expect(closedWord(null)).toBeNull();
    expect(f.balance).toBeNull();
    // Money beyond the whole contract is owed back, cancelled or not.
    expect(f.overpaid).toEqual({ amount: '$50.00', sub: 'refund it from desktop view' });
    expect(f.payments).toHaveLength(1);
    expect(f.total).toBe('$3,650.00');
  });
});

test('earliestStale returns the oldest stamp among the cache-served reads', () => {
  expect(earliestStale(null, undefined)).toBeNull();
  expect(earliestStale('2026-09-29T17:00:00.000Z')).toBe('2026-09-29T17:00:00.000Z');
  expect(earliestStale('2026-09-29T17:00:00.000Z', null, '2026-09-29T15:30:00.000Z')).toBe('2026-09-29T15:30:00.000Z');
  expect(earliestStale('garbage', '2026-09-29T15:30:00.000Z')).toBe('2026-09-29T15:30:00.000Z');
});

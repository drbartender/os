import { buildRepriceSummary, BOOKED_STATUSES } from './repriceSummary';

describe('buildRepriceSummary', () => {
  it('exports the booked statuses the modal gates on', () => {
    expect(BOOKED_STATUSES).toEqual(['deposit_paid', 'balance_paid', 'confirmed', 'completed']);
  });

  it('gates completed events like any booked status', () => {
    const s = buildRepriceSummary({ status: 'completed', totalPrice: '1000', amountPaid: '1000', newTotal: 1500 });
    expect(s).not.toBeNull();
    expect(s.delta).toBe(500);
  });

  it('returns null for unbooked statuses even when price moves', () => {
    // completed moved to the BOOKED set (push-review finding: the server
    // bills price deltas on completed events via Additional Services).
    for (const status of ['draft', 'sent', 'viewed', 'accepted', 'archived']) {
      expect(buildRepriceSummary({ status, totalPrice: '1000', amountPaid: '0', newTotal: 1500 })).toBeNull();
    }
  });

  it('returns null when booked but the total did not move', () => {
    expect(buildRepriceSummary({
      status: 'deposit_paid', totalPrice: '1606.25', amountPaid: '100', newTotal: 1606.25,
    })).toBeNull();
    // Sub-cent float noise does not count as movement.
    expect(buildRepriceSummary({
      status: 'deposit_paid', totalPrice: '1606.25', amountPaid: '100', newTotal: 1606.2500001,
    })).toBeNull();
  });

  it('increase while balance_paid: demotion line + invoice line + rebuild line', () => {
    const s = buildRepriceSummary({
      status: 'balance_paid', totalPrice: '1000', amountPaid: '1000', newTotal: 1250,
    });
    expect(s.delta).toBe(250);
    expect(s.newBalance).toBe(250);
    expect(s.lines).toEqual([
      'This event will drop back to deposit paid and autopay will be unenrolled.',
      'The $250.00 increase will be billed to the client (added to the open balance invoice, or as a new Additional Services invoice).',
      'Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.',
    ]);
  });

  it('increase while deposit_paid: invoice line only, then rebuild line', () => {
    const s = buildRepriceSummary({
      status: 'deposit_paid', totalPrice: '1606.25', amountPaid: '100', newTotal: 1856.25,
    });
    expect(s.lines).toEqual([
      'The $250.00 increase will be billed to the client (added to the open balance invoice, or as a new Additional Services invoice).',
      'Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.',
    ]);
    expect(s.oldTotal).toBe(1606.25);
    expect(s.paid).toBe(100);
    expect(s.newBalance).toBe(1756.25);
  });

  it('decrease below amount paid: overpaid line with the refund amount', () => {
    const s = buildRepriceSummary({
      status: 'balance_paid', totalPrice: '2000', amountPaid: '2000', newTotal: 1700,
    });
    expect(s.delta).toBe(-300);
    expect(s.lines).toEqual([
      'Client is now overpaid by $300.00. A refund is likely owed.',
      'Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.',
    ]);
  });

  it('decrease still above amount paid: rebuild line only', () => {
    const s = buildRepriceSummary({
      status: 'deposit_paid', totalPrice: '2000', amountPaid: '100', newTotal: 1700,
    });
    expect(s.lines).toEqual([
      'Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.',
    ]);
  });

  it('booked with preview unavailable: unknown summary, generic line', () => {
    const s = buildRepriceSummary({
      status: 'confirmed', totalPrice: '2425', amountPaid: '100', newTotal: null,
    });
    expect(s.unknown).toBe(true);
    expect(s.lines).toEqual([
      'Live pricing is not current. Saving will reprice on the server and the total may change.',
    ]);
  });

  it('formats thousands with commas', () => {
    const s = buildRepriceSummary({
      status: 'deposit_paid', totalPrice: '1000', amountPaid: '0', newTotal: 2250.5,
    });
    expect(s.lines[0]).toBe('The $1,250.50 increase will be billed to the client (added to the open balance invoice, or as a new Additional Services invoice).');
  });
});

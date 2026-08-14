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

  // Push-gate 2026-08-14: the overpaid branches shipped untested. Every other
  // increase case has amountPaid <= totalPrice, so none of these paths ran.
  describe('price increase against an existing overpayment', () => {
    it('increase outruns the overpayment: names the balance AND the larger invoice', () => {
      const s = buildRepriceSummary({
        status: 'balance_paid', totalPrice: '1000', amountPaid: '1200', newTotal: 1500,
      });
      const all = s.lines.join(' ');
      // Proposal-level balance is the netted figure...
      expect(all).toContain('$300.00 becomes the new balance due');
      // ...but the invoice is the RAW delta, and the admin must be told.
      expect(all).toContain('the full $500.00');
      // The overpayment absorbs part of it, so the bare "will be billed" copy is wrong here.
      expect(all).not.toContain('increase will be billed to the client');
      // paid ($1,200) genuinely IS short of the new total ($1,500), so the
      // demotion line is correct here and must still appear.
      expect(all).toContain('drop back to deposit paid');
    });

    it('overpayment still covers the increase: no balance due, invoice still written', () => {
      const s = buildRepriceSummary({
        status: 'balance_paid', totalPrice: '1000', amountPaid: '1200', newTotal: 1150,
      });
      const all = s.lines.join(' ');
      expect(all).toContain('already cover the new total');
      expect(all).toContain('stays overpaid by $50.00');
      // No NEW balance is created; the only mention is the copy saying so.
      expect(all).not.toContain('becomes the new balance due');
    });

    it('increase lands exactly at the amount paid: paid in full, nothing new due', () => {
      const s = buildRepriceSummary({
        status: 'balance_paid', totalPrice: '1000', amountPaid: '1200', newTotal: 1200,
      });
      expect(s.lines.join(' ')).toContain('exactly paid in full');
    });

    it('no demotion line when the overpayment still covers the new total', () => {
      const s = buildRepriceSummary({
        status: 'balance_paid', totalPrice: '1000', amountPaid: '1200', newTotal: 1150,
      });
      // reconcileProposalPaymentStatus leaves status alone while paid >= total,
      // so promising a demotion (and an autopay unenroll) would be a lie.
      expect(s.lines.join(' ')).not.toMatch(/no longer (be )?marked|paid in full.*demot|autopay/i);
    });
  });
});

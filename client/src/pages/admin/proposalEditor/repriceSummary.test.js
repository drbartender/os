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
      // The claim must be about RECORDED PAYMENTS, not "the overpayment":
      // refreshUnlockedInvoices nets external_paid, so the broader wording
      // would be false on a CheckCherry proposal with an unlocked invoice.
      expect(all).toContain('not reduced by recorded payments');
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
      // Literal, not a regex alternation: verified that the demotion line is
      // the only thing this gate emits, and a bare /autopay/i would also fail a
      // future CORRECT line such as "autopay stays armed".
      expect(s.lines.join(' ')).not.toContain('drop back to deposit paid');
    });

    // The four cases above prove the three branches EXIST, but each sits $50
    // from the covers/outruns boundary — 10,000x the 0.005 epsilon the code
    // actually switches on. A regression that widened that epsilon, flipped a
    // > to a >=, or rounded to whole dollars would pass every one of them and
    // still misreport a real one-cent balance. These pin the boundary itself.
    describe('at the exact covers/outruns boundary', () => {
      it('one cent short of covered: a real balance is due and the demotion is real', () => {
        const s = buildRepriceSummary({
          status: 'balance_paid', totalPrice: '1000', amountPaid: '1200', newTotal: 1200.01,
        });
        const all = s.lines.join(' ');
        // A penny IS a balance. reconcileProposalPaymentStatus compares rounded
        // CENTS (paidCents 120000 < totalCents 120001), so it genuinely demotes
        // and disarms autopay here; the modal must not round the penny away.
        expect(all).toContain('$0.01 becomes the new balance due');
        expect(all).toContain('drop back to deposit paid');
        expect(all).not.toContain('already cover the new total');
        expect(s.newBalance).toBeCloseTo(0.01, 6);
      });

      it('one cent inside covered: no balance due, no demotion', () => {
        const s = buildRepriceSummary({
          status: 'balance_paid', totalPrice: '1000', amountPaid: '1200', newTotal: 1199.99,
        });
        const all = s.lines.join(' ');
        // paidCents 120000 >= totalCents 119999, so the server leaves the status
        // alone. The mirror of the case above, one cent the other way.
        expect(all).toContain('stays overpaid by $0.01');
        expect(all).not.toContain('becomes the new balance due');
        expect(all).not.toContain('drop back to deposit paid');
      });

      it('exactly covered is the only case that claims paid in full', () => {
        // Pins which side each neighbor of the boundary falls on, so the
        // "exactly" copy cannot silently widen to swallow a penny either way.
        const at = buildRepriceSummary({
          status: 'balance_paid', totalPrice: '1000', amountPaid: '1200', newTotal: 1200,
        });
        const under = buildRepriceSummary({
          status: 'balance_paid', totalPrice: '1000', amountPaid: '1200', newTotal: 1199.99,
        });
        const over = buildRepriceSummary({
          status: 'balance_paid', totalPrice: '1000', amountPaid: '1200', newTotal: 1200.01,
        });
        expect(at.lines.join(' ')).toContain('exactly paid in full');
        expect(under.lines.join(' ')).not.toContain('exactly paid in full');
        expect(over.lines.join(' ')).not.toContain('exactly paid in full');
        expect(at.newBalance).toBe(0);
      });

      it('sub-cent float noise above the old total is not treated as an overpayment', () => {
        // wasOverpaid uses the same 0.005 half-cent epsilon as the delta gate.
        // Float noise must take the plain "will be billed" copy, not the
        // overpaid copy, which would name a nonsense fraction-of-a-cent figure.
        const s = buildRepriceSummary({
          status: 'deposit_paid', totalPrice: '1000', amountPaid: 1000.004, newTotal: 1250,
        });
        expect(s.lines.join(' ')).toContain('increase will be billed to the client');
        expect(s.lines.join(' ')).not.toContain('had overpaid');
      });
    });

    it('returned newBalance agrees with the copy, including when it is negative', () => {
      // RepriceConfirmModal renders summary.newBalance directly in its "New
      // balance" row (with a Unicode-minus convention). Nothing else pinned it
      // on an overpaid case, so clamping it to 0 would leave the modal showing
      // "$0.00" beside copy that says the proposal stays overpaid by $50.00.
      const s = buildRepriceSummary({
        status: 'balance_paid', totalPrice: '1000', amountPaid: '1200', newTotal: 1150,
      });
      expect(s.newBalance).toBe(-50);
      expect(s.lines.join(' ')).toContain('stays overpaid by $50.00');
      expect(s.paid).toBe(1200);
      expect(s.oldTotal).toBe(1000);
      expect(s.delta).toBe(150);
    });

    it('overpaid increase on a non-balance_paid status: same copy, never a demotion', () => {
      // The demotion gate is an AND of two conditions. The suppression test
      // above only exercises the balance half; this exercises the status half,
      // and proves the overpaid copy itself is status-independent.
      for (const status of ['deposit_paid', 'confirmed', 'completed']) {
        const s = buildRepriceSummary({
          status, totalPrice: '1000', amountPaid: '1200', newTotal: 1500,
        });
        const all = s.lines.join(' ');
        expect(all).toContain('$300.00 becomes the new balance due');
        expect(all).toContain('the full $500.00');
        // confirmed/completed are lifecycle states reconcile never touches, and
        // deposit_paid cannot drop below itself. Promising a demotion lies.
        expect(all).not.toContain('drop back to deposit paid');
      }
    });
  });
});

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { pool } = require('../lib/db');
const phase4 = require('./phase4');

// ── Fixture conventions ─────────────────────────────────────────────────
// Pinned negative ids; cc_id prefix 'fix4-' for all fixture proposals so the
// scrubber can delete by LIKE. We pre-insert clients + proposals because
// Phase 4 expects Phase 3's promotion to have already landed.
const FIXTURE_CCID_PREFIX = 'fix4-';
const FIXTURE_CLIENT_IDS = Array.from({ length: 21 }, (_, i) => -94500 - i);
const FIXTURE_EMAIL_DOMAIN = '@phase4-fixture.local';

async function scrubFixtures() {
  // Delete in FK-safe order. proposal_refunds + proposal_payments must be
  // wiped before proposals (proposal_refunds.proposal_id is ON DELETE RESTRICT).
  const proposalIds = (
    await pool.query(`SELECT id FROM proposals WHERE cc_id LIKE $1`, [`${FIXTURE_CCID_PREFIX}%`])
  ).rows.map((r) => r.id);

  if (proposalIds.length) {
    // legacy_cc_payments references proposal_payments/proposal_refunds via
    // promoted_*_id (ON DELETE SET NULL), so we don't strictly need to clear
    // it here — but doing so keeps the test schema tidy across re-runs.
    await pool.query(
      `DELETE FROM legacy_cc_payments
        WHERE promoted_payment_id IN (
          SELECT id FROM proposal_payments WHERE proposal_id = ANY($1::int[])
        )
           OR promoted_refund_id IN (
          SELECT id FROM proposal_refunds WHERE proposal_id = ANY($1::int[])
        )`,
      [proposalIds]
    );
    await pool.query(`DELETE FROM proposal_refunds  WHERE proposal_id = ANY($1::int[])`, [proposalIds]);
    await pool.query(`DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])`, [proposalIds]);
    await pool.query(`DELETE FROM scheduled_messages WHERE entity_type='proposal' AND entity_id = ANY($1::int[])`, [proposalIds]);
    await pool.query(`DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])`, [proposalIds]);
    await pool.query(`DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = ANY($1::int[]))`, [proposalIds]);
    await pool.query(`DELETE FROM shifts WHERE proposal_id = ANY($1::int[])`, [proposalIds]);
    await pool.query(`DELETE FROM proposals WHERE id = ANY($1::int[])`, [proposalIds]);
  }

  // Sweep any orphaned legacy_cc_payments tied to fixture raw_imports.
  await pool.query(
    `DELETE FROM legacy_cc_payments
      WHERE raw_import_id IN (
        SELECT id FROM legacy_cc_raw_imports
         WHERE source_file LIKE 'phase4-fixture/%'
      )`
  );
  await pool.query(`DELETE FROM legacy_cc_raw_imports WHERE source_file LIKE 'phase4-fixture/%'`);

  await pool.query(`DELETE FROM clients WHERE id = ANY($1::int[])`, [FIXTURE_CLIENT_IDS]);
  await pool.query(`DELETE FROM clients WHERE email LIKE $1`, [`%${FIXTURE_EMAIL_DOMAIN}`]);
}

before(async () => { await scrubFixtures(); });
beforeEach(async () => { await scrubFixtures(); });
after(async () => {
  await scrubFixtures();
  await pool.end();
});

// CSV header for report (11).csv — order is load-bearing for our makeCcCsv.
const CSV_HEADER = [
  'Paid On', 'Event Date', 'Payment Applied', 'Tip Amount', 'Processing Fees',
  'Net Amount', 'Event Total', 'Taxable Amount', 'Total Adjustment Amount',
  'Tax Rate', 'Tax Collected', 'Amount Excluding Tax', 'Type', 'Event Title',
  'Brand', 'Service Name', 'Package Group', 'Package Name', 'Add On Names',
  'Add On Name, Quantity & Price', 'Venue Name', 'Venue Street', 'Venue City',
  'Venue Postal Code', 'Venue State', 'Assigned Staff', 'QuickBooks Last Synced',
  'QuickBooks Sync Error', 'Public Notes', 'Private Notes', 'Payment Method',
  'Processor', 'Receipt Number', 'Invoice Number', 'Reference Code', 'Paid By',
];

function escapeCsv(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Write report (11).csv to a temp dir. We use a per-test source_file path
// hint so scrubFixtures can wipe rows by source_file LIKE 'phase4-fixture/%'.
function makeCcDir(rows, opts = {}) {
  const tag = opts.tag || 'default';
  const lines = [CSV_HEADER.map(escapeCsv).join(',')];
  for (const row of rows) {
    lines.push(CSV_HEADER.map((h) => escapeCsv(row[h] || '')).join(','));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `phase4-test-${tag}-`));
  fs.writeFileSync(path.join(dir, 'report (11).csv'), lines.join('\n') + '\n', 'utf8');
  return dir;
}

/**
 * After phase4.run(), the legacy_cc_raw_imports rows were written with
 * source_file='report (11).csv' — not the fixture tag. We rewrite the source
 * file to a fixture-prefixed value so scrubFixtures can wipe by LIKE.
 *
 * Call this RIGHT after each phase4.run() — never in the middle of a run.
 */
async function tagFixtureRawImports() {
  await pool.query(
    `UPDATE legacy_cc_raw_imports
        SET source_file = 'phase4-fixture/' || source_row_number
      WHERE source_file = 'report (11).csv'
        AND source_entity = 'payments'`
  );
}

// Format helpers.
function ccDate(date) {
  const d = typeof date === 'string' ? new Date(date) : date;
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}-${dd}-${d.getUTCFullYear()}`;
}
function isoDate(date) {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toISOString().slice(0, 10);
}
function futureDate(daysAhead) {
  return new Date(Date.now() + daysAhead * 86400000);
}
function pastDate(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400000);
}

// ── Seed helpers ───────────────────────────────────────────────────────

/**
 * Seed a cc-imported proposal (mimics what Phase 3 would have produced) plus
 * its client. status/event_date/total_price are configurable; defaults are
 * Bucket A (confirmed, future, $1000).
 */
async function seedProposal({
  clientId, clientEmail,
  ccId, eventDate = futureDate(30), totalPrice = 1000, status = 'confirmed',
  amountPaid = 0, autopay = false,
}) {
  await pool.query(
    `INSERT INTO clients (id, name, email, source) VALUES ($1, $2, $3, 'direct')`,
    [clientId, `Client ${clientId}`, clientEmail]
  );
  const r = await pool.query(
    `INSERT INTO proposals
       (client_id, cc_id, event_date, event_duration_hours, guest_count,
        total_price, amount_paid, payment_type, status, autopay_enrolled)
     VALUES ($1, $2, $3, 4, 50, $4, $5, 'deposit', $6, $7)
     RETURNING id`,
    [clientId, ccId, isoDate(eventDate), totalPrice, amountPaid, status, autopay]
  );
  return r.rows[0].id;
}

// Build one CSV row from a sparse spec — useful for one-test-one-row layouts.
function paymentRow({
  paidOn, eventDate, paymentApplied, eventTotal, processingFees = 0,
  type = 'Payment', eventTitle = 'Test Event', paymentMethod = 'Credit Card',
  processor = 'Stripe Express', referenceCode = '', paidBy = '', tip = 0,
}) {
  return {
    'Paid On': ccDate(paidOn),
    'Event Date': ccDate(eventDate),
    'Payment Applied': type === 'Refund' ? `$-${Math.abs(paymentApplied)}` : `$${paymentApplied}`,
    'Tip Amount': `$${tip}`,
    'Processing Fees': `$${processingFees}`,
    'Net Amount': type === 'Refund' ? `$-${Math.abs(paymentApplied)}` : `$${paymentApplied}`,
    'Event Total': `$${eventTotal}`,
    'Taxable Amount': `$${eventTotal}`,
    'Total Adjustment Amount': '$0',
    'Tax Rate': '0.0%',
    'Tax Collected': '$0',
    'Amount Excluding Tax': `$${paymentApplied}`,
    'Type': type,
    'Event Title': eventTitle,
    'Payment Method': paymentMethod,
    'Processor': processor,
    'Reference Code': referenceCode,
    'Paid By': paidBy,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

test('Phase 4: clean Stripe Express payment — legacy_charge_id set, payment_method=card, created_at=paid_on noon-UTC', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}P001`;
  const clientId = -94500;
  const email = `clean.stripe${FIXTURE_EMAIL_DOMAIN}`;
  const eventDate = futureDate(30);

  const propId = await seedProposal({ clientId, clientEmail: email, ccId, eventDate, totalPrice: 1000 });

  const dir = makeCcDir([
    paymentRow({
      paidOn: new Date('2026-04-15'),
      eventDate,
      paymentApplied: 500,
      eventTotal: 1000,
      processingFees: 14.5,
      referenceCode: 'ch_3TEST123abc',
    }),
  ], { tag: 'clean-stripe' });

  const res = await phase4.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();

  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.counts.payments_promoted, 1);

  const pp = await pool.query(
    `SELECT amount, fee_cents, payment_type, payment_method, legacy_charge_id,
            status, created_at
       FROM proposal_payments WHERE proposal_id = $1`,
    [propId]
  );
  assert.strictEqual(pp.rowCount, 1);
  const row = pp.rows[0];
  assert.strictEqual(row.amount, 50000);
  assert.strictEqual(row.fee_cents, 1450);
  assert.strictEqual(row.payment_type, 'deposit'); // 500 < 1000
  assert.strictEqual(row.payment_method, 'card');
  assert.strictEqual(row.legacy_charge_id, 'ch_3TEST123abc');
  assert.strictEqual(row.status, 'succeeded');
  // created_at = 2026-04-15T12:00:00Z
  assert.strictEqual(row.created_at.toISOString(), '2026-04-15T12:00:00.000Z');

  // recompute should set amount_paid = 500.
  const pr = await pool.query(`SELECT amount_paid, payment_type, status FROM proposals WHERE id = $1`, [propId]);
  assert.strictEqual(Number(pr.rows[0].amount_paid), 500);
  assert.strictEqual(pr.rows[0].payment_type, 'deposit'); // 500 < 1000
  assert.strictEqual(pr.rows[0].status, 'confirmed'); // still confirmed (Bucket A, not fully paid)
});

test('Phase 4: Cash payment (Custom processor) — legacy_charge_id NULL, payment_method=cash', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}P002`;
  const clientId = -94501;
  const email = `cash${FIXTURE_EMAIL_DOMAIN}`;
  const eventDate = futureDate(40);

  const propId = await seedProposal({ clientId, clientEmail: email, ccId, eventDate, totalPrice: 800 });

  const dir = makeCcDir([
    paymentRow({
      paidOn: new Date('2026-05-01'),
      eventDate,
      paymentApplied: 200,
      eventTotal: 800,
      paymentMethod: 'Cash',
      processor: 'Custom',
      referenceCode: '',
    }),
  ], { tag: 'cash' });

  const res = await phase4.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.counts.payments_promoted, 1);

  const pp = await pool.query(
    `SELECT amount, payment_method, legacy_charge_id, payment_type
       FROM proposal_payments WHERE proposal_id = $1`,
    [propId]
  );
  assert.strictEqual(pp.rows[0].amount, 20000);
  assert.strictEqual(pp.rows[0].payment_method, 'cash');
  assert.strictEqual(pp.rows[0].legacy_charge_id, null);
  assert.strictEqual(pp.rows[0].payment_type, 'deposit');
});

test('Phase 4: 3 payments per event → chronological payment_type (deposit, balance, balance)', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}P003`;
  const clientId = -94502;
  const email = `chrono${FIXTURE_EMAIL_DOMAIN}`;
  const eventDate = futureDate(60);

  const propId = await seedProposal({ clientId, clientEmail: email, ccId, eventDate, totalPrice: 1000 });

  // $100 first → deposit, $700 second → balance, $200 third → balance.
  // Total 1000. Note paid_on is the ordering key.
  const dir = makeCcDir([
    paymentRow({
      paidOn: new Date('2026-04-01'), eventDate, paymentApplied: 100, eventTotal: 1000,
      referenceCode: 'ch_chrono_1',
    }),
    paymentRow({
      paidOn: new Date('2026-04-15'), eventDate, paymentApplied: 700, eventTotal: 1000,
      referenceCode: 'ch_chrono_2',
    }),
    paymentRow({
      paidOn: new Date('2026-04-29'), eventDate, paymentApplied: 200, eventTotal: 1000,
      referenceCode: 'ch_chrono_3',
    }),
  ], { tag: 'chrono' });

  const res = await phase4.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.counts.payments_promoted, 3);

  const pp = await pool.query(
    `SELECT amount, payment_type, legacy_charge_id, created_at
       FROM proposal_payments
      WHERE proposal_id = $1
      ORDER BY created_at ASC`,
    [propId]
  );
  assert.strictEqual(pp.rowCount, 3);
  assert.strictEqual(pp.rows[0].legacy_charge_id, 'ch_chrono_1');
  assert.strictEqual(pp.rows[0].payment_type, 'deposit');
  assert.strictEqual(pp.rows[0].amount, 10000);
  assert.strictEqual(pp.rows[1].legacy_charge_id, 'ch_chrono_2');
  assert.strictEqual(pp.rows[1].payment_type, 'balance');
  assert.strictEqual(pp.rows[1].amount, 70000);
  assert.strictEqual(pp.rows[2].legacy_charge_id, 'ch_chrono_3');
  assert.strictEqual(pp.rows[2].payment_type, 'balance');
  assert.strictEqual(pp.rows[2].amount, 20000);

  // amount_paid should equal 1000 (100+700+200).
  const pr = await pool.query(`SELECT amount_paid, payment_type, status FROM proposals WHERE id = $1`, [propId]);
  assert.strictEqual(Number(pr.rows[0].amount_paid), 1000);
  assert.strictEqual(pr.rows[0].payment_type, 'full');
  // Bucket A confirmed + fully paid + future → balance_paid.
  assert.strictEqual(pr.rows[0].status, 'balance_paid');
});

test('Phase 4: full refund on Bucket B (completed) — status PRESERVED, total_price + amount_paid both drop', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}R001`;
  const clientId = -94503;
  const email = `refund.completed${FIXTURE_EMAIL_DOMAIN}`;
  const eventDate = pastDate(60);

  const propId = await seedProposal({
    clientId, clientEmail: email, ccId, eventDate, totalPrice: 500,
    amountPaid: 500, status: 'completed',
  });

  // One $500 prior payment so the refund has something to reverse.
  const dir = makeCcDir([
    paymentRow({
      paidOn: pastDate(70), eventDate, paymentApplied: 500, eventTotal: 500,
      referenceCode: 'ch_completed_pay',
    }),
    paymentRow({
      paidOn: pastDate(50), eventDate, paymentApplied: 500, eventTotal: 500,
      type: 'Refund', referenceCode: 're_completed_ref',
    }),
  ], { tag: 'refund-completed' });

  const res = await phase4.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.counts.payments_promoted, 1);
  assert.strictEqual(res.counts.refunds_promoted, 1);

  const pr = await pool.query(
    `SELECT total_price, amount_paid, status FROM proposals WHERE id = $1`, [propId]
  );
  // Approach A: both drop by the refund. 500 - 500 = 0.
  assert.strictEqual(Number(pr.rows[0].total_price), 0);
  assert.strictEqual(Number(pr.rows[0].amount_paid), 0);
  // CRITICAL: outer guard preserves 'completed' — must NOT demote to 'accepted'.
  assert.strictEqual(pr.rows[0].status, 'completed');

  const rr = await pool.query(
    `SELECT amount, reason, total_price_before, total_price_after, status, created_at
       FROM proposal_refunds WHERE proposal_id = $1`, [propId]
  );
  assert.strictEqual(rr.rowCount, 1);
  assert.strictEqual(rr.rows[0].amount, 50000);
  assert.match(rr.rows[0].reason, /Legacy Check Cherry import/);
  assert.strictEqual(Number(rr.rows[0].total_price_before), 500);
  assert.strictEqual(Number(rr.rows[0].total_price_after), 0);
  assert.strictEqual(rr.rows[0].status, 'succeeded');
});

test('Phase 4 R002: partial refund where paid == total_after preserves balance_paid + autopay', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}R002`;
  const clientId = -94504;
  const email = `partial.refund${FIXTURE_EMAIL_DOMAIN}`;
  const eventDate = futureDate(30);

  // Pre-seed as fully paid + autopay armed.
  const propId = await seedProposal({
    clientId, clientEmail: email, ccId, eventDate, totalPrice: 1000,
    amountPaid: 1000, status: 'balance_paid', autopay: true,
  });

  // One $1000 prior payment, then a $300 refund (partial).
  const dir = makeCcDir([
    paymentRow({
      paidOn: pastDate(10), eventDate, paymentApplied: 1000, eventTotal: 1000,
      referenceCode: 'ch_partial_pay',
    }),
    paymentRow({
      paidOn: pastDate(2), eventDate, paymentApplied: 300, eventTotal: 1000,
      type: 'Refund', referenceCode: 're_partial_ref',
    }),
  ], { tag: 'partial-refund' });

  const res = await phase4.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.counts.refunds_promoted, 1);

  const pr = await pool.query(
    `SELECT total_price, amount_paid, status, autopay_enrolled FROM proposals WHERE id = $1`,
    [propId]
  );
  // total_price drops by refund → 700. amount_paid drops by refund → 700.
  // BUT step 6 recomputes amount_paid from scratch as
  // SUM(payments) - SUM(refunds) = 1000 - 300 = 700. Same answer.
  assert.strictEqual(Number(pr.rows[0].total_price), 700);
  assert.strictEqual(Number(pr.rows[0].amount_paid), 700);
  // Status demote: balance_paid → deposit_paid (because amount_paid < total_price... wait).
  // After both drop by 300: total=700, paid=700 → amount_paid >= total → status unchanged (still 'balance_paid').
  // The CASE 'WHEN amount_paid < total_price THEN deposit_paid ELSE status' falls through.
  // Hmm — but step 7 re-derives. For Bucket A confirmed fully-paid, step 7
  // converts 'confirmed' → 'balance_paid'. We're starting at balance_paid AT phase4
  // entry (test pre-seed). After refund + recompute, amount_paid == total_price.
  // Step 7's CASE only converts 'confirmed' → 'balance_paid', so 'balance_paid' stays.
  // → final status: 'balance_paid'. autopay_enrolled stays true (no demote happened).
  // This is the "still fully paid at corrected total" Approach A guarantee.
  assert.strictEqual(pr.rows[0].status, 'balance_paid');
  assert.strictEqual(pr.rows[0].autopay_enrolled, true);
});

test('Phase 4: full refund on balance_paid → status demotes to accepted', async () => {
  // Approach A: UPDATE #1 drops total + paid by the same cents. With paid_before
  // == total_before and a refund equal to total, both clamp to 0. UPDATE #2
  // sees amount_paid <= 0 → 'accepted'.
  const ccId = `${FIXTURE_CCID_PREFIX}R003a`;
  const clientId = -94515;
  const email = `demote-accepted${FIXTURE_EMAIL_DOMAIN}`;
  const eventDate = futureDate(30);

  const propId = await seedProposal({
    clientId, clientEmail: email, ccId, eventDate, totalPrice: 500,
    amountPaid: 500, status: 'balance_paid', autopay: false,
  });
  await pool.query(
    `INSERT INTO proposal_payments
       (proposal_id, amount, fee_cents, payment_type, payment_method, status, created_at)
     VALUES ($1, 50000, 0, 'full', 'card', 'succeeded', NOW())`,
    [propId]
  );

  const dir = makeCcDir([
    paymentRow({
      paidOn: pastDate(5), eventDate, paymentApplied: 500, eventTotal: 500,
      type: 'Refund', referenceCode: 're_demote_accepted',
    }),
  ], { tag: 'demote-accepted' });

  const res = await phase4.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.counts.refunds_promoted, 1);

  const pr = await pool.query(
    `SELECT total_price, amount_paid, status FROM proposals WHERE id = $1`, [propId]
  );
  assert.strictEqual(Number(pr.rows[0].total_price), 0);
  assert.strictEqual(Number(pr.rows[0].amount_paid), 0);
  assert.strictEqual(pr.rows[0].status, 'accepted');
});

test('Phase 4: balance_paid + paid<total + partial refund -> demotes to deposit_paid + autopay cleared', async () => {
  // The deposit_paid demote + autopay clear path. Forces a synthetic
  // balance_paid + paid<total starting state (which wouldn't arise naturally
  // since paid_before usually equals total_before for a balance_paid row) so
  // the refund's UPDATE #1 leaves paid < total, which is the only condition
  // under which UPDATE #2's `WHEN amount_paid < total_price THEN deposit_paid`
  // branch fires AND the autopay-clear case `status = balance_paid AND
  // amount_paid < total_price` also fires.
  const ccId = `${FIXTURE_CCID_PREFIX}R003b`;
  const clientId = -94516;
  const email = `demote-deposit${FIXTURE_EMAIL_DOMAIN}`;
  const eventDate = futureDate(30);

  const propId = await seedProposal({
    clientId, clientEmail: email, ccId, eventDate, totalPrice: 1000,
    amountPaid: 800, status: 'balance_paid', autopay: true,
  });
  // Pre-insert succeeded payment so the refund-without-payment assertion passes.
  await pool.query(
    `INSERT INTO proposal_payments
       (proposal_id, amount, fee_cents, payment_type, payment_method, status, created_at)
     VALUES ($1, 80000, 0, 'full', 'card', 'succeeded', NOW())`,
    [propId]
  );

  // Refund $100 -> UPDATE #1: total=900, paid=700. UPDATE #2: paid(700) <
  // total(900) -> demote to deposit_paid; was balance_paid + amount_paid<total
  // -> clear autopay.
  const dir = makeCcDir([
    paymentRow({
      paidOn: pastDate(2), eventDate, paymentApplied: 100, eventTotal: 1000,
      type: 'Refund', referenceCode: 're_demote_deposit',
    }),
  ], { tag: 'demote-deposit' });

  const res = await phase4.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.counts.refunds_promoted, 1);

  const pr = await pool.query(
    `SELECT total_price, amount_paid, status, autopay_enrolled FROM proposals WHERE id = $1`,
    [propId]
  );
  assert.strictEqual(Number(pr.rows[0].total_price), 900);
  assert.strictEqual(Number(pr.rows[0].amount_paid), 700);
  // Demote: balance_paid -> deposit_paid.
  assert.strictEqual(pr.rows[0].status, 'deposit_paid');
  // CRITICAL: autopay_enrolled cleared on balance_paid -> deposit_paid.
  // Without this, balanceScheduler would re-charge the just-refunded amount.
  assert.strictEqual(pr.rows[0].autopay_enrolled, false);
});

test('Phase 4: refund-without-payment assertion — refund > net_paid → raw row errored', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}R004`;
  const clientId = -94506;
  const email = `excess.refund${FIXTURE_EMAIL_DOMAIN}`;
  const eventDate = pastDate(20);

  const propId = await seedProposal({
    clientId, clientEmail: email, ccId, eventDate, totalPrice: 500,
    amountPaid: 0, status: 'completed',
  });

  // No prior Phase4 payment. One $200 refund — but net_paid is 0 → fails.
  const dir = makeCcDir([
    paymentRow({
      paidOn: pastDate(10), eventDate, paymentApplied: 200, eventTotal: 500,
      type: 'Refund', referenceCode: 're_excess',
    }),
  ], { tag: 'excess-refund' });

  const res = await phase4.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();
  assert.strictEqual(res.counts.exceeds_net_paid, 1);
  assert.strictEqual(res.counts.refunds_promoted, 0);

  // proposal money state is unchanged.
  const pr = await pool.query(
    `SELECT total_price, amount_paid, status FROM proposals WHERE id = $1`, [propId]
  );
  assert.strictEqual(Number(pr.rows[0].total_price), 500);
  assert.strictEqual(Number(pr.rows[0].amount_paid), 0);
  assert.strictEqual(pr.rows[0].status, 'completed');

  // raw row marked errored with the right import_notes.
  const raw = await pool.query(
    `SELECT import_status, import_notes FROM legacy_cc_raw_imports
      WHERE source_file LIKE 'phase4-fixture/%'`
  );
  assert.strictEqual(raw.rowCount, 1);
  assert.strictEqual(raw.rows[0].import_status, 'errored');
  assert.strictEqual(raw.rows[0].import_notes.error, 'refund_exceeds_net_paid');
  assert.strictEqual(raw.rows[0].import_notes.refund_cents, 20000);
  assert.strictEqual(raw.rows[0].import_notes.net_paid_cents, 0);
});

test('Phase 4: manual-reconciliation skip — pre-seeded matching refund → CC refund linked, not duplicated', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}M001`;
  const clientId = -94507;
  const email = `manual${FIXTURE_EMAIL_DOMAIN}`;
  const eventDate = pastDate(30);
  const refundDate = new Date('2026-04-10');

  const propId = await seedProposal({
    clientId, clientEmail: email, ccId, eventDate, totalPrice: 800,
    amountPaid: 800, status: 'completed',
  });

  // Pre-seed a manual reconciliation refund row matching what the CSV row will look like.
  // Same amount, reason prefix, ±24h of paid_on.
  const manualRef = await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, stripe_refund_id,
        amount, reason, total_price_before, total_price_after, status, created_at)
     VALUES ($1, NULL, NULL, NULL, $2, $3, $4, $5, 'succeeded', $6)
     RETURNING id`,
    [propId, 15000, 'Manual Stripe reconciliation 2026-04-10', 800, 650,
     refundDate.toISOString()]
  );
  const manualId = manualRef.rows[0].id;

  // Also pre-seed a prior Phase4 payment so the refund assertion passes.
  await pool.query(
    `INSERT INTO proposal_payments
       (proposal_id, amount, fee_cents, payment_type, payment_method, status, created_at)
     VALUES ($1, 80000, 0, 'full', 'card', 'succeeded', NOW())`,
    [propId]
  );

  const dir = makeCcDir([
    paymentRow({
      paidOn: refundDate, eventDate, paymentApplied: 150, eventTotal: 800,
      type: 'Refund', referenceCode: 're_manual_skip',
    }),
  ], { tag: 'manual-skip' });

  const res = await phase4.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.counts.manual_skipped, 1);

  // Exactly ONE refund (the pre-seeded manual one) — no CC-import duplicate.
  const rr = await pool.query(
    `SELECT id, amount FROM proposal_refunds WHERE proposal_id = $1`, [propId]
  );
  assert.strictEqual(rr.rowCount, 1);
  assert.strictEqual(rr.rows[0].id, manualId);

  // legacy_cc_payments row was linked to the manual refund.
  const lp = await pool.query(
    `SELECT promoted_refund_id FROM legacy_cc_payments WHERE cc_event_id = $1`, [ccId]
  );
  assert.strictEqual(lp.rows[0].promoted_refund_id, manualId);
});

test('Phase 4: amount_paid recompute — SUM(payments) - SUM(refunds) reflected to 2 decimals', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}A100`;
  const clientId = -94508;
  const email = `recompute${FIXTURE_EMAIL_DOMAIN}`;
  const eventDate = futureDate(45);

  const propId = await seedProposal({
    clientId, clientEmail: email, ccId, eventDate, totalPrice: 1500,
    amountPaid: 0, status: 'confirmed',
  });

  // $1500 payment + $250.50 refund → expect amount_paid = 1249.50.
  const dir = makeCcDir([
    paymentRow({
      paidOn: pastDate(40), eventDate, paymentApplied: 1500, eventTotal: 1500,
      referenceCode: 'ch_recompute_pay',
    }),
    paymentRow({
      paidOn: pastDate(20), eventDate, paymentApplied: 250.50, eventTotal: 1500,
      type: 'Refund', referenceCode: 're_recompute_ref',
    }),
  ], { tag: 'recompute' });

  const res = await phase4.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();
  assert.strictEqual(res.errored, 0);

  const pr = await pool.query(
    `SELECT amount_paid, total_price, status, payment_type FROM proposals WHERE id = $1`, [propId]
  );
  assert.strictEqual(Number(pr.rows[0].amount_paid), 1249.5);
  // total_price was reduced by refund (1500 → 1249.50).
  assert.strictEqual(Number(pr.rows[0].total_price), 1249.5);
  // amount_paid (1249.50) >= total_price (1249.50) → 'full' payment_type.
  assert.strictEqual(pr.rows[0].payment_type, 'full');
  // Bucket A confirmed + fully paid + future event → status re-derived to balance_paid.
  assert.strictEqual(pr.rows[0].status, 'balance_paid');
});

test('Phase 4: status re-derivation — Bucket A confirmed + fully paid → balance_paid; Bucket B stays completed', async () => {
  // Bucket A proposal.
  const ccIdA = `${FIXTURE_CCID_PREFIX}AB1`;
  const clientIdA = -94509;
  const emailA = `bucketa.rederive${FIXTURE_EMAIL_DOMAIN}`;
  const propAId = await seedProposal({
    clientId: clientIdA, clientEmail: emailA, ccId: ccIdA,
    eventDate: futureDate(30), totalPrice: 500, status: 'confirmed',
  });

  // Bucket B proposal.
  const ccIdB = `${FIXTURE_CCID_PREFIX}AB2`;
  const clientIdB = -94510;
  const emailB = `bucketb.rederive${FIXTURE_EMAIL_DOMAIN}`;
  const propBId = await seedProposal({
    clientId: clientIdB, clientEmail: emailB, ccId: ccIdB,
    eventDate: pastDate(60), totalPrice: 700, status: 'completed',
  });

  const dir = makeCcDir([
    paymentRow({
      paidOn: pastDate(20), eventDate: futureDate(30), paymentApplied: 500, eventTotal: 500,
      referenceCode: 'ch_rederive_a',
    }),
    paymentRow({
      paidOn: pastDate(70), eventDate: pastDate(60), paymentApplied: 700, eventTotal: 700,
      referenceCode: 'ch_rederive_b',
    }),
  ], { tag: 'rederive' });

  const res = await phase4.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.counts.payments_promoted, 2);

  const prA = await pool.query(`SELECT status, payment_type FROM proposals WHERE id = $1`, [propAId]);
  assert.strictEqual(prA.rows[0].status, 'balance_paid');
  assert.strictEqual(prA.rows[0].payment_type, 'full');

  const prB = await pool.query(`SELECT status, payment_type FROM proposals WHERE id = $1`, [propBId]);
  // Bucket B: 'completed' must stay 'completed' (terminal). payment_type still re-derives.
  assert.strictEqual(prB.rows[0].status, 'completed');
  assert.strictEqual(prB.rows[0].payment_type, 'full');
});

test('Phase 4: stale balance-reminder suppression — pending rows for now-fully-paid Bucket A → suppressed', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}S001`;
  const clientId = -94511;
  const email = `suppress${FIXTURE_EMAIL_DOMAIN}`;
  const eventDate = futureDate(30);

  const propId = await seedProposal({
    clientId, clientEmail: email, ccId, eventDate, totalPrice: 600, status: 'confirmed',
  });

  // Pre-seed a balance_reminder row (mimics what Phase 3 would have enqueued).
  await pool.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id,
        channel, scheduled_for, status)
     VALUES ($1, 'proposal', 'balance_reminder_non_autopay_t3', 'client', $2,
             'email', NOW() + INTERVAL '14 days', 'pending')`,
    [propId, clientId]
  );
  // Also seed a non-balance-reminder row that MUST be preserved.
  await pool.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id,
        channel, scheduled_for, status)
     VALUES ($1, 'proposal', 'pre_event_t7', 'client', $2,
             'email', NOW() + INTERVAL '23 days', 'pending')`,
    [propId, clientId]
  );

  // One $600 payment → full coverage.
  const dir = makeCcDir([
    paymentRow({
      paidOn: pastDate(5), eventDate, paymentApplied: 600, eventTotal: 600,
      referenceCode: 'ch_suppress',
    }),
  ], { tag: 'suppress' });

  const res = await phase4.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.suppressedBalanceReminders, 1);

  const sm = await pool.query(
    `SELECT message_type, status, error_message FROM scheduled_messages
      WHERE entity_type='proposal' AND entity_id = $1
      ORDER BY message_type ASC`,
    [propId]
  );
  assert.strictEqual(sm.rowCount, 2);
  // balance_reminder_* → suppressed.
  const bal = sm.rows.find((r) => r.message_type === 'balance_reminder_non_autopay_t3');
  assert.strictEqual(bal.status, 'suppressed');
  assert.match(bal.error_message, /cc-import: balance settled at import/);
  // pre_event_t7 → still pending.
  const pre = sm.rows.find((r) => r.message_type === 'pre_event_t7');
  assert.strictEqual(pre.status, 'pending');
});

test('Phase 4: re-run idempotent — second run with same CSV does not duplicate payments or refunds', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}I001`;
  const clientId = -94512;
  const email = `idem${FIXTURE_EMAIL_DOMAIN}`;
  const eventDate = futureDate(50);

  const propId = await seedProposal({
    clientId, clientEmail: email, ccId, eventDate, totalPrice: 1000, status: 'confirmed',
  });

  const dir = makeCcDir([
    paymentRow({
      paidOn: pastDate(20), eventDate, paymentApplied: 600, eventTotal: 1000,
      referenceCode: 'ch_idem_pay',
    }),
    paymentRow({
      paidOn: pastDate(5), eventDate, paymentApplied: 100, eventTotal: 1000,
      type: 'Refund', referenceCode: 're_idem_ref',
    }),
  ], { tag: 'idem' });

  const r1 = await phase4.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();
  assert.strictEqual(r1.errored, 0);
  assert.strictEqual(r1.counts.payments_promoted, 1);
  assert.strictEqual(r1.counts.refunds_promoted, 1);

  // Second run: SAME CSV, no new rows. promoted_*_id is set → both rows skipped.
  // We need to re-tag because the run reset source_file to 'report (11).csv'
  // and we already tagged once. So untagged first.
  await pool.query(
    `UPDATE legacy_cc_raw_imports
        SET source_file = 'report (11).csv'
      WHERE source_file LIKE 'phase4-fixture/%'`
  );

  const r2 = await phase4.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();
  assert.strictEqual(r2.errored, 0);
  assert.strictEqual(r2.counts.already_promoted, 2);
  assert.strictEqual(r2.counts.payments_promoted, 0);
  assert.strictEqual(r2.counts.refunds_promoted, 0);

  // Exactly one payment + one refund in the ledger.
  const ppc = await pool.query(`SELECT COUNT(*)::int n FROM proposal_payments WHERE proposal_id = $1`, [propId]);
  assert.strictEqual(ppc.rows[0].n, 1);
  const rrc = await pool.query(`SELECT COUNT(*)::int n FROM proposal_refunds WHERE proposal_id = $1`, [propId]);
  assert.strictEqual(rrc.rows[0].n, 1);

  // Final amount_paid still 500 (600 - 100).
  const pr = await pool.query(`SELECT amount_paid FROM proposals WHERE id = $1`, [propId]);
  assert.strictEqual(Number(pr.rows[0].amount_paid), 500);
});

test('promoteSingleLegacyPayment: callable externally for a freshly-set cc_event_id', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}E001`;
  const clientId = -94513;
  const email = `ext.payment${FIXTURE_EMAIL_DOMAIN}`;
  const eventDate = futureDate(20);

  const propId = await seedProposal({
    clientId, clientEmail: email, ccId, eventDate, totalPrice: 800, status: 'confirmed',
  });

  // Pre-insert a legacy_cc_payments row with cc_event_id NULL (mimics an
  // orphan that the operator just linked via Task 19's /link endpoint).
  const raw = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, cc_id, payload)
     VALUES ('phase4-fixture/ext-pay', 'payments', 1, 'hash-ext-pay', NULL, '{}'::jsonb)
     RETURNING id`
  );
  const rawId = raw.rows[0].id;
  const lp = await pool.query(
    `INSERT INTO legacy_cc_payments
       (cc_event_id, cc_type, paid_on, payment_applied_cents, tip_cents,
        processing_fee_cents, payment_method, processor, reference_code, raw_import_id)
     VALUES ($1, 'Payment', $2, $3, 0, 0, 'Credit Card', 'Stripe Express', 'ch_ext_pay_1', $4)
     RETURNING id`,
    [ccId, isoDate(pastDate(10)), 25000, rawId]
  );

  const r = await phase4.promoteSingleLegacyPayment(lp.rows[0].id);
  assert.strictEqual(r.status, 'promoted');
  assert.ok(r.paymentId);

  const pp = await pool.query(
    `SELECT amount, payment_method, legacy_charge_id, payment_type
       FROM proposal_payments WHERE id = $1`, [r.paymentId]
  );
  assert.strictEqual(pp.rows[0].amount, 25000);
  assert.strictEqual(pp.rows[0].payment_method, 'card');
  assert.strictEqual(pp.rows[0].legacy_charge_id, 'ch_ext_pay_1');
  assert.strictEqual(pp.rows[0].payment_type, 'deposit'); // 250 < 800
});

test('promoteSingleLegacyRefund: callable externally for a freshly-set cc_event_id', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}E002`;
  const clientId = -94514;
  const email = `ext.refund${FIXTURE_EMAIL_DOMAIN}`;
  const eventDate = pastDate(40);

  const propId = await seedProposal({
    clientId, clientEmail: email, ccId, eventDate, totalPrice: 600,
    amountPaid: 600, status: 'completed',
  });

  // Seed a prior succeeded payment so the refund-without-payment assertion passes.
  await pool.query(
    `INSERT INTO proposal_payments
       (proposal_id, amount, fee_cents, payment_type, payment_method, status, created_at)
     VALUES ($1, 60000, 0, 'full', 'card', 'succeeded', NOW())`,
    [propId]
  );

  // Pre-insert an orphan refund legacy row with cc_event_id set (operator linked).
  const raw = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, cc_id, payload)
     VALUES ('phase4-fixture/ext-ref', 'payments', 1, 'hash-ext-ref', NULL, '{}'::jsonb)
     RETURNING id`
  );
  const rawId = raw.rows[0].id;
  const lp = await pool.query(
    `INSERT INTO legacy_cc_payments
       (cc_event_id, cc_type, paid_on, payment_applied_cents, tip_cents,
        processing_fee_cents, payment_method, processor, reference_code, raw_import_id)
     VALUES ($1, 'Refund', $2, $3, 0, 0, 'Credit Card', 'Stripe Express', 're_ext_ref_1', $4)
     RETURNING id`,
    [ccId, isoDate(pastDate(5)), 10000, rawId]
  );

  const r = await phase4.promoteSingleLegacyRefund(lp.rows[0].id);
  assert.strictEqual(r.status, 'promoted');
  assert.ok(r.refundId);

  const pr = await pool.query(
    `SELECT total_price, amount_paid, status FROM proposals WHERE id = $1`, [propId]
  );
  // UPDATE #1: total = 600 - 100 = 500. amount_paid = 600 - 100 = 500.
  assert.strictEqual(Number(pr.rows[0].total_price), 500);
  assert.strictEqual(Number(pr.rows[0].amount_paid), 500);
  // 'completed' preserved by outer guard.
  assert.strictEqual(pr.rows[0].status, 'completed');

  const rr = await pool.query(`SELECT amount FROM proposal_refunds WHERE id = $1`, [r.refundId]);
  assert.strictEqual(rr.rows[0].amount, 10000);
});

test('Phase 4: paid_on NULL — created_at falls back to DEFAULT NOW() instead of NULL', async () => {
  // Regression guard for the financial-dashboard "paid" lens (date-grouped by
  // created_at) and the manual-reconciliation skip's ±24h window — both break
  // when created_at lands as NULL. When CC's `Paid On` column is empty,
  // paidOnNoonUtc returns null; the INSERT must OMIT created_at so the schema
  // DEFAULT NOW() fires.
  const ccId = `${FIXTURE_CCID_PREFIX}N001`;
  const clientId = -94517;
  const email = `null.paidon${FIXTURE_EMAIL_DOMAIN}`;
  const eventDate = futureDate(25);

  const propId = await seedProposal({
    clientId, clientEmail: email, ccId, eventDate, totalPrice: 600, status: 'confirmed',
  });

  // Pre-insert a legacy_cc_payments row with paid_on = NULL + a non-empty
  // payment_applied_cents value (mirrors a CC export where `Paid On` is blank).
  const raw = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, cc_id, payload)
     VALUES ('phase4-fixture/null-paidon', 'payments', 1, 'hash-null-paidon', NULL, '{}'::jsonb)
     RETURNING id`
  );
  const rawId = raw.rows[0].id;
  const lp = await pool.query(
    `INSERT INTO legacy_cc_payments
       (cc_event_id, cc_type, paid_on, payment_applied_cents, tip_cents,
        processing_fee_cents, payment_method, processor, reference_code, raw_import_id)
     VALUES ($1, 'Payment', NULL, $2, 0, 0, 'Credit Card', 'Stripe Express', 'ch_null_paidon_1', $3)
     RETURNING id`,
    [ccId, 12500, rawId]
  );

  const before = new Date();
  const r = await phase4.promoteSingleLegacyPayment(lp.rows[0].id);
  const after = new Date();
  assert.strictEqual(r.status, 'promoted');
  assert.ok(r.paymentId);

  const pp = await pool.query(
    `SELECT amount, payment_method, legacy_charge_id, created_at
       FROM proposal_payments WHERE id = $1`, [r.paymentId]
  );
  assert.strictEqual(pp.rows[0].amount, 12500);
  assert.strictEqual(pp.rows[0].payment_method, 'card');
  assert.strictEqual(pp.rows[0].legacy_charge_id, 'ch_null_paidon_1');
  // The critical assertion: created_at must NOT be null — DEFAULT NOW() fired.
  assert.ok(pp.rows[0].created_at !== null, 'created_at must not be NULL');
  assert.ok(pp.rows[0].created_at instanceof Date, 'created_at must be a Date');
  // And it should be within the window of this test's execution (NOW() time).
  const ts = pp.rows[0].created_at.getTime();
  assert.ok(
    ts >= before.getTime() - 1000 && ts <= after.getTime() + 1000,
    `created_at ${pp.rows[0].created_at.toISOString()} should be near NOW(), not literal NULL or epoch`
  );
});

test('Phase 4: orphan payment — CSV row matches no proposal → cc_event_id NULL, no promotion', async () => {
  // No proposal seeded. Payment row will not resolve.
  const dir = makeCcDir([
    paymentRow({
      paidOn: pastDate(30), eventDate: futureDate(45), paymentApplied: 200, eventTotal: 999,
      referenceCode: 'ch_orphan_1',
    }),
  ], { tag: 'orphan' });

  const res = await phase4.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  await tagFixtureRawImports();
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.counts.orphans, 1);
  assert.strictEqual(res.counts.payments_promoted, 0);

  // legacy_cc_payments row exists with cc_event_id NULL.
  const lp = await pool.query(
    `SELECT cc_event_id, promoted_payment_id, promoted_refund_id FROM legacy_cc_payments
      WHERE raw_import_id IN (SELECT id FROM legacy_cc_raw_imports WHERE source_file LIKE 'phase4-fixture/%')`
  );
  assert.strictEqual(lp.rowCount, 1);
  assert.strictEqual(lp.rows[0].cc_event_id, null);
  assert.strictEqual(lp.rows[0].promoted_payment_id, null);
  assert.strictEqual(lp.rows[0].promoted_refund_id, null);
});

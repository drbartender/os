#!/usr/bin/env node
'use strict';
/**
 * backfillFullPaymentInvoices.js — one-time repair (spec 2026-08-28 §5).
 *
 * Bookings paid in full on deposit terms carry a paid, locked $100 Deposit
 * invoice and no invoice behind the rest of the money, because the webhook's
 * label-blind link credited the capture onto the send-time Deposit row and the
 * cap dropped the overflow. The code fix (upgradeDepositInvoiceToFull, at all
 * three entrances) stops it happening again; this script corrects the rows
 * already in that shape. Prod dry run 2026-08-28 (evening): 26 by shape, 25 to
 * apply, #633 skipped for its refund. Those counts drift as payments land, so
 * ALWAYS build --expect from a fresh dry run, never from this comment.
 *
 * What is frozen in those locked rows is a recording error, not a true receipt.
 * proposal_payments holds the truth, so each row is rewritten to it:
 *   invoices: label Full Payment, amount_due = amount_paid = the linked payment's amount
 *   invoice_payments: amount = the same (keeps sum(invoice_payments) == invoices.amount_paid)
 *   line items regenerate ONLY when total_price still equals the payment; otherwise the
 *   proposal moved since, and a receipt for a number nobody paid is worse than stale lines
 *   one proposal_activity_log breadcrumb per proposal carrying the FULL before-state
 *
 * Selection is by SHAPE, not a hand-typed list. Exclusions, each a SKIP line on
 * the dry run: external_paid > 0 (the CC-transfer cohort), proposal 600 (legal
 * hold), any proposal_refunds row, a cancelled or archived proposal (its refund
 * figure was computed from the row as it was), a payment whose type is not a
 * contract type, any other succeeded payment on the proposal (the repair is
 * for ONE payment), and a payment above the contract (a hand repair). Line items regenerate only when total_price still equals the
 * payment AND the generated lines sum to it; otherwise the old lines stay.
 *
 * Dry run by default. --apply REQUIRES --expect <ids>: the script refuses to
 * write unless the selected set (after exclusions) equals the expected set
 * exactly. Prints the database host and the mode before anything.
 *
 *   DATABASE_URL=<prod> node server/scripts/backfillFullPaymentInvoices.js                                # dry run
 *   DATABASE_URL=<prod> node server/scripts/backfillFullPaymentInvoices.js --apply --expect 442,450,...   # write
 *
 * Idempotent: an upgraded row is no longer labelled Deposit and is not re-selected.
 * One transaction per proposal: a failure leaves the rest untouched.
 *
 * Exit codes: 0 = clean (a dry run, or every selected proposal applied); 1 = bad
 * arguments, or at least one proposal FAILED and was rolled back; 2 = the selection
 * did not match --expect and nothing was written. After ANY nonzero exit, re-run the
 * dry run before doing anything else. A FAILED proposal was rolled back whole, and
 * its message says which kind it is: "no longer matches" or "acquired" means the
 * shape moved under the run (a payment, refund or edit landed), so the fresh dry
 * run decides whether it is still a candidate; "exceeds contract" or "link set"
 * means the row is not this script's shape and will fail identically every run,
 * so it is a hand repair and must be left out of --expect.
 */
const { pool } = require('../db');
const { toCents } = require('../utils/invoiceShared');
const { generateLineItemsFromProposal, writeLineItems } = require('../utils/invoiceLineItems');

const LEGAL_HOLD_PROPOSAL_IDS = new Set([600]);

const SELECT_SQL = `
  WITH contract AS (
    SELECT i.proposal_id, count(*) AS n, min(i.id) AS invoice_id
      FROM invoices i
     WHERE i.status <> 'void' AND i.label IN ('Deposit', 'Balance', 'Full Payment')
     GROUP BY i.proposal_id
  ), links AS (
    -- ALL link rows, any sign. The rewrite sets the one link and amount_paid to
    -- the same figure, so an invoice with any second row (a legacy reversal, say)
    -- is not this script's shape; the apply-time link-set check refuses the same
    -- thing under the lock, and the selection must never list what the apply
    -- would always refuse, because --expect demands an exact match.
    SELECT ip.invoice_id, count(*) AS n, min(ip.id) AS link_id
      FROM invoice_payments ip
     GROUP BY ip.invoice_id
  )
  SELECT p.id AS proposal_id, c.name AS client_name,
         p.total_price, p.amount_paid, p.external_paid, p.cancelled_at, p.status AS proposal_status,
         i.id AS invoice_id, i.invoice_number, i.label, i.amount_due,
         i.amount_paid AS invoice_amount_paid,
         ip.id AS link_id, ip.amount AS link_amount,
         pp.id AS payment_id, pp.amount AS payment_amount, pp.payment_type,
         (SELECT count(*)::int FROM proposal_refunds r WHERE r.proposal_id = p.id) AS refund_count,
         (SELECT count(*)::int FROM proposal_payments x
           WHERE x.proposal_id = p.id AND x.status = 'succeeded' AND x.id <> pp.id) AS other_payments
    FROM proposals p
    JOIN contract ct ON ct.proposal_id = p.id AND ct.n = 1
    JOIN invoices i ON i.id = ct.invoice_id
                   AND i.label = 'Deposit' AND i.status = 'paid' AND i.locked = true
    JOIN links l ON l.invoice_id = i.id AND l.n = 1
    -- amount > 0 is the codebase's discriminator for a positive credit link
    -- (schema.sql uq_invoice_payments_positive_link, payrollAccrual.js).
    JOIN invoice_payments ip ON ip.id = l.link_id AND ip.amount > 0
    JOIN proposal_payments pp ON pp.id = ip.payment_id AND pp.status = 'succeeded'
    LEFT JOIN clients c ON c.id = p.client_id
   WHERE p.amount_paid >= p.total_price AND p.total_price > 0
     AND pp.amount > i.amount_due
   ORDER BY p.id`;

async function selectCandidates(db) {
  const { rows } = await db.query(SELECT_SQL);
  return rows;
}

function excludeReason(c) {
  if (LEGAL_HOLD_PROPOSAL_IDS.has(Number(c.proposal_id))) return 'legal_hold';
  if (Number(c.external_paid || 0) > 0) return 'external_paid';
  if (Number(c.refund_count || 0) > 0) return 'has_refund';
  // A cancelled booking's refund figure and audit note were computed from the
  // row as it was, and the refund route caps at that snapshot; a relabel that
  // moves the retainer would quietly lower a refund the client was promised.
  if (c.cancelled_at || c.proposal_status === 'archived') return 'cancelled';
  // Contract payment types only: payrollAccrual nets card fees off these, and
  // the rewrite of invoice_payments.amount is fee-neutral for exactly this set
  // and not for 'invoice'. A reason, not a join predicate, so it prints.
  if (!['deposit', 'balance', 'full'].includes(c.payment_type)) return 'non_contract_payment';
  // The repair is "ONE payment landed on a Deposit invoice". Any other
  // succeeded payment on the proposal (a second contract charge, an extras
  // charge that also rolled into amount_paid) makes the shape ambiguous: the
  // linked payment alone may be short of the contract while the proposal
  // reads fully paid. Hand repair.
  if (Number(c.other_payments || 0) > 0) return 'other_payment';
  // A payment above the contract is a hand repair (see the cap in applyCandidate,
  // which re-checks this under the lock). Surfacing it here keeps it out of the
  // --expect set and shows it on the dry run instead of as a FAILED line.
  if (Number(c.payment_amount) > toCents(c.total_price) - toCents(c.external_paid || 0)) return 'exceeds_contract';
  return null;
}

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const i = argv.indexOf('--expect');
  let expect = null;
  if (i >= 0) {
    // Every token must be a bare integer. A typo the old parser silently dropped
    // ("45O" -> NaN -> filtered) or silently accepted (a trailing comma -> id 0)
    // would shrink the operator's list until it happened to match the selection,
    // and the write would proceed against a list nobody actually typed.
    const raw = argv[i + 1];
    if (!raw || raw.startsWith('--')) {
      throw new Error('--expect needs a comma-separated list of proposal ids');
    }
    const tokens = raw.split(',').map((s) => s.trim());
    for (const t of tokens) {
      if (!/^\d+$/.test(t)) throw new Error(`--expect: not a proposal id: "${t}"`);
    }
    expect = new Set(tokens.map(Number));
    // Unreachable while every token must match the pattern above; kept so a future
    // loosening of the token rule cannot quietly produce an empty expectation, which
    // would match an empty selection and "succeed" having written nothing.
    if (expect.size === 0) throw new Error('--expect parsed to an empty set of ids');
  }
  if (apply && !expect) throw new Error('--apply requires --expect <comma-separated proposal ids>');
  return { apply, expect };
}

function describe(c) {
  const regen = toCents(c.total_price) === Number(c.payment_amount);
  return `#${c.proposal_id} ${c.client_name || '(no client)'}: ${c.invoice_number} ${c.label} `
    + `[${c.payment_type || '?'}] `
    + `due ${Number(c.amount_due) / 100} paid ${Number(c.invoice_amount_paid) / 100} `
    + `-> Full Payment due ${Number(c.payment_amount) / 100} paid ${Number(c.payment_amount) / 100}; `
    + `link ${Number(c.link_amount) / 100} -> ${Number(c.payment_amount) / 100}; `
    + `lines ${regen ? 'regenerate if they sum to the payment' : 'LEFT ALONE (total_price moved)'}`;
}

async function applyCandidate(db, c) {
  const paymentCents = Number(c.payment_amount);
  let linesRegenerated = false;
  let skippedReason = null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // The global lock order is proposals -> invoices: every live money rail takes
    // the proposal row first (actions.js, and both Stripe webhook handlers before
    // they touch an invoice). Taking the invoice first here would deadlock this
    // repair against a webhook settling the same booking mid-run.
    const proposalNow = await client.query(
      'SELECT total_price, external_paid FROM proposals WHERE id = $1 FOR UPDATE', [c.proposal_id]
    );
    if (!proposalNow.rows[0]) {
      throw new Error(`proposal ${c.proposal_id} disappeared between selection and apply`);
    }
    const totalPriceAtApply = proposalNow.rows[0].total_price;
    const externalPaidAtApply = proposalNow.rows[0].external_paid;
    // Everything below re-verifies, under the locks, the exact shape the selection
    // matched. A refund or an admin edit landing in that window means the numbers
    // this transaction was built from are stale, and a locked client-visible
    // receipt written from stale numbers is not something a later run can spot.
    // Refuse the proposal instead; the catch rolls it back and the run exits 1.
    if (Number(externalPaidAtApply || 0) !== 0) {
      throw new Error(`proposal ${c.proposal_id} acquired external_paid since selection`);
    }
    // Nothing upstream rejects a payment larger than the contract, and once
    // amount_due == amount_paid the balance-invoice monitor cannot see the
    // overbill either. An overpaid proposal is a hand repair, not this script's.
    const contractCents = toCents(totalPriceAtApply) - toCents(externalPaidAtApply || 0);
    if (paymentCents > contractCents) {
      throw new Error(`proposal ${c.proposal_id}: payment ${paymentCents} exceeds contract ${contractCents}; repair by hand`);
    }
    const before = await client.query(
      'SELECT label, amount_due, amount_paid, status, locked FROM invoices WHERE id = $1 FOR UPDATE',
      [c.invoice_id]
    );
    const inv = before.rows[0];
    if (!inv || inv.label !== 'Deposit' || inv.status !== 'paid' || inv.locked !== true
        || Number(inv.amount_due) !== Number(c.amount_due)
        || Number(inv.amount_paid) !== Number(c.invoice_amount_paid)) {
      throw new Error(`invoice ${c.invoice_id} no longer matches the selected shape at apply time`);
    }
    // proposal_payments holds the truth this script rewrites TO, so it is re-read
    // rather than trusted from the selection row.
    const payNow = await client.query(
      'SELECT amount, status, payment_type FROM proposal_payments WHERE id = $1', [c.payment_id]
    );
    const pay = payNow.rows[0];
    if (!pay || pay.status !== 'succeeded' || Number(pay.amount) !== paymentCents
        || !['deposit', 'balance', 'full'].includes(pay.payment_type)) {
      throw new Error(`payment ${c.payment_id} no longer matches the selected shape at apply time`);
    }
    const othersNow = await client.query(
      `SELECT count(*)::int AS n FROM proposal_payments
        WHERE proposal_id = $1 AND status = 'succeeded' AND id <> $2`,
      [c.proposal_id, c.payment_id]
    );
    if (Number(othersNow.rows[0].n) !== 0) {
      throw new Error(`proposal ${c.proposal_id} acquired another payment since selection`);
    }
    // The WHOLE link set for the invoice, not just the selected row: the rewrite
    // below assumes the invoice carries exactly one link, because it sets that
    // link and invoices.amount_paid to the same figure and the reconciliation
    // invariant is sum(invoice_payments) == amount_paid. A second row of any
    // sign would break the invariant on write. Both locks held above cover this
    // read: linkPaymentToInvoice locks the invoice before it inserts, and
    // applyRefundReconciliation locks the proposal before it inserts a reversal.
    const linkNow = await client.query(
      'SELECT id, payment_id, amount FROM invoice_payments WHERE invoice_id = $1 ORDER BY id', [c.invoice_id]
    );
    const link = linkNow.rows[0];
    if (linkNow.rows.length !== 1 || Number(link.id) !== Number(c.link_id)
        || Number(link.payment_id) !== Number(c.payment_id)
        || Number(link.amount) !== Number(c.link_amount)) {
      throw new Error(`invoice ${c.invoice_id} link set no longer matches the selected shape at apply time (${linkNow.rows.length} link rows)`);
    }
    // ct.n = 1 is the one selection predicate nothing above re-checks: a Balance
    // invoice minted between selection and apply (the deposit rail's
    // createBalanceInvoice serializes around this transaction, not inside it)
    // would sit open beside a Full Payment carrying the whole payment, billing
    // the same money twice.
    const contractNow = await client.query(
      `SELECT id FROM invoices
        WHERE proposal_id = $1 AND status <> 'void' AND label IN ('Deposit', 'Balance', 'Full Payment')
        ORDER BY id`,
      [c.proposal_id]
    );
    if (contractNow.rows.length !== 1 || Number(contractNow.rows[0].id) !== Number(c.invoice_id)) {
      throw new Error(`proposal ${c.proposal_id} contract invoice set no longer matches the selected shape at apply time (${contractNow.rows.length} rows)`);
    }
    const refundNow = await client.query(
      'SELECT 1 FROM proposal_refunds WHERE proposal_id = $1 LIMIT 1', [c.proposal_id]
    );
    if (refundNow.rowCount) {
      throw new Error(`proposal ${c.proposal_id} acquired a refund since selection`);
    }
    // The regenerate decision is made HERE, under the locks, from the total this
    // transaction read, not from the one the selection saw. A total that moved
    // between selection and apply must not regenerate lines to a number nobody
    // paid. describe() still previews from the selection-time value: a dry run
    // cannot know any better, and it only prints.
    linesRegenerated = toCents(totalPriceAtApply) === paymentCents;
    skippedReason = linesRegenerated ? null : 'total_moved';
    const priorLines = (await client.query(
      'SELECT description, quantity, unit_price, line_total, source_type, source_id FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id',
      [c.invoice_id]
    )).rows;
    await client.query(
      `UPDATE invoices SET label = 'Full Payment', amount_due = $1, amount_paid = $1 WHERE id = $2`,
      [paymentCents, c.invoice_id]
    );
    await client.query('UPDATE invoice_payments SET amount = $1 WHERE id = $2', [paymentCents, c.link_id]);
    // Both live entrances stamp payment_type = 'full' when a full payment
    // lands; a row left at 'deposit' would mint a fresh Deposit invoice on an
    // archive-to-draft-to-sent recovery, the exact hazard the stamp prevents.
    const stamped = await client.query(
      "UPDATE proposals SET payment_type = 'full' WHERE id = $1 AND payment_type = 'deposit'", [c.proposal_id]
    );
    if (linesRegenerated) {
      const items = await generateLineItemsFromProposal(c.proposal_id, client);
      // The generator builds from pricing_snapshot + addons and never reads
      // total_price_override, so on an override'd or legacy-snapshot proposal its
      // lines can sum to something other than the money actually collected.
      // Writing those would leave a locked, client-visible invoice whose lines
      // contradict its own amount_due, which is worse than stale lines.
      const generatedCents = items.reduce((sum, it) => sum + Number(it.line_total), 0);
      if (generatedCents === paymentCents) {
        await writeLineItems(c.invoice_id, items, client);
      } else {
        linesRegenerated = false;
        skippedReason = 'generated_sum_mismatch';
      }
    }
    await client.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'invoice_backfilled_to_full', 'system', $2)`,
      [c.proposal_id, JSON.stringify({
        invoice_id: c.invoice_id,
        invoice_number: c.invoice_number,
        from_label: inv.label,
        from_amount_due: Number(inv.amount_due),
        from_amount_paid: Number(inv.amount_paid),
        from_link_amount: Number(c.link_amount),
        from_line_items: priorLines,
        to_amount_due: paymentCents,
        total_price_at_apply: totalPriceAtApply,
        lines_regenerated: linesRegenerated,
        lines_skipped_reason: skippedReason,
        payment_type_stamped: stamped.rowCount === 1,
      })]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    client.release();
  }
  return { linesRegenerated, linesSkippedReason: skippedReason };
}

async function main(argv = process.argv, deps = {}) {
  // deps is a test seam only: production always takes the module pool and the real
  // applyCandidate, so the defaults are the whole story for the runbook.
  const { db = pool, applyOne = applyCandidate } = deps;
  const { apply, expect } = parseArgs(argv);
  let host = '(unknown)';
  try { host = new URL(process.env.DATABASE_URL).host; } catch { /* leave unknown */ }
  console.log(`backfillFullPaymentInvoices: host=${host} mode=${apply ? 'APPLY' : 'dry run'}`);

  const candidates = await selectCandidates(db);
  const todo = [];
  for (const c of candidates) {
    const why = excludeReason(c);
    if (why) { console.log(`SKIP  ${describe(c)}  [${why}]`); continue; }
    // WOULD even under --apply: nothing is decided until --expect matches.
    console.log(`WOULD ${describe(c)}`);
    todo.push(c);
  }
  console.log(`${todo.length} selected, ${candidates.length - todo.length} skipped.`);

  if (expect) {
    const got = new Set(todo.map((c) => Number(c.proposal_id)));
    const missing = [...expect].filter((id) => !got.has(id));
    const extra = [...got].filter((id) => !expect.has(id));
    if (missing.length || extra.length) {
      console.error(`REFUSING: selection does not match --expect. missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
      process.exitCode = 2;
      return;
    }
    console.log('--expect matches the selection exactly.');
  }
  if (!apply) return;

  let ok = 0;
  for (const c of todo) {
    try {
      const r = await applyOne(db, c);
      ok += 1;
      const why = r.linesRegenerated ? 'regenerated' : `left alone: ${r.linesSkippedReason}`;
      console.log(`  done #${c.proposal_id} (lines ${why})`);
    } catch (err) {
      console.error(`  FAILED #${c.proposal_id}: ${err.message}`);
    }
  }
  console.log(`${ok}/${todo.length} applied.`);
  // A rolled-back proposal must not look like a clean run to whatever called this.
  if (ok < todo.length) process.exitCode = 1;
}

module.exports = { selectCandidates, excludeReason, applyCandidate, parseArgs, main };

if (require.main === module) {
  main().then(() => pool.end()).catch((err) => {
    console.error(err);
    pool.end().finally(() => process.exit(1));
  });
}

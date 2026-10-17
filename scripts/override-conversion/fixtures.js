'use strict';
// Synthetic fixture rows for the override conversion's DB tests and its dev
// rehearsal (plan 2026-10-16-price-override-removal, Tasks V1, V3, V4).
// Synthetic labels and amounts only; every row hangs off one synthetic client
// and one synthetic package, and cleanup deletes them in foreign-key order.
// Never used against prod; the callers refuse NODE_ENV=production.

const { calculateProposal } = require('../../server/utils/pricingEngine');

async function createFixtureContext(db, nonce) {
  const c = await db.query('INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`Conversion Fixture ${nonce}`, `${nonce}@example.test`]);
  const p = await db.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        extra_hour_rate, extra_hour_rate_small, min_guests, guests_per_bartender, bar_type, includes,
        first_bar_fee, additional_bar_fee)
     VALUES ($1, 'Conversion Fixture Pkg', 'hosted', 'per_guest', 30, 35, 6, 7, 50, 100, 'full_bar', '[]', 75, 125)
     RETURNING id`, [`conv-${nonce}`]);
  const pkg = (await db.query('SELECT * FROM service_packages WHERE id = $1', [p.rows[0].id])).rows[0];
  return { nonce, clientId: c.rows[0].id, pkg, proposalIds: [], refundIds: [], invoiceIds: [], changeRequestIds: [] };
}

// The engine's snapshot for a fixture's inputs (the shape every writer stores).
function priceFixture(ctx, {
  guestCount = 120, hours = 4, numBars = 1, numBartenders = null, syrups = [], adjustments = [],
  override = null, gratuityRate = 0, tipJar = true,
} = {}) {
  return calculateProposal({
    pkg: ctx.pkg, guestCount, durationHours: hours, numBars, numBartenders, addons: [],
    syrupSelections: syrups, adjustments, totalPriceOverride: override,
    gratuityRate, tipJar, gratuityFloorRate: null,
  });
}

/**
 * Insert one proposal. `snapshot` defaults to the engine's price for the
 * inputs; `totalPrice` defaults to that snapshot's total. Pass `packageId:
 * null` for a row with no package.
 */
async function insertProposal(db, ctx, opts = {}) {
  const {
    status = 'confirmed', guestCount = 120, hours = 4, numBars = 1, numBartenders = null, syrups = [],
    adjustments = [], override = null, gratuityRate = 0, tipJar = true, amountPaid = 0,
  } = opts;
  const snapshot = opts.snapshot !== undefined ? opts.snapshot
    : priceFixture(ctx, { guestCount, hours, numBars, numBartenders, syrups, adjustments, override, gratuityRate, tipJar });
  const totalPrice = opts.totalPrice !== undefined ? opts.totalPrice : snapshot.total;
  const packageId = opts.packageId !== undefined ? opts.packageId : ctx.pkg.id;
  const { rows } = await db.query(
    `INSERT INTO proposals
       (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, num_bartenders, adjustments,
        total_price, total_price_override, amount_paid, gratuity_rate, tip_jar, pricing_snapshot)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', $3, 'America/Chicago',
             $4, 'birthday-party', $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14::jsonb)
     RETURNING id`,
    [ctx.clientId, packageId, hours, status, guestCount, numBars, numBartenders,
      adjustments === null ? null : JSON.stringify(adjustments),
      totalPrice, override, amountPaid, gratuityRate, tipJar, JSON.stringify(snapshot)]);
  ctx.proposalIds.push(rows[0].id);
  return rows[0].id;
}

async function insertRefund(db, ctx, {
  proposalId, amountCents, scope = 'contract', before, after, status = 'succeeded', createdAt = null,
}) {
  const { rows } = await db.query(
    `INSERT INTO proposal_refunds (proposal_id, amount, reason, total_price_before, total_price_after, status, total_scope, created_at)
     VALUES ($1, $2, 'conversion fixture', $3, $4, $5, $6, COALESCE($7::timestamptz, NOW())) RETURNING id`,
    [proposalId, amountCents, before, after, status, scope, createdAt]);
  ctx.refundIds.push(rows[0].id);
  return rows[0].id;
}

async function insertInvoice(db, ctx, { proposalId, label = 'Additional Services', amountDue = 5000, createdAt = null }) {
  const { rows } = await db.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, status, created_at)
     VALUES ($1, $2, $3, $4, 'sent', COALESCE($5::timestamptz, NOW())) RETURNING id`,
    [proposalId, `CV-${ctx.nonce.slice(-8)}-${ctx.invoiceIds.length}`, label, amountDue, createdAt]);
  ctx.invoiceIds.push(rows[0].id);
  return rows[0].id;
}

async function insertChangeRequest(db, ctx, { proposalId, status = 'pending' }) {
  const { rows } = await db.query(
    `INSERT INTO proposal_change_requests (proposal_id, status, edit_window) VALUES ($1, $2, 'before_t14') RETURNING id`,
    [proposalId, status]);
  ctx.changeRequestIds.push(rows[0].id);
  return rows[0].id;
}

async function cleanupFixtures(db, ctx) {
  if (!ctx) return;
  const ids = ctx.proposalIds;
  if (ids.length) {
    await db.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [ids]);
    await db.query('DELETE FROM proposal_change_requests WHERE proposal_id = ANY($1)', [ids]);
    await db.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1))', [ids]);
    await db.query('DELETE FROM invoices WHERE proposal_id = ANY($1)', [ids]);
    await db.query('DELETE FROM proposal_refunds WHERE proposal_id = ANY($1)', [ids]);
    await db.query('DELETE FROM proposal_addons WHERE proposal_id = ANY($1)', [ids]);
    await db.query('DELETE FROM proposals WHERE id = ANY($1)', [ids]);
  }
  if (ctx.pkg) await db.query('DELETE FROM service_packages WHERE id = $1', [ctx.pkg.id]);
  if (ctx.clientId) await db.query('DELETE FROM clients WHERE id = $1', [ctx.clientId]);
}

const minus = (snap, c) => (Math.round(snap.total * 100) - c) / 100;

// A row whose Refund line names a real refund row (step 1 wrote it), with
// `driftCents` of snapshot drift on top (the 59 shape) or none.
async function plantRefundLine(db, ctx, { cents, driftCents }) {
  const pid = await insertProposal(db, ctx, { status: 'confirmed' });
  const rid = await insertRefund(db, ctx, { proposalId: pid, amountCents: cents, before: 1000, after: 1000 - cents / 100 });
  const adj = [{ type: 'discount', label: 'Refund', amount: cents / 100, visible: true, source: 'refund', refund_id: rid }];
  const snap = priceFixture(ctx, { adjustments: adj });
  await db.query('UPDATE proposals SET adjustments = $2::jsonb, pricing_snapshot = $3::jsonb, total_price = $4 WHERE id = $1',
    [pid, JSON.stringify(adj), JSON.stringify(snap), minus(snap, driftCents)]);
  return pid;
}

/**
 * One synthetic booking of every shape the conversion handles (plan Task V2's
 * list), for the DO block suite and the dev rehearsal. Returns the ids by
 * shape; `held` is meant to be added to the legal-hold refusal by the caller.
 * Shapes that convert: live, liveGrat, terminal, existing, s527, even,
 * termGrat, noBreakdown, noGratuity, nullLines, noSnapLines, backfill, focus4. Shapes that must not:
 * step1, s59, gapZero, unequal, mismatch, held.
 */
async function seedEveryShape(db, ctx) {
  const id = {};
  const base = priceFixture(ctx);
  const ins = (opts) => insertProposal(db, ctx, opts);
  id.live = await ins({ status: 'confirmed', override: 2000, syrups: ['jalapeno'],
    adjustments: [{ type: 'discount', label: 'Test discount A', amount: '25.00', visible: true }] });
  id.liveGrat = await ins({ status: 'deposit_paid', override: 3000, gratuityRate: 25 });
  id.terminal = await ins({ status: 'archived', override: 1500 });
  id.existing = await ins({ status: 'completed', override: 2500, adjustments: [
    { type: 'discount', label: 'Test discount B', amount: 200, visible: true },
    { type: 'discount', label: 'Test discount C', amount: '37.50', visible: false }] });
  id.s527 = await ins({ status: 'completed', override: 1700, totalPrice: 1700, snapshot: priceFixture(ctx, { override: 1800 }) });
  await insertRefund(db, ctx, { proposalId: id.s527, amountCents: 10000, before: 1800, after: 1700 });
  id.even = await ins({ status: 'archived', override: base.subtotal });
  id.termGrat = await ins({ status: 'archived', override: 1600, gratuityRate: 25 });
  const noBd = priceFixture(ctx, { override: 1500 });
  delete noBd.breakdown;
  id.noBreakdown = await ins({ status: 'archived', override: 1500, snapshot: noBd });
  const noGrat = priceFixture(ctx, { override: 1500 });
  delete noGrat.gratuity;
  id.noGratuity = await ins({ status: 'completed', override: 1500, snapshot: noGrat });
  id.nullLines = await ins({ status: 'archived', override: 1500, adjustments: null }); // SQL NULL lines
  const noLines = priceFixture(ctx, { override: 1500 });
  delete noLines.adjustments;
  id.noSnapLines = await ins({ status: 'completed', override: 1500, snapshot: noLines }); // no adjustments key
  id.backfill = await ins({ status: 'balance_paid', snapshot: base, totalPrice: minus(base, 8000) });
  await insertRefund(db, ctx, { proposalId: id.backfill, amountCents: 5000, before: 3000, after: 2950, createdAt: '2026-09-01T00:00:00Z' });
  await insertRefund(db, ctx, { proposalId: id.backfill, amountCents: 3000, before: 2950, after: 2920, createdAt: '2026-09-02T00:00:00Z' });
  id.focus4 = await ins({ status: 'balance_paid', snapshot: base, totalPrice: minus(base, 4000) });
  await insertRefund(db, ctx, { proposalId: id.focus4, amountCents: 2500, scope: 'overpayment', before: 2000, after: 2000 });
  await insertRefund(db, ctx, { proposalId: id.focus4, amountCents: 4000, before: 2000, after: 1960 });
  id.step1 = await plantRefundLine(db, ctx, { cents: 4000, driftCents: 0 });
  id.s59 = await plantRefundLine(db, ctx, { cents: 2000, driftCents: 3300 });
  id.gapZero = await ins({ status: 'confirmed' });
  await insertRefund(db, ctx, { proposalId: id.gapZero, amountCents: 6000, before: 2000, after: 1940, createdAt: '2026-09-05T00:00:00Z' });
  await insertInvoice(db, ctx, { proposalId: id.gapZero, amountDue: 6000 });
  id.unequal = await ins({ status: 'confirmed', snapshot: base, totalPrice: minus(base, 7000) });
  await insertRefund(db, ctx, { proposalId: id.unequal, amountCents: 5000, before: 2000, after: 1950 });
  id.mismatch = await ins({ status: 'archived', override: 1400, adjustments: [],
    snapshot: priceFixture(ctx, { override: 1400, adjustments: [{ type: 'discount', label: 'Test discount D', amount: 10, visible: true }] }) });
  id.held = await ins({ status: 'archived', override: 1500 });
  return id;
}

module.exports = {
  createFixtureContext, priceFixture, insertProposal, insertRefund, insertInvoice, insertChangeRequest, cleanupFixtures,
  seedEveryShape,
};

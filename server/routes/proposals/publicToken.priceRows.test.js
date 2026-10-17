// The public proposal payload's price_rows and the fold report (spec
// 2026-10-16 sections 4.1 and 4.2; plan Task C4). Calls
// buildPublicProposalPayload directly (no HTTP), like
// publicToken.additionalTime.test.js. Runs against the dev DB; creates real
// rows and purges them in after(). Synthetic labels and amounts.
//
// The report: Sentry hears, by proposal id only and at most once per proposal
// per process, when the rows fall back to a "Pricing adjustment" row, when a
// snapshot with a total has no package row, or when the gap the rows fold is
// not explained by the hidden lines on a booking without an override.

require('dotenv').config();

// The captures are DSN-gated, so a DSN is set (or every capture silently
// no-ops and the assertions pass for the wrong reason), and the stub lands
// before publicToken.js is required.
process.env.SENTRY_DSN_SERVER = process.env.SENTRY_DSN_SERVER || 'https://test@example.invalid/1';
const sentryMessages = [];
const sentryModule = require('@sentry/node');
sentryModule.captureMessage = (msg, ctx) => { sentryMessages.push({ msg, ctx }); };
sentryModule.captureException = (err, ctx) => { sentryMessages.push({ msg: String(err && err.message), ctx }); };

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../../db');
const { buildPublicProposalPayload } = require('./publicToken');

if (process.env.NODE_ENV === 'production') {
  throw new Error('publicToken.priceRows.test.js refuses to run against production');
}

const createdProposalIds = new Set();
const createdClientIds = new Set();
let clientId;
let pkg;

// subtotal 500 + 40 + 60 = 600; a visible 15 discount; a hidden 35 discount.
function snapshotWith({ adjustments, total, override = null, gratuity = 0, withPackage = true }) {
  return {
    ...(withPackage ? { package: { id: pkg.id, name: pkg.name, base_cost: 500 } } : {}),
    staffing: { actual: 1, extra: 0, total: 0 },
    bar_rental: { num_bars: 1, total: 40 },
    addons: [{ name: 'Test Rows Add-on', line_total: 60 }],
    syrups: { total: 0 },
    adjustments,
    breakdown: adjustments.map((a) => ({ label: a.label, amount: a.type === 'discount' ? -a.amount : a.amount })),
    gratuity: { total: gratuity, staff_count: 1, hours: 4 },
    total_price_override: override,
    subtotal: 600,
    total,
  };
}
const VISIBLE = { type: 'discount', label: 'Test shown discount', amount: 15, visible: true };
const HIDDEN = { type: 'discount', label: 'Test rows hidden', amount: 35, visible: false };

async function insertProposal(snapshot, { override = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO proposals
       (client_id, token, package_id, guest_count, event_duration_hours, num_bars,
        pricing_snapshot, total_price, total_price_override, payment_type, status)
     VALUES ($1, $2, $3, 100, 4, 1, $4, $5, $6, 'full', 'viewed')
     RETURNING id, token`,
    [clientId, crypto.randomUUID(), pkg.id, JSON.stringify(snapshot), snapshot.total ?? 0, override]
  );
  createdProposalIds.add(rows[0].id);
  return rows[0];
}

const reportsFor = (id) => sentryMessages.filter((m) => m.ctx && m.ctx.extra && m.ctx.extra.proposalId === id);

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    ['Price Rows Test', `pricerows+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`]
  );
  clientId = c.rows[0].id;
  createdClientIds.add(clientId);
  const p = await pool.query(
    `SELECT id, name FROM service_packages WHERE category = 'byob' AND is_active = true ORDER BY id LIMIT 1`);
  pkg = p.rows[0];
  assert.ok(pkg, 'the dev catalog carries a BYOB package');
});

after(async () => {
  if (createdProposalIds.size > 0) {
    const ids = [...createdProposalIds];
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids]);
  }
  if (createdClientIds.size > 0) {
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [[...createdClientIds]]);
  }
  await pool.end();
});

test('the payload carries the folded rows, labeled with the package name the page uses', async () => {
  const p = await insertProposal(snapshotWith({ adjustments: [VISIBLE, HIDDEN], total: 550 }));
  const payload = await buildPublicProposalPayload(p.token);
  assert.deepEqual(payload.price_rows, [
    { key: 'package', label: pkg.name, amount: 465 },          // 500 less the hidden 35
    { key: 'bar-rental', label: 'Bar Rental', amount: 40 },
    { key: 'addon-0', label: 'Test Rows Add-on', amount: 60 },
    { key: 'adjustment-0', label: 'Test shown discount', amount: -15 },
  ]);
  assert.equal(payload.package_name, pkg.name);
  assert.ok(!('fold' in payload) && !JSON.stringify(payload).includes('gapCents'), 'the fold never leaves (decision 6)');
  assert.deepEqual(reportsFor(p.id), [], 'a fold the hidden lines explain is silent');
});

test('a client gratuity stays out of the rows; the page adds it', async () => {
  const p = await insertProposal(snapshotWith({ adjustments: [HIDDEN], total: 765, gratuity: 200 }));
  const payload = await buildPublicProposalPayload(p.token);
  const cents = payload.price_rows.reduce((s, r) => s + Math.round(r.amount * 100), 0);
  assert.equal(cents, 56500, 'rows reach snapshot.total less gratuity');
  assert.ok(!payload.price_rows.some((r) => /gratuity/i.test(String(r.label))));
  assert.equal(payload.pricing_snapshot.gratuity.total, 200, 'the gratuity block is kept for the page');
});

test('a fallback is reported once per proposal, by id only', async () => {
  // Hidden 900 against a 500 package row: one Pricing adjustment row carries it.
  const big = { ...HIDDEN, amount: 900 };
  const p = await insertProposal(snapshotWith({ adjustments: [big], total: 0 }));
  const first = await buildPublicProposalPayload(p.token);
  await buildPublicProposalPayload(p.token);
  assert.equal(first.price_rows.at(-1).label, 'Pricing adjustment');
  assert.equal(first.price_rows.reduce((s, r) => s + Math.round(r.amount * 100), 0), 0);
  const seen = reportsFor(p.id);
  assert.equal(seen.length, 1, 'throttled to one report per proposal per process');
  assert.equal(seen[0].msg, 'public_rows_fold_fallback');
  // The whole context, exactly: the proposal id and nothing else, no amounts.
  assert.deepEqual(seen[0].ctx, {
    level: 'warning',
    tags: { route: 'proposals/public', step: 'price_rows' },
    extra: { proposalId: p.id },
  });
});

test('a snapshot with a total and no package row is reported', async () => {
  const p = await insertProposal(snapshotWith({ adjustments: [], total: 100, withPackage: false }));
  const payload = await buildPublicProposalPayload(p.token);
  assert.deepEqual(payload.price_rows, [], 'no package: no rows, as the page drew none');
  assert.deepEqual(reportsFor(p.id).map((m) => m.msg), ['public_rows_no_package']);
});

test('a gap the snapshot does not explain is reported; an override explains its own', async () => {
  // The snapshot says its parts come to 600, but they come to 580: drift.
  const driftSnap = snapshotWith({ adjustments: [], total: 600 });
  driftSnap.addons = [{ name: 'Test Rows Add-on', line_total: 40 }];
  const drift = await insertProposal(driftSnap);
  await buildPublicProposalPayload(drift.token);
  assert.deepEqual(reportsFor(drift.id).map((m) => m.msg), ['public_rows_unexplained_gap']);
  // An override's difference is the snapshot's own arithmetic: silent.
  const over = await insertProposal(snapshotWith({ adjustments: [], total: 480, override: 480 }), { override: 480 });
  const payload = await buildPublicProposalPayload(over.token);
  assert.equal(payload.price_rows.reduce((s, r) => s + Math.round(r.amount * 100), 0), 48000);
  assert.deepEqual(reportsFor(over.id), []);
});

test('a comped booking the engine clamped at $0 is silent, not unexplained', async () => {
  // A visible 700 discount against a 600 subtotal: the engine clamps the total
  // at 0, so the rows run to -100 and the fold lifts them back to $0.
  const p = await insertProposal(snapshotWith({
    adjustments: [{ type: 'discount', label: 'Test big discount', amount: 700, visible: true }], total: 0,
  }));
  const payload = await buildPublicProposalPayload(p.token);
  assert.equal(payload.price_rows.reduce((s, r) => s + Math.round(r.amount * 100), 0), 0, 'the rows reach $0');
  assert.deepEqual(reportsFor(p.id), [], 'the clamp is explained by the snapshot');
});

test('the reporter is shared: its own route tag, once per proposal per route, the id only', () => {
  const { reportPriceRowsFold } = require('./publicToken');
  const id = 987654321; // synthetic: the reporter keys on it and sends it, nothing reads the DB
  const fallback = { applied: 'fallback', gapCents: -1, hiddenNetCents: -1, explainedCents: -1, unexplainedCents: 0 };
  reportPriceRowsFold(id, fallback, 3, { route: 'client-portal' });
  reportPriceRowsFold(id, fallback, 3, { route: 'client-portal' });
  reportPriceRowsFold(id, fallback, 3);
  assert.deepEqual(reportsFor(id).map((m) => m.ctx), [
    { level: 'warning', tags: { route: 'client-portal', step: 'price_rows' }, extra: { proposalId: id } },
    { level: 'warning', tags: { route: 'proposals/public', step: 'price_rows' }, extra: { proposalId: id } },
  ]);
  // Nothing to report: silent.
  reportPriceRowsFold(id + 1, { applied: 'package', gapCents: -500, hiddenNetCents: -500, explainedCents: -500, unexplainedCents: 0 }, 3);
  assert.deepEqual(reportsFor(id + 1), []);
});

test('an empty snapshot: no rows, no report, nothing invented', async () => {
  const { rows } = await pool.query(
    `INSERT INTO proposals (client_id, token, package_id, guest_count, event_duration_hours, num_bars, status)
     VALUES ($1, $2, $3, 100, 4, 1, 'viewed') RETURNING id, token`,
    [clientId, crypto.randomUUID(), pkg.id]
  );
  createdProposalIds.add(rows[0].id);
  const payload = await buildPublicProposalPayload(rows[0].token);
  assert.deepEqual(payload.price_rows, []);
  assert.deepEqual(payload.pricing_snapshot, {});
  assert.deepEqual(reportsFor(rows[0].id), []);
});

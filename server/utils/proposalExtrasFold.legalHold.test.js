require('dotenv').config();

// The legal-hold guard in the extras fold (plan 2026-10-16-price-override-removal,
// Task F1; spec section 5.3). foldExtrasIntoProposal is the one client-triggered
// re-pricing writer: drink-plan submit, the Enhancement Lab and cancel-line all
// reach it. A held booking keeps the price it has, so the fold refuses a held
// row FIRST, before it issues a single query, with the client-facing
// ConflictError("This booking can't be changed online right now.",
// 'NOT_CHANGEABLE') (plan decision 4: a client-facing refusal never names the
// hold). The fold has no request value to read: the guard binds on the id of
// the row its caller loaded FOR UPDATE, an integer from pg.
//
// A throw from the fold leaves the caller's own earlier writes in its open
// transaction. Each production caller rolls them back:
//   - server/utils/lineItemCancel.js:627, after the per-kind write, inside the
//     transaction runCore opens; runCore ROLLBACKs at
//     server/routes/proposals/cancelLineItem.js:69 and rethrows (preview and
//     execute share it).
//   - server/routes/drinkPlans/submit.js:450, after the plan UPDATE and the
//     add-on upserts; the txErr catch ROLLBACKs at submit.js:605 and rethrows.
//   - server/routes/drinkPlans/lab.js:344, after the selections UPDATE and the
//     lab-owned add-on rows; the outer catch ROLLBACKs at lab.js:522 and
//     rethrows.
//
// Held ids are synthetic, ADDED through __setLegalHoldIdsForTest; nothing here
// reads or writes a real held booking. Each test runs in its own transaction
// and rolls back. Run ALONE against the shared dev DB:
//   node --test server/utils/proposalExtrasFold.legalHold.test.js
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const { foldExtrasIntoProposal, loadRepriceAddons } = require('./proposalExtrasFold');
const { calculateProposal } = require('./pricingEngine');
const { __setLegalHoldIdsForTest } = require('./legalHold');

if (process.env.NODE_ENV === 'production') {
  throw new Error('proposalExtrasFold.legalHold.test.js refuses to run against production');
}

const NONCE = `foldhold-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const TRAVEL = Object.freeze([{ type: 'surcharge', label: 'Test surcharge A', amount: 100, visible: true }]);
const REFUSAL = "This booking can't be changed online right now.";
const cents = (n) => Math.round(Number(n) * 100);

let clientId;
let pkg;
let nativeId;
let overrideId;

before(async () => {
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`Fold Hold ${NONCE}`, `${NONCE}@example.test`]
  );
  clientId = c.rows[0].id;
  const pkgIns = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        min_guests, guests_per_bartender, bar_type, includes)
     VALUES ($1, 'Fold Hold Test Pkg', 'hosted', 'per_guest', 28, 33, 50, 100, 'full_bar', '[]')
     RETURNING id`,
    [NONCE]
  );
  pkg = (await pool.query('SELECT * FROM service_packages WHERE id = $1', [pkgIns.rows[0].id])).rows[0];

  const insert = async (override) => {
    const snap = calculateProposal({
      pkg, guestCount: 80, durationHours: 4, numBars: 0, numBartenders: null,
      addons: [], syrupSelections: [], adjustments: TRAVEL,
      totalPriceOverride: override, gratuityRate: 0, tipJar: true,
    });
    const p = await pool.query(
      `INSERT INTO proposals
         (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
          status, event_type, guest_count, num_bars, num_bartenders, adjustments,
          total_price, total_price_override, amount_paid, gratuity_rate, tip_jar, pricing_snapshot)
       VALUES ($1, $2, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
               'deposit_paid', 'birthday-party', 80, 0, NULL, $3::jsonb,
               $4, $5, 100, 0, true, $6::jsonb)
       RETURNING id`,
      [clientId, pkg.id, JSON.stringify(TRAVEL), snap.total, override, JSON.stringify(snap)]
    );
    return p.rows[0].id;
  };
  nativeId = await insert(null);
  overrideId = await insert(2000);
});

afterEach(() => __setLegalHoldIdsForTest(null));

after(async () => {
  __setLegalHoldIdsForTest(null);
  for (const id of [nativeId, overrideId].filter(Boolean)) {
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
  if (pkg) await pool.query('DELETE FROM service_packages WHERE id = $1', [pkg.id]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

// The seeded event priced at catalog with the given adjustments.
function catalogAt(adjustments) {
  return calculateProposal({
    pkg, guestCount: 80, durationHours: 4, numBars: 0, numBartenders: null,
    addons: [], syrupSelections: [], adjustments,
    totalPriceOverride: null, gratuityRate: 0, tipJar: true,
  });
}

// Lock the row, run fn, roll back: nothing persists on the shared dev DB.
async function inTx(proposalId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = (await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [proposalId])).rows[0];
    return await fn(client, p);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

// A client that records every query the fold sends, then forwards it.
function recording(client) {
  const sent = [];
  return {
    sent,
    client: {
      query: (...args) => {
        sent.push(typeof args[0] === 'string' ? args[0] : args[0] && args[0].text);
        return client.query(...args);
      },
    },
  };
}

// A fold that would move money: the surcharge comes off.
async function removeSurcharge(client, proposal) {
  const addons = await loadRepriceAddons(client, proposal.id);
  return foldExtrasIntoProposal({
    client, proposal, pkg,
    addonsBefore: addons, addonsAfter: addons,
    syrupsBefore: [], syrupsAfter: [],
    numBarsBefore: 0, numBarsAfter: 0,
    adjustmentsBefore: TRAVEL, adjustmentsAfter: [],
    statusChangeReason: 'legal hold test',
  });
}

const MONEY_COLS = `SELECT total_price, total_price_override, pricing_snapshot, adjustments, status, updated_at
                      FROM proposals WHERE id = $1`;

for (const [shape, idOf] of [['native', () => nativeId], ['override', () => overrideId]]) {
  test(`a held ${shape} booking is refused before the fold sends a single query`, async () => {
    const proposalId = idOf();
    __setLegalHoldIdsForTest([proposalId]);
    await inTx(proposalId, async (client, proposal) => {
      const beforeRow = (await client.query(MONEY_COLS, [proposalId])).rows[0];
      const beforeLog = (await client.query(
        'SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1', [proposalId])).rows[0].n;
      const rec = recording(client);
      await assert.rejects(
        foldExtrasIntoProposal({
          client: rec.client, proposal, pkg,
          addonsBefore: [], addonsAfter: [],
          syrupsBefore: [], syrupsAfter: [],
          numBarsBefore: 0, numBarsAfter: 0,
          adjustmentsBefore: TRAVEL, adjustmentsAfter: [],
          statusChangeReason: 'legal hold test',
        }),
        (err) => {
          assert.equal(err.name, 'ConflictError');
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'NOT_CHANGEABLE');
          assert.equal(err.message, REFUSAL);
          assert.doesNotMatch(err.message, /legal|hold/i, 'a client-facing refusal never names the hold');
          return true;
        }
      );
      assert.deepEqual(rec.sent, [], 'the guard runs before any read or write');
      // Read inside the same open transaction: an uncommitted fold write would show here.
      assert.deepEqual((await client.query(MONEY_COLS, [proposalId])).rows[0], beforeRow);
      assert.equal((await client.query(
        'SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1', [proposalId])).rows[0].n,
      beforeLog);
    });
  });
}

test('the same folds re-price both bookings while another id is held (the hold is per booking)', async () => {
  // The control for the two refusals above: the fixtures and the legs move
  // money, so the refusals are the hold and nothing else.
  __setLegalHoldIdsForTest([Math.max(nativeId, overrideId) + 1000000]);
  await inTx(nativeId, async (client, proposal) => {
    const { snapshot } = await removeSurcharge(client, proposal);
    const row = (await client.query(MONEY_COLS, [nativeId])).rows[0];
    assert.equal(cents(snapshot.total), cents(catalogAt([]).total));
    assert.equal(cents(row.total_price), cents(catalogAt(TRAVEL).total) - 10000, 'the surcharge came off');
    assert.equal(row.total_price_override, null);
  });
  await inTx(overrideId, async (client, proposal) => {
    await removeSurcharge(client, proposal);
    const row = (await client.query(MONEY_COLS, [overrideId])).rows[0];
    assert.equal(cents(row.total_price_override), 190000, 'the override moved by the removed surcharge');
    assert.equal(cents(row.total_price), 190000);
  });
});

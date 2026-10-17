// The conversion's forward and reverse DO blocks (plan
// 2026-10-16-price-override-removal, Task V3; spec 8.5 and 10), run for real on
// synthetic fixtures of every V2 shape: export -> fresh compute -> transform ->
// render -> run.
//
// WHERE IT RUNS: on a Neon branch of dev that this suite creates itself
// (branch.js, parent dev) and deletes in after(), never on the shared dev DB,
// ci-smoke or anything DATABASE_URL names. It points DATABASE_URL at its own
// branch before any server module loads (server/db binds its pool at load) and
// refuses to start if one already loaded. With no Neon key it refuses to run
// rather than fall back. Safe to run anywhere the key is; a crash before
// after() can leave an override-conversion-test-* branch, which
// `node scripts/override-conversion/branch.js --delete <id>` removes.
// Held ids are synthetic (the seam's test setter); nothing here uses a real
// held booking. Run ALONE:
//   node --test scripts/override-conversion/doBlock.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBranch, deleteBranch, discoverApiKey, DEV_BRANCH_ID, BRANCH_PREFIX } = require('./branch');
const { MONEY_MD5_EXPR, readUriFile } = require('./shared');

if (process.env.NODE_ENV === 'production') throw new Error('doBlock.test.js refuses to run against production');

const NONCE = `convblk-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const cents = (n) => Math.round(Number(n) * 100);
const apiKey = discoverApiKey();
let branch = null;
let scratch = null;
let pool;
let ctx;
const id = {};
let planned;
// Loaded only after DATABASE_URL names this suite's own branch.
let __setLegalHoldIdsForTest, calculateSyrupCost, foldExtrasIntoProposal, loadRepriceAddons, fx;
let renderForwardBlock, renderReverseBlock, runTag, confirmConversion;

const MONEY = `SELECT id, total_price, amount_paid, status, total_price_override, adjustments, pricing_snapshot,
                      ${MONEY_MD5_EXPR} AS money_md5 FROM proposals WHERE id = ANY($1) ORDER BY id`;
const money = async (ids = ctx.proposalIds) => new Map((await pool.query(MONEY, [ids])).rows.map((r) => [r.id, r]));
const md5s = async () => [...(await money()).values()].map((r) => `${r.id}:${r.money_md5}`).join(',');

before(async () => {
  if (!apiKey) {
    throw new Error('doBlock.test.js runs its DO blocks only on a Neon branch of dev it creates, and needs NEON_API_KEY '
      + '(or ~/.secrets/neon_api_key); it never falls back to DATABASE_URL');
  }
  if (require.cache[require.resolve('../../server/db')]) throw new Error('server/db loaded before the suite\'s own branch existed');
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-doblock-'));
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  branch = await createBranch({
    apiKey, scratchDir: scratch, parent: DEV_BRANCH_ID, name: `${BRANCH_PREFIX}test-${stamp}-${crypto.randomBytes(2).toString('hex')}`,
  });
  process.env.DATABASE_URL = readUriFile(branch.uriFile);
  ({ pool } = require('../../server/db'));
  ({ __setLegalHoldIdsForTest } = require('../../server/utils/legalHold'));
  ({ calculateSyrupCost } = require('../../server/utils/pricingEngine'));
  ({ foldExtrasIntoProposal, loadRepriceAddons } = require('../../server/utils/proposalExtrasFold'));
  fx = require('./fixtures');
  const { exportConversion } = require('./export');
  const { computeFresh } = require('./freshCompute');
  const { planConversion } = require('./transform');
  ({ renderForwardBlock, renderReverseBlock, runTag } = require('./doBlock'));
  ({ confirmConversion } = require('./confirm'));

  ctx = await fx.createFixtureContext(pool, NONCE);
  Object.assign(id, await fx.seedEveryShape(pool, ctx));
  __setLegalHoldIdsForTest([id.held]);
  const client = await pool.connect();
  try {
    const exp = await exportConversion(client, { onlyIds: ctx.proposalIds });
    const fresh = await computeFresh(client, exp.rows);
    planned = planConversion({ rows: exp.rows, fresh, legalHoldIds: [] });
  } finally {
    client.release();
  }
});

after(async () => {
  try {
    if (__setLegalHoldIdsForTest) __setLegalHoldIdsForTest(null);
    if (pool) await pool.end();
  } finally {
    if (branch) await deleteBranch({ apiKey, id: branch.id, scratchDir: scratch });
  }
});

const WRITTEN = ['live', 'liveGrat', 'terminal', 'existing', 's527', 'even', 'termGrat', 'noBreakdown', 'noGratuity',
  'nullLines', 'noSnapLines', 'backfill', 'focus4'];
const UNTOUCHED = ['step1', 's59', 'gapZero', 'unequal', 'mismatch', 'held'];
const tamper = (fn) => { const copy = structuredClone(planned.changes); fn(copy); return copy; };
// Alter a line and keep its breakdown row in step (the renderer refuses rows that disagree with their lines).
const relabel = (c, label) => { c.lines[0].label = label; c.breakdownRows[0].label = label; };
const reprice = (c, delta) => {
  c.lines[0].amount = Math.round((c.lines[0].amount + delta) * 100) / 100;
  c.breakdownRows[0].amount = (c.lines[0].type === 'discount' ? -1 : 1) * c.lines[0].amount;
};

test('the change set holds exactly the shapes that convert', () => {
  assert.deepEqual(planned.changes.map((c) => c.id), WRITTEN.map((k) => id[k]).sort((a, b) => a - b));
  assert.deepEqual(planned.dallasLists.unconverted, []);
});

test('the rendered blocks: ids of the change set only, no updated_at, refuse a held id and junk', () => {
  const fwd = renderForwardBlock(planned.changes);
  const rev = renderReverseBlock(planned.changes);
  for (const sql of [fwd, rev]) {
    assert.match(sql, /^DO \$conv\$/m);
    assert.ok(!/updated_at/i.test(sql), 'never updated_at');
    const ids = sql.match(/v_ids integer\[\] := '\{([0-9,]+)\}'/)[1].split(',').map(Number);
    assert.deepEqual(ids, planned.changes.map((c) => c.id));
    assert.ok(sql.includes(runTag(planned.changes)));
  }
  __setLegalHoldIdsForTest([id.held, id.terminal]);
  try {
    assert.throws(() => renderForwardBlock(planned.changes), /legal hold/);
    assert.throws(() => renderReverseBlock(planned.changes), /legal hold/);
  } finally {
    __setLegalHoldIdsForTest([id.held]);
  }
  assert.throws(() => renderForwardBlock([]), /nothing to convert/);
  assert.throws(() => renderForwardBlock(tamper((c) => { c[0].money_md5 = 'x'; })), /md5/);
  assert.throws(() => renderForwardBlock(tamper((c) => { c[1].id = c[0].id; })), /twice/);
  assert.throws(() => renderForwardBlock(tamper((c) => { c[0].lines.push({ type: 'discount', label: 'x', amount: 1, visible: false }); })), /line/);
  const labelled = tamper((c) => { relabel(c[0], 'odd $j$ label'); c[0].after.pricing_snapshot.adjustments.at(-1).label = 'odd $j$ label'; });
  assert.match(renderForwardBlock(labelled), /\$j1\$\[\{[^$]*"label":"odd \$j\$ label"/, 'a literal holding $j$ is quoted with $j1$');
  assert.throws(() => renderForwardBlock(tamper((c) => { relabel(c[2], 'x $conv$ y'); })), /block tag/);
  assert.throws(() => renderForwardBlock(tamper((c) => { c[2].lines[0].label = 'not its row'; })), /breakdown rows do not match/);
});

test('a row that moved after rendering makes the forward block RAISE and leaves every fixture unchanged', async () => {
  const sql = renderForwardBlock(planned.changes);
  await pool.query('UPDATE proposals SET amount_paid = amount_paid + 1 WHERE id = $1', [id.existing]);
  const before = await md5s();
  await assert.rejects(pool.query(sql), /changed since the export/);
  assert.equal(await md5s(), before);
  await pool.query('UPDATE proposals SET amount_paid = amount_paid - 1 WHERE id = $1', [id.existing]);
});

test('a wrong line amount trips the in-block arithmetic, in place and in a full literal', async () => {
  const before = await md5s();
  const inPlace = tamper((c) => { reprice(c.find((x) => x.id === id.terminal), 0.01); });
  await assert.rejects(pool.query(renderForwardBlock(inPlace)), /does not add up/);
  const live = tamper((c) => {
    const adj = c.find((x) => x.id === id.live).after.pricing_snapshot.adjustments;
    adj[adj.length - 1] = { ...adj.at(-1), amount: adj.at(-1).amount + 0.01 }; // the snapshot literal only
  });
  await assert.rejects(pool.query(renderForwardBlock(live)), /does not add up|lines differ/);
  assert.equal(await md5s(), before);
});

test('a NULL where a value was expected RAISEs (never a silent pass)', async () => {
  const before = await md5s();
  const noSub = tamper((c) => { delete c.find((x) => x.id === id.live).after.pricing_snapshot.subtotal; });
  await assert.rejects(pool.query(renderForwardBlock(noSub)), /no subtotal/);
  const noTotal = tamper((c) => { delete c.find((x) => x.id === id.liveGrat).after.pricing_snapshot.total; });
  await assert.rejects(pool.query(renderForwardBlock(noTotal)), /total/);
  // A breakdown slot on a snapshot with no breakdown would null the whole snapshot: refused by id, never a NOT NULL error.
  const noBd = tamper((c) => { c.find((x) => x.id === id.noBreakdown).placement = 'end'; });
  await assert.rejects(pool.query(renderForwardBlock(noBd)), /no snapshot to write/);
  assert.equal(await md5s(), before);
});

test('the forward block writes exactly the transform\'s after-states, logs each, and touches nothing else', async () => {
  const before = await money();
  await pool.query(renderForwardBlock(planned.changes));
  const now = await money();
  const tag = runTag(planned.changes);
  for (const c of planned.changes) {
    const r = now.get(c.id);
    assert.deepEqual(r.adjustments, c.after.adjustments, `adjustments ${c.id}`);
    assert.deepEqual(r.pricing_snapshot, c.after.pricing_snapshot, `snapshot ${c.id}`);
    assert.equal(r.total_price_override, null);
    assert.equal(r.total_price, before.get(c.id).total_price, 'total_price never moves');
    assert.equal(r.amount_paid, before.get(c.id).amount_paid);
    assert.equal(r.status, before.get(c.id).status);
    const log = (await pool.query(
      `SELECT action, actor_type, details FROM proposal_activity_log WHERE proposal_id = $1 AND details->>'run' = $2`, [c.id, tag])).rows;
    assert.equal(log.length, 1);
    assert.equal(log[0].action, c.kind === 'refund_backfill' ? 'refund_line_backfilled' : 'price_override_converted');
    assert.equal(log[0].actor_type, 'system');
    assert.equal(log[0].details.after_md5, r.money_md5);
    assert.equal(log[0].details.before_md5, c.money_md5);
  }
  for (const k of UNTOUCHED) assert.equal(now.get(id[k]).money_md5, before.get(id[k]).money_md5, `${k} untouched`);
  assert.equal(now.get(id.held).total_price_override, before.get(id.held).total_price_override);
  const bd = now.get(id.termGrat).pricing_snapshot.breakdown;
  assert.equal(bd.at(-1).label, 'Gratuity');
  assert.equal(bd.at(-2).label, 'Agreed price adjustment');
  assert.equal('breakdown' in now.get(id.noBreakdown).pricing_snapshot, false, 'never invents a breakdown');
  assert.deepEqual(now.get(id.backfill).adjustments.map((a) => a.amount), [50, 30]);
  assert.deepEqual(now.get(id.focus4).adjustments.length, 1);
});

test('the confirmation passes every converted row, holds out the listed override, and names a row that drifts', async () => {
  const scope = ctx.proposalIds;
  const first = await confirmConversion(pool, planned, { scopeIds: scope, tag: runTag(planned.changes) });
  assert.deepEqual(first.failures, {
    convertedStillOverridden: [], listedOverrides: [id.mismatch], unexpectedOverrides: [], snapshotTotal: [],
    uncoveredRefunds: [], missingLog: [], contentMismatch: [],
  }, 'only the override still on Dallas\'s list keeps it from clean');
  // A paste slip the in-block arithmetic cannot see: a hidden line turned visible in both copies.
  await pool.query(`UPDATE proposals SET adjustments = jsonb_set(adjustments, '{0,visible}', 'true'::jsonb),
      pricing_snapshot = jsonb_set(pricing_snapshot, '{adjustments,0,visible}', 'true'::jsonb) WHERE id = $1`, [id.terminal]);
  assert.deepEqual((await confirmConversion(pool, planned, { scopeIds: scope })).failures.contentMismatch, [id.terminal]);
  const terminalAfter = planned.changes.find((c) => c.id === id.terminal).after;
  await pool.query('UPDATE proposals SET adjustments = $2::jsonb, pricing_snapshot = $3::jsonb WHERE id = $1',
    [id.terminal, JSON.stringify(terminalAfter.adjustments), JSON.stringify(terminalAfter.pricing_snapshot)]);
  assert.equal(first.clean, false);
  assert.equal(first.heldOverrides, 1, 'the held booking is counted, never named');
  assert.equal(first.listedRefunds.length, 2, 'the gap-0 and unequal-gap refunds are on Dallas\'s list');
  await pool.query(`UPDATE proposals SET pricing_snapshot = jsonb_set(pricing_snapshot, '{total}', '1'::jsonb) WHERE id = $1`, [id.terminal]);
  const dirty = await confirmConversion(pool, planned, { scopeIds: scope });
  assert.equal(dirty.clean, false);
  assert.deepEqual(dirty.failures.snapshotTotal, [id.terminal]);
  await pool.query(`UPDATE proposals SET pricing_snapshot = $2::jsonb WHERE id = $1`,
    [id.terminal, JSON.stringify(planned.changes.find((c) => c.id === id.terminal).after.pricing_snapshot)]);
});

test('spec 10: on a converted live booking, a drink-plan syrup raises the total by exactly its catalog price', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = (await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [id.live])).rows[0];
    assert.equal(p.total_price_override, null);
    const pkg = (await client.query('SELECT * FROM service_packages WHERE id = $1', [p.package_id])).rows[0];
    const addons = await loadRepriceAddons(client, p.id);
    const syrups = p.pricing_snapshot.syrups.selections;
    const more = [...syrups, 'lavender'];
    await foldExtrasIntoProposal({
      client, proposal: p, pkg, addonsBefore: addons, addonsAfter: addons, syrupsBefore: syrups, syrupsAfter: more,
      numBarsBefore: p.num_bars, numBarsAfter: p.num_bars, statusChangeReason: 'conversion test',
    });
    const now = (await client.query('SELECT total_price, adjustments FROM proposals WHERE id = $1', [id.live])).rows[0];
    const syrupPrice = cents(calculateSyrupCost(more, p.guest_count).total) - cents(calculateSyrupCost(syrups, p.guest_count).total);
    assert.ok(syrupPrice > 0);
    assert.equal(cents(now.total_price) - cents(p.total_price), syrupPrice, 'bills only the extra');
    assert.deepEqual(now.adjustments, p.adjustments, 'the agreed-price line rides along');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

test('the reverse block restores every money column exactly', async () => {
  await pool.query(renderReverseBlock(planned.changes));
  const now = await money();
  for (const c of planned.changes) {
    const r = now.get(c.id);
    assert.equal(r.money_md5, c.money_md5, `proposal ${c.id} is byte for byte its exported state`);
    assert.deepEqual(r.pricing_snapshot, c.before.pricing_snapshot);
    assert.deepEqual(r.adjustments, c.before.adjustments);
  }
  const reversed = await pool.query(
    `SELECT count(*)::int n FROM proposal_activity_log WHERE proposal_id = ANY($1) AND action = 'override_conversion_reversed'`,
    [planned.changes.map((c) => c.id)]);
  assert.equal(reversed.rows[0].n, planned.changes.length);
});

test('the reverse block refuses a row that is not in its after-state, and writes nothing', async () => {
  await pool.query(renderForwardBlock(planned.changes)); // the forward runs again on the restored rows
  await pool.query('UPDATE proposals SET amount_paid = amount_paid + 1 WHERE id = $1', [id.backfill]);
  const before = await md5s();
  await assert.rejects(pool.query(renderReverseBlock(planned.changes)), /changed since the conversion/);
  assert.equal(await md5s(), before);
  await pool.query('UPDATE proposals SET amount_paid = amount_paid - 1 WHERE id = $1', [id.backfill]);
  await pool.query(renderReverseBlock(planned.changes));
  await assert.rejects(pool.query(renderReverseBlock(planned.changes)), /changed since the conversion/,
    'a second reverse finds the rows already restored');
});

test('one moved row: the full reverse restores nothing, a reverse of the rest restores every other row', async () => {
  await pool.query(renderForwardBlock(planned.changes));
  await pool.query('UPDATE proposals SET amount_paid = amount_paid + 1 WHERE id = $1', [id.live]); // a payment lands
  await assert.rejects(pool.query(renderReverseBlock(planned.changes)), /changed since the conversion/);
  const rest = planned.changes.map((c) => c.id).filter((x) => x !== id.live);
  await pool.query(renderReverseBlock(planned.changes, { onlyIds: rest }));
  const now = await money();
  for (const c of planned.changes.filter((x) => x.id !== id.live)) {
    assert.equal(now.get(c.id).money_md5, c.money_md5, `proposal ${c.id} restored to its exported state`);
  }
  const live = planned.changes.find((c) => c.id === id.live);
  assert.deepEqual(now.get(id.live).pricing_snapshot, live.after.pricing_snapshot, 'the moved row is left as the forward block wrote it');
});

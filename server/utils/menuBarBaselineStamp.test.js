process.env.NODE_ENV = 'test';
require('dotenv').config();

// Spec 2026-10-19 section 17, lane menu-bar-baseline: the one-time bar baseline
// the server stamps at its first production boot after the deploy. Runs on the
// dev database against this suite's own drafts only (the onlyDraftIds seam).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { stampLegacyBarBaselines, runAtBoot } = require('./menuBarBaselineStamp');
const { loadEventPlan, loadCatalogMaps, normalizePlan, buildFingerprint } = require('./menuDrinkSource');
const { computeDiff } = require('./menuDraftRead');
const { __setLegalHoldIdsForTest } = require('./legalHold');

if (process.env.NODE_ENV === 'production') throw new Error('refusing to run in production');

const NONCE = crypto.randomBytes(4).toString('hex');
const proposalIds = [];
const drafts = {};
const PICKS = { wineFromFullBar: ['Red'], spirits: ['Vodka'], beerFromFullBar: ['Non-Alcoholic'] };
const line = (label, text) => ({ label, text });
// As Generate stored them before keys: Beer and Wine renamed, Spirits, NA renamed.
const LEGACY_LINES = [line('Beer & Wine', 'Red, and a house pinot.'), line('Spirits', 'Vodka, from a local distillery.'),
  line('Zero Proof', 'Athletic Brewing NA.')];
const DONE = { words_status: 'done', title: `Bar Menu ${NONCE}`, drinks: [], also_at_bar: LEGACY_LINES };
const LEGACY_FP = { drink_keys: [], brief_hash: 'b', brief_fields: {}, planner_image_key: null };

async function makeDraft(name, { selections = PICKS, plan = true, content = DONE, fingerprint = LEGACY_FP } = {}) {
  const p = await pool.query("INSERT INTO proposals (status) VALUES ('draft') RETURNING id");
  const proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  let planId = null;
  if (plan) {
    planId = (await pool.query("INSERT INTO drink_plans (proposal_id, status, selections) VALUES ($1, 'submitted', $2) RETURNING id",
      [proposalId, selections])).rows[0].id;
  }
  const d = await pool.query(
    `INSERT INTO menu_drafts (proposal_id, drink_plan_id, run_id, inputs, content, plan_fingerprint, version, dismissed_plan_hash)
     VALUES ($1, $2, $3, '{}', $4, $5, 3, $6) RETURNING id`,
    [proposalId, planId, crypto.randomUUID(), content, fingerprint, `dismissed-${NONCE}`]);
  drafts[name] = { id: d.rows[0].id, proposalId };
}

const rowOf = async (name) => (await pool.query(
  'SELECT content, plan_fingerprint, version, dismissed_plan_hash, updated_at FROM menu_drafts WHERE id = $1', [drafts[name].id])).rows[0];
const allIds = () => Object.values(drafts).map((d) => d.id);
const planOf = async (name) => normalizePlan(await loadEventPlan(drafts[name].proposalId, pool), await loadCatalogMaps(pool));

before(async () => {
  await makeDraft('same');                                                    // the picks are as Generate saw them
  await makeDraft('spiritsGone', { selections: { wineFromFullBar: ['White'], beerFromFullBar: ['Non-Alcoholic'] } });
  await makeDraft('held');
  await makeDraft('noPlan', { plan: false });
  await makeDraft('wordsPending', { content: { ...DONE, words_status: 'working' } });
  await makeDraft('stamped', { fingerprint: { ...LEGACY_FP, bar_lines: {}, bar_hash: 'h' } });
  __setLegalHoldIdsForTest([drafts.held.proposalId]);
  // A Saved time in the past (the trigger leaves an updated_at-only write alone), so a move would show.
  await pool.query("UPDATE menu_drafts SET updated_at = NOW() - interval '9 days' WHERE id = ANY($1::int[])", [allIds()]);
});

after(async () => {
  __setLegalHoldIdsForTest(null);
  if (proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  await pool.end();
});

test('the stamp: today\'s baseline where nothing is provable, a gone category kept reading changed; content, version, dismissal and Saved time untouched; the held, planless, pending and stamped drafts left alone', async () => {
  const before = { same: await rowOf('same'), spiritsGone: await rowOf('spiritsGone'), held: await rowOf('held') };
  const r = await stampLegacyBarBaselines({ onlyDraftIds: allIds() });
  assert.deepEqual(r.stamped.sort(), [drafts.same.id, drafts.spiritsGone.id].sort());
  assert.deepEqual(r.flagged, [drafts.spiritsGone.id]);
  assert.deepEqual([r.legalHold, r.noPlan, r.raced, r.unkeyed], [[drafts.held.id], [drafts.noPlan.id], [], []]);

  // Picks unchanged since Generate: the baseline is today's, so nothing reads changed.
  const same = await rowOf('same');
  const sameToday = buildFingerprint(await planOf('same'));
  assert.deepEqual([same.plan_fingerprint.bar_lines, same.plan_fingerprint.bar_hash], [sameToday.bar_lines, sameToday.bar_hash]);
  assert.equal(computeDiff(same, await planOf('same')).bar_changed, false);

  // Spirits dropped since Generate: the stored Spirits line proves it, so it reads gone; the wine swap is taken.
  const gone = await rowOf('spiritsGone');
  const goneDiff = computeDiff(gone, await planOf('spiritsGone'));
  assert.deepEqual([goneDiff.bar_changed, goneDiff.bar_changed_labels], [true, ['Spirits']]);

  for (const name of ['same', 'spiritsGone']) {
    const after = await rowOf(name);
    assert.deepEqual(after.content, before[name].content, `${name}: content untouched (keys come at Update draft)`);
    assert.deepEqual([after.version, after.dismissed_plan_hash, after.updated_at.toISOString()],
      [before[name].version, before[name].dismissed_plan_hash, before[name].updated_at.toISOString()], `${name}: no version, dismissal or Saved time moved`);
  }
  assert.deepEqual(await rowOf('held'), before.held, 'the legal-hold draft is never written');
  for (const name of ['noPlan', 'wordsPending']) {
    assert.equal(Object.prototype.hasOwnProperty.call((await rowOf(name)).plan_fingerprint, 'bar_lines'), false, name);
  }
  assert.deepEqual((await rowOf('stamped')).plan_fingerprint.bar_lines, {});

  // Idempotent: a second boot finds only the skipped ones.
  const again = await stampLegacyBarBaselines({ onlyDraftIds: allIds() });
  assert.deepEqual([again.stamped, again.legalHold, again.noPlan], [[], [drafts.held.id], [drafts.noPlan.id]]);
});

test('runAtBoot: one line of ids and counts, never content; a failure is logged and reported, never thrown', async () => {
  const lines = [];
  const logger = { log: (m) => lines.push(m), error: (m) => lines.push(`ERR ${m}`) };
  const r = await runAtBoot({ logger, stamp: async () => ({ stamped: [7], flagged: [7], unkeyed: [], raced: [], legalHold: [1], noPlan: [], failed: [], pending: [9] }) });
  assert.deepEqual(r.stamped, [7]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[menu-bar-baseline\] stamped 1 draft\(s\) \[7\]; flagged as changed since Generate \[7\]/);
  assert.match(lines[0], /words not done \[9\]; failed \[\]$/);
  assert.doesNotMatch(lines[0], /pinot|Vodka/);
  const quiet = [];
  await runAtBoot({ logger: { log: (m) => quiet.push(m), error: (m) => quiet.push(m) },
    stamp: async () => ({ stamped: [], flagged: [], unkeyed: [], raced: [], legalHold: [], noPlan: [], failed: [], pending: [] }) });
  assert.deepEqual(quiet, [], 'a boot that finds nothing says nothing');
  const failed = [];
  const out = await runAtBoot({ logger: { log: () => {}, error: (m) => failed.push(m) }, stamp: async () => { throw new Error('boom'); } });
  assert.equal(out, null);
  assert.match(failed[0], /^\[menu-bar-baseline\] failed, nothing more stamped this boot: boom$/);
  const rowFailed = [];
  await runAtBoot({ logger: { log: (m) => rowFailed.push(m), error: (m) => rowFailed.push(`ERR ${m}`) },
    stamp: async () => ({ stamped: [3], flagged: [], unkeyed: [], raced: [], legalHold: [], noPlan: [], failed: [4], pending: [], error: new Error('pooler') }) });
  assert.match(rowFailed[1], /^ERR \[menu-bar-baseline\] 1 draft\(s\) failed and stay unstamped until the next run: pooler$/);
});

test('a row that fails is listed and the rest are still stamped; a legacy draft whose words are not done is listed', async () => {
  await makeDraft('boom1');
  await makeDraft('boom2');
  const ids = [drafts.boom1.id, drafts.boom2.id, drafts.wordsPending.id];
  // A db whose plan read fails for the first draft's proposal only.
  const db = { query: (sql, params) => (/FROM drink_plans/.test(sql) && params[0] === drafts.boom1.proposalId
    ? Promise.reject(new Error('pooler reset')) : pool.query(sql, params)) };
  const r = await stampLegacyBarBaselines({ db, onlyDraftIds: ids });
  assert.deepEqual([r.failed, r.stamped, r.pending], [[drafts.boom1.id], [drafts.boom2.id], [drafts.wordsPending.id]]);
  assert.equal(r.error.message, 'pooler reset');
  assert.equal(Object.prototype.hasOwnProperty.call((await rowOf('boom1')).plan_fingerprint, 'bar_lines'), false);
});

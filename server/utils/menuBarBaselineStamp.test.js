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
const { loadEventPlan, loadCatalogMaps, normalizePlan, buildFingerprint, fingerprintHash } = require('./menuDrinkSource');
const { computeDiff } = require('./menuDraftRead');
const { __setLegalHoldIdsForTest } = require('./legalHold');

if (process.env.NODE_ENV === 'production') throw new Error('refusing to run in production');

const NONCE = crypto.randomBytes(4).toString('hex');
const proposalIds = [];
const drafts = {};
const PICKS = { wineFromFullBar: ['Red'], spirits: ['Vodka'], beerFromFullBar: ['Non-Alcoholic'] };
const line = (label, text) => ({ label, text });
// As Generate stored them before keys, hand-edited but under their builder labels.
const LEGACY_LINES = [line('Beer and Wine', 'Red, and a house pinot.'), line('Spirits', 'Vodka, from a local distillery.'),
  line('Non-Alcoholic', 'Athletic Brewing NA.')];
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
  // The Spirits line renamed and filled with brand names: no builder label keys it, and nothing matches it.
  await makeDraft('renamed', { content: { ...DONE, also_at_bar: [LEGACY_LINES[0], line('Liquor', 'Tito\'s.'), LEGACY_LINES[2]] } });
  // The same renamed line, and the client has dropped every spirit.
  await makeDraft('renamedGone', { selections: { wineFromFullBar: ['Red'], beerFromFullBar: ['Non-Alcoholic'] },
    content: { ...DONE, also_at_bar: [LEGACY_LINES[0], line('Liquor', 'Tito\'s.'), LEGACY_LINES[2]] } });
  // Spirits dropped and NA added behind a renamed line: a swap no word can be trusted to show.
  await makeDraft('swapByWords', { selections: { wineFromFullBar: ['Red'], beerFromFullBar: ['Non-Alcoholic'] },
    content: { ...DONE, also_at_bar: [LEGACY_LINES[0], line('Liquor', 'Vodka, local.')] } });
  await makeDraft('heldPending', { content: { ...DONE, words_status: 'working' } });
  __setLegalHoldIdsForTest([drafts.held.proposalId, drafts.heldPending.proposalId]);
  // A Saved time in the past (the trigger leaves an updated_at-only write alone), so a move would show.
  await pool.query("UPDATE menu_drafts SET updated_at = NOW() - interval '9 days' WHERE id = ANY($1::int[])", [allIds()]);
});

after(async () => {
  __setLegalHoldIdsForTest(null);
  if (proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  await pool.end();
});

test('the stamp: today\'s baseline where nothing is provable, a gone category kept reading changed, a renamed line flagged as unchecked; content, version, dismissal and Saved time untouched; the held, planless, pending and stamped drafts left alone', async () => {
  const before = { same: await rowOf('same'), spiritsGone: await rowOf('spiritsGone'), held: await rowOf('held') };
  const r = await stampLegacyBarBaselines({ onlyDraftIds: allIds() });
  assert.deepEqual(r.stamped.sort(), [drafts.same.id, drafts.spiritsGone.id, drafts.renamed.id, drafts.renamedGone.id, drafts.swapByWords.id].sort());
  assert.deepEqual(r.flagged.sort(), [drafts.renamed.id, drafts.renamedGone.id, drafts.swapByWords.id].sort(),
    'every draft holding a renamed line is flagged, whatever its count, order or words');
  // A renamed line is never matched: it reads unchecked, never as a pick change, whether its category held, went or swapped.
  for (const name of ['renamed', 'renamedGone', 'swapByWords']) {
    const d = computeDiff(await rowOf(name), await planOf(name));
    assert.deepEqual([d.bar_changed, d.bar_changed_labels, d.bar_unchecked], [false, [], 1], name);
  }
  assert.deepEqual(r.changed, [drafts.spiritsGone.id], 'a category the stored lines prove went reads changed since Generate');
  assert.deepEqual([r.noPlan, r.raced], [[drafts.noPlan.id], []]);
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'unkeyed'), false, 'no hand-check list');
  assert.equal(r.legalHold, 2,
    'the held proposal\'s drafts are counted as legal hold, the drafting one too, and listed by id nowhere (money law 15)');
  assert.deepEqual(r.pending, [drafts.wordsPending.id]);

  // Picks unchanged since Generate: the baseline is today's, so nothing reads changed.
  const same = await rowOf('same');
  const sameToday = buildFingerprint(await planOf('same'));
  assert.deepEqual([same.plan_fingerprint.bar_lines, same.plan_fingerprint.bar_hash], [sameToday.bar_lines, sameToday.bar_hash]);
  assert.equal(computeDiff(same, await planOf('same')).bar_changed, false);

  // Spirits dropped since Generate: the stored Spirits line proves it, so it reads gone; the wine swap is taken.
  const gone = await rowOf('spiritsGone');
  const goneDiff = computeDiff(gone, await planOf('spiritsGone'));
  assert.deepEqual([goneDiff.bar_changed, goneDiff.bar_changed_labels, goneDiff.bar_unchecked], [true, ['Spirits'], 0]);

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
  assert.deepEqual([again.stamped, again.legalHold, again.noPlan], [[], 2, [drafts.noPlan.id]]);
});

test('a dismissal made before the deploy survives the stamp of a draft whose only difference is a renamed line', async () => {
  // The client added a drink before the deploy and the owner dismissed it (a hash with no bar);
  // the Spirits line was renamed, and its words name a whisky called Red.
  await makeDraft('dismissedRenamed', { selections: { ...PICKS, customCocktails: [`Zq Added ${NONCE}`] },
    content: { ...DONE, also_at_bar: [LEGACY_LINES[0], line('Liquor', 'Tito\'s, Johnnie Walker Red.'), LEGACY_LINES[2]] } });
  const { bar_hash: barHash, bar_lines: barLines, ...barless } = buildFingerprint(await planOf('dismissedRenamed'));
  assert.ok(barHash && barLines);
  await pool.query('UPDATE menu_drafts SET dismissed_plan_hash = $2 WHERE id = $1', [drafts.dismissedRenamed.id, fingerprintHash(barless)]);
  const r = await stampLegacyBarBaselines({ onlyDraftIds: [drafts.dismissedRenamed.id] });
  const d = computeDiff(await rowOf('dismissedRenamed'), await planOf('dismissedRenamed'));
  assert.deepEqual([d.dismissed, d.bar_changed, d.bar_unchecked, d.added.length], [true, false, 1, 1],
    'the dismissed drink stays dismissed: the renamed line is no pick change');
  assert.deepEqual([r.stamped, r.changed, r.flagged], [[drafts.dismissedRenamed.id], [], [drafts.dismissedRenamed.id]]);
});

test('a Start over between the stamp\'s read and its write leaves the draft for the next run, whether its new words are still drafting or done', async () => {
  // A new run whose words have already landed is refused by the run_id clause alone.
  await makeDraft('startOverDone');
  const doneDb = { query: async (sql, params) => {
    if (/FROM drink_plans/.test(sql) && params[0] === drafts.startOverDone.proposalId) {
      await pool.query('UPDATE menu_drafts SET run_id = $2 WHERE id = $1', [drafts.startOverDone.id, crypto.randomUUID()]);
    }
    return pool.query(sql, params);
  } };
  const done = await stampLegacyBarBaselines({ db: doneDb, onlyDraftIds: [drafts.startOverDone.id] });
  assert.deepEqual([done.stamped, done.raced], [[], [drafts.startOverDone.id]]);
  await makeDraft('startOver');
  const ids = [drafts.startOver.id];
  // A db whose plan read for this draft lands a Start over first (a new run_id, words pending).
  const db = { query: async (sql, params) => {
    if (/FROM drink_plans/.test(sql) && params[0] === drafts.startOver.proposalId) {
      await pool.query("UPDATE menu_drafts SET run_id = $2, content = content || '{\"words_status\": \"working\"}'::jsonb WHERE id = $1",
        [drafts.startOver.id, crypto.randomUUID()]);
    }
    return pool.query(sql, params);
  } };
  const r = await stampLegacyBarBaselines({ db, onlyDraftIds: ids });
  assert.deepEqual([r.stamped, r.raced], [[], [drafts.startOver.id]]);
  assert.equal(Object.prototype.hasOwnProperty.call((await rowOf('startOver')).plan_fingerprint, 'bar_lines'), false);
});

test('runAtBoot: one line of ids and counts, never content; a failure is logged and reported, never thrown', async () => {
  const lines = [];
  const logger = { log: (m) => lines.push(m), error: (m) => lines.push(`ERR ${m}`) };
  // (The startOver drafts above stay unstamped; this test stubs the stamp.)
  const r = await runAtBoot({ logger, stamp: async () => ({ stamped: [7, 8], changed: [7], flagged: [8], raced: [], legalHold: 1, noPlan: [], failed: [], pending: [9] }) });
  assert.deepEqual(r.stamped, [7, 8]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[menu-bar-baseline\] stamped 2 draft\(s\) \[7,8\]; changed since Generate \[7\]; holding a bar line renamed before bar picks were tracked, which Update draft rebuilds \[8\]; /);
  assert.match(lines[0], /skipped: legal hold 1, /);
  assert.match(lines[0], /words not done \[9\]; failed \[\]$/);
  assert.doesNotMatch(lines[0], /pinot|Vodka|by hand|matched by place/);
  const quiet = [];
  await runAtBoot({ logger: { log: (m) => quiet.push(m), error: (m) => quiet.push(m) },
    stamp: async () => ({ stamped: [], changed: [], flagged: [], raced: [], legalHold: 0, noPlan: [], failed: [], pending: [] }) });
  assert.deepEqual(quiet, [], 'a boot that finds nothing says nothing');
  const failed = [];
  const out = await runAtBoot({ logger: { log: () => {}, error: (m) => failed.push(m) }, stamp: async () => { throw new Error('boom'); } });
  assert.equal(out, null);
  assert.match(failed[0], /^\[menu-bar-baseline\] failed, nothing more stamped this boot: boom$/);
  const rowFailed = [];
  await runAtBoot({ logger: { log: (m) => rowFailed.push(m), error: (m) => rowFailed.push(`ERR ${m}`) },
    stamp: async () => ({ stamped: [3], changed: [], flagged: [], raced: [], legalHold: 0, noPlan: [], failed: [4], pending: [], error: new Error('pooler') }) });
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

test('the held proposal\'s drafts are left out at the query: never selected, and still counted under legal hold, by count only', async () => {
  const heldDrafts = [drafts.held.id, drafts.heldPending.id];
  const heldProposals = [drafts.held.proposalId, drafts.heldPending.proposalId];
  const rowsSeen = [];
  const db = { query: async (sql, params) => { const r = await pool.query(sql, params); rowsSeen.push(...r.rows); return r; } };
  const r = await stampLegacyBarBaselines({ db, onlyDraftIds: [...heldDrafts, drafts.noPlan.id] });
  assert.deepEqual(rowsSeen.filter((row) => heldDrafts.includes(Number(row.draft_id)) || heldProposals.includes(Number(row.proposal_id))), [],
    'no row of the held proposal is ever read (money law 15)');
  assert.deepEqual([r.legalHold, r.noPlan, r.stamped], [2, [drafts.noPlan.id], []]);
  assert.equal(Object.prototype.hasOwnProperty.call((await rowOf('held')).plan_fingerprint, 'bar_lines'), false, 'the held draft stays unstamped');
});

test('a missing held list fails closed: no query runs, nothing is stamped, and the boot logs one failure', async () => {
  const sweep = require('./staleProposalSweep');
  const real = sweep.LEGAL_HOLD_PROPOSAL_IDS;
  const queries = [];
  const db = { query: (sql, params) => { queries.push(sql); return pool.query(sql, params); } };
  const lines = [];
  const logger = { log: (m) => lines.push(m), error: (m) => lines.push(`ERR ${m}`) };
  let out;
  sweep.LEGAL_HOLD_PROPOSAL_IDS = undefined;
  try {
    out = await runAtBoot({ logger, stamp: () => stampLegacyBarBaselines({ db, onlyDraftIds: allIds() }) });
  } finally {
    sweep.LEGAL_HOLD_PROPOSAL_IDS = real;
  }
  assert.equal(out, null);
  assert.deepEqual(queries, [], 'the list is read before the first query');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ERR \[menu-bar-baseline\] failed, nothing more stamped this boot: legalHold: LEGAL_HOLD_PROPOSAL_IDS is missing/);
});

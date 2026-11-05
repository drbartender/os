process.env.NODE_ENV = 'test';
require('dotenv').config();
// menuDraftRead.js (spec 2026-10-01 sections 7, 8, 9; 5.5 Stuck rule). Pure
// halves plus live reads on dev-DB fixtures: a temp proposal, its drink plan
// and its draft, all removed by the ids recorded here (the draft before the
// temp user, since approved_by has no ON DELETE action). Typed drink names
// carry a nonce so the shopping-list matcher never resolves them to a catalog
// drink. No provider is called.
//
// Run: node --test server/utils/menuDraftRead.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const read = require('./menuDraftRead');
const { NotFoundError } = require('./errors');
const {
  loadEventPlan, loadCatalogMaps, normalizePlan, buildFingerprint, fingerprintHash,
} = require('./menuDrinkSource');

const { PRINT_STATES: S } = read;
const NONCE = crypto.randomBytes(4).toString('hex');
const DRINK_A = `Zq Alpha ${NONCE}`;
const DRINK_B = `Zq Bravo ${NONCE}`;
const DRINK_C = `Zq Charlie ${NONCE}`;
const MOCK_ID = `zq-mock-${NONCE}`;
const KEY = {
  a: `custom:zq-alpha-${NONCE}`, b: `custom:zq-bravo-${NONCE}`,
  c: `custom:zq-charlie-${NONCE}`, mock: `custom:zq-mock-${NONCE}`,
};
const PRINT_KEY = (id) => `menu-print/${id}/approved-${NONCE}.jpg`;

const proposalIds = [];
const draftIds = [];
let userId = null;
let proposalId = null;
let planId = null;
let draftId = null;
let logoKey = null;
let base = null;

async function setPlan(patch = {}) {
  await pool.query('UPDATE drink_plans SET selections = $2 WHERE id = $1', [planId, { ...base, ...patch }]);
}

async function currentFingerprint() {
  const plan = await loadEventPlan(proposalId, pool);
  return buildFingerprint(normalizePlan(plan, await loadCatalogMaps(pool)));
}

// Back to the base plan and a fresh, never-approved draft fingerprinted to it.
async function reset() {
  await setPlan();
  await pool.query('UPDATE proposals SET menu_print_key = NULL, menu_not_required = false WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM menu_draft_pieces WHERE draft_id = $1', [draftId]);
  await pool.query(
    `UPDATE menu_drafts
        SET content = $2, inputs = $3, plan_fingerprint = $4, dismissed_plan_hash = NULL,
            version = 1, art_version = 0, approved_version = NULL, approved_art_version = NULL,
            approved_print_key = NULL, approved_planner_image_key = NULL, approved_at = NULL, approved_by = NULL
      WHERE id = $1`,
    [draftId, {
      words_status: 'done', words_error: null, words_heartbeat_at: new Date().toISOString(), title: 'Bar Menu',
      drinks: [{ key: KEY.a, display_name: 'Alpha shown' }, { key: KEY.b, display_name: 'Bravo shown' },
        { key: KEY.mock, display_name: 'Mock shown' }],
    }, {
      planner_image_role: 'logo', reference_source: 'upload', reference_key: `menu-art/${proposalId}/ref-${NONCE}.png`,
      art_direction: '', drb_mark: true, image_model: 'openai',
    }, await currentFingerprint()]
  );
}

// Approved at version 1 / art 0 with the base planner image as the logo.
async function approve() {
  await pool.query('UPDATE proposals SET menu_print_key = $2 WHERE id = $1', [proposalId, PRINT_KEY(proposalId)]);
  await pool.query(
    `UPDATE menu_drafts SET approved_version = version, approved_art_version = art_version,
            approved_print_key = $2, approved_planner_image_key = $3, approved_at = NOW(), approved_by = $4
      WHERE id = $1`, [draftId, PRINT_KEY(proposalId), logoKey, userId]);
}

const payload = () => read.readDraftPayload(proposalId);

before(async () => {
  const u = await pool.query("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [`menudraftread-${NONCE}@example.com`]);
  userId = u.rows[0].id;
  const p = await pool.query("INSERT INTO proposals (status) VALUES ('draft') RETURNING id");
  proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  const plan = await pool.query(
    "INSERT INTO drink_plans (proposal_id, status, selections) VALUES ($1, 'submitted', '{}') RETURNING id", [proposalId]);
  planId = plan.rows[0].id;
  logoKey = `drink-plan-logos/${planId}-logo-${NONCE}.png`;
  base = {
    menuStyle: 'custom', menuTheme: 'Garden party', drinkNaming: 'Name them after flowers', menuDesignNotes: 'Pastels',
    customCocktails: [DRINK_A, DRINK_B], mocktails: [MOCK_ID], _logoFilename: logoKey,
    beerFromFullBar: ['Light / Easy Drinking', 'IPA', 'Non-Alcoholic', 'None'], wineFromFullBar: ['Red', 'White'],
    spirits: ['Vodka', 'Other'], spiritsOther: 'Mezcal',
  };
  await setPlan();
  const d = await pool.query(
    `INSERT INTO menu_drafts (proposal_id, drink_plan_id, run_id, inputs, content, plan_fingerprint)
     VALUES ($1, $2, $3, '{}', '{}', '{}') RETURNING id`, [proposalId, planId, crypto.randomUUID()]);
  draftId = d.rows[0].id;
  draftIds.push(draftId);
});

after(async () => {
  if (draftIds.length) await pool.query('DELETE FROM menu_drafts WHERE id = ANY($1::int[])', [draftIds]);
  if (proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

// ─── Pure ────────────────────────────────────────────────────────────────────

test('stuck: the boundary at the stale age, for pending and working, pieces and the words step', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const ms = 300000;
  for (const status of ['pending', 'working']) {
    assert.equal(read.stuck({ status, heartbeat_at: new Date(now - ms) }, now, ms), false, `${status} at the age`);
    assert.equal(read.stuck({ status, heartbeat_at: new Date(now - ms - 1) }, now, ms), true, `${status} past it`);
    assert.equal(read.stuck({ words_status: status, words_heartbeat_at: new Date(now - ms - 1).toISOString() }, now, ms), true);
    assert.equal(read.stuck({ status }, now, ms), true, 'an open row with no heartbeat is stuck');
  }
  for (const status of ['done', 'failed']) {
    assert.equal(read.stuck({ status, heartbeat_at: new Date(0) }, now, ms), false);
  }
  assert.equal(read.stuck(null, now, ms), false);
});

test('stuck reads MENU_ART_STALE_MS by default, and nonsense falls back to 300000', () => {
  const saved = process.env.MENU_ART_STALE_MS;
  try {
    process.env.MENU_ART_STALE_MS = '1000';
    assert.equal(read.readStaleMs(), 1000);
    assert.equal(read.stuck({ status: 'working', heartbeat_at: new Date(Date.now() - 5000) }), true);
    process.env.MENU_ART_STALE_MS = 'abc';
    assert.equal(read.readStaleMs(), 300000);
    assert.equal(read.stuck({ status: 'working', heartbeat_at: new Date(Date.now() - 5000) }), false);
  } finally {
    if (saved === undefined) delete process.env.MENU_ART_STALE_MS; else process.env.MENU_ART_STALE_MS = saved;
  }
});

test('derivePrintState: every state of spec 8, first rule wins', () => {
  const approved = {
    version: 3, art_version: 2, approved_version: 3, approved_art_version: 2,
    approved_print_key: 'k1', approved_planner_image_key: 'logo1', inputs: { planner_image_role: 'logo' },
  };
  const at = (over = {}, draft = approved) => read.derivePrintState({
    menuPrintKey: 'k1', menuNotRequired: false, draft, plannerImageKey: 'logo1', ...over,
  });
  assert.equal(at(), S.APPROVED);
  assert.equal(at({}, { ...approved, version: 4 }), S.EDITED, 'edited by version');
  assert.equal(at({}, { ...approved, art_version: 3 }), S.EDITED, 'edited by art_version');
  assert.equal(at({ plannerImageKey: 'logo2' }), S.EDITED, 'logo image replaced');
  assert.equal(at({ plannerImageKey: null }), S.EDITED, 'logo image removed');
  assert.equal(at({ plannerImageKey: 'logo2' }, { ...approved, inputs: { planner_image_role: 'reference' } }), S.APPROVED);
  assert.equal(at({ menuPrintKey: 'manual' }), S.REPLACED);
  assert.equal(at({ menuPrintKey: 'manual' }, { ...approved, approved_print_key: null }), S.REPLACED, 'never approved, manual upload in use');
  assert.equal(at({ menuPrintKey: null }), S.REMOVED);
  assert.equal(at({ menuPrintKey: null }, { ...approved, approved_print_key: null }), S.NONE, 'never approved');
  assert.equal(at({ menuNotRequired: true, menuPrintKey: 'manual' }), S.NOT_REQUIRED);
  assert.equal(at({ menuNotRequired: true }, null), S.NOT_REQUIRED, 'no draft, marked');
  assert.equal(at({}, null), S.NONE, 'no draft');
  assert.deepEqual(Object.values(S).sort(),
    ['approved', 'edited_since_approval', 'none', 'not_required', 'removed', 'replaced']);
});

test('the catalog maps are cached for 60 seconds, and a reset reloads them', async () => {
  read._resetCatalogCacheForTest();
  const t = Date.now();
  const first = read.cachedCatalogMaps(t);
  assert.equal(read.cachedCatalogMaps(t + 59999), first);
  const second = read.cachedCatalogMaps(t + 60000);
  assert.notEqual(second, first);
  read._resetCatalogCacheForTest();
  assert.notEqual(read.cachedCatalogMaps(), second);
  assert.ok((await first).catalogById instanceof Map);
  await second;
});

// ─── Live ────────────────────────────────────────────────────────────────────

test('no plan and no draft, then a draft with no plan reads read-only', async () => {
  const p = await pool.query("INSERT INTO proposals (status) VALUES ('draft') RETURNING id");
  const bare = p.rows[0].id;
  proposalIds.push(bare);
  const empty = await read.readDraftPayload(bare);
  assert.deepEqual([empty.draft, empty.pieces, empty.brief, empty.diff, empty.plan], [null, [], null, null, null]);
  assert.deepEqual(empty.print, { state: S.NONE, approved_at: null, approved_by_name: null, print_key: null, approved_file_in_use: false });
  assert.deepEqual(Object.keys(empty.cap).sort(), ['limit', 'remaining', 'resets_at', 'used']);
  assert.deepEqual(Object.keys(empty.configured).sort(), ['gemini', 'openai']);
  assert.equal(typeof empty.configured.openai, 'boolean');

  const d = await pool.query(
    `INSERT INTO menu_drafts (proposal_id, run_id, inputs, content, plan_fingerprint)
     VALUES ($1, $2, '{}', '{"words_status":"done"}', '{}') RETURNING id`, [bare, crypto.randomUUID()]);
  draftIds.push(d.rows[0].id);
  const orphan = await read.readDraftPayload(bare);
  assert.equal(orphan.draft.read_only, true);
  assert.deepEqual([orphan.plan, orphan.diff, orphan.brief], [null, null, null]);
  await assert.rejects(read.readDraftPayload(0), NotFoundError);
  const { rows: [max] } = await pool.query('SELECT COALESCE(MAX(id), 0) + 100000 AS id FROM proposals');
  await assert.rejects(read.readDraftPayload(max.id), NotFoundError);
});

test('the plan payload: drinks with the mock flag, the bar summary, a house menu', async () => {
  await reset();
  let out = await payload();
  assert.deepEqual(out.plan, {
    id: planId, menu_style: 'custom', drink_count: 3,
    drinks: [{ name: DRINK_A, mock: false }, { name: DRINK_B, mock: false }, { name: MOCK_ID, mock: true }],
    bar_summary: { beer_wine: 4, spirits: 2, na: 1 },
  });
  assert.equal(out.draft.read_only, false);
  assert.deepEqual(out.brief, {
    theme: 'Garden party', naming: 'Name them after flowers', notes: 'Pastels', has_planner_image: true,
    planner_image_rev: crypto.createHash('sha256').update(`planner:${logoKey}`, 'utf8').digest('hex').slice(0, 16),
  });
  await setPlan({ menuStyle: 'house' });
  out = await payload();
  assert.equal(out.plan.menu_style, 'house');
  await setPlan({ menuStyle: 'something-else', customCocktails: [], mocktails: [] });
  out = await payload();
  assert.deepEqual([out.plan.menu_style, out.plan.drink_count, out.plan.drinks], [null, 0, []]);
});

test('the diff: added and dropped, by key, dropped named from the draft', async () => {
  await reset();
  let out = await payload();
  assert.deepEqual(out.diff, { added: [], dropped: [], brief_edited: [], image_changed: false, dismissed: false });
  await setPlan({ customCocktails: [DRINK_A, DRINK_C] });
  out = await payload();
  assert.deepEqual(out.diff.added, [{ key: KEY.c, name: DRINK_C }]);
  assert.deepEqual(out.diff.dropped, [{ key: KEY.b, name: 'Bravo shown' }]);
  assert.deepEqual([out.diff.brief_edited, out.diff.image_changed], [[], false]);
});

test('brief edited only names the changed field; the planner image reads as changed and edits an approved logo draft', async () => {
  await reset();
  await setPlan({ menuTheme: 'Roaring twenties', drinkNaming: '  Name   them after flowers ' });
  let out = await payload();
  assert.deepEqual(out.diff, { added: [], dropped: [], brief_edited: ['theme'], image_changed: false, dismissed: false },
    'whitespace alone is not an edit');
  assert.equal(out.brief.theme, 'Roaring twenties');

  await reset();
  await approve();
  out = await payload();
  assert.equal(out.print.state, S.APPROVED);
  assert.equal(out.print.approved_by_name, `menudraftread-${NONCE}@example.com`);
  assert.equal(out.print.approved_file_in_use, true);
  assert.ok(out.print.approved_at instanceof Date);
  await setPlan({ _logoFilename: `drink-plan-logos/${planId}-new-${NONCE}.png` });
  out = await payload();
  assert.equal(out.diff.image_changed, true);
  assert.deepEqual(out.diff.brief_edited, []);
  assert.equal(out.print.state, S.EDITED, 'a logo draft whose planner image changed');
  await pool.query(`UPDATE menu_drafts SET inputs = inputs || '{"planner_image_role":"reference"}' WHERE id = $1`, [draftId]);
  assert.equal((await payload()).print.state, S.APPROVED, 'the image is not on the printed file unless it is the logo');
});

test('the print state read live: approved, edited by version and art_version, replaced, removed, no menu needed', async () => {
  await reset();
  assert.equal((await payload()).print.state, S.NONE);
  await approve();
  assert.equal((await payload()).print.state, S.APPROVED);
  await pool.query('UPDATE menu_drafts SET version = version + 1 WHERE id = $1', [draftId]);
  assert.equal((await payload()).print.state, S.EDITED);
  await pool.query('UPDATE menu_drafts SET version = approved_version, art_version = art_version + 1 WHERE id = $1', [draftId]);
  let out = await payload();
  assert.equal(out.print.state, S.EDITED);
  assert.equal(out.print.approved_file_in_use, true);
  await pool.query("UPDATE proposals SET menu_print_key = $2 WHERE id = $1", [proposalId, `menu-print/${proposalId}/manual-${NONCE}.pdf`]);
  out = await payload();
  assert.equal(out.print.state, S.REPLACED);
  assert.equal(out.print.approved_file_in_use, false);
  assert.equal(out.print.print_key, `menu-print/${proposalId}/manual-${NONCE}.pdf`);
  await pool.query('UPDATE proposals SET menu_print_key = NULL WHERE id = $1', [proposalId]);
  assert.equal((await payload()).print.state, S.REMOVED);
  await pool.query('UPDATE proposals SET menu_not_required = true WHERE id = $1', [proposalId]);
  assert.equal((await payload()).print.state, S.NOT_REQUIRED);
});

test('dismissed until the plan changes again', async () => {
  await reset();
  await setPlan({ customCocktails: [DRINK_A] });
  assert.equal((await payload()).diff.dismissed, false);
  await pool.query('UPDATE menu_drafts SET dismissed_plan_hash = $2 WHERE id = $1',
    [draftId, fingerprintHash(await currentFingerprint())]);
  let out = await payload();
  assert.equal(out.diff.dismissed, true);
  assert.deepEqual(out.diff.dropped.map((d) => d.key), [KEY.b], 'the diff itself is still reported');
  await setPlan({ customCocktails: [DRINK_A], menuDesignNotes: 'Gold foil' });
  out = await payload();
  assert.equal(out.diff.dismissed, false);
  assert.deepEqual(out.diff.brief_edited, ['notes']);
});

test('stuck pieces and a stuck words step read failed "interrupted"; no R2 key leaves the payload', async () => {
  await reset();
  const run = crypto.randomUUID();
  const r2 = `menu-art/${proposalId}/${run}/background-${NONCE}.jpg`;
  await pool.query(
    `INSERT INTO menu_draft_pieces (draft_id, piece_key, run_id, status, r2_key, heartbeat_at, provider, model, drawn_count, tone, ground_rgb)
     VALUES ($1, 'background', $2, 'done', $3, NOW() - interval '1 hour', 'gemini', 'g-model', 2, 'dark', '10,20,30'),
            ($1, $4, $2, 'pending', NULL, NOW() - interval '10 minutes', 'openai', 'o-model', 0, NULL, NULL),
            ($1, $5, $2, 'working', NULL, NOW(), 'openai', 'o-model', 0, NULL, NULL),
            ($1, $6, $2, 'pending', $7, NOW(), 'gemini', 'g-model', 1, NULL, NULL)`,
    [draftId, run, r2, KEY.a, KEY.b, 'custom:reroll-pending', `menu-art/${proposalId}/${run}/old-${NONCE}.png`]);
  await pool.query(
    `UPDATE menu_drafts SET content = content || jsonb_build_object('words_status', 'working',
       'words_heartbeat_at', to_jsonb(NOW() - interval '10 minutes')) WHERE id = $1`, [draftId]);
  const out = await payload();
  assert.deepEqual(out.pieces.map((p) => [p.piece_key, p.status, p.error]),
    [['background', 'done', null], [KEY.a, 'failed', 'interrupted'], [KEY.b, 'working', null], ['custom:reroll-pending', 'pending', null]]);
  const bg = out.pieces[0];
  assert.deepEqual([bg.has_image, bg.provider, bg.model, bg.drawn_count, bg.tone, bg.ground_rgb],
    [true, 'gemini', 'g-model', 2, 'dark', '10,20,30']);
  assert.equal(out.pieces[1].has_image, false);
  assert.equal(out.pieces[3].has_image, false, 'pending a re-roll with its old r2_key: not an image the route will send');
  assert.match(bg.image_rev, /^[0-9a-f]{16}$/);
  assert.deepEqual(out.pieces.slice(1).map((p) => p.image_rev), [null, null, null], 'image_rev only with has_image');
  assert.deepEqual([out.draft.content.words_status, out.draft.content.words_error], ['failed', 'interrupted']);
  assert.equal(out.draft.inputs.has_reference, true);
  assert.equal(out.draft.inputs.reference_key, undefined);
  const json = JSON.stringify(out);
  assert.ok(!json.includes(r2) && !json.includes('r2_key') && !json.includes(`ref-${NONCE}`), 'no R2 key in the payload');
  assert.ok(!json.includes('plan_fingerprint') && !json.includes('run_id'), 'internals stay inside');
});

test('image_rev: opaque, non-null exactly with has_image, and new for every drawing of the same piece key', async () => {
  await reset();
  const [runA, runB] = [crypto.randomUUID(), crypto.randomUUID()];
  const keyA = `menu-art/${proposalId}/${runA}/background-${crypto.randomUUID()}.jpg`;
  const keyB = `menu-art/${proposalId}/${runB}/background-${crypto.randomUUID()}.jpg`;
  await pool.query(
    `INSERT INTO menu_draft_pieces (draft_id, piece_key, run_id, status, r2_key, heartbeat_at, provider, model)
     VALUES ($1, 'background', $2, 'done', $3, NOW(), 'openai', 'o-model')`, [draftId, runA, keyA]);
  const first = (await payload()).pieces[0];
  assert.equal(first.has_image, true);
  assert.match(first.image_rev, /^[0-9a-f]{16}$/);
  assert.equal((await payload()).pieces[0].image_rev, first.image_rev, 'stable while the image is unchanged');

  // A re-roll under a new run: pending keeps the old key (no image yet), then lands a new one.
  await pool.query("UPDATE menu_draft_pieces SET status = 'pending', run_id = $2 WHERE draft_id = $1", [draftId, runB]);
  const pending = (await payload()).pieces[0];
  assert.deepEqual([pending.has_image, pending.image_rev], [false, null]);
  await pool.query("UPDATE menu_draft_pieces SET status = 'done', r2_key = $2 WHERE draft_id = $1", [draftId, keyB]);
  const second = (await payload()).pieces[0];
  assert.match(second.image_rev, /^[0-9a-f]{16}$/);
  assert.notEqual(second.image_rev, first.image_rev, 'the second run\'s first drawing reads as a new image');
  const json = JSON.stringify(await payload());
  for (const key of [keyA, keyB]) {
    assert.ok(!json.includes(key) && !json.includes(key.split('/').pop()), 'no part of the key leaves');
  }
});

test('has_reference: an upload source with a stored key; a PATCH to none or planner reads false though the key stays', async () => {
  await reset();
  const refKey = `menu-art/${proposalId}/ref-${NONCE}.png`;
  const cases = [
    [{ reference_source: 'upload', reference_key: refKey }, true],
    [{ reference_source: 'none', reference_key: refKey }, false],
    [{ reference_source: 'planner', reference_key: refKey }, false],
    [{ reference_source: 'upload', reference_key: '' }, false],
    [{ reference_source: 'upload', reference_key: null }, false],
  ];
  for (const [inputs, expected] of cases) {
    await pool.query('UPDATE menu_drafts SET inputs = inputs || $2::jsonb WHERE id = $1', [draftId, inputs]);
    const out = (await payload()).draft.inputs;
    assert.equal(out.has_reference, expected, JSON.stringify(inputs));
    assert.equal(out.reference_key, undefined);
  }
});

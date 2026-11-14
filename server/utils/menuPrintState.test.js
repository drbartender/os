process.env.NODE_ENV = 'test';
// The menu print state (spec 2026-10-19 section 10.3, lane menu-approve-send):
// every branch of readPrintState in the spec's order, pure, with no database.
// Keys are made-up R2 paths; nothing here reaches a provider or R2.
//
// Run: node --test server/utils/menuPrintState.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readPrintState, derivePrintState, isHeldFile, PRINT_STATES } = require('./menuPrintState');

const OLD = 'menu-print/7/old-released.jpg';
const NEW = 'menu-print/7/new-held.jpg';
const UPLOAD = 'menu-print/7/admin-upload.pdf';

// A draft at 4/2 with an approval of 4/2 under approvedKey.
function draft(over = {}) {
  return {
    version: 4, art_version: 2, approved_version: 4, approved_art_version: 2,
    approved_print_key: NEW, approved_planner_image_key: null, released_print_key: null,
    inputs: { planner_image_role: 'ignore' }, ...over,
  };
}
const proof = (over = {}) => ({ version: 4, art_version: 2, withdrawn_at: null, ...over });
const read = (args) => readPrintState(args);

test('the states are the seven values, held among them', () => {
  assert.deepEqual(Object.values(PRINT_STATES).sort(),
    ['approved', 'edited_since_approval', 'held', 'none', 'not_required', 'removed', 'replaced']);
});

test('not_required: the mark wins over everything, a held file included', () => {
  assert.deepEqual(read({ menuNotRequired: true }), { state: 'not_required', live: null });
  assert.deepEqual(read({ menuNotRequired: true, draft: draft(), latestProof: proof() }), { state: 'not_required', live: null });
  assert.equal(read({ menuNotRequired: true, menuPrintKey: NEW, draft: draft({ released_print_key: NEW }) }).state, 'not_required');
});

test('none: no draft, or a draft never approved and no print file', () => {
  assert.deepEqual(read({}), { state: 'none', live: null });
  assert.equal(read({ draft: draft({ approved_print_key: null, approved_version: null, approved_art_version: null }) }).state, 'none');
});

test('held, live none: an approved file not released, its proof out, nothing live for staff', () => {
  assert.deepEqual(read({ draft: draft(), latestProof: proof() }), { state: 'held', live: 'none' });
  assert.equal(read({ draft: draft(), latestProof: proof({ answer: 'changes' }) }).state, 'held', 'a change request still holds the file');
});

test('held, live previous: a new approval beside the older released file staff still have', () => {
  const d = draft({ released_print_key: OLD });
  assert.deepEqual(read({ menuPrintKey: OLD, draft: d, latestProof: proof() }), { state: 'held', live: 'previous' });
});

test('held needs the latest proof for the approved pair and not withdrawn', () => {
  assert.equal(isHeldFile(draft(), proof()), true);
  assert.equal(isHeldFile(draft(), null), false, 'no proof');
  assert.equal(isHeldFile(draft(), proof({ withdrawn_at: new Date() })), false, 'withdrawn');
  assert.equal(isHeldFile(draft(), proof({ version: 3 })), false, 'another pair');
  assert.equal(isHeldFile(draft(), proof({ art_version: 1 })), false, 'another art version');
  assert.equal(isHeldFile(draft({ released_print_key: NEW }), proof()), false, 'already released');
  assert.equal(isHeldFile(draft({ approved_print_key: null }), proof()), false, 'nothing approved');
  // Withdrawn and nothing live: not held, and with a proof it is not v1 removed either.
  assert.equal(read({ draft: draft(), latestProof: proof({ withdrawn_at: new Date() }) }).state, 'none');
});

test('approved (Released): the released key is live; edited when the pair, the logo or the file moved', () => {
  const released = draft({ released_print_key: NEW });
  assert.deepEqual(read({ menuPrintKey: NEW, draft: released, latestProof: proof() }), { state: 'approved', live: null });
  assert.equal(read({ menuPrintKey: NEW, draft: { ...released, version: 5 }, latestProof: proof() }).state, 'edited_since_approval');
  assert.equal(read({ menuPrintKey: NEW, draft: { ...released, art_version: 3 }, latestProof: proof() }).state, 'edited_since_approval');
  const logo = { ...released, inputs: { planner_image_role: 'logo' }, approved_planner_image_key: 'drink-plan-logos/a.png' };
  assert.equal(read({ menuPrintKey: NEW, draft: logo, plannerImageKey: 'drink-plan-logos/a.png' }).state, 'approved');
  assert.equal(read({ menuPrintKey: NEW, draft: logo, plannerImageKey: 'drink-plan-logos/b.png' }).state, 'edited_since_approval');
  // The released file staff have is older than the approved one, whose proof was withdrawn.
  const older = draft({ released_print_key: OLD });
  assert.equal(read({ menuPrintKey: OLD, draft: older, latestProof: proof({ withdrawn_at: new Date() }) }).state, 'edited_since_approval');
});

test('approved: a v1 approval (its file live, no release recorded, no proof) reads Released', () => {
  const v1 = draft({ released_print_key: null });
  assert.deepEqual(read({ menuPrintKey: NEW, draft: v1, latestProof: null }), { state: 'approved', live: null });
  assert.equal(read({ menuPrintKey: NEW, draft: { ...v1, version: 5 }, latestProof: null }).state, 'edited_since_approval');
});

test('replaced: an admin upload live, beside a released file, a v1 approval or a held one (no Release offered)', () => {
  assert.equal(read({ menuPrintKey: UPLOAD, draft: draft({ released_print_key: NEW }) }).state, 'replaced');
  assert.equal(read({ menuPrintKey: UPLOAD, draft: draft() }).state, 'replaced', 'beside a v1 approval');
  // A proof approved while his own file was live: the file is held, but not beside an upload.
  assert.deepEqual(read({ menuPrintKey: UPLOAD, draft: draft(), latestProof: proof() }), { state: 'replaced', live: null });
  assert.deepEqual(read({ menuPrintKey: UPLOAD, draft: draft({ released_print_key: OLD }), latestProof: proof() }), { state: 'replaced', live: null });
  assert.equal(read({ menuPrintKey: UPLOAD, draft: draft({ approved_print_key: null }) }).state, 'replaced', 'never approved');
});

test('removed: the released file taken down, or a v1 approval taken down (not held)', () => {
  assert.equal(read({ menuPrintKey: null, draft: draft({ released_print_key: NEW }), latestProof: proof() }).state, 'removed');
  assert.equal(read({ menuPrintKey: null, draft: draft({ released_print_key: OLD }), latestProof: proof({ withdrawn_at: new Date() }) }).state, 'removed');
  assert.deepEqual(read({ menuPrintKey: null, draft: draft(), latestProof: null }), { state: 'removed', live: null }, 'a v1 approval later removed');
});

test('derivePrintState is readPrintState\'s state', () => {
  const args = { menuPrintKey: OLD, draft: draft({ released_print_key: OLD }), latestProof: proof() };
  assert.equal(derivePrintState(args), 'held');
  assert.equal(derivePrintState(), 'none');
});

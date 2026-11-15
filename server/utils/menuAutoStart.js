// The drink plan submit's bar menu step, triggerMenuAutoStart(planId): the client's no-menu mark, then the
// menu draft that starts itself with nobody watching (spec 2026-10-19 sections 8 and 15).
//
// Called beside triggerShoppingListAutoGen at both submit tails
// (server/routes/drinkPlans/submit.js), after the submit's COMMIT and its
// client's release, in that helper's shape: fire-and-forget on its own pool
// connections, never failing or delaying the submit response; a failure goes
// to the console and Sentry. It returns the settled promise so a suite can
// await it; the submit never does. Two steps, in order (spec 8.1): the mark,
// then the auto-start. Each step's failure is reported on its own, and a
// failed mark step still lets the auto-start run (a plan is submitted once):
// the auto-start's own checks read the stored mark and the plan's
// selections, so it needs nothing from the mark step.
//
// The mark, from the submitted plan's selections:
// - Skip the Menu ('none'): menu_not_required = true and
//   menu_not_required_by = 'planner', only with no print key, no mark and no
//   admin decision (an admin's Undo stores by 'admin' and stands); the
//   UPDATE's own WHERE guards it, the menuPrint.js PATCH precedent, so the $5
//   menu_print duty line in dutyLines.js, which reads both columns, can never
//   see a mark beside a key. A mark writes one menu_not_required activity row;
//   a Skip the Menu that a print file overrides writes no mark but one row
//   saying so ({ by: 'planner', mark: 'skipped', reason: 'print_file' }), one
//   per submit.
// - Custom or Standard ('custom' or 'house'): clears only a 'planner' mark; a
//   mark the admin set, or one from before provenance was stored, stays. A
//   clear that changed a row clears the Inbox cache, since it reopens the
//   tasks the mark closed.
// - Only an explicit menuStyle counts (spec 15, amended 2026-11-12): the
//   legacy customMenuDesign boolean answered the old planner's custom-graphic
//   question, never a no-menu request, so with no menuStyle it is no choice.
// - A mark withdraws the draft's open proof (one with no answer) in the
//   mark's own transaction, through the admin's mark's own helper
//   (menuProofs.withdrawLatestProof), after the draft row lock (the draft
//   before the proposal, the order every proof writer keeps), so a Looks great
//   can never be recorded under the mark; the Inbox cache is cleared after the
//   commit, since the mark closes every menu task.
// An archived proposal is skipped in the UPDATE's WHERE. The legal-hold
// proposal (money law 15) is skipped through isLegalHold, which fails closed,
// before any statement names its row.
//
// The auto-start (spec 8.2 and 8.3; lane menu-auto-start): a billed provider
// run started by a public submit, so every condition is checked before
// anything is spent, and the run-once guard last. Nothing is started and
// nothing is recorded unless all hold, in this order:
//   1. the submitted plan has a proposal and menuOwedFor its selections (an
//      explicit menuStyle custom or house; nextStepsCopy.js's rule);
//   2. isLegalHold(proposal) is false (it fails closed), checked before any
//      statement names the proposal's row;
//   3. the proposal exists and is booked (proposalStatus.isBooked: an archived
//      one, or a refunded booking demoted to accepted, starts no billed run),
//      and its event_date, read as text (event_date::text, never a JS Date),
//      is null or on or after chicagoTodayYmd();
//   4. it has no menu_drafts row, no menu_print_key and no no-menu mark;
//   5. the guard: INSERT INTO menu_auto_starts ... ON CONFLICT (proposal_id)
//      DO NOTHING, and a rowCount of 0 stops. The row is never deleted, so two
//      racing submits, or a plan an admin reopened and the client resubmitted,
//      start at most one run in the proposal's life.
// Then startGeneration (server/routes/proposals/menuDraftGenerate.js), the one
// Generate, with { image_model: the default image model } (Gemini when its key
// is set, else OpenAI; menuDraftRead.defaultImageModel) and every other input
// at validateGenerateInputs's default, so the look is decided (spec 9.1), and
// firstDraft, so a manual Generate that landed meanwhile stands. It runs its
// key checks and the daily caps before any provider call; the draft reads the
// lowest-id plan, as every Generate does (spec 8.5). The guard row gets
// draft_id and run_id inside startGeneration's own transaction, on its client
// (its onStarted hook), so the run and the draft land together or not at all:
// no failure or restart can leave a live draft beside a guard row with no
// run. Once startGeneration returns, the job is queued exactly as the route
// queues it. On a refusal (a failed store included, which rolls the draft and
// its reservations back) the guard row gets error_code and the fixed sentence
// of spec 8.3 (Sentry for anything unexpected; firstDraft's refusal, a
// manual Generate that landed meanwhile, is recorded and never paged).
// Either way the Inbox cache is cleared. Every other query runs on its own
// pool connection: none is held across startGeneration, which takes its own.
//
// The test-process gate (testProcessWithoutOptIn), checked before anything
// else in the auto-start: a billed run must never start from a test process
// that did not opt in. Any suite that submits a booked Custom or Standard
// plan through the real submit route reaches this step, and most never set
// NODE_ENV=test, so with real keys in the env file such a suite would start a
// real, billed run. A test process is one node --test runs a file in
// (NODE_TEST_CONTEXT is set) or one whose entry file is a .test.js file (how
// scripts/run-suites.js runs each suite); there, unless NODE_ENV is test, the
// auto-start reads nothing, writes no guard row and returns 'test_process'. A
// suite that opts in with NODE_ENV=test gets the full step, and under it the
// AI wrappers themselves refuse a real call unless a stub is injected. The
// server's entry file is server/index.js and node --test never runs it, so
// production is never gated. The no-menu mark is not gated: it calls no
// provider, and other suites rely on it.
const { pool } = require('../db');
const { AppError } = require('./errors');
const { isLegalHold } = require('./legalHold');
const { withdrawLatestProof } = require('./menuProofs');
const inboxCache = require('./inbox/cache');
const { isBooked } = require('./proposalStatus');
const { chicagoTodayYmd } = require('./businessTime');
const { defaultImageModel } = require('./menuDraftRead');
const { SENTENCES } = require('./menuArtJobErrors');
const { AUTO_START_SENTENCES } = require('./inbox/readMenuTasks');
const job = require('./menuArtJob');
const generate = require('../routes/proposals/menuDraftGenerate');
const { queue } = require('../routes/proposals/menuDraftShared');

const STYLES = new Set(['none', 'custom', 'house']);
const PLAN_SQL = 'SELECT proposal_id, selections FROM drink_plans WHERE id = $1';

/**
 * The plan's explicit menu choice ('none' | 'custom' | 'house'), or null when
 * it stored none. The legacy customMenuDesign flag is never read.
 */
function menuStyleOf(selections) {
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) return null;
  return STYLES.has(selections.menuStyle) ? selections.menuStyle : null;
}

/** A menu is owed: the server mirror of the planner's menuOwedFor (nextStepsCopy.js). */
function menuOwedFor(selections) {
  const style = menuStyleOf(selections);
  return style === 'custom' || style === 'house';
}

const MARK_SQL = `UPDATE proposals SET menu_not_required = true, menu_not_required_by = 'planner'
  WHERE id = $1 AND status <> 'archived' AND menu_print_key IS NULL AND menu_not_required = false
    AND menu_not_required_by IS DISTINCT FROM 'admin'
  RETURNING id`;
// A Skip the Menu that did not land, logged under its own action so the
// timeline never reads it as a mark: the print file stays (the key stands) or
// the admin's own decision stands (unmarked, last decided by the admin).
const SKIPPED_SQL = `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
  SELECT id, 'menu_not_required_skipped', 'client',
         jsonb_build_object('by', 'planner', 'mark', 'skipped',
           'reason', CASE WHEN menu_print_key IS NOT NULL THEN 'print_file' ELSE 'admin' END)
    FROM proposals
   WHERE id = $1 AND status <> 'archived'
     AND (menu_print_key IS NOT NULL OR (menu_not_required = false AND menu_not_required_by = 'admin'))
  RETURNING details->>'reason' AS reason`;
const CLEAR_SQL = `UPDATE proposals SET menu_not_required = false, menu_not_required_by = NULL
  WHERE id = $1 AND status <> 'archived' AND menu_not_required = true AND menu_not_required_by = 'planner'`;
const ACTIVITY_SQL = `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
  VALUES ($1, 'menu_not_required', 'client', $2::jsonb)`;
// The event's draft row, locked before the proposal row is written: the lock
// order every proof writer keeps (the draft, then the proposal, then the
// proof; menuProofs.js), as the admin's mark takes it (menuPrint.js).
const DRAFT_LOCK_SQL = 'SELECT id FROM menu_drafts WHERE proposal_id = $1 FOR UPDATE';

/**
 * Apply or clear the planner's no-menu mark for drink plan `planId`. Returns
 * what it did: 'marked', 'cleared', or a reason it did nothing.
 */
async function applyNoMenuMark(planId) {
  const plan = await pool.query(PLAN_SQL, [planId]);
  const row = plan.rows[0];
  if (!row || !row.proposal_id) return 'no_proposal';
  const proposalId = row.proposal_id;
  if (isLegalHold(proposalId)) return 'legal_hold';
  const style = menuStyleOf(row.selections);
  if (style === 'custom' || style === 'house') {
    const upd = await pool.query(CLEAR_SQL, [proposalId]);
    if (!upd.rowCount) return 'unchanged';
    // The mark had closed every menu task; clearing it reopens them.
    inboxCache.invalidate();
    return 'cleared';
  }
  if (style !== 'none') return 'no_choice';
  // The mark, its activity row and the withdraw of the open proof land
  // together or not at all.
  const client = await pool.connect();
  let upd;
  let skipped = null;
  try {
    await client.query('BEGIN');
    const draft = (await client.query(DRAFT_LOCK_SQL, [proposalId])).rows[0];
    upd = await client.query(MARK_SQL, [proposalId]);
    if (upd.rowCount) {
      await client.query(ACTIVITY_SQL, [proposalId, JSON.stringify({ by: 'planner' })]);
      // The admin's mark's own withdraw (an unanswered proof only), so a
      // Looks great can never be recorded under the mark.
      if (draft) await withdrawLatestProof(client, draft.id);
    } else {
      const ins = await client.query(SKIPPED_SQL, [proposalId]);
      skipped = ins.rowCount ? ins.rows[0].reason : null;
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the original error is the one reported */ }
    throw err;
  } finally {
    client.release();
  }
  if (!upd.rowCount) return skipped ? `skipped_${skipped}` : 'unchanged';
  // A mark closes every menu task of the event (spec 13.1).
  inboxCache.invalidate();
  return 'marked';
}

// A test process that did not opt in with NODE_ENV=test (header): node --test
// runs this file's process, or the entry file is a test file.
const TEST_ENTRY = /\.test\.[cm]?js$/;
function testProcessWithoutOptIn() {
  const testProcess = Boolean(process.env.NODE_TEST_CONTEXT)
    || Boolean(require.main && TEST_ENTRY.test(require.main.filename || ''));
  return testProcess && process.env.NODE_ENV !== 'test';
}

// The proposal facts the 8.2 checks read; the date as text (spec 8.2).
const FACTS_SQL = `
  SELECT p.status, p.event_date::text AS event_date, p.menu_print_key, p.menu_not_required,
         EXISTS (SELECT 1 FROM menu_drafts d WHERE d.proposal_id = p.id) AS has_draft
    FROM proposals p
   WHERE p.id = $1`;
// The run-once guard (spec 8.2 step 4), the last check.
const GUARD_SQL = 'INSERT INTO menu_auto_starts (proposal_id, plan_id) VALUES ($1, $2) ON CONFLICT (proposal_id) DO NOTHING';
const STARTED_SQL = 'UPDATE menu_auto_starts SET draft_id = $2, run_id = $3::uuid WHERE proposal_id = $1';
const FAILED_SQL = 'UPDATE menu_auto_starts SET error_code = $2, error_sentence = $3 WHERE proposal_id = $1';

// The guard row's sentence for each refusal startGeneration throws (spec 8.3).
const REFUSALS = new Map([
  ['MENU_ART_NOT_CONFIGURED', SENTENCES.notSetUp],
  ['MENU_ART_GEMINI_NOT_CONFIGURED', SENTENCES.geminiOff],
  ['MENU_NO_DRINKS', SENTENCES.noDrinks],
  ['MENU_ART_CAP_REACHED', AUTO_START_SENTENCES.capped],
  ['MENU_ART_TEXT_CAP_REACHED', AUTO_START_SENTENCES.capped],
  // firstDraft's refusal: a manual Generate landed between the checks and the
  // start, the designed outcome. Its task never shows, since a draft exists.
  ['MENU_DRAFT_CHANGED', AUTO_START_SENTENCES.notStarted],
]);
const UNEXPECTED = 'MENU_AUTO_START_FAILED';

function report(err, extra) {
  console.error('Menu auto-start failed:', err);
  if (process.env.SENTRY_DSN_SERVER) {
    const Sentry = require('@sentry/node');
    Sentry.captureException(err, { tags: { route: 'drinkPlans/putToken', op: 'menu_auto_start' }, extra });
  }
}

// Spec 8.2 steps 1 to 3 and the first half of 4, before the guard: whether a
// draft is owed and may start now. -> null to go on, else the reason.
function skipReason(facts, today) {
  if (!facts) return 'no_proposal';
  if (!isBooked(facts.status)) return 'not_booked';
  if (facts.event_date !== null && facts.event_date < today) return 'past';
  if (facts.has_draft || facts.menu_print_key || facts.menu_not_required) return 'handled';
  return null;
}

/**
 * Start the one auto-started draft for drink plan `planId` when spec 8.2
 * holds (header). Returns what it did: 'started', 'refused', or a reason it
 * did nothing. Throws only when its own reads or the guard write fail.
 */
async function autoStart(planId) {
  // First of all: no billed run from a test process that did not opt in.
  if (testProcessWithoutOptIn()) return 'test_process';
  const plan = (await pool.query(PLAN_SQL, [planId])).rows[0];
  if (!plan || !plan.proposal_id) return 'no_proposal';
  if (!menuOwedFor(plan.selections)) return 'not_owed';
  const proposalId = plan.proposal_id;
  if (isLegalHold(proposalId)) return 'legal_hold';
  const facts = (await pool.query(FACTS_SQL, [proposalId])).rows[0];
  const reason = skipReason(facts, chicagoTodayYmd());
  if (reason) return reason;
  // The guard, last of all the checks and before any provider call.
  const guard = await pool.query(GUARD_SQL, [proposalId, planId]);
  if (!guard.rowCount) return 'already_started';

  let started;
  try {
    started = await generate.startGeneration({
      proposalId, inputs: { image_model: defaultImageModel() }, file: null, firstDraft: true,
      // The run lands on the guard row in the draft's own transaction, on its client.
      onStarted: (client, ids) => client.query(STARTED_SQL, [proposalId, ids.draftId, ids.runId]),
    });
  } catch (err) {
    const known = err instanceof AppError && REFUSALS.has(err.code);
    if (!known) report(err, { planId, proposalId });
    await pool.query(FAILED_SQL, [proposalId, known ? err.code : (err instanceof AppError && err.code) || UNEXPECTED,
      known ? REFUSALS.get(err.code) : AUTO_START_SENTENCES.notStarted]);
    inboxCache.invalidate();
    return 'refused';
  }
  // As the Generate route queues it, once the transaction is in and its client released.
  queue('generate', () => job.runGeneration({ draftId: started.draftId, runId: started.runId, proposalId }));
  inboxCache.invalidate();
  return 'started';
}

/**
 * Fire-and-forget, after the submit has committed: never throws, never
 * rejects. Returns undefined for no plan id, else a promise that settles once
 * the work (or its reported failure) is done.
 */
function triggerMenuAutoStart(planId) {
  if (!planId) return undefined;
  return Promise.resolve()
    .then(() => applyNoMenuMark(planId))
    .catch((err) => report(err, { planId, step: 'mark' }))
    .then(() => autoStart(planId))
    .then(() => undefined, (err) => report(err, { planId, step: 'auto_start' }));
}

module.exports = { triggerMenuAutoStart, applyNoMenuMark, autoStart, menuStyleOf, menuOwedFor, testProcessWithoutOptIn };

// The drink plan submit's bar menu step, triggerMenuAutoStart(planId): the
// client's no-menu mark (spec 2026-10-19 sections 8.1 and 15).
//
// Called beside triggerShoppingListAutoGen at both submit tails
// (server/routes/drinkPlans/submit.js), after the submit's COMMIT and its
// client's release, in that helper's shape: fire-and-forget on its own pool
// connection, never failing or delaying the submit response; a failure goes to
// the console and Sentry. It returns the settled promise so a suite can await
// it; the submit never does. The auto-start (spec 8.2) joins it as a second
// step in lane menu-auto-start.
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
//   mark the admin set, or one from before provenance was stored, stays.
// - Only an explicit menuStyle counts (spec 15, amended 2026-11-12): the
//   legacy customMenuDesign boolean answered the old planner's custom-graphic
//   question, never a no-menu request, so with no menuStyle it is no choice.
// An archived proposal is skipped in the UPDATE's WHERE. The legal-hold
// proposal (money law 15) is skipped through isLegalHold, which fails closed,
// before any statement names its row.

const { pool } = require('../db');
const { isLegalHold } = require('./legalHold');

const STYLES = new Set(['none', 'custom', 'house']);

/**
 * The plan's explicit menu choice ('none' | 'custom' | 'house'), or null when
 * it stored none. The legacy customMenuDesign flag is never read.
 */
function menuStyleOf(selections) {
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) return null;
  return STYLES.has(selections.menuStyle) ? selections.menuStyle : null;
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

/**
 * Apply or clear the planner's no-menu mark for drink plan `planId`. Returns
 * what it did: 'marked', 'cleared', or a reason it did nothing.
 */
async function applyNoMenuMark(planId) {
  const plan = await pool.query('SELECT proposal_id, selections FROM drink_plans WHERE id = $1', [planId]);
  const row = plan.rows[0];
  if (!row || !row.proposal_id) return 'no_proposal';
  const proposalId = row.proposal_id;
  if (isLegalHold(proposalId)) return 'legal_hold';
  const style = menuStyleOf(row.selections);
  if (style === 'custom' || style === 'house') {
    const upd = await pool.query(CLEAR_SQL, [proposalId]);
    return upd.rowCount ? 'cleared' : 'unchanged';
  }
  if (style !== 'none') return 'no_choice';
  // The mark and its activity row land together or not at all.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(MARK_SQL, [proposalId]);
    let skipped = null;
    if (upd.rowCount) {
      await client.query(ACTIVITY_SQL, [proposalId, JSON.stringify({ by: 'planner' })]);
    } else {
      const ins = await client.query(SKIPPED_SQL, [proposalId]);
      skipped = ins.rowCount ? ins.rows[0].reason : null;
    }
    await client.query('COMMIT');
    if (upd.rowCount) return 'marked';
    return skipped ? `skipped_${skipped}` : 'unchanged';
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the original error is the one reported */ }
    throw err;
  } finally {
    client.release();
  }
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
    .then(() => undefined, (err) => {
      console.error('Menu auto-start failed:', err);
      if (process.env.SENTRY_DSN_SERVER) {
        const Sentry = require('@sentry/node');
        Sentry.captureException(err, { tags: { route: 'drinkPlans/putToken', op: 'menu_auto_start' }, extra: { planId } });
      }
    });
}

module.exports = { triggerMenuAutoStart, applyNoMenuMark, menuStyleOf };

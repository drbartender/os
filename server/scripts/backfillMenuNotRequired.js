'use strict';

/**
 * One-time backfill of the client's no-menu mark (spec 2026-10-19 section 15):
 * marks menu_not_required, by 'planner', on every upcoming booking whose plan says Skip the Menu.
 *
 * The set, the spec's: event_date on or after chicagoTodayYmd() (compared as
 * event_date::text, spec 8.2), booked (isBooked's BOOKED_STATUSES), not
 * archived, not the legal-hold proposal, no menu_print_key, menu_not_required
 * false, and the designer's plan (the lowest-id plan on the proposal,
 * menuDrinkSource.loadEventPlan) submitted ('submitted' or 'reviewed') and
 * saying none: an explicit menuStyle 'none' (utils/menuAutoStart.js menuStyleOf). A
 * row the admin last decided (menu_not_required_by 'admin', an Undo) is left
 * alone, as are a plan still in draft at Skip the Menu and past events.
 * The legacy customMenuDesign false with no menuStyle answered the old
 * planner's custom-graphic question, never a no-menu request (spec 15,
 * amended 2026-11-12): those rows, under the same rules otherwise, are
 * printed apart as "legacy, not marked, check by hand", ids and counts only,
 * and never written.
 *
 * Safe by construction:
 *   - DRY RUN by default: prints the counts and the proposal ids it would mark,
 *     and writes nothing. It prints ids and counts only, never a name.
 *   - Money law 15: the legal-hold proposal is left out of the selection
 *     (heldProposalIds, bound as one int[]; a missing list throws before any
 *     row is read), and every run prints how many rows the hold left out. A
 *     write run refuses unless --held-excluded <n> gives that count from a dry
 *     run and the count still matches.
 *   - The write runs in ONE transaction: the set is re-selected FOR UPDATE, the
 *     UPDATE repeats the no-key and no-mark guards, and each mark gets the
 *     submit path's menu_not_required activity row (actor client, details
 *     { by: 'planner', source: 'backfill' }).
 *   - The mark never sits beside a print key, so the $5 menu_print duty line
 *     (dutyLines.js) is unchanged and no reaccrual is needed.
 *
 *   node server/scripts/backfillMenuNotRequired.js                               # dry run
 *   node server/scripts/backfillMenuNotRequired.js --apply --held-excluded <n>   # write
 *
 * Running it on production is an owner-approved step after the lane ships.
 *
 * Exit codes: 0 clean; 1 bad arguments, a write run with no held count, or a
 * failure; 2 the held count did not match and nothing was written.
 */

require('dotenv').config();
const { pool } = require('../db');
const { heldProposalIds } = require('../utils/legalHold');
const { chicagoTodayYmd } = require('../utils/businessTime');
const { BOOKED_STATUSES } = require('../utils/proposalStatus');

const HELD_FLAG = '--held-excluded';
const TAG = '[backfill-menu-not-required]';

// The count after --held-excluded, or null when the flag is absent. Throws on
// a missing or malformed value, so a typo never reads as a count.
function parseHeldExcluded(args) {
  const i = args.indexOf(HELD_FLAG);
  if (i < 0) return null;
  const raw = args[i + 1];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(`${HELD_FLAG} needs the legal-hold count a dry run printed (a whole number)`);
  }
  return Number(raw);
}

// Every rule but the hold and the plan's menu choice. $1 the booked statuses,
// $2 the business day.
const BASE = `
  FROM proposals p
  JOIN LATERAL (
    SELECT dp.status, dp.selections FROM drink_plans dp
     WHERE dp.proposal_id = p.id ORDER BY dp.id LIMIT 1
  ) plan ON true
 WHERE p.event_date IS NOT NULL
   AND p.event_date::text >= $2
   AND p.status = ANY($1::text[])
   AND p.status <> 'archived'
   AND p.menu_print_key IS NULL
   AND p.menu_not_required = false
   AND p.menu_not_required_by IS DISTINCT FROM 'admin'
   AND plan.status IN ('submitted', 'reviewed')
   AND jsonb_typeof(plan.selections) = 'object'`;
const ELIGIBLE = `${BASE} AND plan.selections->>'menuStyle' = 'none'`;
const LEGACY = `${BASE}
   AND NOT (plan.selections ? 'menuStyle') AND plan.selections->'customMenuDesign' = 'false'::jsonb`;

// $3 the held ids.
const HELD_COUNT_SQL = `SELECT count(*)::int AS n ${ELIGIBLE} AND p.id = ANY($3::int[])`;
const SELECT_SQL = `SELECT p.id ${ELIGIBLE} AND p.id <> ALL($3::int[]) ORDER BY p.id`;
const LEGACY_SQL = `SELECT p.id ${LEGACY} AND p.id <> ALL($3::int[]) ORDER BY p.id`;
const LOCK_SQL = `${SELECT_SQL} FOR UPDATE OF p`;
const MARK_SQL = `UPDATE proposals SET menu_not_required = true, menu_not_required_by = 'planner'
  WHERE id = ANY($1::int[]) AND id <> ALL($2::int[]) AND menu_print_key IS NULL AND menu_not_required = false
    AND menu_not_required_by IS DISTINCT FROM 'admin'
  RETURNING id`;
const ACTIVITY_SQL = `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
  SELECT id, 'menu_not_required', 'client', $2::jsonb FROM unnest($1::int[]) AS id`;

async function main(args = process.argv.slice(2)) {
  const apply = args.includes('--apply');
  let heldFlag;
  try {
    heldFlag = parseHeldExcluded(args);
  } catch (err) {
    console.error(`REFUSING: ${err.message}. Nothing was written.`);
    process.exitCode = 1;
    return;
  }
  if (apply && heldFlag === null) {
    console.error(`REFUSING: --apply needs ${HELD_FLAG} <n>, the legal-hold count a dry run printed. Nothing was written.`);
    process.exitCode = 1;
    return;
  }

  // Read before any row is: a missing list throws here.
  const held = heldProposalIds();
  const today = chicagoTodayYmd();
  const params = [[...BOOKED_STATUSES], today, held];

  console.log(`${TAG} ${apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);

  // The held rows are counted, never read.
  const heldCount = (await pool.query(HELD_COUNT_SQL, params)).rows[0].n;
  console.log(`legal hold: ${heldCount} proposal(s) left out (money law 15). A write run needs ${HELD_FLAG} ${heldCount}.`);
  if (apply && heldFlag !== heldCount) {
    console.error(`REFUSING: ${HELD_FLAG} ${heldFlag} does not match the ${heldCount} held proposal(s) this run leaves out. Re-run the dry run first. Nothing was written.`);
    process.exitCode = 2;
    return;
  }

  const legacy = (await pool.query(LEGACY_SQL, params)).rows.map((r) => r.id);
  console.log(`legacy, not marked, check by hand: ${legacy.length} proposal(s)`);
  console.log(`legacy ids: ${legacy.join(', ')}`);

  if (!apply) {
    const ids = (await pool.query(SELECT_SQL, params)).rows.map((r) => r.id);
    console.log(`would mark: ${ids.length} proposal(s)`);
    console.log(`ids: ${ids.join(', ')}`);
    if (ids.length) console.log(`Re-run with --apply ${HELD_FLAG} ${heldCount} to write these marks.`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = (await client.query(LOCK_SQL, params)).rows.map((r) => r.id);
    const marked = ids.length
      ? (await client.query(MARK_SQL, [ids, held])).rows.map((r) => r.id).sort((a, b) => a - b)
      : [];
    if (marked.length) {
      await client.query(ACTIVITY_SQL, [marked, JSON.stringify({ by: 'planner', source: 'backfill' })]);
    }
    await client.query('COMMIT');
    console.log(`marked: ${marked.length} proposal(s)`);
    console.log(`ids: ${marked.join(', ')}`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the original error is the one reported */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { main };

if (require.main === module) {
  main()
    .catch((err) => { console.error(`${TAG} failed:`, err.message); process.exitCode = 1; })
    .finally(async () => { await pool.end(); });
}

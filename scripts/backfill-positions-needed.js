'use strict';

// One-time backfill: re-derive shifts.positions_needed for upcoming events from
// the full paid roster (bartenders + banquet servers + barbacks), per-role
// shrink-capped so an approved-active assignment is NEVER dropped.
//
//   node -r dotenv/config scripts/backfill-positions-needed.js            # DRY RUN (default, no writes)
//   node -r dotenv/config scripts/backfill-positions-needed.js --apply    # write (gated ops step)
//
// Mirrors syncShiftsFromProposal's reconciliation exactly: grow freely; on a
// shrink never go below approved-active per role (Math.max(desired, approved)).
// Single-shift events only — multi-shift events are admin-managed per shift, the
// same guard the sync path uses (count !== 1 -> skip).
//
// --apply runs the whole sweep in ONE transaction with a SAVEPOINT per event, so
// one bad row rolls back only itself and the sweep continues. DRY RUN writes
// nothing and prints, per changed event, current -> planned, plus two reports:
//   1. RECRUITING — events that gained open (unfilled) role slots.
//   2. LOSS RED FLAGS — events where a re-derive would drop a server/barback
//      slot (a snapshotless proposal is the usual cause; inspect before apply).

const { pool } = require('../server/db');
const { deriveStaffingRoster, loadStaffingAddons } = require('../server/utils/eventCreation');
const { parsePositionsNeeded, rosterCounts } = require('../server/utils/positionsNeeded');
const { canonicalizeRole } = require('../server/utils/staffingRoles');

const apply = process.argv.includes('--apply');
const ROLES = ['Bartender', 'Banquet Server', 'Barback'];

function fmtDate(d) {
  if (!d) return 'no-date';
  try { return new Date(d).toISOString().slice(0, 10); } catch { return String(d); }
}

// Whether the proposal's pricing_snapshot carries its own addons[] (vs. needing
// the proposal_addons join fallback). Used only to annotate the loss report.
function snapshotHasAddons(proposal) {
  try {
    const snap = typeof proposal.pricing_snapshot === 'string'
      ? JSON.parse(proposal.pricing_snapshot)
      : proposal.pricing_snapshot;
    return !!(snap && Array.isArray(snap.addons) && snap.addons.length);
  } catch { return false; }
}

// Approved-active counts per canonical role on a shift. A NULL / non-canonical
// approved position counts as Bartender (the legacy default the migration
// normalized to), identical to syncShiftsFromProposal, so the per-role shrink
// cap can never silently drop a real assignment.
async function approvedByRoleFor(client, shiftId) {
  const { rows } = await client.query(
    `SELECT position, COUNT(*)::int AS n FROM shift_requests
       WHERE shift_id = $1 AND status = 'approved' AND dropped_at IS NULL
       GROUP BY position`,
    [shiftId],
  );
  const out = {};
  for (const r of rows) {
    const role = canonicalizeRole(r.position) || 'Bartender';
    out[role] = (out[role] || 0) + r.n;
  }
  return out;
}

function plannedPositions(desired, approvedByRole) {
  const final = [];
  for (const role of ROLES) {
    const slots = Math.max(desired[role] || 0, approvedByRole[role] || 0);
    for (let i = 0; i < slots; i++) final.push(role);
  }
  if (final.length === 0) final.push('Bartender');
  return final;
}

async function main() {
  console.log(`backfill-positions-needed: ${apply ? 'APPLYING (writes)' : 'DRY RUN (no writes)'}`);
  const client = await pool.connect();
  const gained = []; // recruiting list
  const lost = [];   // server/barback shrink red flags
  let scanned = 0;
  let changed = 0;
  let errors = 0;
  try {
    // Single-shift, still-active upcoming events. p.* carries pricing_snapshot,
    // num_bartenders, event_duration_hours, id, package_id for the helpers.
    // Exclude cancelled AND completed: a roster re-derive is only meaningful for
    // events still being staffed (a completed shift, even if future-dated by a
    // data anomaly, must keep its historical roster). The single-shift COUNT
    // guard is unfiltered, exactly mirroring syncShiftsFromProposal.
    const { rows: events } = await client.query(`
      SELECT p.*, s.id AS shift_id, s.positions_needed AS current_positions
        FROM proposals p
        JOIN shifts s ON s.proposal_id = p.id
       WHERE s.event_date >= CURRENT_DATE
         AND s.status NOT IN ('cancelled', 'completed')
         AND (SELECT COUNT(*) FROM shifts s2 WHERE s2.proposal_id = p.id) = 1
       ORDER BY s.event_date ASC
    `);

    if (apply) await client.query('BEGIN');

    for (const ev of events) {
      scanned += 1;
      const addons = await loadStaffingAddons(ev, client);
      const desired = rosterCounts(deriveStaffingRoster(ev, addons));
      const approved = await approvedByRoleFor(client, ev.shift_id);
      const planned = plannedPositions(desired, approved);
      const plannedJson = JSON.stringify(planned);

      const currentArr = parsePositionsNeeded(ev.current_positions);
      const currentCounts = rosterCounts(currentArr);
      const plannedCounts = rosterCounts(planned);

      // Hard invariant: a re-derive must never drop below approved-active.
      for (const role of ROLES) {
        if ((plannedCounts[role] || 0) < (approved[role] || 0)) {
          throw new Error(`INVARIANT VIOLATION shift ${ev.shift_id}: planned ${role}=${plannedCounts[role] || 0} < approved ${approved[role]}`);
        }
      }

      const deltas = {};
      for (const role of ROLES) {
        const c = currentCounts[role] || 0;
        const pl = plannedCounts[role] || 0;
        if (c !== pl) deltas[role] = { from: c, to: pl };
      }
      const unchanged = Object.keys(deltas).length === 0;

      // Recruiting: roles with an open (unfilled) planned slot.
      const open = {};
      for (const role of ROLES) {
        const o = (plannedCounts[role] || 0) - (approved[role] || 0);
        if (o > 0) open[role] = o;
      }
      if (!unchanged && Object.keys(open).length) {
        gained.push({ shiftId: ev.shift_id, proposalId: ev.id, eventDate: ev.event_date, deltas, open });
      }

      // Loss red flag: a server/barback slot the re-derive would remove.
      const losses = {};
      for (const role of ['Banquet Server', 'Barback']) {
        const c = currentCounts[role] || 0;
        const pl = plannedCounts[role] || 0;
        if (pl < c) losses[role] = { from: c, to: pl };
      }
      if (Object.keys(losses).length) {
        lost.push({ shiftId: ev.shift_id, proposalId: ev.id, eventDate: ev.event_date, losses, snapshot: snapshotHasAddons(ev) });
      }

      if (unchanged) continue;

      // Deliberate divergence from syncShiftsFromProposal: the live sync writes a
      // staffing_shrink_capped proposal_activity_log row when it caps; this
      // one-time backfill surfaces every change in the console output instead
      // (the LOSS report for server/barback shrinks, the per-event line below for
      // all changes incl. Bartender) to avoid flooding the activity log with rows
      // dated to the backfill run. The positions_needed value written is identical.
      console.log(`  shift ${ev.shift_id} (proposal ${ev.id}, ${fmtDate(ev.event_date)}): ${JSON.stringify(currentArr)} -> ${JSON.stringify(planned)}`);
      if (apply) {
        await client.query('SAVEPOINT ev');
        try {
          await client.query('UPDATE shifts SET positions_needed = $1 WHERE id = $2', [plannedJson, ev.shift_id]);
          await client.query('RELEASE SAVEPOINT ev');
          changed += 1;
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT ev');
          errors += 1;
          console.error(`    ERROR on shift ${ev.shift_id}: ${e.message} (rolled back this event, continuing)`);
        }
      } else {
        changed += 1; // would-change
      }
    }

    if (apply) await client.query('COMMIT');

    console.log(`\n=== RECRUITING — events with open role slots after re-derive: ${gained.length} ===`);
    for (const g of gained) {
      console.log(`  shift ${g.shiftId} (proposal ${g.proposalId}, ${fmtDate(g.eventDate)}): open ${JSON.stringify(g.open)} | change ${JSON.stringify(g.deltas)}`);
    }
    console.log(`\n=== LOSS RED FLAGS — server/barback slots a re-derive would drop: ${lost.length} ===`);
    for (const l of lost) {
      console.log(`  shift ${l.shiftId} (proposal ${l.proposalId}, ${fmtDate(l.eventDate)}): ${JSON.stringify(l.losses)} | snapshot-addons:${l.snapshot ? 'present' : 'MISSING (inspect before apply)'}`);
    }

    console.log(`\nscanned ${scanned} single-shift upcoming events; ${apply ? 'wrote' : 'would write'} ${changed}; errors ${errors}.`);
    if (!apply) console.log('DRY RUN — no writes. Re-run with --apply to write (gated ops step; review the two reports first).');
  } catch (err) {
    if (apply) { try { await client.query('ROLLBACK'); } catch { /* ignore */ } }
    console.error('backfill-positions-needed FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();

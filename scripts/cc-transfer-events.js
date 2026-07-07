#!/usr/bin/env node
/**
 * One-time CheckCherry EVENT TRANSFER (cc-import phase 3).
 *
 * Moves the future confirmed CC events into native DRB proposals before the
 * 2026-07-21 CheckCherry shutdown. Spec:
 * docs/superpowers/specs/2026-07-07-cc-transfer-events-design.md
 *
 *   --manifest <path>   off-repo JSON (client PII stays out of git)
 *   --only <cc_id,...>  restrict to specific events
 *   --apply             actually write; default = dry run
 *
 * Money law: total_price_override = the CC contracted total (the pricing
 * engine can never recompute it); CC-collected money lands in external_paid
 * AND amount_paid with ZERO proposal_payments rows (the CC-era ledger already
 * holds those payments — native rows would double-count blended metrics).
 * Balance math (total_price - amount_paid) then self-corrects dunning and
 * invoice derivation everywhere.
 *
 * Comms guards (verified against code 2026-07-07, see spec):
 * - Created as DRAFT via the real creation helpers (silent by construction),
 *   then finalized to confirmed/accepted_at by direct UPDATE (the lifecycle
 *   PATCH is silent for those states too; we never pass through 'sent', so
 *   no proposal email, no drip enrollment).
 * - Drink plan is created FIRST with skipNudge so createEventShifts' internal
 *   createDrinkPlan call hits the idempotent skip: plan exists, no T-21 nudge
 *   (Dallas intro-notes each client, then uses the admin re-enroll button).
 * - scheduleBalanceReminders + schedulePreEventReminders enroll the WANTED
 *   touches (balance ladder, event-week, event-eve); afterwards we delete
 *   pending drink_plan_nudge rows those helpers enqueued and any PAST-dated
 *   pending rows (a stale ladder rung would fire on the next dispatcher tick).
 * - No Stripe activity => the last-minute machinery (webhook-only) and the
 *   sign-and-pay gratuity floor never engage. Later balance payments arrive
 *   via invoices, which the webhook credits ADDITIVELY while preserving
 *   'confirmed' (verified paymentIntentSucceeded.js).
 *
 * Metrics dedupe: each event's legacy_cc_proposals row is DELETED in the same
 * transaction (its CC deposit rows in legacy_cc_payments STAY — that money
 * was collected in the CC era). The ledger loader skips transferred cc_ids on
 * reload via the proposals.transferred_from_cc_id registry.
 *
 * Prod run order: deploy first (schema.sql adds the columns via initDb), then
 * dry-run, then --apply on Dallas's explicit go. Idempotent: an event whose
 * transferred_from_cc_id already exists is skipped.
 *
 * PROD PRECONDITION (per-lane review): set RUN_MESSAGE_DISPATCHER_SCHEDULER=
 * false (or RUN_SCHEDULERS=false) on the server for the apply window. The
 * scheduling helpers commit rows BEFORE the purge deletes the suppressed/
 * past-dated ones; a dispatcher drain overlapping that ms-wide gap could send
 * a stale rung. Flip the env back after the post-checks print clean.
 *
 * --resume is for IMMEDIATE crash recovery (post-commit artifact failure).
 * A resume run days later could re-enqueue a balance rung that already SENT
 * (scheduleMessage dedupes pending only) — do not use it as a re-sync tool.
 *
 * If a payment slides through CC before shutdown (Sid due 7/9, Cody 7/17):
 *   UPDATE proposals SET external_paid = external_paid + <dollars>,
 *          amount_paid = amount_paid + <dollars>
 *    WHERE transferred_from_cc_id = '<cc_id>';
 * (whole dollars; never insert a proposal_payments row for CC money).
 */

const fs = require('fs');
const path = require('path');
const { pool } = require('../server/db');
const { insertProposalRecord } = require('../server/utils/proposalInsert');
const { validateProposalRules, stripIncludedAddons } = require('../server/utils/proposalRules');
const { calculateProposal } = require('../server/utils/pricingEngine');
const { createEventShifts, createDrinkPlan } = require('../server/utils/eventCreation');
const { scheduleBalanceReminders } = require('../server/utils/balanceReminderScheduling');
const { schedulePreEventReminders } = require('../server/utils/preEventScheduling');

// The scheduling helpers resolve message-type metadata from the dispatcher
// registry, which the SERVER wires at boot (server/index.js ~463-475). A
// standalone script must register the same handler sets or
// computeScheduledFor throws "no handler metadata registered".
require('../server/utils/preEventHandlers').registerAll();
require('../server/utils/marketingHandlers').registerMarketingHandlers();
require('../server/utils/dripSmsHandlers').registerDripSmsHandlers();
require('../server/utils/drinkPlanNudge').registerDrinkPlanNudgeHandlers();
require('../server/utils/balanceSmsHandlers').registerBalanceSmsHandlers();
require('../server/utils/eventEveSms').registerEventEveHandler();

// Message types the transfer must NOT leave pending: the T-21 drink-plan
// nudges (suppressed until Dallas's personal intro; re-enrolled via the admin
// button) — plus, separately, anything already past-dated at transfer time.
const SUPPRESSED_TYPES = ['drink_plan_nudge', 'drink_plan_nudge_sms'];

// ── pure helpers (exported for tests) ─────────────────────────────

/** Manifest sanity: shapes, money bounds, date formats. Throws with a list. */
function validateManifest(manifest) {
  const problems = [];
  if (!manifest || !Array.isArray(manifest.events) || manifest.events.length === 0) {
    throw new Error('manifest.events missing or empty');
  }
  const seen = new Set();
  for (const ev of manifest.events) {
    const tag = ev.cc_id || '(missing cc_id)';
    if (!ev.cc_id) problems.push(`${tag}: cc_id required`);
    if (seen.has(ev.cc_id)) problems.push(`${tag}: duplicate cc_id`);
    seen.add(ev.cc_id);
    if (!ev.client_email || !ev.client_email.includes('@')) problems.push(`${tag}: client_email invalid`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.event_date || '')) problems.push(`${tag}: event_date must be YYYY-MM-DD`);
    if (!/^\d{2}:\d{2}$/.test(ev.start_time || '')) problems.push(`${tag}: start_time must be HH:MM`);
    if (!(Number(ev.duration_hours) > 0)) problems.push(`${tag}: duration_hours must be > 0`);
    if (!ev.package) problems.push(`${tag}: package name required`);
    if (!Number.isInteger(ev.guest_count) || ev.guest_count <= 0) problems.push(`${tag}: guest_count must be a positive integer`);
    if (!(Number(ev.total) > 0)) problems.push(`${tag}: total must be > 0 (whole dollars)`);
    if (!(Number(ev.external_paid) >= 0)) problems.push(`${tag}: external_paid must be >= 0`);
    if (Number(ev.external_paid) > Number(ev.total)) problems.push(`${tag}: external_paid exceeds total`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.balance_due_date || '')) problems.push(`${tag}: balance_due_date must be YYYY-MM-DD`);
    for (const a of ev.addons || []) {
      if (!a.slug) problems.push(`${tag}: addon missing slug`);
      if (!(Number(a.quantity) > 0)) problems.push(`${tag}: addon ${a.slug} quantity must be > 0`);
    }
  }
  if (problems.length) throw new Error(`manifest invalid:\n  ${problems.join('\n  ')}`);
  return manifest.events;
}

/** Resolve manifest addon slugs against the active catalog rows. Throws on a miss. */
function resolveAddons(ev, allActiveAddons) {
  const bySlug = new Map(allActiveAddons.map((a) => [a.slug, a]));
  const ids = [];
  const quantities = {};
  for (const a of ev.addons || []) {
    const row = bySlug.get(a.slug);
    if (!row) throw new Error(`${ev.cc_id}: addon slug not in active catalog: ${a.slug}`);
    ids.push(row.id);
    quantities[String(row.id)] = Number(a.quantity);
  }
  const strippedIds = stripIncludedAddons(ids, allActiveAddons);
  const selected = allActiveAddons
    .filter((a) => strippedIds.includes(a.id))
    .map((a) => ({ ...a, variant: null, quantity: quantities[String(a.id)] || 1 }));
  return { strippedIds, selected };
}

// ── db plumbing ────────────────────────────────────────────────────

async function resolveEvent(ev, catalog) {
  const { packagesByName, allActiveAddons, clientByEmail, adminId } = catalog;
  const client = clientByEmail.get(ev.client_email.toLowerCase());
  if (!client) throw new Error(`${ev.cc_id}: no client with email ${ev.client_email} — run the phase-1 client import first`);
  const pkg = packagesByName.get(ev.package);
  if (!pkg) throw new Error(`${ev.cc_id}: no active package named "${ev.package}"`);
  const { strippedIds, selected } = resolveAddons(ev, allActiveAddons);

  validateProposalRules({
    pkg,
    guestCount: ev.guest_count,
    addonIds: strippedIds,
    addons: allActiveAddons,
    clientProvidesGlassware: false,
  });

  const snapshot = calculateProposal({
    pkg,
    guestCount: ev.guest_count,
    durationHours: Number(ev.duration_hours),
    numBars: 1,
    numBartenders: undefined,
    addons: selected,
    syrupSelections: [],
    adjustments: [],
    totalPriceOverride: Number(ev.total),
    gratuityRate: 0,
    tipJar: true,
  });
  if (Number(snapshot.total) !== Number(ev.total)) {
    throw new Error(`${ev.cc_id}: snapshot.total ${snapshot.total} != contracted ${ev.total} — override not honored`);
  }

  return { ev, client, pkg, snapshot, selected, adminId };
}

async function transferOne(resolved) {
  const { ev, client, pkg, snapshot, adminId } = resolved;
  const dbClient = await pool.connect();
  let proposalId;
  let ledgerDeleted = 0;
  try {
    await dbClient.query('BEGIN');
    const proposal = await insertProposalRecord(dbClient, {
      clientId: client.id,
      eventDate: ev.event_date,
      eventStartTime: ev.start_time,
      durationHours: Number(ev.duration_hours),
      venue: ev.venue || {},
      eventLocationFallback: null,
      guestCount: ev.guest_count,
      packageId: pkg.id,
      numBars: 1,
      numBartenders: snapshot.staffing.actual,
      pricingSnapshot: snapshot,
      totalPrice: Number(ev.total),
      createdBy: adminId,
      status: 'draft',
      sentAt: null,
      classOptions: null,
      clientProvidesGlassware: false,
      eventType: ev.event_type || null,
      eventTypeCategory: null,
      eventTypeCustom: ev.event_type_custom || null,
      source: null,
      adminNotes: ev.notes ? `CC transfer: ${ev.notes}` : null,
    });
    proposalId = proposal.id;

    // Finalize: born confirmed + accepted (they signed and paid in CC; DRB
    // must never ask them to accept or pay a deposit). Direct UPDATE — the
    // lifecycle PATCH is comms-silent for these states, and we deliberately
    // never pass through 'sent' (drip + proposal email live there).
    await dbClient.query(
      `UPDATE proposals
          SET status = 'confirmed',
              accepted_at = NOW(),
              sent_at = NOW(),
              total_price_override = $2,
              external_paid = $3,
              amount_paid = $3,
              balance_due_date = $4,
              transferred_from_cc_id = $5
        WHERE id = $1`,
      [proposalId, Number(ev.total), Number(ev.external_paid), ev.balance_due_date, ev.cc_id]
    );

    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'created', 'admin', $2, $3)`,
      [proposalId, adminId, JSON.stringify({
        cc_transfer: true, cc_id: ev.cc_id, total: Number(ev.total),
        external_paid: Number(ev.external_paid), package: pkg.name,
      })]
    );

    // Metrics dedupe: this event now lives natively; remove its ledger row
    // (its CC deposit payments STAY in legacy_cc_payments — collected in the
    // CC era). The loader skips transferred cc_ids on any reload.
    const del = await dbClient.query('DELETE FROM legacy_cc_proposals WHERE cc_id = $1', [ev.cc_id]);
    ledgerDeleted = del.rowCount;

    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }

  const { purged } = await finishTransfer(proposalId);
  return { proposalId, ledgerDeleted, purged };
}

/**
 * Post-commit artifacts (pool-based helpers, mirroring the webhook's
 * post-commit style). Fully idempotent, so a crash between the transfer
 * transaction and here is recovered with --resume: createDrinkPlan and
 * createEventShifts skip when rows exist, scheduleMessage no-ops pending
 * dups, and the purge is a plain delete. ORDER MATTERS: drink plan FIRST
 * with skipNudge, so createEventShifts' internal createDrinkPlan call hits
 * the idempotent existing-plan skip and cannot enqueue the nudge.
 */
async function finishTransfer(proposalId) {
  const pr = await pool.query(
    `SELECT p.*, c.name AS client_name, c.email AS client_email
       FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`, [proposalId]
  );
  await createDrinkPlan(proposalId, pr.rows[0], { skipNudge: true });
  await createEventShifts(proposalId);
  await scheduleBalanceReminders(proposalId);
  await schedulePreEventReminders(proposalId, pool);

  // Purge (a) the nudge rows schedulePreEventReminders just re-enqueued —
  // suppressed until Dallas's personal intro; (b) any pending row already in
  // the past, which would otherwise fire on the next dispatcher tick (e.g. a
  // T-3 balance rung for a due date two days out).
  const purged = await pool.query(
    `DELETE FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending'
        AND (message_type = ANY($2) OR scheduled_for < NOW())
      RETURNING message_type`,
    [proposalId, SUPPRESSED_TYPES]
  );
  return { purged: purged.rows.map((r) => r.message_type) };
}

async function postChecks(proposalId) {
  const { rows: [p] } = await pool.query(
    `SELECT status, total_price, amount_paid, external_paid, balance_due_date,
            (total_price - amount_paid) AS balance
       FROM proposals WHERE id = $1`, [proposalId]
  );
  const { rows: pending } = await pool.query(
    `SELECT message_type, to_char(scheduled_for, 'YYYY-MM-DD') AS day,
            (scheduled_for < NOW()) AS is_past
       FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending'
      ORDER BY scheduled_for`, [proposalId]
  );
  // Both suppressed types AND surviving past-dated rows fail the gate — the
  // purge guarantees neither exists, so either is evidence something raced.
  const badPending = pending.filter((m) => SUPPRESSED_TYPES.includes(m.message_type) || m.is_past);
  const { rows: [{ n: payRows }] } = await pool.query(
    'SELECT count(*)::int AS n FROM proposal_payments WHERE proposal_id = $1', [proposalId]
  );
  return { p, pending, badPending, payRows };
}

async function run() {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const manifestPath = getArg('--manifest');
  const only = (getArg('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const apply = args.includes('--apply');
  const resume = args.includes('--resume'); // re-run post-commit artifacts for already-transferred events
  if (!manifestPath) {
    console.error('Usage: cc-transfer-events.js --manifest <path.json> [--only cc_id,...] [--apply]');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
  let events = validateManifest(manifest);
  if (only.length) events = events.filter((e) => only.includes(e.cc_id));

  try {
    const [pkgs, addons, admin] = await Promise.all([
      pool.query('SELECT * FROM service_packages WHERE is_active = true'),
      pool.query('SELECT * FROM service_addons WHERE is_active = true'),
      pool.query("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1"),
    ]);
    if (!admin.rows[0]) throw new Error('no admin user found for createdBy');
    const emails = events.map((e) => e.client_email.toLowerCase());
    const { rows: clientRows } = await pool.query(
      'SELECT id, name, email, phone FROM clients WHERE lower(email) = ANY($1)', [emails]
    );
    const catalog = {
      packagesByName: new Map(pkgs.rows.map((p) => [p.name, p])),
      allActiveAddons: addons.rows,
      clientByEmail: new Map(clientRows.map((c) => [c.email.toLowerCase(), c])),
      adminId: admin.rows[0].id,
    };

    // Idempotency + ledger presence, per event.
    const { rows: doneRows } = await pool.query(
      'SELECT transferred_from_cc_id FROM proposals WHERE transferred_from_cc_id IS NOT NULL'
    );
    const done = new Set(doneRows.map((r) => r.transferred_from_cc_id));
    const { rows: ledgerRows } = await pool.query(
      'SELECT cc_id FROM legacy_cc_proposals WHERE cc_id = ANY($1)', [events.map((e) => e.cc_id)]
    );
    const inLedger = new Set(ledgerRows.map((r) => r.cc_id));

    let failures = 0;
    const plan = [];
    for (const ev of events) {
      if (done.has(ev.cc_id)) {
        plan.push(resume ? { ev, resume: true } : { ev, skip: 'already transferred' });
        continue;
      }
      try {
        const resolved = await resolveEvent(ev, catalog);
        plan.push({ ev, resolved, ledger: inLedger.has(ev.cc_id) });
      } catch (err) {
        failures++;
        plan.push({ ev, error: err.message });
      }
    }

    console.log(`Transfer plan (${events.length} events):`);
    for (const row of plan) {
      const { ev } = row;
      if (row.skip) { console.log(`  SKIP  ${ev.cc_id} ${ev.client_name}: ${row.skip}`); continue; }
      if (row.resume) { console.log(`  RESUME ${ev.cc_id} ${ev.client_name}: already transferred, will re-run post-commit artifacts`); continue; }
      if (row.error) { console.log(`  FAIL  ${ev.cc_id} ${ev.client_name}: ${row.error}`); continue; }
      const balance = Number(ev.total) - Number(ev.external_paid);
      console.log(`  OK    ${ev.cc_id} ${ev.client_name} ${ev.event_date} ${row.resolved.pkg.name}`
        + ` staff=${row.resolved.snapshot.staffing.actual} total=$${ev.total} ccPaid=$${ev.external_paid}`
        + ` balance=$${balance} due=${ev.balance_due_date} ledgerRow=${row.ledger ? 'yes' : 'MISSING'}`);
    }
    const ready = plan.filter((r) => r.resolved);
    const sum = (f) => ready.reduce((a, r) => a + Number(f(r.ev)), 0);
    console.log(`Ready: ${ready.length}, skipped: ${plan.filter((r) => r.skip).length}, failed: ${failures}`
      + ` | totals $${sum((e) => e.total)}, CC-paid $${sum((e) => e.external_paid)},`
      + ` balances $${sum((e) => e.total) - sum((e) => e.external_paid)}`);

    if (!apply) {
      console.log('\nDRY RUN - nothing written. Re-run with --apply to transfer.');
      return;
    }
    if (failures) {
      console.error('\nABORTED: unresolved events above; nothing written.');
      process.exit(1);
    }

    // Resume pass: complete post-commit artifacts for events whose transfer
    // transaction committed but whose artifact phase failed (all idempotent).
    for (const row of plan.filter((r) => r.resume)) {
      const { rows: [found] } = await pool.query(
        'SELECT id FROM proposals WHERE transferred_from_cc_id = $1', [row.ev.cc_id]
      );
      const { purged } = await finishTransfer(found.id);
      const checks = await postChecks(found.id);
      const ok = checks.p.status === 'confirmed' && checks.badPending.length === 0 && checks.payRows === 0;
      console.log(`  ${ok ? 'RESUMED' : 'CHECK-FAILED'} ${row.ev.cc_id} -> proposal ${found.id}`
        + ` balance=$${checks.p.balance} purged=[${purged.join(',')}]`
        + ` pending=[${checks.pending.map((m) => `${m.message_type}@${m.day}`).join(', ')}]`);
      if (!ok) process.exit(1);
    }

    let created = 0;
    for (const row of ready) {
      const { proposalId, ledgerDeleted, purged } = await transferOne(row.resolved);
      const checks = await postChecks(proposalId);
      created++;
      const ok = checks.p.status === 'confirmed'
        && Number(checks.p.balance) === Number(row.ev.total) - Number(row.ev.external_paid)
        && checks.badPending.length === 0
        && checks.payRows === 0;
      console.log(`  ${ok ? 'DONE' : 'CHECK-FAILED'} ${row.ev.cc_id} -> proposal ${proposalId}`
        + ` balance=$${checks.p.balance} ledgerRowDeleted=${ledgerDeleted}`
        + ` purged=[${purged.join(',')}]`
        + ` pending=[${checks.pending.map((m) => `${m.message_type}@${m.day}`).join(', ')}]`);
      if (!ok) {
        console.error('ABORTING remaining transfers: post-check failed above — investigate before continuing.');
        process.exit(1);
      }
    }
    console.log(`\nAPPLIED: ${created} events transferred.`);
  } finally {
    await pool.end();
  }
}

module.exports = { validateManifest, resolveAddons, SUPPRESSED_TYPES };

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

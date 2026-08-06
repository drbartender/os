/**
 * Typed duty-pay lines (spec 2026-08-06-contractor-duty-pay-design.md §2-§5, §7).
 *
 * Derive-never-increment: every accrual run computes the set of auto lines that
 * SHOULD exist for a proposal and reconciles both directions. Removed rows are
 * kept forever so derivation cannot resurrect them; admin-owned amounts are
 * never overwritten; a payable total only ever moves through
 * payrollProcessing.recomputePayoutTotal(s) (the single writer).
 *
 * "Payable" = removed_at IS NULL AND (held_state IS NULL OR held_state = 'confirmed').
 */
const Sentry = require('@sentry/node');
const { isHostedPackage } = require('./pricingEngine');
const { isBartender } = require('./staffingRoles');
const { readSnapshot } = require('./pricingSnapshot');
const { chicagoTodayYmd } = require('./businessTime');
// No cycle: payrollProcessing imports nothing from this module.
const { findOpenPeriodForDate, recomputePayoutTotal } = require('./payrollProcessing');

const DUTY_KINDS = [
  'bar_rental', 'parking', 'equipment_supplies', 'hosted_supplies',
  'menu_print', 'out_of_area', 'review_bounty', 'review_contest',
];

const DUTY_KIND_LABELS = {
  bar_rental: 'Bar rental',
  parking: 'Parking',
  equipment_supplies: 'Equipment & supplies',
  hosted_supplies: 'Hosted supplies & load',
  menu_print: 'Menu print',
  out_of_area: 'Out-of-Area Bonus',
  review_bounty: 'Review bounty',
  review_contest: 'Review contest award',
};

// Kinds that need a duty_attributions row before a line may materialize.
const ATTRIBUTED_KINDS = ['bar_rental', 'equipment_supplies', 'hosted_supplies', 'menu_print'];
// Event-derived kinds (singleton per payout+shift via idx_duty_lines_event_kinds).
const EVENT_KINDS = ['bar_rental', 'parking', 'equipment_supplies', 'hosted_supplies', 'menu_print', 'out_of_area'];

const BAR_RENTAL_CENTS = 2000;
const PARKING_CENTS = 2000;
const EQUIPMENT_SUPPLIES_CENTS = 2000;
const MENU_PRINT_CENTS = 500;
const REVIEW_BOUNTY_CENTS = 1000;
const CONTEST_POT_CENTS = 10000;
// Hosted events pay a flat supply/load hours block at the attributed staffer's
// own hourly rate (policy range 2 to 3 hours; Dallas 2026-08-06). Deliberately
// NOT wired into payrollMath.contractedHours — that would be a retroactive
// wage change to every past hosted event.
const HOSTED_SUPPLY_HOURS = 2.5;
// Storage-pickup threshold for the equipment fee, in cents. The bar-rental
// package fee (num_bars money) is EXCLUDED: the bar duty pays its own $20.
const EQUIPMENT_THRESHOLD_CENTS = 5000;

const cents = (x) => Math.round(Number(x || 0) * 100);

/** Funded gate — the exact predicate payrollAccrual uses for gratuity. */
function isFundedProposal(proposal) {
  const totalCents = cents(proposal.total_price);
  const paidCents = cents(proposal.amount_paid);
  return paidCents >= totalCents;
}

/** Eligible attribution targets for a kind, from the accrual worker rows. */
function eligibleWorkers(kind, workers) {
  if (kind === 'bar_rental' || kind === 'menu_print') {
    return workers.filter((w) => isBartender(w.position));
  }
  return workers.slice();
}

/**
 * Pure trigger computation. No DB.
 *   proposal: { num_bars, menu_print_key, menu_not_required, total_price,
 *               amount_paid, pricing_snapshot }
 *   pkg: service_packages row or null (isHostedPackage input)
 *   addons: [{ slug, line_total, requires_provisioning }] from the snapshot,
 *           requires_provisioning joined from service_addons by slug
 *   workers: accrual roster rows [{ user_id, position, shift_id, hourly_rate }]
 *   shift: { id, out_of_area_bonus_cents, out_of_area_locked_user_id } or null
 *   attributions: duty_attributions rows [{ kind, user_id }]
 * Returns desired auto lines: [{ contractor_id, shift_id, kind, amount_cents }].
 */
function computeDesiredDutyLines({ proposal, pkg, addons, workers, shift, shifts, attributions }) {
  if (!proposal || !workers || !workers.length) return [];
  if (!isFundedProposal(proposal)) return [];

  const hosted = isHostedPackage(pkg || {});
  const snap = readSnapshot(proposal.pricing_snapshot, { context: 'dutyLines' }) || {};
  const attributionFor = new Map((attributions || []).map((a) => [a.kind, Number(a.user_id)]));
  const workerById = new Map(workers.map((w) => [Number(w.user_id), w]));
  const desired = [];

  const attributedLine = (kind, amountCentsFor) => {
    const userId = attributionFor.get(kind);
    if (!userId) return; // pending attribution: no line yet (spec §3.1)
    const w = workerById.get(userId);
    if (!w) return; // attributed user off the roster: stale, surfaced by listUnattributedDuties
    if (!eligibleWorkers(kind, workers).some((e) => Number(e.user_id) === userId)) return;
    desired.push({
      contractor_id: userId,
      shift_id: Number(w.shift_id),
      kind,
      amount_cents: amountCentsFor(w),
    });
  };

  const pickupCents = (addons || [])
    .filter((a) => a && a.requires_provisioning && a.slug !== 'parking-fee')
    .reduce((sum, a) => sum + cents(a.line_total), 0);
  const hasBar = Number(proposal.num_bars || 0) > 0
    && cents(snap.bar_rental && snap.bar_rental.total) > 0;

  if (hosted) {
    // One hosted_supplies block replaces BOTH the $20 equipment fee and the
    // $20 bar share, so a single pickup is never paid twice (spec §2).
    if (pickupCents > 0 || Number(proposal.num_bars || 0) > 0) {
      attributedLine('hosted_supplies', (w) =>
        Math.round(HOSTED_SUPPLY_HOURS * Number(w.hourly_rate || 0) * 100));
    }
  } else {
    if (hasBar) attributedLine('bar_rental', () => BAR_RENTAL_CENTS);
    if (pickupCents >= EQUIPMENT_THRESHOLD_CENTS) {
      attributedLine('equipment_supplies', () => EQUIPMENT_SUPPLIES_CENTS);
    }
  }

  const hasParking = (addons || []).some(
    (a) => a && a.slug === 'parking-fee' && cents(a.line_total) > 0
  );
  if (hasParking) {
    // One $20 per STAFFER (spec §2), never per shift-request row: a worker
    // approved on two shifts of one proposal still parks once (review W6).
    const seen = new Set();
    for (const w of workers) {
      const uid = Number(w.user_id);
      if (seen.has(uid)) continue;
      seen.add(uid);
      desired.push({
        contractor_id: uid,
        shift_id: Number(w.shift_id),
        kind: 'parking',
        amount_cents: PARKING_CENTS,
      });
    }
  }

  if (proposal.menu_print_key && !proposal.menu_not_required) {
    attributedLine('menu_print', () => MENU_PRINT_CENTS);
  }

  // All of a proposal's shifts, not just the first: a bonus locked on shift
  // 2..N must still pay (review W5). `shifts` preferred; `shift` kept for
  // callers/tests that pass a single row.
  const shiftRows = (Array.isArray(shifts) && shifts.length) ? shifts : (shift ? [shift] : []);
  for (const s of shiftRows) {
    if (!s || !s.out_of_area_locked_user_id || Number(s.out_of_area_bonus_cents || 0) <= 0) continue;
    const w = workerById.get(Number(s.out_of_area_locked_user_id));
    if (!w) continue;
    desired.push({
      contractor_id: Number(w.user_id),
      shift_id: Number(s.id),
      kind: 'out_of_area',
      amount_cents: Number(s.out_of_area_bonus_cents),
    });
  }

  return desired;
}

/** Attributed kinds this context currently needs (trigger true, funded). */
function neededAttributedKinds(ctx) {
  const { proposal, pkg, addons, workers } = ctx;
  if (!workers.length || !isFundedProposal(proposal)) return [];
  const hosted = isHostedPackage(pkg || {});
  const snap = readSnapshot(proposal.pricing_snapshot, { context: 'dutyLines' }) || {};
  const pickupCents = (addons || [])
    .filter((a) => a && a.requires_provisioning && a.slug !== 'parking-fee')
    .reduce((sum, a) => sum + cents(a.line_total), 0);
  const kinds = [];
  if (hosted) {
    if (pickupCents > 0 || Number(proposal.num_bars || 0) > 0) kinds.push('hosted_supplies');
  } else {
    if (Number(proposal.num_bars || 0) > 0 && cents(snap.bar_rental && snap.bar_rental.total) > 0) {
      kinds.push('bar_rental');
    }
    if (pickupCents >= EQUIPMENT_THRESHOLD_CENTS) kinds.push('equipment_supplies');
  }
  if (proposal.menu_print_key && !proposal.menu_not_required) kinds.push('menu_print');
  return kinds;
}

/**
 * Load everything the trigger math needs for one proposal. Works on a pool or
 * a transaction client (executor).
 */
async function loadProposalDutyContext(executor, proposalId) {
  const propRes = await executor.query(
    `SELECT p.id, p.event_date, p.status, p.total_price, p.amount_paid,
            p.pricing_snapshot, p.num_bars, p.menu_print_key, p.menu_not_required,
            p.package_id
       FROM proposals p WHERE p.id = $1`,
    [proposalId]
  );
  const proposal = propRes.rows[0];
  if (!proposal) return null;

  let pkg = null;
  if (proposal.package_id) {
    const pkgRes = await executor.query(
      'SELECT * FROM service_packages WHERE id = $1', [proposal.package_id]
    );
    pkg = pkgRes.rows[0] || null;
  }

  const snap = readSnapshot(proposal.pricing_snapshot, { context: 'dutyLines' }) || {};
  const snapAddons = Array.isArray(snap.addons) ? snap.addons : [];
  let addons = [];
  if (snapAddons.length) {
    const slugs = snapAddons.map((a) => a && a.slug).filter(Boolean);
    const flagRes = slugs.length
      ? await executor.query(
          'SELECT slug, requires_provisioning FROM service_addons WHERE slug = ANY($1)',
          [slugs]
        )
      : { rows: [] };
    const flagBySlug = new Map(flagRes.rows.map((r) => [r.slug, r.requires_provisioning]));
    addons = snapAddons.map((a) => ({
      slug: a.slug,
      line_total: a.line_total,
      requires_provisioning: !!flagBySlug.get(a.slug),
    }));
  }

  const workersRes = await executor.query(
    `SELECT sr.user_id, sr.position, s.id AS shift_id,
            COALESCE(cp.hourly_rate, 20.00) AS hourly_rate
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
      WHERE s.proposal_id = $1 AND sr.status = 'approved' AND sr.dropped_at IS NULL
      ORDER BY sr.user_id`,
    [proposalId]
  );

  const shiftsRes = await executor.query(
    `SELECT id, out_of_area_bonus_cents, out_of_area_locked_user_id
       FROM shifts WHERE proposal_id = $1 ORDER BY id`,
    [proposalId]
  );

  const attrRes = await executor.query(
    'SELECT kind, user_id FROM duty_attributions WHERE proposal_id = $1',
    [proposalId]
  );

  return {
    proposal,
    pkg,
    addons,
    workers: workersRes.rows,
    shifts: shiftsRes.rows,
    shift: shiftsRes.rows[0] || null,
    attributions: attrRes.rows,
    shiftIds: shiftsRes.rows.map((s) => s.id),
  };
}

/**
 * Reconcile the desired auto lines against what exists, both directions.
 * Never touches review kinds; never deletes rows; never aborts the caller's
 * transaction on a concurrent duplicate. Frozen rows (payout paid, or caller
 * says the period is not open) are reported in frozenSkips, never written.
 * Returns { inserted, updated, systemRemoved, restored, held, frozenSkips,
 * affectedPayoutIds } — the caller recomputes totals for affectedPayoutIds
 * via the single writer.
 */
async function reconcileDutyLines(client, { proposalId, desired, shiftIds, periodOpen, rosterContractorIds }) {
  const result = {
    inserted: 0, updated: 0, systemRemoved: 0, restored: 0, held: 0,
    frozenSkips: [], affectedPayoutIds: new Set(),
  };
  if (!shiftIds || !shiftIds.length) return result;
  // Required, not defaulted: an omitted roster would silently mean "everyone
  // is off-roster" and re-open the held-admin-money defect (review B1).
  if (!Array.isArray(rosterContractorIds)) {
    throw new Error('reconcileDutyLines requires rosterContractorIds (pass [] for an empty roster)');
  }
  const roster = new Set(rosterContractorIds.map(Number));

  // Existing event-kind lines on this proposal's shifts, with payout AND
  // period state: lines can live in another (frozen) period when an event
  // date moved weeks, and those must never be rewritten here (review W2,
  // mirroring the payout_events sweep's period scoping).
  const existingRes = await client.query(
    `SELECT d.*, po.status AS payout_status, pp.status AS period_status
       FROM payout_duty_lines d
       JOIN payouts po ON po.id = d.payout_id
       JOIN pay_periods pp ON pp.id = po.pay_period_id
      WHERE d.shift_id = ANY($1) AND d.kind <> ALL($2)`,
    [shiftIds, ['review_bounty', 'review_contest']]
  );
  const keyOf = (r) => `${r.payout_id}:${r.shift_id}:${r.kind}`;
  const existing = new Map(existingRes.rows.map((r) => [keyOf(r), r]));
  const desiredKeys = new Set();

  for (const d of desired || []) {
    if (!d.payout_id) continue; // caller must resolve payout ids before reconcile
    const key = `${d.payout_id}:${d.shift_id}:${d.kind}`;
    desiredKeys.add(key);
    const prior = existing.get(key);

    if (!prior) {
      const ins = await client.query(
        `INSERT INTO payout_duty_lines
           (payout_id, contractor_id, shift_id, kind, amount_cents, origin)
         VALUES ($1, $2, $3, $4, $5, 'auto')
         ON CONFLICT (payout_id, shift_id, kind)
           WHERE kind NOT IN ('review_bounty','review_contest')
         DO NOTHING
         RETURNING id`,
        [d.payout_id, d.contractor_id, d.shift_id, d.kind, d.amount_cents]
      );
      if (ins.rowCount) {
        result.inserted += 1;
        result.affectedPayoutIds.add(d.payout_id);
      }
      continue;
    }

    const frozen = prior.payout_status === 'paid' || !periodOpen
      || prior.period_status === 'paid' || prior.period_status === 'processing';

    // Restore a system removal whose trigger is back (admin removals stay).
    if (prior.removed_at && !prior.removed_by) {
      if (frozen) { result.frozenSkips.push({ id: prior.id, kind: prior.kind, action: 'restore' }); continue; }
      await client.query(
        `UPDATE payout_duty_lines
            SET removed_at = NULL, note = 'trigger restored', updated_at = NOW()
          WHERE id = $1`,
        [prior.id]
      );
      result.restored += 1;
      result.affectedPayoutIds.add(prior.payout_id);
    }
    // A held line whose contractor is back in the desired set becomes payable
    // again (mirrors the payout_events rejoin path clearing held_state).
    if (prior.held_state === 'held') {
      if (frozen) { result.frozenSkips.push({ id: prior.id, kind: prior.kind, action: 'unhold' }); continue; }
      await client.query(
        `UPDATE payout_duty_lines SET held_state = NULL, updated_at = NOW() WHERE id = $1`,
        [prior.id]
      );
      result.affectedPayoutIds.add(prior.payout_id);
    }
    // Propagate a changed auto amount (e.g. a bonus raised after materializing).
    if (!prior.admin_owned && prior.origin === 'auto'
        && Number(prior.amount_cents) !== Number(d.amount_cents)) {
      if (frozen) { result.frozenSkips.push({ id: prior.id, kind: prior.kind, action: 'amount' }); continue; }
      await client.query(
        `UPDATE payout_duty_lines SET amount_cents = $2, updated_at = NOW() WHERE id = $1`,
        [prior.id, Number(d.amount_cents)]
      );
      result.updated += 1;
      result.affectedPayoutIds.add(prior.payout_id);
    }
  }

  // Lines that should no longer exist. TWO distinct reversal causes, and only
  // these two (review B1: an admin's manual line for an ON-ROSTER worker is
  // NEVER touched here — derivation cannot see manual money, so its absence
  // from `desired` means nothing):
  //   (a) auto line whose trigger went false -> system-remove;
  //   (b) any line whose CONTRACTOR left the roster -> auto removes,
  //       admin-owned holds (spec §3.5, the M5 analog).
  for (const r of existingRes.rows) {
    if (desiredKeys.has(keyOf(r))) continue;
    if (r.removed_at) continue; // already removed (admin or system): leave alone
    const frozen = r.payout_status === 'paid' || !periodOpen
      || r.period_status === 'paid' || r.period_status === 'processing';
    const adminLine = r.admin_owned || r.origin === 'admin';
    const offRoster = !roster.has(Number(r.contractor_id));
    if (adminLine && !offRoster) continue; // manual on-roster money: admin's alone
    if (frozen) {
      result.frozenSkips.push({ id: r.id, kind: r.kind, action: adminLine ? 'hold' : 'remove' });
      continue;
    }
    if (adminLine) {
      if (r.held_state) continue; // already held or confirmed: admin decided / pending
      await client.query(
        `UPDATE payout_duty_lines SET held_state = 'held', updated_at = NOW() WHERE id = $1`,
        [r.id]
      );
      result.held += 1;
      result.affectedPayoutIds.add(r.payout_id);
    } else {
      // Structural "confirmed is sticky" (payout_events rule): today only
      // admin lines are ever held, but if that invariant ever loosens, a
      // confirmed line must still never be system-removed.
      if (r.held_state === 'confirmed') continue;
      await client.query(
        `UPDATE payout_duty_lines
            SET removed_at = NOW(), removed_by = NULL,
                note = 'trigger no longer met', updated_at = NOW()
          WHERE id = $1`,
        [r.id]
      );
      result.systemRemoved += 1;
      result.affectedPayoutIds.add(r.payout_id);
    }
  }

  result.affectedPayoutIds = [...result.affectedPayoutIds];
  return result;
}

/** Sentry-report frozen skips (spec §3.2: alert-only after freeze, never clawback). */
function reportFrozenSkips(proposalId, frozenSkips) {
  if (!frozenSkips || !frozenSkips.length) return;
  Sentry.captureMessage('dutyLines: frozen lines need an admin decision', {
    level: 'warning',
    tags: { component: 'dutyLines', reason: 'frozen_skip' },
    extra: { proposalId, skips: frozenSkips },
  });
}

/** Payable duty cents for one payout. */
async function sumPayableDutyCents(executor, payoutId) {
  const { rows } = await executor.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::int AS total
       FROM payout_duty_lines
      WHERE payout_id = $1 AND removed_at IS NULL
        AND (held_state IS NULL OR held_state = 'confirmed')`,
    [payoutId]
  );
  return Number(rows[0].total) || 0;
}

/**
 * Attributed duties in a pay period that block Process: missing attributions
 * and stale ones (attributed user off the approved roster).
 * Returns [{ proposal_id, kind, eligible_user_ids, stale }].
 */
async function listUnattributedDuties(executor, payPeriodId) {
  const periodRes = await executor.query(
    'SELECT start_date, end_date FROM pay_periods WHERE id = $1', [payPeriodId]
  );
  if (!periodRes.rows[0]) return [];
  const { start_date: startDate, end_date: endDate } = periodRes.rows[0];
  const propRes = await executor.query(
    `SELECT id FROM proposals
      WHERE status = 'completed' AND event_date BETWEEN $1 AND $2`,
    [startDate, endDate]
  );
  const out = [];
  for (const { id: proposalId } of propRes.rows) {
    const ctx = await loadProposalDutyContext(executor, proposalId);
    if (!ctx || !ctx.workers.length) continue;
    const needed = neededAttributedKinds(ctx);
    if (!needed.length) continue;
    const attrByKind = new Map(ctx.attributions.map((a) => [a.kind, Number(a.user_id)]));
    const rosterIds = new Set(ctx.workers.map((w) => Number(w.user_id)));
    for (const kind of needed) {
      const attributed = attrByKind.get(kind);
      const eligible = eligibleWorkers(kind, ctx.workers).map((w) => Number(w.user_id));
      if (!attributed) {
        if (eligible.length) out.push({ proposal_id: proposalId, kind, eligible_user_ids: eligible, stale: false });
      } else if (!rosterIds.has(attributed)) {
        // A stale attribution with NOBODY eligible to inherit must not block
        // Process forever (review blocker: the lone bartender dropped and only
        // a barback remains — there is no valid assignee and no line to pay,
        // reconcile already removed it). Alert-only in that case.
        if (eligible.length) {
          out.push({ proposal_id: proposalId, kind, eligible_user_ids: eligible, stale: true });
        } else {
          Sentry.captureMessage('dutyLines: stale attribution with no eligible replacement (not blocking)', {
            level: 'info',
            tags: { component: 'dutyLines', reason: 'stale_attribution_unresolvable' },
            extra: { proposalId, kind, attributed },
          });
        }
      }
    }
  }
  return out;
}

/** Find-or-create the contractor's payout in the current open period. */
async function openPeriodPayout(client, contractorId) {

  const period = await findOpenPeriodForDate(client, chicagoTodayYmd());
  if (!period) return null;
  const { rows } = await client.query(
    `INSERT INTO payouts (pay_period_id, contractor_id)
     VALUES ($1, $2)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE
       SET pay_period_id = EXCLUDED.pay_period_id
     RETURNING id`,
    [period.id, contractorId]
  );
  return rows[0].id;
}

/**
 * Materialize a $10 review bounty for one credited contractor into the current
 * open period. Idempotent across periods via UNIQUE(staff_review_id,
 * contractor_id). Returns the inserted row or null (duplicate / no open period).
 */
async function materializeReviewLine(client, { staffReviewId, contractorId }) {
  const payoutId = await openPeriodPayout(client, contractorId);
  if (!payoutId) return null; // no open period: the confirmed review waits
  const ins = await client.query(
    `INSERT INTO payout_duty_lines
       (payout_id, contractor_id, kind, amount_cents, origin, staff_review_id)
     VALUES ($1, $2, 'review_bounty', $3, 'auto', $4)
     ON CONFLICT (staff_review_id, contractor_id) WHERE kind = 'review_bounty'
     DO NOTHING
     RETURNING *`,
    [payoutId, contractorId, REVIEW_BOUNTY_CENTS, staffReviewId]
  );
  if (!ins.rowCount) return null;

  await recomputePayoutTotal(client, payoutId);
  return ins.rows[0];
}

/**
 * Materialize a contest award (winner's share of the pot) for a quarter like
 * '2026-Q3'. Idempotent via UNIQUE(contest_quarter, contractor_id).
 */
async function materializeContestAward(client, { contractorId, quarter, amountCents }) {
  const payoutId = await openPeriodPayout(client, contractorId);
  if (!payoutId) return null;
  const ins = await client.query(
    `INSERT INTO payout_duty_lines
       (payout_id, contractor_id, kind, amount_cents, origin, contest_quarter)
     VALUES ($1, $2, 'review_contest', $3, 'auto', $4)
     ON CONFLICT (contest_quarter, contractor_id) WHERE kind = 'review_contest'
     DO NOTHING
     RETURNING *`,
    [payoutId, contractorId, amountCents, quarter]
  );
  if (!ins.rowCount) return null;

  await recomputePayoutTotal(client, payoutId);
  return ins.rows[0];
}

/**
 * Catch-up pass: pay every confirmed 5-star review credit that has no bounty
 * line yet (a review confirmed while no period was open, or a credit added
 * later). Safe to call any time; no-op without an open period.
 */
async function materializePendingReviewLines(client) {
  const { rows } = await client.query(
    `SELECT c.staff_review_id, c.user_id
       FROM staff_review_credits c
       JOIN staff_reviews r ON r.id = c.staff_review_id
      WHERE r.status = 'confirmed' AND r.stars = 5
        AND NOT EXISTS (
          SELECT 1 FROM payout_duty_lines d
           WHERE d.kind = 'review_bounty'
             AND d.staff_review_id = c.staff_review_id
             AND d.contractor_id = c.user_id
        )`
  );
  let materialized = 0;
  for (const row of rows) {
    const line = await materializeReviewLine(client, {
      staffReviewId: row.staff_review_id, contractorId: row.user_id,
    });
    if (line) materialized += 1;
  }
  return { materialized };
}

module.exports = {
  DUTY_KINDS, DUTY_KIND_LABELS, ATTRIBUTED_KINDS, EVENT_KINDS,
  HOSTED_SUPPLY_HOURS, REVIEW_BOUNTY_CENTS, CONTEST_POT_CENTS,
  isFundedProposal, eligibleWorkers, computeDesiredDutyLines,
  neededAttributedKinds, loadProposalDutyContext, reconcileDutyLines,
  reportFrozenSkips, sumPayableDutyCents, listUnattributedDuties,
  materializeReviewLine, materializeContestAward, materializePendingReviewLines,
};

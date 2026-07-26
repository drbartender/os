/**
 * Cancel line item — one admin act that removes a client-visible priced line
 * from a booked proposal and settles the money.
 * Spec: docs/superpowers/specs/2026-07-22-cancel-line-item-design.md
 *
 * Part 1 (this file section): target parsing + cancellable-line enumeration.
 * Part 2 below: applyLineItemCancel, the shared preview/execute core. The
 * preview endpoint runs the SAME core inside a rolled-back transaction (one
 * computation, two callers); only the execute route COMMITs.
 */

'use strict';

const { ValidationError, ConflictError, NotFoundError } = require('./errors');
const { calculateStaffing } = require('./pricingEngine');
const { readSnapshot } = require('./pricingSnapshot');
const { foldExtrasIntoProposal, loadRepriceAddons } = require('./proposalExtrasFold');
const { refreshUnlockedInvoices, createAdditionalInvoiceIfNeeded, writeLineItems } = require('./invoiceHelpers');
const { syncShiftsFromProposal, deriveStaffingRoster, loadStaffingAddons } = require('./eventCreation');
const { rosterCounts } = require('./positionsNeeded');
const { toCents } = require('./invoiceShared');

// Archived proposals are settled history; completed events have run payroll.
// Changes there are deliberate manual territory, never one-click.
const CANCEL_BLOCKED_STATUSES = ['archived', 'completed'];

const KINDS = new Set(['addon', 'bar', 'syrup', 'extra-bartender', 'adjustment', 'gratuity', 'package']);
const KEYED = new Set(['addon', 'syrup', 'adjustment']);

/**
 * Parse a typed cancel target string into { kind, key }.
 * Kinds: addon:<slug> | bar | syrup:<id> | extra-bartender | adjustment:<idx>
 *      | gratuity | package (package is enumerated but never executable here;
 *        removing the package is the cancel-event flow).
 */
function parseCancelTarget(str) {
  if (typeof str !== 'string' || !str) throw new ValidationError({ target: 'Missing cancel target' });
  const i = str.indexOf(':');
  const kind = i === -1 ? str : str.slice(0, i);
  const rawKey = i === -1 ? null : str.slice(i + 1);
  if (!KINDS.has(kind)) throw new ValidationError({ target: `Unknown cancel target kind: ${kind}` });
  if (KEYED.has(kind) === (rawKey === null || rawKey === '')) {
    throw new ValidationError({ target: `Malformed cancel target: ${str}` });
  }
  if (kind === 'adjustment') {
    const idx = Number(rawKey);
    if (!Number.isInteger(idx) || idx < 0) throw new ValidationError({ target: `Bad adjustment index: ${rawKey}` });
    return { kind, key: idx };
  }
  return { kind, key: rawKey };
}

/**
 * How many bartenders are removable above the staffing floor. The floor is
 * max(required, included): never below the package's required ratio staffing
 * (spec) and never into included $0 heads (hosted-package rule, CLAUDE.md).
 * The targets endpoint advertises THIS number and the apply core caps at it,
 * so the UI can never offer a removal the floor rejects.
 */
function removableBartenders({ pkg, guestCount, durationHours, actual }) {
  const staffing = calculateStaffing(pkg, guestCount, durationHours, null);
  const floor = Math.max(staffing.required, staffing.included);
  const a = actual ?? staffing.required;
  return { removable: Math.max(0, a - floor), floor, actual: a };
}

/**
 * Quantity semantics mirror of withRepriceQuantities (proposalExtrasFold.js):
 * the stored proposal_addons.quantity is a genuine unit count ONLY for billing
 * types where the engine treats it as a multiplier. per_guest/per_guest_timed
 * store guest_count; per_staff bills once per staff and ignores the stored
 * count. Only genuine-count rows with quantity > 1 get a "remove how many?".
 */
function quantityIsCount(billingType) {
  return billingType !== 'per_guest' && billingType !== 'per_guest_timed' && billingType !== 'per_staff';
}

/**
 * Enumerate every client-visible priced line as a typed cancel target.
 * Display-only figures come from the stored snapshot; the true money delta is
 * always the preview's job (same engine, fresh compute).
 *
 * @param {object} dbClient  pool or held client
 * @param {number|string} proposalId
 * @returns {Promise<{eligible: boolean, targets: object[]}>}
 */
async function computeCancelTargets(dbClient, proposalId) {
  const pRes = await dbClient.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
  const proposal = pRes.rows[0];
  if (!proposal) throw new NotFoundError('Proposal not found');
  if (CANCEL_BLOCKED_STATUSES.includes(proposal.status)) return { eligible: false, targets: [] };

  const pkg = proposal.package_id
    ? (await dbClient.query('SELECT * FROM service_packages WHERE id = $1', [proposal.package_id])).rows[0]
    : null;
  const snap = readSnapshot(proposal.pricing_snapshot, { context: 'lineItemCancel.targets' });

  const addonRows = (await dbClient.query(
    `SELECT pa.id, pa.addon_id, pa.addon_name, pa.billing_type, pa.quantity, pa.line_total, sa.slug
       FROM proposal_addons pa
       LEFT JOIN service_addons sa ON sa.id = pa.addon_id
      WHERE pa.proposal_id = $1
      ORDER BY pa.id`,
    [proposalId]
  )).rows;

  // Lab ownership: an addon slug marked labAdded in the newest drink plan's
  // selections must ALSO be stripped there on removal, or the client's next
  // Lab save resurrects the charge (the resurrection trap).
  const planRes = await dbClient.query(
    'SELECT selections FROM drink_plans WHERE proposal_id = $1 ORDER BY id DESC LIMIT 1',
    [proposalId]
  );
  const labSlugs = new Set();
  const sel = planRes.rows[0]?.selections;
  for (const [slug, meta] of Object.entries(sel?.addOns || {})) {
    if (meta && meta.labAdded === true) labSlugs.add(slug);
  }

  const targets = [];

  targets.push({
    target: 'package',
    label: pkg?.name || 'Package',
    amount: snap?.package?.base_cost ?? null,
    cancellable: false,
    reason: 'event_cancel',
  });

  if ((proposal.num_bars || 0) > 0 && Number(snap?.bar_rental?.total || 0) > 0) {
    targets.push({
      target: 'bar',
      label: 'Bar Rental',
      amount: Number(snap.bar_rental.total),
      quantity: proposal.num_bars,
      cancellable: true,
    });
  }

  for (const row of addonRows) {
    if (!row.addon_id || !row.slug) {
      // Orphaned row (catalog addon deleted; addon_id ON DELETE SET NULL): the
      // fold cannot reprice a row that no longer joins service_addons, so it
      // is not a fold-safe cancel target. The admin edits it in the editor.
      targets.push({
        target: null,
        label: row.addon_name,
        amount: Number(row.line_total),
        cancellable: false,
        reason: 'orphaned_addon',
      });
      continue;
    }
    const qty = Number(row.quantity) || 1;
    targets.push({
      target: `addon:${row.slug}`,
      label: row.addon_name,
      amount: Number(row.line_total),
      ...(quantityIsCount(row.billing_type) && qty > 1 ? { quantity: qty } : {}),
      ...(labSlugs.has(row.slug) ? { labOwned: true } : {}),
      cancellable: true,
    });
  }

  for (const id of snap?.syrups?.selections || []) {
    targets.push({
      target: `syrup:${id}`,
      label: `Syrup: ${id}`,
      amount: null, // pack math; per-syrup delta is the preview's job
      cancellable: true,
    });
  }

  if (pkg) {
    const rb = removableBartenders({
      pkg,
      guestCount: proposal.guest_count,
      durationHours: Number(proposal.event_duration_hours),
      actual: proposal.num_bartenders,
    });
    if (rb.removable > 0) {
      // MIRROR the engine's own staffing line rather than recomputing it, so
      // the admin UI can bind this target to its row by label + amount. Two
      // traps this avoids (push review, 2026-07-26): the hand-written label
      // "Additional bartender(s)" matched no row at all, orphaning the control
      // beside a near-identical add-on line and setting up a mis-click; and
      // staffing.total is NOT the row's amount, because the engine puts the
      // sub-100-guest surcharge on its own Shared Gratuity row
      // (pricingEngine.js:458-481). The override line is emitted BEFORE the
      // add-on lines, so the first "Additional Bartender…" row is ours — which
      // also picks up the "— Included with class" variant verbatim.
      const staffingRow = (snap?.breakdown || []).find(
        (b) => typeof b?.label === 'string' && b.label.startsWith('Additional Bartender')
      );
      const extra = Number(snap?.staffing?.extra || 0);
      const hours = Number(proposal.event_duration_hours) || 0;
      targets.push({
        target: 'extra-bartender',
        label: staffingRow?.label ?? `Additional Bartender${extra !== 1 ? 's' : ''} (${extra})`,
        amount: staffingRow
          ? Number(staffingRow.amount)
          : Math.round(extra * hours * Number(snap?.staffing?.hourly_rate || 0) * 100) / 100,
        count: rb.removable,
        cancellable: true,
      });
    }
  }

  (proposal.adjustments || []).forEach((adj, idx) => {
    const amt = Math.abs(Number(adj.amount) || 0);
    targets.push({
      target: `adjustment:${idx}`,
      label: adj.label || (adj.type === 'discount' ? 'Discount' : 'Surcharge'),
      amount: adj.type === 'discount' ? -amt : amt,
      cancellable: true,
    });
  });

  if (Number(proposal.gratuity_rate) > 0) {
    targets.push({
      target: 'gratuity',
      label: 'Gratuity',
      amount: Number(snap?.gratuity?.total || 0),
      rate: Number(proposal.gratuity_rate),
      cancellable: true,
    });
  }

  return { eligible: true, targets };
}

// ---------------------------------------------------------------------------
// Part 2: the shared preview/execute core.
// ---------------------------------------------------------------------------

// Delta invoices bill money already folded into total_price ('Additional
// Services' from an admin increase, 'Enhancement Lab' from a fully-paid lab
// round, 'Drink Plan Extras' from submit). When a removal lowers the total,
// open unpaid ones must shrink or the client is chased for cancelled money.
const DELTA_LABELS = ['Additional Services', 'Enhancement Lab', 'Drink Plan Extras'];

function positiveIntOrThrow(value, field, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new ValidationError({ [field]: `Must be a whole number between 1 and ${max}` });
  }
  return n;
}

/**
 * Strip a lab-owned selection from the newest drink plan so the client's next
 * Lab save cannot resurrect the cancelled item (lab GET ownership AND the
 * shopping-list generator both read selections, never proposal_addons).
 * `mutate(selections)` edits in place and returns true when it changed.
 */
async function stripLabSelection(client, proposalId, mutate) {
  const res = await client.query(
    'SELECT id, selections FROM drink_plans WHERE proposal_id = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE',
    [proposalId]
  );
  const plan = res.rows[0];
  if (!plan || !plan.selections) return { labCleaned: false, labPlanId: null };
  const selections = plan.selections;
  if (!mutate(selections)) return { labCleaned: false, labPlanId: null };
  await client.query(
    'UPDATE drink_plans SET selections = $1::jsonb, updated_at = NOW() WHERE id = $2',
    [JSON.stringify(selections), plan.id]
  );
  return { labCleaned: true, labPlanId: plan.id };
}

/**
 * Reconcile open unlocked delta invoices down after a decrease, mirroring the
 * lab remainder arithmetic (lab.js:365-440) with the same guarded update.
 * Locked invoices are NEVER touched (their totals stand; the preview says so).
 * Status is deliberately not flipped (lab precedent: a zeroed invoice stays
 * 'sent' with due 0); keep >= amount_paid so due can never fall below held
 * money. Returns [{ id, label, fromCents, toCents }] for changed rows only.
 */
async function reconcileOpenDeltaInvoices(client, proposal, snapshot) {
  const open = (await client.query(
    `SELECT id, label, amount_due, amount_paid FROM invoices
      WHERE proposal_id = $1 AND locked = false AND status IN ('sent', 'partially_paid')
        AND label = ANY($2)
      ORDER BY id DESC
      FOR UPDATE`,
    [proposal.id, DELTA_LABELS]
  )).rows;
  if (open.length === 0) return [];

  const absorbing = await client.query(
    `SELECT id FROM invoices
      WHERE proposal_id = $1 AND locked = false AND status != 'void'
        AND label IN ('Balance', 'Full Payment') LIMIT 1`,
    [proposal.id]
  );

  let headroomLeft = null;
  if (absorbing.rows.length === 0) {
    // Locked-invoice world: the delta invoices are the only live demand.
    // headroom = what is still genuinely owed outside locked + contract-open
    // invoices, exactly the lab remainder formula.
    const lockedAgg = await client.query(
      `SELECT COALESCE(SUM(amount_due), 0) AS locked_total FROM invoices
        WHERE proposal_id = $1 AND locked = true AND status != 'void'
          AND COALESCE(label, '') <> 'Drink Plan Extras'`,
      [proposal.id]
    );
    const openOthers = await client.query(
      `SELECT COALESCE(SUM(amount_due), 0) AS open_total FROM invoices
        WHERE proposal_id = $1 AND locked = false AND status != 'void'
          AND NOT (label = ANY($2))`,
      [proposal.id, DELTA_LABELS]
    );
    headroomLeft = Math.max(0,
      toCents(snapshot.total)
      - toCents(proposal.external_paid || 0)
      - Number(lockedAgg.rows[0].locked_total)
      - Number(openOthers.rows[0].open_total));
  }

  const changed = [];
  for (const inv of open) {
    const due = Number(inv.amount_due);
    const paid = Number(inv.amount_paid) || 0;
    let keep;
    if (absorbing.rows.length > 0) {
      // An unlocked Balance/Full Payment was just rebuilt at the new total and
      // absorbs all remaining demand; the delta invoice keeps only held money.
      keep = paid;
    } else {
      keep = Math.min(due, Math.max(paid, headroomLeft));
      headroomLeft = Math.max(0, headroomLeft - keep);
    }
    if (keep === due) continue;
    const upd = await client.query(
      `UPDATE invoices SET amount_due = $1, updated_at = NOW()
        WHERE id = $2 AND locked = false AND status IN ('sent', 'partially_paid')`,
      [keep, inv.id]
    );
    if (upd.rowCount === 0) continue;
    await writeLineItems(
      inv.id,
      keep > 0
        ? [{
            description: `${inv.label} (adjusted after item removal)`,
            quantity: 1, unit_price: keep, line_total: keep,
            source_type: 'manual', source_id: null,
          }]
        : [],
      client
    );
    changed.push({ id: inv.id, label: inv.label, fromCents: due, toCents: keep });
  }
  return changed;
}

/**
 * The one-motion cancel core: per-kind mutation, contract-safe fold, invoice
 * refresh + delta reconcile, shift sync, activity log. Runs inside the
 * CALLER's transaction and takes the proposal FOR UPDATE itself. The preview
 * endpoint calls this and ROLLS BACK; execute COMMITs. It never moves money:
 * the refund plan is computed by the caller from the returned overpaymentCents.
 *
 * @param {object} client  held transaction client
 * @param {object} a
 * @param {number|string} a.proposalId
 * @param {string|{kind,key}} a.target
 * @param {number|null} [a.quantity]   addon units / bars / bartenders to remove; default ALL removable
 * @param {number|null} [a.newRate]    gratuity kind only; null = remove entirely
 * @param {number} a.actorId
 * @param {object|null} [a.expectFingerprint]  from the preview; mismatch throws STALE_PREVIEW
 */
async function applyLineItemCancel(client, {
  proposalId, target, quantity = null, newRate = null, actorId, expectFingerprint = null,
}) {
  const t = typeof target === 'string' ? parseCancelTarget(target) : target;

  // 1. Lock + guards.
  const pRes = await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [proposalId]);
  const proposal = pRes.rows[0];
  if (!proposal) throw new NotFoundError('Proposal not found');
  if (CANCEL_BLOCKED_STATUSES.includes(proposal.status)) {
    throw new ConflictError('Line items cannot be removed from an archived or completed proposal.', 'NOT_CANCELLABLE');
  }
  const fingerprint = {
    updated_at: proposal.updated_at instanceof Date ? proposal.updated_at.toISOString() : String(proposal.updated_at),
    amount_paid: Number(proposal.amount_paid) || 0,
    total_price: Number(proposal.total_price) || 0,
  };
  if (expectFingerprint && (
    expectFingerprint.updated_at !== fingerprint.updated_at
    || Number(expectFingerprint.amount_paid) !== fingerprint.amount_paid
    || Number(expectFingerprint.total_price) !== fingerprint.total_price
  )) {
    throw new ConflictError('This proposal changed since the preview. Review the numbers again.', 'STALE_PREVIEW');
  }
  if (t.kind === 'package') {
    throw new ConflictError('Removing the package is an event cancellation. Use the cancel-event flow.', 'PACKAGE_IS_EVENT_CANCEL');
  }
  const pkg = proposal.package_id
    ? (await client.query('SELECT * FROM service_packages WHERE id = $1', [proposal.package_id])).rows[0]
    : null;
  if (!pkg) throw new ConflictError('This proposal has no package; edit it in the proposal editor.', 'NO_PACKAGE');
  const snapBefore = readSnapshot(proposal.pricing_snapshot, { context: 'lineItemCancel.apply' });
  const oldTotal = Number(proposal.total_price) || 0;

  // 2. Before legs (defaults double as After for kinds that don't touch them).
  const addonsBefore = await loadRepriceAddons(client, proposalId);
  const syrupsBefore = snapBefore?.syrups?.selections || [];
  const numBarsBefore = proposal.num_bars ?? 0;
  const bartendersBefore = proposal.num_bartenders;
  const adjustmentsBefore = proposal.adjustments || [];
  let addonsAfter = addonsBefore;
  let syrupsAfter = syrupsBefore;
  let numBarsAfter = numBarsBefore;
  let bartendersAfter = bartendersBefore;
  let adjustmentsAfter = adjustmentsBefore;

  // 3. Per-kind mutation.
  let removedLabel = null;
  let labCleanup = { labCleaned: false, labPlanId: null };
  let gratuity = null;
  let partialAddonId = null;

  if (t.kind === 'addon') {
    const rowRes = await client.query(
      `SELECT pa.id, pa.addon_id, pa.addon_name, pa.billing_type, pa.quantity, sa.slug
         FROM proposal_addons pa JOIN service_addons sa ON sa.id = pa.addon_id
        WHERE pa.proposal_id = $1 AND sa.slug = $2`,
      [proposalId, t.key]
    );
    const row = rowRes.rows[0];
    if (!row) throw new NotFoundError('That add-on is not on this proposal.');
    removedLabel = row.addon_name;
    const storedQty = Number(row.quantity) || 1;
    let removeN = storedQty;
    if (quantity !== null) {
      if (!quantityIsCount(row.billing_type)) {
        throw new ValidationError({ quantity: 'This add-on is priced per guest or per staff; remove it entirely instead.' });
      }
      removeN = positiveIntOrThrow(quantity, 'quantity', storedQty);
    }
    if (removeN >= storedQty) {
      await client.query('DELETE FROM proposal_addons WHERE id = $1', [row.id]);
      labCleanup = await stripLabSelection(client, proposalId, (sel) => {
        if (sel.addOns && sel.addOns[t.key] && sel.addOns[t.key].labAdded === true) {
          delete sel.addOns[t.key];
          return true;
        }
        return false;
      });
    } else {
      await client.query('UPDATE proposal_addons SET quantity = $1 WHERE id = $2', [storedQty - removeN, row.id]);
      partialAddonId = row.addon_id;
    }
    addonsAfter = await loadRepriceAddons(client, proposalId);
  } else if (t.kind === 'bar') {
    // Deliberately permissive vs computeCancelTargets (which only advertises a
    // bar with a priced line): removing a $0 bundled bar via direct API is
    // fold-correct (zero delta) and just drops the logistics count.
    if (numBarsBefore <= 0) throw new NotFoundError('No bar rental to remove.');
    const n = quantity === null ? numBarsBefore : positiveIntOrThrow(quantity, 'quantity', numBarsBefore);
    numBarsAfter = numBarsBefore - n;
    await client.query('UPDATE proposals SET num_bars = $1 WHERE id = $2', [numBarsAfter, proposalId]);
    proposal.num_bars = numBarsAfter;
    removedLabel = 'Bar Rental';
  } else if (t.kind === 'syrup') {
    if (!syrupsBefore.includes(t.key)) throw new NotFoundError('That syrup is not on this proposal.');
    syrupsAfter = syrupsBefore.filter((s) => s !== t.key);
    removedLabel = `Syrup: ${t.key}`;
    labCleanup = await stripLabSelection(client, proposalId, (sel) => {
      let changedSel = false;
      const map = sel.labSyrupSelections || {};
      for (const drinkId of Object.keys(map)) {
        if (Array.isArray(map[drinkId]) && map[drinkId].includes(t.key)) {
          map[drinkId] = map[drinkId].filter((s) => s !== t.key);
          if (map[drinkId].length === 0) delete map[drinkId];
          changedSel = true;
        }
      }
      return changedSel;
    });
  } else if (t.kind === 'extra-bartender') {
    const rb = removableBartenders({
      pkg,
      guestCount: proposal.guest_count,
      durationHours: Number(proposal.event_duration_hours),
      actual: proposal.num_bartenders,
    });
    if (rb.removable <= 0) {
      throw new ConflictError('No removable bartenders above the package staffing.', 'AT_STAFFING_FLOOR');
    }
    const n = quantity === null ? rb.removable : positiveIntOrThrow(quantity, 'quantity', rb.removable);
    bartendersAfter = rb.actual - n;
    await client.query('UPDATE proposals SET num_bartenders = $1 WHERE id = $2', [bartendersAfter, proposalId]);
    proposal.num_bartenders = bartendersAfter;
    removedLabel = n === 1 ? 'Additional bartender' : `${n} additional bartenders`;
  } else if (t.kind === 'adjustment') {
    if (t.key >= adjustmentsBefore.length) throw new NotFoundError('That adjustment is not on this proposal.');
    const adj = adjustmentsBefore[t.key];
    removedLabel = adj.label || (adj.type === 'discount' ? 'Discount' : 'Surcharge');
    adjustmentsAfter = adjustmentsBefore.filter((_, i) => i !== t.key);
    await client.query('UPDATE proposals SET adjustments = $1::jsonb WHERE id = $2',
      [JSON.stringify(adjustmentsAfter), proposalId]);
    proposal.adjustments = adjustmentsAfter;
  } else if (t.kind === 'gratuity') {
    const rate = Number(proposal.gratuity_rate) || 0;
    if (rate <= 0) throw new NotFoundError('No gratuity to remove.');
    const targetRate = newRate === null ? 0 : Number(newRate);
    if (!Number.isFinite(targetRate) || targetRate < 0 || targetRate >= rate) {
      throw new ValidationError({ new_rate: 'Enter a rate below the current one (or remove entirely).' });
    }
    // Below the $50 no-jar floor the DB CHECK (tip_jar OR gratuity_rate >= 50)
    // admits only tip_jar = true, and staff MUST be told they can set out a
    // jar (mandatory notice; the BEO page is the durable record).
    const tipJarAfter = targetRate >= 50 ? proposal.tip_jar : true;
    await client.query(
      `UPDATE proposals SET gratuity_rate = $1, tip_jar = $2, gratuity_rate_change_origin = 'admin' WHERE id = $3`,
      [targetRate, tipJarAfter, proposalId]
    );
    proposal.gratuity_rate = targetRate;
    proposal.tip_jar = tipJarAfter;
    removedLabel = 'Gratuity';
    gratuity = { newRate: targetRate, tipJarAfter, staffNotice: targetRate < 50 };
  } else {
    throw new ValidationError({ target: `Unhandled cancel target kind: ${t.kind}` });
  }

  // 4. Contract-safe reprice: override moves by the catalog delta of exactly
  // what changed; the final snapshot prices at the After legs.
  const { snapshot, statusChanged } = await foldExtrasIntoProposal({
    client, proposal, pkg,
    addonsBefore, addonsAfter, syrupsBefore, syrupsAfter,
    numBarsBefore, numBarsAfter,
    numBartendersBefore: bartendersBefore, numBartendersAfter: bartendersAfter,
    adjustmentsBefore, adjustmentsAfter,
    statusChangeReason: 'line_item_cancelled',
  });

  // 5. Partial-quantity removal: keep the row's line_total honest with the
  // fresh snapshot. line_total ONLY: the snapshot entry's `quantity` is the
  // ENGINE-facing figure (per_hour bakes effectiveHours x count,
  // pricingEngine.js:166-169), while proposal_addons.quantity is the raw unit
  // count the fold's withRepriceQuantities contract expects — step 3 already
  // wrote the correct count, and overwriting it with the baked figure would
  // silently overbill every later reprice (checkpoint code-review, 2026-07-24).
  if (partialAddonId !== null) {
    const entry = (snapshot.addons || []).find((a) => a.id === partialAddonId);
    if (entry) {
      await client.query('UPDATE proposal_addons SET line_total = $1 WHERE proposal_id = $2 AND addon_id = $3',
        [entry.line_total, proposalId, partialAddonId]);
    }
  }

  // 6. Invoice cascade: rebuild unlocked invoices at the new pricing; a RISE
  // (discount removal) flows through the existing increase path instead.
  await refreshUnlockedInvoices(proposalId, client);
  let deltaInvoicesAdjusted = [];
  if (toCents(snapshot.total) > toCents(oldTotal)) {
    await createAdditionalInvoiceIfNeeded(Number(proposalId), toCents(oldTotal), client);
  } else {
    deltaInvoicesAdjusted = await reconcileOpenDeltaInvoices(client, proposal, snapshot);
  }

  // 7. Shifts follow staffing (no-ops for non-staffing kinds and multi-shift
  // events; shrink is capped at approved heads and logged by the sync itself).
  await syncShiftsFromProposal(proposalId, client);

  // 8. Staffing warning for the preview: approved bartenders above the new
  // desired roster are NOT auto-unassigned; the admin resolves them by hand.
  let staffingWarning = null;
  if (t.kind === 'extra-bartender') {
    const staffingAddons = await loadStaffingAddons(proposal, client);
    const desired = rosterCounts(deriveStaffingRoster(proposal, staffingAddons));
    const desiredBartenders = desired.Bartender || 0;
    const approvedRes = await client.query(
      `SELECT COUNT(*)::int AS n
         FROM shift_requests sr JOIN shifts s ON s.id = sr.shift_id
        WHERE s.proposal_id = $1 AND sr.status = 'approved' AND sr.dropped_at IS NULL
          AND (sr.position IS NULL OR LOWER(TRIM(sr.position)) = 'bartender')`,
      [proposalId]
    );
    const approved = approvedRes.rows[0].n;
    if (approved > desiredBartenders) {
      staffingWarning = { role: 'Bartender', approved, desired: desiredBartenders };
    }
  }

  // 9. Audit trail (refund IDs land in the execute route's follow-up row,
  // 'line_item_cancel_refunded': refunds fire post-commit and cannot exist yet).
  await client.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
     VALUES ($1, 'line_item_cancelled', 'admin', $2, $3)`,
    [proposalId, actorId, JSON.stringify({
      target: typeof target === 'string' ? target : `${t.kind}${t.key !== null ? ':' + t.key : ''}`,
      quantity, new_rate: newRate, removed_label: removedLabel,
      old_total: oldTotal, new_total: snapshot.total,
    })]
  );

  // 10. Result.
  const lockedInvoices = (await client.query(
    `SELECT id, label, amount_due FROM invoices
      WHERE proposal_id = $1 AND locked = true AND status != 'void' ORDER BY id`,
    [proposalId]
  )).rows.map((r) => ({ id: r.id, label: r.label, amount_due: Number(r.amount_due) }));

  return {
    oldTotal,
    newTotal: Number(snapshot.total),
    externalPaid: Number(proposal.external_paid) || 0,
    snapshot,
    statusChanged,
    newStatus: proposal.status,
    overpaymentCents: Math.max(0, Math.round(fingerprint.amount_paid * 100) - toCents(snapshot.total)),
    removedLabel,
    lockedInvoices,
    deltaInvoicesAdjusted,
    staffingWarning,
    labCleaned: labCleanup.labCleaned,
    labPlanId: labCleanup.labPlanId,
    gratuity,
    fingerprint,
  };
}

module.exports = {
  CANCEL_BLOCKED_STATUSES,
  parseCancelTarget,
  removableBartenders,
  computeCancelTargets,
  applyLineItemCancel,
};


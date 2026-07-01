// Proposal option groups: the admin-side model for "compare your options".
//
// A group bundles two or three sibling proposal rows behind one public
// /compare/:token link. Each option stays a full proposal; this module only
// creates/attaches/detaches options and reads a group's members. Sending,
// the public compare view, and the pay-time choice-commit live elsewhere.
const { pool } = require('../db');
const { insertProposalRecord } = require('./proposalInsert');
const { ConflictError, NotFoundError } = require('./errors');

// Only these statuses may spawn or join a comparison. A paid/booked proposal
// (amount_paid > 0) or an accepted/archived/completed one is never groupable.
const GROUPABLE_STATUSES = ['draft', 'sent', 'viewed', 'modified'];
const MAX_OPTIONS = 3;

// Map a proposals row (snake_case) onto insertProposalRecord's camelCase field
// bag. Copies the shared logistics + the source's package/pricing so the clone
// is immediately valid; admin swaps the package afterward. NOTE: insertProposalRecord
// writes neither group_id nor payment_type/deposit_amount, so group_id is set by
// an explicit UPDATE after insert; payment_type is irrelevant here (the winner's
// settle-time payment_type governs its invoice, not the clone's default).
function buildCloneFieldBag(src, actorUserId) {
  return {
    clientId: src.client_id,
    eventDate: src.event_date,
    eventStartTime: src.event_start_time,
    durationHours: src.event_duration_hours,
    guestCount: src.guest_count,
    packageId: src.package_id,
    numBars: src.num_bars,
    numBartenders: src.num_bartenders,
    pricingSnapshot: src.pricing_snapshot, // JSONB -> object; carries .addons for re-insert
    totalPrice: src.total_price,
    createdBy: actorUserId,
    status: 'draft',
    eventType: src.event_type,
    eventTypeCategory: src.event_type_category,
    eventTypeCustom: src.event_type_custom,
    classOptions: src.class_options,
    clientProvidesGlassware: src.client_provides_glassware,
    source: src.source,
    eventLocationFallback: src.event_location,
    venue: {
      name: src.venue_name, street: src.venue_street, city: src.venue_city,
      state: src.venue_state, zip: src.venue_zip,
    },
  };
}

// Clone `sourceProposalId` into a sibling option in the same group (creating the
// group if the source is not grouped yet). Serialized by a FOR UPDATE on the
// source so a double-click cannot spawn two clones / two groups.
// Returns { groupId, groupToken, newProposalId }.
async function addAlternative(sourceProposalId, actorUserId, db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [src] } = await client.query(
      'SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [sourceProposalId]);
    if (!src) throw new NotFoundError('Proposal not found');
    if (!GROUPABLE_STATUSES.includes(src.status) || Number(src.amount_paid || 0) > 0) {
      throw new ConflictError('This proposal can no longer take alternatives');
    }

    let groupId = src.group_id;
    let groupToken;
    if (!groupId) {
      const { rows: [g] } = await client.query(
        'INSERT INTO proposal_groups (client_id, created_by) VALUES ($1, $2) RETURNING id, token',
        [src.client_id, actorUserId]);
      groupId = g.id; groupToken = g.token;
      await client.query('UPDATE proposals SET group_id = $1 WHERE id = $2', [groupId, sourceProposalId]);
    } else {
      const { rows: [g] } = await client.query(
        'SELECT token FROM proposal_groups WHERE id = $1 FOR UPDATE', [groupId]);
      if (!g) throw new NotFoundError('Group not found');
      groupToken = g.token;
    }

    const { rows: [{ n }] } = await client.query(
      'SELECT COUNT(*)::int AS n FROM proposals WHERE group_id = $1', [groupId]);
    if (n >= MAX_OPTIONS) throw new ConflictError(`A comparison holds at most ${MAX_OPTIONS} options`);

    const clone = await insertProposalRecord(client, buildCloneFieldBag(src, actorUserId));
    // insertProposalRecord does not write group_id; attach the clone explicitly.
    await client.query('UPDATE proposals SET group_id = $1 WHERE id = $2', [groupId, clone.id]);

    await client.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'alternative_added', 'admin', $2, $3)`,
      [sourceProposalId, actorUserId, JSON.stringify({ new_proposal_id: clone.id, group_id: groupId })]);

    await client.query('COMMIT');
    return { groupId, groupToken, newProposalId: clone.id };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Detach a member from its group. If that leaves a single member, dissolve the
// group so the survivor reverts to a normal solo proposal. Refuses on a decided
// group (a winner is booked). Returns { dissolved }.
async function removeAlternative(proposalId, actorUserId, db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [p] } = await client.query(
      'SELECT id, group_id FROM proposals WHERE id = $1 FOR UPDATE', [proposalId]);
    if (!p) throw new NotFoundError('Proposal not found');
    if (!p.group_id) throw new ConflictError('This proposal is not part of a comparison');

    const groupId = p.group_id;
    const { rows: [g] } = await client.query(
      'SELECT chosen_proposal_id FROM proposal_groups WHERE id = $1 FOR UPDATE', [groupId]);
    if (g && g.chosen_proposal_id) throw new ConflictError('This comparison is already decided');

    await client.query('UPDATE proposals SET group_id = NULL WHERE id = $1', [proposalId]);
    await client.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'alternative_removed', 'admin', $2, $3)`,
      [proposalId, actorUserId, JSON.stringify({ group_id: groupId })]);

    const { rows: [{ n }] } = await client.query(
      'SELECT COUNT(*)::int AS n FROM proposals WHERE group_id = $1', [groupId]);
    let dissolved = false;
    if (n <= 1) {
      await client.query('UPDATE proposals SET group_id = NULL WHERE group_id = $1', [groupId]);
      await client.query('DELETE FROM proposal_groups WHERE id = $1', [groupId]);
      dissolved = true;
    }

    await client.query('COMMIT');
    return { dissolved };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Ordered options for a group, with the package fields the compare view needs
// (name/slug/category/pricing_type via a service_packages join, same shape as
// publicToken). Ordered by created_at so column order is stable.
async function getGroupMembers(groupId, db = pool) {
  const { rows } = await db.query(
    `SELECT p.id, p.token, p.status, p.total_price, p.package_id,
            sp.name AS package_name, sp.slug AS package_slug,
            sp.category AS package_category, sp.pricing_type
       FROM proposals p
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.group_id = $1
      ORDER BY p.created_at ASC`,
    [groupId]);
  return rows;
}

// Group summary for a given proposal (for the admin Alternatives panel).
// Returns null when the proposal is solo (group_id IS NULL).
async function getGroupForProposal(proposalId, db = pool) {
  const { rows: [row] } = await db.query(
    `SELECT g.id, g.token, g.chosen_proposal_id
       FROM proposals p JOIN proposal_groups g ON g.id = p.group_id
      WHERE p.id = $1`, [proposalId]);
  if (!row) return null;
  const members = await getGroupMembers(row.id, db);
  return {
    group_id: row.id,
    group_token: row.token,
    decided: row.chosen_proposal_id !== null,
    chosen_proposal_id: row.chosen_proposal_id,
    members,
  };
}

module.exports = {
  GROUPABLE_STATUSES,
  MAX_OPTIONS,
  addAlternative,
  removeAlternative,
  getGroupMembers,
  getGroupForProposal,
};

// Choice-commit for proposal option groups. Runs INSIDE the settle transaction of
// the winning option's first payment (webhook or admin record-payment), BEFORE the
// amount_paid/invoice-link step, on the caller's dbClient. It does NOT create the
// winner's invoice (the caller does that AFTER stamping payment_type, so Deposit vs
// Full is picked correctly) and does NOT run the best-effort marketing/change-request
// reaps (those run post-commit in the caller, matching today's ->archived semantics
// so a loser's reap failure can never roll back a paid winner).
//
// Returns { committed, conflict, archivedLoserIds }:
//   - solo proposal (no group)            -> { committed:false, conflict:false, [] }
//   - this call won the first-writer race -> { committed:true,  conflict:false, [loserIds] }
//   - group already decided by THIS winner-> { committed:false, conflict:false, [] }  (idempotent replay)
//   - group already decided by ANOTHER    -> { committed:false, conflict:true,  [] }  (money on a loser)
const { voidUnpaidProposalInvoice } = require('./invoiceVoid');

const CONVERTED_STATUSES = ['deposit_paid', 'balance_paid', 'confirmed', 'completed'];
// Pre-payment statuses eligible for the same-client sweep; matches the lifecycle
// state machine's ->archived set exactly.
const SWEEPABLE_STATUSES = ['draft', 'sent', 'viewed', 'modified', 'accepted'];

async function commitGroupChoice(winnerProposalId, dbClient) {
  const winnerId = Number(winnerProposalId);
  const { rows: [winner] } = await dbClient.query(
    'SELECT id, group_id FROM proposals WHERE id = $1', [winnerId]);
  if (!winner || winner.group_id === null) {
    return { committed: false, conflict: false, archivedLoserIds: [] };
  }
  const groupId = winner.group_id;

  // Serialize concurrent settlements of two options in the same group.
  await dbClient.query('SELECT id FROM proposal_groups WHERE id = $1 FOR UPDATE', [groupId]);

  // First-writer-wins: only the first settling option sets chosen_proposal_id.
  const claim = await dbClient.query(
    `UPDATE proposal_groups SET chosen_proposal_id = $1, updated_at = NOW()
      WHERE id = $2 AND chosen_proposal_id IS NULL`,
    [winnerId, groupId]);

  if (claim.rowCount === 0) {
    const { rows: [g] } = await dbClient.query(
      'SELECT chosen_proposal_id FROM proposal_groups WHERE id = $1', [groupId]);
    // Same winner replaying (idempotent) vs a genuine second-option conflict.
    if (g && Number(g.chosen_proposal_id) === winnerId) {
      return { committed: false, conflict: false, archivedLoserIds: [] };
    }
    return { committed: false, conflict: true, archivedLoserIds: [] };
  }

  // We won. Archive every losing sibling (unless it somehow already converted) and
  // void its unpaid invoice. Best-effort marketing/change-request reaps run in the
  // caller AFTER commit (see the money-commit lane's Task 11 wiring).
  const { rows: losers } = await dbClient.query(
    'SELECT id FROM proposals WHERE group_id = $1 AND id <> $2', [groupId, winnerId]);
  const archivedLoserIds = [];
  for (const loser of losers) {
    const upd = await dbClient.query(
      `UPDATE proposals SET status = 'archived', archive_reason = 'option_not_chosen', updated_at = NOW()
        WHERE id = $1 AND status <> ALL($2)`,
      [loser.id, CONVERTED_STATUSES]);
    if (upd.rowCount === 0) continue; // a converted sibling is left alone (defensive)
    await voidUnpaidProposalInvoice(loser.id, dbClient);
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'option_not_chosen', 'system', NULL, $2)`,
      [loser.id, JSON.stringify({ group_id: groupId, chosen_proposal_id: winnerId })]);
    archivedLoserIds.push(loser.id);
  }

  await dbClient.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
     VALUES ($1, 'option_chosen', 'system', NULL, $2)`,
    [winnerId, JSON.stringify({ group_id: groupId })]);

  return { committed: true, conflict: false, archivedLoserIds };
}

// Same-client sweep for UNGROUPED alternatives. When a client's FIRST payment
// settles on a proposal, their other open proposals (draft/sent/viewed/modified/
// accepted, nothing paid) are almost always alternatives for the same event, so
// archive them like formal-group losers: status 'archived' + reason
// 'option_not_chosen' + unpaid-invoice void + activity row. Runs INSIDE the
// settle tx, AFTER commitGroupChoice (formal-group losers are already 'archived'
// by then, so the status filter skips them; this catches ungrouped strays).
// Callers must gate on initial-booking payments only (deposit/full, or
// record-payment with nothing previously paid): a balance or extras payment
// months later must never sweep, because a new draft for the client's NEXT
// event is legitimate by then. Best-effort marketing/change-request reaps run
// post-commit in the caller, same as commitGroupChoice's losers.
//
// Returns { sweptIds }.
async function sweepClientAlternatives(winnerProposalId, dbClient) {
  const winnerId = Number(winnerProposalId);
  const { rows: [winner] } = await dbClient.query(
    'SELECT id, client_id FROM proposals WHERE id = $1', [winnerId]);
  if (!winner || winner.client_id === null) return { sweptIds: [] };

  // Serialize concurrent archivers via the client row. GLOBAL LOCK ORDER:
  // clients -> proposal_groups -> proposals — every path that archives
  // proposals (this sweep, commitGroupChoice's losers via the settle-site
  // hoist, the admin archive endpoint) must take the client lock before any
  // proposal row, or two paths can deadlock AB-BA. The settle sites hoist
  // this same lock BEFORE commitGroupChoice, so this acquisition is normally
  // a same-tx re-lock (a no-op); it stays here so the helper is safe alone.
  await dbClient.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [winner.client_id]);

  const { rows: alts } = await dbClient.query(
    `SELECT id FROM proposals
      WHERE client_id = $1 AND id <> $2
        AND status = ANY($3) AND COALESCE(amount_paid, 0) = 0
      ORDER BY id
      FOR UPDATE`,
    [winner.client_id, winnerId, SWEEPABLE_STATUSES]);

  const sweptIds = [];
  for (const alt of alts) {
    await dbClient.query(
      `UPDATE proposals SET status = 'archived', archive_reason = 'option_not_chosen', updated_at = NOW()
        WHERE id = $1`,
      [alt.id]);
    await voidUnpaidProposalInvoice(alt.id, dbClient);
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'option_not_chosen', 'system', NULL, $2)`,
      [alt.id, JSON.stringify({ swept_by_proposal_id: winnerId })]);
    sweptIds.push(alt.id);
  }
  return { sweptIds };
}

module.exports = { commitGroupChoice, sweepClientAlternatives };

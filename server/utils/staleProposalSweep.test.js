// Stale-proposal sweep. Run alone:
//   node -r dotenv/config --test server/utils/staleProposalSweep.test.js
//
// SHARED DEV DB NOTE: the sweep scans every proposal in the database and will
// legitimately archive unrelated stale rows. No test asserts a global count.
// Each asserts on ITS OWN fixture proposal by id.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  selectCandidates,
  archiveOne,
  SWEEP_STATUSES,
} = require('./staleProposalSweep');

let seq = 0;
const made = [];

// daysAgo(3) => a date string 3 days before today, so fixtures are relative to
// the run and never rot. Chicago is the fixture timezone throughout.
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// NOTE: pendingMessage requires a client (recipient_id is NOT NULL), so never
// combine `clientless: true` with `pendingMessage: true`.
async function fixture({
  status = 'viewed', eventDate, amountPaid = 0, timezone = 'America/Chicago',
  clientless = false, invoice = null, pendingMessage = false,
}) {
  if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');
  const tag = `${process.pid}-${++seq}`;
  let clientId = null;
  if (!clientless) {
    const c = await pool.query(
      `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'other') RETURNING id`,
      [`Sweep Fixture ${tag}`, `sweep-${tag}@example.com`]
    );
    clientId = c.rows[0].id;
  }
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_timezone, guest_count,
                            total_price, amount_paid, status, sent_at)
     VALUES ($1, $2, $3, 50, 500, $4, $5, NOW()) RETURNING id`,
    [clientId, eventDate, timezone, amountPaid, status]
  );
  const proposalId = p.rows[0].id;
  let invoiceId = null;
  if (invoice) {
    const r = await pool.query(
      `INSERT INTO invoices (proposal_id, label, amount_due, amount_paid, status, invoice_number)
       VALUES ($1, 'Deposit', 10000, 0, $2, $3) RETURNING id`,
      [proposalId, invoice, `SW${tag}`]
    );
    invoiceId = r.rows[0].id;
  }
  if (pendingMessage) {
    // Column shape matters: there is NO send_at column (it is scheduled_for), and
    // recipient_type + recipient_id are both NOT NULL. recipient_type is CHECK-ed
    // to ('client','staff','admin'). Mirrors archive.test.js's makeScheduledMessage.
    await pool.query(
      `INSERT INTO scheduled_messages
         (entity_id, entity_type, message_type, recipient_type, recipient_id,
          channel, scheduled_for, status)
       VALUES ($1, 'proposal', 'test_fixture', 'client', $2, 'email',
               NOW() + INTERVAL '5 days', 'pending')`,
      [proposalId, clientId]
    );
  }
  made.push({ proposalId, clientId });
  return { proposalId, clientId, invoiceId };
}

// Snapshot of which proposals already carried a skip marker before this suite
// ran, so the cleanup below can tell a stray from a pre-existing one.
const preExistingSkipMarkers = new Set();
const preExistingHealMarkers = new Set();
test.before(async () => {
  const { rows } = await pool.query(
    'SELECT proposal_id, action FROM proposal_activity_log WHERE action = ANY($1)',
    [['auto_archive_skipped', 'pi_cancel_incomplete']]);
  for (const r of rows) {
    if (r.action === 'auto_archive_skipped') preExistingSkipMarkers.add(r.proposal_id);
    else preExistingHealMarkers.add(r.proposal_id);
  }
});

async function statusOf(proposalId) {
  const { rows } = await pool.query(
    'SELECT status, archive_reason FROM proposals WHERE id = $1', [proposalId]);
  return rows[0];
}

test.after(async () => {
  // Stray skip markers first: notifySkipped stamps every row matching the skip
  // query, so a test with a successful-send stub marks real dev proposals too.
  // Delete only markers that were not there before this suite started.
  const { rows: nowMarked } = await pool.query(
    'SELECT DISTINCT proposal_id FROM proposal_activity_log WHERE action = $1', ['auto_archive_skipped']);
  const strays = nowMarked.map((r) => r.proposal_id).filter((id) => !preExistingSkipMarkers.has(id));
  if (strays.length) {
    await pool.query(
      'DELETE FROM proposal_activity_log WHERE action = $1 AND proposal_id = ANY($2)',
      ['auto_archive_skipped', strays]);
    console.log(`    (cleaned ${strays.length} stray skip marker(s) off shared dev rows)`);
  }
  // Heal markers too. A leaked pi_cancel_incomplete marker carrying a fake pi_ id
  // would make every later run of processStaleProposals retrieve it against the
  // REAL Stripe client (the stub is only set inside the two tail tests) and never
  // clear, since a fake id never succeeds.
  const healStrays = await pool.query(
    'SELECT DISTINCT proposal_id FROM proposal_activity_log WHERE action = $1', ['pi_cancel_incomplete']);
  const healIds = healStrays.rows.map((r) => r.proposal_id).filter((id) => !preExistingHealMarkers.has(id));
  if (healIds.length) {
    await pool.query(
      'DELETE FROM proposal_activity_log WHERE action = $1 AND proposal_id = ANY($2)',
      ['pi_cancel_incomplete', healIds]);
    console.log(`    (cleaned ${healIds.length} stray heal marker(s) off shared dev rows)`);
  }
  for (const { proposalId, clientId } of made) {
    await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = $2', ['proposal', proposalId]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
    if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  }
  await pool.end();
});

test('SWEEP_STATUSES never contains accepted (the refunded-to-zero guard)', () => {
  assert.ok(!SWEEP_STATUSES.includes('accepted'),
    'accepted must stay exempt: the demote ladder parks refunded-to-zero bookings there');
});

test('archives a viewed proposal 3 days past its event date', async () => {
  const f = await fixture({ status: 'viewed', eventDate: daysAgo(3) });
  const ids = (await selectCandidates()).map((r) => r.id);
  assert.ok(ids.includes(f.proposalId), 'should be a candidate');
  await archiveOne(f.proposalId);
  assert.deepEqual(await statusOf(f.proposalId),
    { status: 'archived', archive_reason: 'event_passed' });
});

test('does NOT archive a proposal only 1 day past its event date', async () => {
  const f = await fixture({ status: 'viewed', eventDate: daysAgo(1) });
  const ids = (await selectCandidates()).map((r) => r.id);
  assert.ok(!ids.includes(f.proposalId), 'inside the 48-hour window');
});

test('does NOT archive an accepted proposal', async () => {
  const f = await fixture({ status: 'accepted', eventDate: daysAgo(10) });
  const ids = (await selectCandidates()).map((r) => r.id);
  assert.ok(!ids.includes(f.proposalId));
});

test('does NOT archive a proposal carrying money', async () => {
  const f = await fixture({ status: 'viewed', eventDate: daysAgo(10), amountPaid: 250 });
  const ids = (await selectCandidates()).map((r) => r.id);
  assert.ok(!ids.includes(f.proposalId));
});

test('voids the unpaid invoice and deletes pending scheduled messages', async () => {
  const f = await fixture({
    status: 'sent', eventDate: daysAgo(5), invoice: 'sent', pendingMessage: true });
  await archiveOne(f.proposalId);
  const inv = await pool.query('SELECT status FROM invoices WHERE id = $1', [f.invoiceId]);
  assert.equal(inv.rows[0].status, 'void');
  const msgs = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending'`,
    [f.proposalId]);
  assert.equal(msgs.rows[0].n, 0);
});

test('writes an activity-log row carrying the reap detail', async () => {
  const f = await fixture({
    status: 'viewed', eventDate: daysAgo(5), invoice: 'sent', pendingMessage: true });
  await archiveOne(f.proposalId);
  const { rows } = await pool.query(
    `SELECT action, actor_type, details FROM proposal_activity_log
      WHERE proposal_id = $1 AND action = 'archived'`, [f.proposalId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_type, 'system');
  const d = typeof rows[0].details === 'string' ? JSON.parse(rows[0].details) : rows[0].details;
  assert.equal(d.archive_reason, 'event_passed');
  assert.equal(d.via, 'stale_proposal_sweep');
  assert.equal(d.deleted_pending_messages, 1);
  assert.equal(d.voided_invoice_ids.length, 1);
});

test('archiveOne returns null when the status changed under the lock', async () => {
  const f = await fixture({ status: 'viewed', eventDate: daysAgo(5) });
  await pool.query(`UPDATE proposals SET status = 'deposit_paid' WHERE id = $1`, [f.proposalId]);
  assert.equal(await archiveOne(f.proposalId), null);
  assert.equal((await statusOf(f.proposalId)).status, 'deposit_paid');
});

test('archives a client-less proposal (the conditional client-lock branch)', async () => {
  const f = await fixture({ status: 'viewed', eventDate: daysAgo(5), clientless: true });
  await archiveOne(f.proposalId);
  assert.equal((await statusOf(f.proposalId)).status, 'archived');
});

test('the date expression is evaluated in the EVENT timezone, not the session', async () => {
  // The correctness core. The prod session is GMT, which rolls the date at 19:00
  // Chicago, so a naive comparison archives a Saturday-night event's quote while
  // the party is still running.
  //
  // Proven behaviorally by contrasting two rows on the SAME event_date, one in
  // Chicago and one in Pacific/Kiritimati (UTC+14). They are 19 hours apart, so
  // for most of the day exactly one has crossed the +2 day line. Which OFFSET
  // discriminates depends on the time of day, so find it at runtime rather than
  // hardcoding one: an earlier cut hardcoded daysAgo(2), where both zones had
  // already crossed, and the test passed for free.
  const { rows: probe } = await pool.query(`
    SELECT k,
      (((CURRENT_DATE - k) + INTERVAL '2 days') AT TIME ZONE 'Pacific/Kiritimati') < NOW() AS kir,
      (((CURRENT_DATE - k) + INTERVAL '2 days') AT TIME ZONE 'America/Chicago')    < NOW() AS chi
    FROM generate_series(0,4) AS k`);
  const split = probe.find((r) => r.kir && !r.chi);

  // Time-independent half: the same calendar date in two zones must yield
  // thresholds exactly 19 hours apart. This alone fails if AT TIME ZONE is dropped.
  const { rows: [delta] } = await pool.query(`
    SELECT EXTRACT(EPOCH FROM
      ((CURRENT_DATE + INTERVAL '2 days') AT TIME ZONE 'America/Chicago')
      - ((CURRENT_DATE + INTERVAL '2 days') AT TIME ZONE 'Pacific/Kiritimati')) AS secs`);
  assert.equal(Number(delta.secs), 19 * 3600,
    'Chicago and Kiritimati thresholds for the same date must be 19 hours apart');

  if (!split) {
    // ~5 hours a day no integer offset lands inside the 19-hour window.
    console.log('    (no discriminating offset at this hour; behavioral half skipped)');
    return;
  }
  const eventDate = daysAgo(Number(split.k));
  const chi = await fixture({ status: 'viewed', eventDate, timezone: 'America/Chicago' });
  const kir = await fixture({ status: 'viewed', eventDate, timezone: 'Pacific/Kiritimati' });
  const ids = (await selectCandidates()).map((r) => r.id);
  assert.ok(ids.includes(kir.proposalId),
    'Kiritimati crossed the +2 day line and must be a candidate');
  assert.ok(!ids.includes(chi.proposalId),
    'Chicago has NOT crossed yet; selecting it means event_timezone is being ignored');
});

test('an option-group member sweeps like any other row', async () => {
  // 8 prod rows are group members and hit this on the first tick. No special
  // handling is intended: every member shares the event date, so a group whose
  // event passed with nothing chosen archives whole, one row at a time.
  const a = await fixture({ status: 'viewed', eventDate: daysAgo(4) });
  const b = await fixture({ status: 'viewed', eventDate: daysAgo(4) });
  const g = await pool.query(
    'INSERT INTO proposal_groups (client_id) VALUES ($1) RETURNING id', [a.clientId]);
  const groupId = g.rows[0].id;
  await pool.query('UPDATE proposals SET group_id = $1 WHERE id = ANY($2)',
    [groupId, [a.proposalId, b.proposalId]]);

  const ids = (await selectCandidates()).map((r) => r.id);
  assert.ok(ids.includes(a.proposalId) && ids.includes(b.proposalId));
  await archiveOne(a.proposalId);
  await archiveOne(b.proposalId);
  assert.equal((await statusOf(a.proposalId)).status, 'archived');
  assert.equal((await statusOf(b.proposalId)).status, 'archived');

  await pool.query('UPDATE proposals SET group_id = NULL WHERE group_id = $1', [groupId]);
  await pool.query('DELETE FROM proposal_groups WHERE id = $1', [groupId]);
});

test('the legal-hold exclusion clause actually excludes, and covers 600', async () => {
  // An earlier cut only asserted 600 was absent from the results, which passes for
  // free unless the dev DB happens to hold a sweepable proposal 600. That proved
  // the constant, not the SQL. Prove the CLAUSE: a row that IS selected normally
  // must disappear when its id is passed as the exclusion parameter.
  const { LEGAL_HOLD_PROPOSAL_IDS } = require('./staleProposalSweep');
  assert.ok(LEGAL_HOLD_PROPOSAL_IDS.includes(600), 'proposal 600 is on legal hold');

  const f = await fixture({ status: 'viewed', eventDate: daysAgo(5) });
  const included = (await selectCandidates()).map((r) => r.id);
  assert.ok(included.includes(f.proposalId), 'baseline: the row is a candidate');

  const excluded = (await selectCandidates(undefined, [f.proposalId])).map((r) => r.id);
  assert.ok(!excluded.includes(f.proposalId), 'the id <> ALL clause must drop it');
});

test('archiveOne itself refuses a legal-hold id, not just the query', async () => {
  // archiveOne is exported; a future direct caller must not route around the hold.
  assert.equal(await archiveOne(600), null);
});

test('archiveOne bails when amount_paid appears under the lock', async () => {
  // The invoice and drink_plan_extras webhook rails credit amount_paid with NO
  // status guard, so a partial payment settling between selection and lock leaves
  // a 'viewed' row carrying money. Archiving it would stamp "never booked" on a
  // proposal someone paid.
  const f = await fixture({ status: 'viewed', eventDate: daysAgo(5) });
  await pool.query('UPDATE proposals SET amount_paid = 150 WHERE id = $1', [f.proposalId]);
  assert.equal(await archiveOne(f.proposalId), null);
  assert.equal((await statusOf(f.proposalId)).status, 'viewed');
});

const {
  processStaleProposals,
  MAX_ARCHIVES_PER_RUN,
  _setSelectCandidatesForTests,
  _setNotifierForTests,
} = require('./staleProposalSweep');

test('one poisoned row does not stop the batch, and the run still rethrows', async () => {
  // wrapScheduler (schedulerHealth.js) records 'failed' ONLY when the fn throws.
  // Without this rethrow, a systemic break (e.g. a narrowed CHECK raising 23514
  // on every row) fails every row every hour while scheduler_health reads green.
  //
  // The poison must genuinely THROW. An id of -1 would not: archiveOne's peek
  // returns no row, so it ROLLBACKs and resolves null — a clean skip, not a
  // failure. A non-integer id forces 22P02 on the peek query instead.
  const healthy = await fixture({ status: 'viewed', eventDate: daysAgo(5) });
  _setSelectCandidatesForTests(async () => ([
    { id: 'poison', status: 'viewed' },
    { id: healthy.proposalId, status: 'viewed' },
  ]));
  await assert.rejects(() => processStaleProposals(), /1 row\(s\) failed/);
  assert.equal((await statusOf(healthy.proposalId)).status, 'archived',
    'a poisoned row must not abort the rest of the batch');
  _setSelectCandidatesForTests(null);
});

test('runaway bound archives nothing AND emails the admin the count', async () => {
  const fake = Array.from({ length: MAX_ARCHIVES_PER_RUN + 1 }, (_, i) => ({ id: -(i + 1), status: 'viewed' }));
  _setSelectCandidatesForTests(async () => fake);
  let alert = null;
  _setNotifierForTests(async (args) => { alert = args; return { emailed: 1, texted: 0 }; });

  const res = await processStaleProposals();
  assert.equal(res.abortedRunaway, true);
  assert.equal(res.archived.length, 0, 'must archive NOTHING when the bound trips');
  // A guard that fires only into a log nobody reads is not a guard.
  assert.ok(alert, 'the runaway path must send an admin alert');
  assert.equal(alert.category, 'routine_admin');
  assert.ok(alert.subject.includes(String(MAX_ARCHIVES_PER_RUN + 1)),
    'the alert must name the candidate count');
  assert.ok(!alert.subject.includes('—'), 'no em dash in subject');
  assert.equal(alert.smsBody, undefined, 'email only');

  _setNotifierForTests(null);
  _setSelectCandidatesForTests(null);
});

test('a second overlapping run is a no-op while the first is in flight', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  _setSelectCandidatesForTests(async () => { await gate; return []; });
  const first = processStaleProposals();
  const second = await processStaleProposals();
  assert.equal(second.skippedReentrant, true);
  release();
  await first;
  _setSelectCandidatesForTests(null);
});

const { notifySkipped, selectSkipCandidates, SKIP_ACTION } = require('./staleProposalSweep');

async function skipMarkersFor(proposalId) {
  const { rows } = await pool.query(
    'SELECT id FROM proposal_activity_log WHERE proposal_id = $1 AND action = $2',
    [proposalId, SKIP_ACTION]);
  return rows.length;
}

// SHARED DEV DB GUARD, two layers.
//
// notifySkipped marks EVERY row matching the skip query, not just fixtures. On
// the shared dev DB that means real proposals get auto_archive_skipped markers,
// which then suppress them from future notices forever. That is correct in prod
// and pure damage in a test run.
//
// Layer 1: default every test to a notifier reporting zero delivered, so
// notifySkipped marks nothing. Tests that need a successful send override it.
// Layer 2: for those that do override, snapshot which proposals already carried
// a marker before the suite ran, and delete every marker that was not in that
// set. Layer 1 alone is not enough, which a run against dev proved by stamping
// four real rows.
test.beforeEach(() => { _setNotifierForTests(async () => ({ emailed: 0, texted: 0 })); });
test.afterEach(() => { _setNotifierForTests(null); });

// The stray-marker sweep lives in the SINGLE test.after below, before pool.end().
// A second after hook registered later runs after the pool is already closed.

test('emails once for a past-dated accepted proposal, and not again', async () => {
  const f = await fixture({ status: 'accepted', eventDate: daysAgo(6) });
  let calls = 0;
  _setNotifierForTests(async () => { calls += 1; return { emailed: 1, texted: 0 }; });

  const first = await notifySkipped();
  assert.ok(first.notified.includes(f.proposalId));
  assert.equal(calls, 1);
  assert.equal(await skipMarkersFor(f.proposalId), 1);

  const second = await notifySkipped();
  assert.ok(!second.notified.includes(f.proposalId), 'must not re-notify');
  assert.equal(await skipMarkersFor(f.proposalId), 1);
});

test('a failed send writes NO marker, so the next run retries', async () => {
  // notifyAdminCategory NEVER throws: it swallows per-recipient failures and a
  // Resend quota error, returning {emailed: 0}. Marking first would write the
  // marker, send nothing, and suppress every future attempt — the one case that
  // explicitly wants admin eyes would go permanently silent.
  const f = await fixture({ status: 'accepted', eventDate: daysAgo(6) });
  _setNotifierForTests(async () => ({ emailed: 0, texted: 0 }));
  const res = await notifySkipped();
  assert.ok(!res.notified.includes(f.proposalId));
  assert.equal(await skipMarkersFor(f.proposalId), 0, 'no marker on a failed send');

  let calls = 0;
  _setNotifierForTests(async () => { calls += 1; return { emailed: 1, texted: 0 }; });
  const retry = await notifySkipped();
  assert.ok(retry.notified.includes(f.proposalId), 'next run must retry');
  assert.equal(calls, 1);
});

test('the skip email carries no em dashes', async () => {
  const f = await fixture({ status: 'accepted', eventDate: daysAgo(6) });
  let captured = null;
  _setNotifierForTests(async (args) => { captured = args; return { emailed: 1, texted: 0 }; });
  await notifySkipped();
  assert.ok(captured, 'notifier was called');
  assert.ok(!captured.subject.includes('—'), 'no em dash in subject');
  assert.ok(!captured.emailText.includes('—'), 'no em dash in body');
  assert.equal(captured.category, 'routine_admin');
  assert.equal(captured.smsBody, undefined, 'email only, never SMS');
  assert.ok(String(captured.emailText).includes(String(f.proposalId)));
});

test('the SKIP query has a working exclusion clause too, not just the sweep', async () => {
  const f = await fixture({ status: 'accepted', eventDate: daysAgo(6) });
  const included = (await selectSkipCandidates()).map((r) => r.id);
  assert.ok(included.includes(f.proposalId), 'baseline: the row is a skip candidate');

  const excluded = (await selectSkipCandidates(undefined, [f.proposalId])).map((r) => r.id);
  assert.ok(!excluded.includes(f.proposalId), 'the p.id <> ALL clause must drop it');
});

test('dry run writes nothing, sends nothing, and reports both lists', async () => {
  // The mode the entire rollout leans on. It must be proven inert.
  const sweepable = await fixture({ status: 'viewed', eventDate: daysAgo(5), invoice: 'sent' });
  const skippable = await fixture({ status: 'accepted', eventDate: daysAgo(5) });
  let sent = 0;
  _setNotifierForTests(async () => { sent += 1; return { emailed: 1, texted: 0 }; });
  process.env.STALE_PROPOSAL_SWEEP_DRY_RUN = 'true';
  try {
    const res = await processStaleProposals();
    assert.equal(res.dryRun, true);
    assert.deepEqual(res.archived, [], 'dry run archives nothing');
    assert.ok(res.wouldArchive.includes(sweepable.proposalId));
    assert.ok(res.wouldSkip.includes(skippable.proposalId));
    assert.equal(sent, 0, 'dry run sends nothing');
  } finally {
    delete process.env.STALE_PROPOSAL_SWEEP_DRY_RUN;
  }
  assert.equal((await statusOf(sweepable.proposalId)).status, 'viewed');
  assert.equal((await statusOf(skippable.proposalId)).status, 'accepted');
  const inv = await pool.query('SELECT status FROM invoices WHERE id = $1', [sweepable.invoiceId]);
  assert.equal(inv.rows[0].status, 'sent', 'dry run voids no invoice');
  assert.equal(await skipMarkersFor(skippable.proposalId), 0, 'dry run writes no marker');
});

const { runPostCommitTail, healStrandedIntents, HEAL_ACTION } = require('./staleProposalSweep');
const invoiceVoid = require('./invoiceVoid');

async function healMarkersFor(proposalId) {
  const { rows } = await pool.query(
    'SELECT id FROM proposal_activity_log WHERE proposal_id = $1 AND action = $2',
    [proposalId, HEAL_ACTION]);
  return rows.length;
}

test('a legitimate skip leaves no heal marker (a processing PI is left alone)', async () => {
  const f = await fixture({ status: 'viewed', eventDate: daysAgo(5), invoice: 'sent' });
  const res = await archiveOne(f.proposalId);
  let cancelCalls = 0;
  invoiceVoid._setStripeForTests({
    paymentIntents: {
      // 'processing' is not cancelable; the correct behavior is to leave it and
      // let the archivedSettle guard handle it if it settles.
      retrieve: async (id) => ({ id, status: 'processing', metadata: { invoice_id: String(res.invoiceIds[0]) } }),
      cancel: async () => { cancelCalls += 1; return {}; },
    },
  });
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, status, stripe_payment_intent_id)
     VALUES ($1, 'pending', $2)`, [f.proposalId, `pi_proc_${process.pid}_${f.proposalId}`]);

  await runPostCommitTail(res);
  assert.equal(cancelCalls, 0, 'a processing intent must never be cancelled');
  assert.equal(await healMarkersFor(f.proposalId), 0,
    'a legitimate skip is not a failure and leaves no marker');
  invoiceVoid._setStripeForTests(null);
  await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [f.proposalId]);
});

test('a failed intent cancellation is recorded, then cleared by the heal pass', async () => {
  const f = await fixture({ status: 'viewed', eventDate: daysAgo(5), invoice: 'sent' });
  const res = await archiveOne(f.proposalId);
  invoiceVoid._setStripeForTests({
    paymentIntents: {
      retrieve: async () => { throw new Error('stripe is down'); },
      cancel: async () => { throw new Error('unreachable'); },
    },
  });
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, status, stripe_payment_intent_id)
     VALUES ($1, 'pending', $2)`, [f.proposalId, `pi_heal_${process.pid}_${f.proposalId}`]);

  await runPostCommitTail(res);
  assert.equal(await healMarkersFor(f.proposalId), 1, 'a thrown cancel must leave a heal marker');

  // A clean retry clears it.
  invoiceVoid._setStripeForTests({
    paymentIntents: {
      retrieve: async (id) => ({ id, status: 'requires_payment_method', metadata: { invoice_id: String(res.invoiceIds[0]) } }),
      cancel: async () => ({}),
    },
  });
  await healStrandedIntents();
  assert.equal(await healMarkersFor(f.proposalId), 0, 'a clean retry clears the marker');
  invoiceVoid._setStripeForTests(null);
  await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [f.proposalId]);
});

const { cancelFailureCount } = require('./staleProposalSweep');

test('cancelFailureCount treats a NON-ATTEMPT as a failure', () => {
  // The critical inversion the fleet caught. cancelOpenInvoiceIntents reports
  // failed: 0 when it tried NOTHING (no Stripe client, or the session lookup
  // threw). Read as a clean pass, healStrandedIntents deletes its own retry queue
  // in exactly the windows the heal exists for.
  //
  // This is a UNIT test on the single decision point both call sites share. An
  // earlier attempt tried to drive it end-to-end by clearing the Stripe stub, but
  // _setStripeForTests(null) only CLEARS the override and falls through to the
  // real getStripe(), so it exercised the failed path and survived mutation.
  assert.equal(cancelFailureCount({ canceled: 0, checked: 0, failed: 0, aborted: true }), 1,
    'aborted means nothing was tried, which is not the same as nothing failing');
  assert.equal(cancelFailureCount(null), 1, 'a missing result is not a clean pass');
  assert.equal(cancelFailureCount(undefined), 1);
  assert.equal(cancelFailureCount({ canceled: 0, checked: 2, failed: 2, aborted: false }), 2);
  assert.equal(cancelFailureCount({ canceled: 1, checked: 1, failed: 0, aborted: false }), 0,
    'a genuine clean pass is still clean');
  // checked === 0 with aborted false is legitimate convergence: the PI failed on
  // its own and the webhook flipped its session off pending. Must NOT count.
  assert.equal(cancelFailureCount({ canceled: 0, checked: 0, failed: 0, aborted: false }), 0);
});

test('cancelOpenInvoiceIntents flags its non-attempt paths as aborted', async () => {
  // Contract pin on the producer side: a normal call must report aborted: false,
  // so the consumer above can trust the flag rather than guessing from checked.
  const f = await fixture({ status: 'viewed', eventDate: daysAgo(5), invoice: 'sent' });
  const res = await archiveOne(f.proposalId);
  invoiceVoid._setStripeForTests({
    paymentIntents: {
      retrieve: async (id) => ({ id, status: 'processing', metadata: { invoice_id: '999999' } }),
      cancel: async () => { throw new Error('should not be called'); },
    },
  });
  const out = await invoiceVoid.cancelOpenInvoiceIntents(f.proposalId, res.invoiceIds[0]);
  assert.equal(out.aborted, false, 'a real attempt is never aborted');
  assert.equal(out.failed, 0);
  invoiceVoid._setStripeForTests(null);
});

test('a dry run that trips the runaway bound still prints the lists and sends nothing', async () => {
  const fake = Array.from({ length: MAX_ARCHIVES_PER_RUN + 1 }, (_, i) => ({ id: -(i + 1), status: 'viewed' }));
  _setSelectCandidatesForTests(async () => fake);
  let sent = 0;
  _setNotifierForTests(async () => { sent += 1; return { emailed: 1, texted: 0 }; });
  process.env.STALE_PROPOSAL_SWEEP_DRY_RUN = 'true';
  try {
    const res = await processStaleProposals();
    assert.equal(res.dryRun, true);
    assert.equal(res.abortedRunaway, true);
    assert.equal(sent, 0, 'a dry run must stay inert even when the bound trips');
    assert.equal(res.wouldArchive.length, MAX_ARCHIVES_PER_RUN + 1,
      'the candidate list is exactly what an operator needs here');
    assert.ok(Array.isArray(res.wouldSkip));
  } finally {
    delete process.env.STALE_PROPOSAL_SWEEP_DRY_RUN;
    _setSelectCandidatesForTests(null);
  }
});

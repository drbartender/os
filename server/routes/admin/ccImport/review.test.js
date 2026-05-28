require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../../db');
const { AppError } = require('../../../utils/errors');
const ccImportRouter = require('./index');

if (process.env.NODE_ENV === 'production') {
  throw new Error('review.test.js refuses to run against production');
}

const PREFIX = 'cc-review-test-';

// Fixture handles (populated in before()).
let server, baseUrl;
let adminId, adminToken, managerId, clientUserId, clientToken;

// Shared fixture ids
let clientId;
let proposalNativeId, proposalCcId, proposalCcOtherId, proposalCcCcStr; // a native proposal + two CC proposals
let stubUserId, realUserId, stubUserBId, realUserBId, stubUserCId, realUserCId;
let stubUserDId; // Already linked: used for the create-stub failure test
let stubUserFId, realUserFId; // Collision test (I2): both non-approved on same shift
let dummyTargetStubId; // a stub used as the "link to stub" target → 409
let shiftId, shiftOtherId;

// Mutable: user_id returned by the create-stub success test (captured at runtime
// so we can delete this row explicitly in after() — its email shape doesn't
// match the broader pattern-deletes below).
let createdStubUserId = null;

// raw_imports / legacy rows
let rawDupReviewId; // duplicate_review state row
let rawDupConfirmedId; // duplicate_confirmed state row (NOT in review state, used for guard test)
let rawDupReviewEditedId; // duplicate_review row whose candidate was edited (candidate-edited 409)
let rawDupReviewEditedBypassId; // duplicate_review row used for the confirm_candidate_edited bypass test
let candidateEditedProposalId; // proposal whose updated_at is intentionally bumped after import
let candidateEditedBypassProposalId; // same idea, separate row
let alreadyPromotedProposalCcStr; // cc_id used by the promote-anyway already-promoted path

let rawSkippedId, rawNotSkippedId; // skipped(event), non-skipped raw rows
let rawErroredEventsId, rawErroredPaymentsId, rawNotErroredId;

let orphanPaymentId, orphanPaymentNativeTargetTestId, orphanDismissedId, orphanPromotedId;
let unmatchedPayoutStubId; // stub linked to shift_requests for the BIG test (reassign-only)
let unmatchedPayoutDelete1aId, unmatchedPayoutDelete1bId; // DELETE 1a + DELETE 1b scenarios
let unmatchedPayoutNoStubId; // no_stub_path
let unmatchedPayoutLinkedId; // already-linked → create-stub 409
let unmatchedPayoutCollisionId; // Collision-guard test (I2)
let shift1aId, shift1bId; // shifts used by the DELETE 1a / 1b scenarios
let shiftCollisionId; // shift used by the collision-guard test
let shiftRequest1aRealPendingId, shiftRequest1bRealApprovedId; // tracked for cleanup verification
let shiftRequestCollisionStubId, shiftRequestCollisionRealId; // tracked for cleanup verification

let phase0EligibleId, phase0NotEligibleId, phase0DoneId;

// Sequence counters for unique source_row_number / hash values
let srnSeq = 1000;
function nextSrn() { return srnSeq++; }
function nextHash(name) { return `${PREFIX}hash-${name}-${nextSrn()}`; }

async function insertRaw(client, {
  status = 'pending',
  entity = 'events',
  payload = { Title: 'Default Test Title', 'Client Name': 'Test Client' },
  notes = null,
}) {
  const r = await client.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, payload, import_status, import_notes)
     VALUES ('review-test', $1, $2, $3, $4::jsonb, $5, $6::jsonb)
     RETURNING id, imported_at`,
    [entity, nextSrn(), nextHash(entity), JSON.stringify(payload), status, notes ? JSON.stringify(notes) : null]
  );
  return r.rows[0];
}

before(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // Users: admin + manager + a non-admin/manager 'client' for auth tests.
    const a = await c.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`,
      [`${PREFIX}admin@example.com`]
    );
    adminId = a.rows[0].id;
    adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

    const m = await c.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'manager') RETURNING id`,
      [`${PREFIX}manager@example.com`]
    );
    managerId = m.rows[0].id;

    // The 403 spot-check needs a non-admin/non-manager role. 'staff' is the
    // only other allowed role (users_role_check: 'staff' | 'admin' | 'manager').
    // The original spec said 'client', but no such role exists in this schema.
    const cu = await c.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`,
      [`${PREFIX}staff-403@example.com`]
    );
    clientUserId = cu.rows[0].id;
    clientToken = jwt.sign({ userId: clientUserId, tokenVersion: 0 }, process.env.JWT_SECRET);

    // Stub + real user pairs for various unmatched-payee scenarios.
    async function mkStub(idTag, name) {
      const r = await c.query(
        `INSERT INTO users (email, password_hash, role, cc_id, onboarding_status)
         VALUES ($1, 'x', 'staff', $2, 'deactivated') RETURNING id`,
        [`legacy-cc-${idTag}@drbartender.local`, `legacy_cc:${idTag}`]
      );
      const id = r.rows[0].id;
      await c.query(
        `INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)`,
        [id, name]
      );
      return id;
    }
    async function mkReal(tag, name) {
      const r = await c.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`,
        [`${PREFIX}${tag}@example.com`]
      );
      const id = r.rows[0].id;
      await c.query(
        `INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)`,
        [id, name]
      );
      return id;
    }
    stubUserId = await mkStub('reviewstubA:abc', 'Review Stub A');
    realUserId = await mkReal('real-a', 'Review Real A');
    stubUserBId = await mkStub('reviewstubB:bcd', 'Review Stub B');
    realUserBId = await mkReal('real-b', 'Review Real B');
    stubUserCId = await mkStub('reviewstubC:cde', 'Review Stub C');
    realUserCId = await mkReal('real-c', 'Review Real C');
    stubUserDId = await mkStub('reviewstubD:def', 'Review Stub D');
    dummyTargetStubId = await mkStub('reviewstubE:efg', 'Review Stub Target Disallowed');
    stubUserFId = await mkStub('reviewstubF:fgh', 'Review Stub F');
    realUserFId = await mkReal('real-f', 'Review Real F');

    // Client + proposals (one native, one cc-imported).
    const c1 = await c.query(
      `INSERT INTO clients (name, email, email_status) VALUES ($1, $2, 'ok') RETURNING id`,
      ['Review Test Client', `${PREFIX}rclient@example.com`]
    );
    clientId = c1.rows[0].id;
    const pn = await c.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price)
       VALUES ($1, CURRENT_DATE + INTERVAL '40 days', 'confirmed', 'birthday-party', '6:00 PM', 4, 1500)
       RETURNING id`,
      [clientId]
    );
    proposalNativeId = pn.rows[0].id;
    proposalCcCcStr = `cc-review-test-${nextSrn()}`;
    const pc = await c.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                              event_duration_hours, total_price, cc_id)
       VALUES ($1, CURRENT_DATE - INTERVAL '10 days', 'completed', 'wedding', '4:00 PM', 4, 2500, $2)
       RETURNING id`,
      [clientId, proposalCcCcStr]
    );
    proposalCcId = pc.rows[0].id;
    // Second cc-proposal so the reassign-only scenario can hit TWO distinct
    // proposals (the inherited_proposal_count assertion in the big test).
    const pc2 = await c.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                              event_duration_hours, total_price, cc_id)
       VALUES ($1, CURRENT_DATE - INTERVAL '11 days', 'completed', 'wedding', '5:00 PM', 4, 2700, $2)
       RETURNING id`,
      [clientId, `cc-review-test-${nextSrn()}`]
    );
    proposalCcOtherId = pc2.rows[0].id;

    // Two shifts on TWO different cc proposals — used by reassign-only scenario.
    const s1 = await c.query(
      `INSERT INTO shifts (proposal_id, client_name, event_date, start_time, positions_needed, status, created_by)
       VALUES ($1, 'Review Test Client', CURRENT_DATE - INTERVAL '10 days', '4:00 PM', $2::jsonb, 'completed', $3)
       RETURNING id`,
      [proposalCcId, JSON.stringify(['Bartender']), adminId]
    );
    shiftId = s1.rows[0].id;
    const s2 = await c.query(
      `INSERT INTO shifts (proposal_id, client_name, event_date, start_time, positions_needed, status, created_by)
       VALUES ($1, 'Review Test Client', CURRENT_DATE - INTERVAL '11 days', '5:00 PM', $2::jsonb, 'completed', $3)
       RETURNING id`,
      [proposalCcOtherId, JSON.stringify(['Bartender']), adminId]
    );
    shiftOtherId = s2.rows[0].id;

    // ── DUPLICATES ──────────────────────────────────────────────
    // 1) plain duplicate_review row (used for /confirm success)
    const dupRow = await insertRaw(c, {
      status: 'duplicate_review',
      entity: 'events',
      payload: { Title: 'Duplicate Review Title', 'Client Name': 'Foo' },
      notes: { candidate_proposal_id: proposalNativeId },
    });
    rawDupReviewId = dupRow.id;

    // 2) duplicate_confirmed row (used to test "not in duplicate_review" 409)
    const dupConfirmed = await insertRaw(c, { status: 'duplicate_confirmed', entity: 'events' });
    rawDupConfirmedId = dupConfirmed.id;

    // 3) duplicate_review row + candidate that has been edited (candidate-edited 409)
    const candEdit = await c.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                              event_duration_hours, total_price, cc_id)
       VALUES ($1, CURRENT_DATE - INTERVAL '5 days', 'completed', 'wedding', '5:00 PM', 4, 3000, $2)
       RETURNING id`,
      [clientId, `cc-cand-edited-${nextSrn()}`]
    );
    candidateEditedProposalId = candEdit.rows[0].id;
    const dupEdit = await insertRaw(c, {
      status: 'duplicate_review',
      entity: 'events',
      payload: { Title: 'Candidate Edited', 'Client Name': 'Bar' },
      notes: { candidate_proposal_id: candidateEditedProposalId },
    });
    rawDupReviewEditedId = dupEdit.id;
    // Force candidate's updated_at to AFTER the raw row's imported_at. The
    // BEFORE-UPDATE trigger overrides any explicit value to NOW(), and inside
    // a single transaction NOW() is pinned to transaction start, so we have
    // to commit + reopen and use clock_timestamp() via a fresh statement.

    // 4) Bypass scenario: same shape, separate row + proposal. After the bypass
    //    test runs, the row should be marked duplicate_confirmed and proposal
    //    might get clobbered — that's why we use a dedicated proposal.
    //    To exercise the "already exists in DB" branch of promoteBucketA, we
    //    give the cc-id a value that already matches a real proposal — that
    //    proposal becomes the bypass row's payload.cc_id, so promoteBucketA
    //    short-circuits to 'already_promoted'.
    alreadyPromotedProposalCcStr = `cc-bypass-${nextSrn()}`;
    const bypassProp = await c.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                              event_duration_hours, total_price, cc_id)
       VALUES ($1, CURRENT_DATE - INTERVAL '6 days', 'completed', 'wedding', '5:00 PM', 4, 3000, $2)
       RETURNING id`,
      [clientId, alreadyPromotedProposalCcStr]
    );
    candidateEditedBypassProposalId = bypassProp.rows[0].id;
    const dupBypass = await insertRaw(c, {
      status: 'duplicate_review',
      entity: 'events',
      // Build a payload that promoteBucketA can map to the same cc_id.
      payload: {
        'CC ID': alreadyPromotedProposalCcStr,
        Title: 'Bypass Promote',
        'Client Name': 'Baz',
        'Status': 'Confirmed',
        'Event Date': new Date(Date.now() + 60 * 86400 * 1000).toISOString().slice(0, 10),
      },
      notes: { candidate_proposal_id: candidateEditedBypassProposalId },
    });
    rawDupReviewEditedBypassId = dupBypass.id;

    // ── ORPHAN PAYMENTS ──────────────────────────────────────────
    const rawOp = await insertRaw(c, { status: 'pending', entity: 'payments' });
    const op = await c.query(
      `INSERT INTO legacy_cc_payments
         (cc_event_title, cc_type, paid_on, payment_applied_cents, payment_method, reference_code, raw_import_id)
       VALUES ('Some Event', 'Payment', CURRENT_DATE - INTERVAL '50 days', 12500, 'card', 'ch_test_orphan1', $1)
       RETURNING id`,
      [rawOp.id]
    );
    orphanPaymentId = op.rows[0].id;

    // Already-dismissed
    const rawDis = await insertRaw(c, { status: 'pending', entity: 'payments' });
    const dis = await c.query(
      `INSERT INTO legacy_cc_payments
         (cc_event_title, cc_type, paid_on, payment_applied_cents, payment_method, reference_code, raw_import_id, dismissed_at, notes)
       VALUES ('Dismissed Event', 'Payment', CURRENT_DATE - INTERVAL '60 days', 5000, 'cash', 'ch_test_dismissed', $1, NOW(), 'already dismissed')
       RETURNING id`,
      [rawDis.id]
    );
    orphanDismissedId = dis.rows[0].id;

    // Already-promoted (cc_event_id set + promoted_payment_id NULL is enough
    // to fail "not orphan" guard; we want both promoted-flag AND cc_event_id
    // for the "already promoted" branch).
    const rawPro = await insertRaw(c, { status: 'pending', entity: 'payments' });
    const pro = await c.query(
      `INSERT INTO legacy_cc_payments
         (cc_event_id, cc_event_title, cc_type, paid_on, payment_applied_cents, payment_method, raw_import_id)
       VALUES ($1, 'Promoted Event', 'Payment', CURRENT_DATE - INTERVAL '70 days', 9000, 'card', $2)
       RETURNING id`,
      [proposalCcCcStr, rawPro.id]
    );
    orphanPromotedId = pro.rows[0].id;

    // Same as orphanPaymentId but for the "non-cc proposal target" test —
    // we just want a clean orphan row; the test passes proposalNativeId as
    // proposal_id.
    const rawNcp = await insertRaw(c, { status: 'pending', entity: 'payments' });
    const ncp = await c.query(
      `INSERT INTO legacy_cc_payments
         (cc_event_title, cc_type, paid_on, payment_applied_cents, payment_method, raw_import_id)
       VALUES ('Native Target Test', 'Payment', CURRENT_DATE - INTERVAL '55 days', 7700, 'card', $1)
       RETURNING id`,
      [rawNcp.id]
    );
    orphanPaymentNativeTargetTestId = ncp.rows[0].id;

    // ── UNMATCHED PAYOUTS ────────────────────────────────────────
    // (a) Stub with two approved shift_requests on two different shifts; real
    //     user has nothing. Reassign-only.
    await c.query(
      `INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', 'Bartender')`,
      [shiftId, stubUserId]
    );
    await c.query(
      `INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', 'Bartender')`,
      [shiftOtherId, stubUserId]
    );
    const rawPoA = await insertRaw(c, { status: 'pending', entity: 'payouts' });
    const poA = await c.query(
      `INSERT INTO legacy_cc_payouts (payee_name, payee_name_normalized, payee_user_id, paid_on, amount_cents, raw_import_id)
       VALUES ('Review Stub A', 'review stub a', $1, CURRENT_DATE - INTERVAL '100 days', 25000, $2)
       RETURNING id`,
      [stubUserId, rawPoA.id]
    );
    unmatchedPayoutStubId = poA.rows[0].id;

    // (b) DELETE 1a scenario: shared shift; stub approved + real pending.
    const sb = await c.query(
      `INSERT INTO shifts (proposal_id, client_name, event_date, start_time, positions_needed, status, created_by)
       VALUES ($1, 'Review Test Client', CURRENT_DATE - INTERVAL '12 days', '7:00 PM', $2::jsonb, 'completed', $3)
       RETURNING id`,
      [proposalCcId, JSON.stringify(['Bartender']), adminId]
    );
    shift1aId = sb.rows[0].id;
    await c.query(
      `INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', 'Bartender')`,
      [shift1aId, stubUserBId]
    );
    const srRealPending = await c.query(
      `INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'pending', 'Bartender') RETURNING id`,
      [shift1aId, realUserBId]
    );
    shiftRequest1aRealPendingId = srRealPending.rows[0].id;
    const rawPoB = await insertRaw(c, { status: 'pending', entity: 'payouts' });
    const poB = await c.query(
      `INSERT INTO legacy_cc_payouts (payee_name, payee_name_normalized, payee_user_id, paid_on, amount_cents, raw_import_id)
       VALUES ('Review Stub B', 'review stub b', $1, CURRENT_DATE - INTERVAL '101 days', 15000, $2)
       RETURNING id`,
      [stubUserBId, rawPoB.id]
    );
    unmatchedPayoutDelete1aId = poB.rows[0].id;

    // (c) DELETE 1b scenario: shared shift; both approved (true dup).
    const sc2 = await c.query(
      `INSERT INTO shifts (proposal_id, client_name, event_date, start_time, positions_needed, status, created_by)
       VALUES ($1, 'Review Test Client', CURRENT_DATE - INTERVAL '14 days', '8:00 PM', $2::jsonb, 'completed', $3)
       RETURNING id`,
      [proposalCcId, JSON.stringify(['Bartender']), adminId]
    );
    shift1bId = sc2.rows[0].id;
    await c.query(
      `INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', 'Bartender')`,
      [shift1bId, stubUserCId]
    );
    const srRealApproved = await c.query(
      `INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', 'Bartender') RETURNING id`,
      [shift1bId, realUserCId]
    );
    shiftRequest1bRealApprovedId = srRealApproved.rows[0].id;
    const rawPoC = await insertRaw(c, { status: 'pending', entity: 'payouts' });
    const poC = await c.query(
      `INSERT INTO legacy_cc_payouts (payee_name, payee_name_normalized, payee_user_id, paid_on, amount_cents, raw_import_id)
       VALUES ('Review Stub C', 'review stub c', $1, CURRENT_DATE - INTERVAL '102 days', 18000, $2)
       RETURNING id`,
      [stubUserCId, rawPoC.id]
    );
    unmatchedPayoutDelete1bId = poC.rows[0].id;

    // (d) no_stub_path: payee_user_id IS NULL.
    const rawPoD = await insertRaw(c, { status: 'pending', entity: 'payouts' });
    const poD = await c.query(
      `INSERT INTO legacy_cc_payouts (payee_name, payee_name_normalized, payee_user_id, paid_on, amount_cents, raw_import_id)
       VALUES ('Solo Payee', 'solo payee', NULL, CURRENT_DATE - INTERVAL '103 days', 9000, $1)
       RETURNING id`,
      [rawPoD.id]
    );
    unmatchedPayoutNoStubId = poD.rows[0].id;

    // (e) already-linked: blocks create-stub.
    const rawPoE = await insertRaw(c, { status: 'pending', entity: 'payouts' });
    const poE = await c.query(
      `INSERT INTO legacy_cc_payouts (payee_name, payee_name_normalized, payee_user_id, paid_on, amount_cents, raw_import_id)
       VALUES ('Linked Already', 'linked already', $1, CURRENT_DATE - INTERVAL '104 days', 4000, $2)
       RETURNING id`,
      [stubUserDId, rawPoE.id]
    );
    unmatchedPayoutLinkedId = poE.rows[0].id;

    // (f) collision-guard scenario (I2): stub + real BOTH non-approved on the
    // same shift. The guard rejects this with 409 / CC_LINK_NON_APPROVED_COLLISION
    // — neither row should be deleted.
    const sf = await c.query(
      `INSERT INTO shifts (proposal_id, client_name, event_date, start_time, positions_needed, status, created_by)
       VALUES ($1, 'Review Test Client', CURRENT_DATE - INTERVAL '16 days', '9:00 PM', $2::jsonb, 'completed', $3)
       RETURNING id`,
      [proposalCcId, JSON.stringify(['Bartender']), adminId]
    );
    shiftCollisionId = sf.rows[0].id;
    const srColStub = await c.query(
      `INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'pending', 'Bartender') RETURNING id`,
      [shiftCollisionId, stubUserFId]
    );
    shiftRequestCollisionStubId = srColStub.rows[0].id;
    const srColReal = await c.query(
      `INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'denied', 'Bartender') RETURNING id`,
      [shiftCollisionId, realUserFId]
    );
    shiftRequestCollisionRealId = srColReal.rows[0].id;
    const rawPoF = await insertRaw(c, { status: 'pending', entity: 'payouts' });
    const poF = await c.query(
      `INSERT INTO legacy_cc_payouts (payee_name, payee_name_normalized, payee_user_id, paid_on, amount_cents, raw_import_id)
       VALUES ('Review Stub F', 'review stub f', $1, CURRENT_DATE - INTERVAL '105 days', 7000, $2)
       RETURNING id`,
      [stubUserFId, rawPoF.id]
    );
    unmatchedPayoutCollisionId = poF.rows[0].id;

    // ── ERRORED + SKIPPED ────────────────────────────────────────
    const rawErr = await insertRaw(c, { status: 'errored', entity: 'events' });
    rawErroredEventsId = rawErr.id;
    const rawErrPay = await insertRaw(c, { status: 'errored', entity: 'payments' });
    rawErroredPaymentsId = rawErrPay.id;
    const rawOk = await insertRaw(c, { status: 'pending', entity: 'events' });
    rawNotErroredId = rawOk.id;

    const rawSk = await insertRaw(c, { status: 'skipped', entity: 'events' });
    rawSkippedId = rawSk.id;
    const rawNotSk = await insertRaw(c, { status: 'pending', entity: 'events' });
    rawNotSkippedId = rawNotSk.id;

    // ── PHASE 0 FAILURES ─────────────────────────────────────────
    const ph0a = await c.query(
      `INSERT INTO cc_import_phase0_failures
         (source_url, source_entity, source_row_hash, attempt_count, last_error, last_attempted_at)
       VALUES ($1, 'events', 'review-test-hash-ph0a', 11, 'boom', NOW())
       RETURNING id`,
      [`https://review-test/eligible-${nextSrn()}`]
    );
    phase0EligibleId = ph0a.rows[0].id;

    const ph0b = await c.query(
      `INSERT INTO cc_import_phase0_failures
         (source_url, source_entity, source_row_hash, attempt_count, last_error, last_attempted_at)
       VALUES ($1, 'events', 'review-test-hash-ph0b', 3, 'small boom', NOW())
       RETURNING id`,
      [`https://review-test/notelig-${nextSrn()}`]
    );
    phase0NotEligibleId = ph0b.rows[0].id;

    const ph0c = await c.query(
      `INSERT INTO cc_import_phase0_failures
         (source_url, source_entity, source_row_hash, attempt_count, last_error,
          last_attempted_at, given_up_at, given_up_reason)
       VALUES ($1, 'events', 'review-test-hash-ph0c', 12, 'permadead', NOW(), NOW(), 'already gave up')
       RETURNING id`,
      [`https://review-test/done-${nextSrn()}`]
    );
    phase0DoneId = ph0c.rows[0].id;

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }

  // Post-commit: bump candidate proposals' updated_at so the candidate-edited
  // gate trips. The trigger overrides to clock_timestamp() at row touch time,
  // so a fresh top-level UPDATE here (after the raw rows' imported_at was
  // pinned inside the transaction above) guarantees a later timestamp.
  await pool.query(
    `UPDATE proposals SET event_location = COALESCE(event_location,'') || ' bump' WHERE id = $1`,
    [candidateEditedProposalId]
  );
  await pool.query(
    `UPDATE proposals SET event_location = COALESCE(event_location,'') || ' bump' WHERE id = $1`,
    [candidateEditedBypassProposalId]
  );

  const app = express();
  app.use(express.json());
  app.use('/api/admin/cc-import', ccImportRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));

  // Clean shift_requests first (FK from users).
  const shiftIds = [shiftId, shiftOtherId, shift1aId, shift1bId, shiftCollisionId].filter(Boolean);
  if (shiftIds.length) {
    await pool.query(`DELETE FROM shift_requests WHERE shift_id = ANY($1::int[])`, [shiftIds]);
    await pool.query(`DELETE FROM shifts WHERE id = ANY($1::int[])`, [shiftIds]);
  }

  // Payouts → must clear payee FK before deleting users.
  await pool.query(
    `DELETE FROM legacy_cc_payouts WHERE raw_import_id IN (SELECT id FROM legacy_cc_raw_imports WHERE source_file = 'review-test')`
  );

  // Payments tied to test raws.
  await pool.query(
    `DELETE FROM legacy_cc_payments WHERE raw_import_id IN (SELECT id FROM legacy_cc_raw_imports WHERE source_file = 'review-test')`
  );

  // Activity log for our proposals.
  const propIds = [
    proposalNativeId,
    proposalCcId,
    proposalCcOtherId,
    candidateEditedProposalId,
    candidateEditedBypassProposalId,
  ].filter(Boolean);
  if (propIds.length) {
    await pool.query(`DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])`, [propIds]);
  }

  // Raw imports — also catch any rows whose status changed mid-test.
  await pool.query(`DELETE FROM legacy_cc_raw_imports WHERE source_file = 'review-test'`);

  // Phase 0.
  await pool.query(`DELETE FROM cc_import_phase0_failures WHERE source_row_hash LIKE 'review-test-hash-%'`);

  // Proposals + clients.
  if (propIds.length) {
    // Proposals might have created stubs that link back — clear FK before delete.
    await pool.query(`DELETE FROM proposals WHERE id = ANY($1::int[])`, [propIds]);
  }
  // Also clean any cc-proposal created by promote bypass test if it
  // ended up writing a fresh row (cc_id LIKE 'cc-bypass-%' or
  // 'cc-cand-edited-%' or 'cc-review-test-%').
  await pool.query(
    `DELETE FROM proposals WHERE cc_id LIKE 'cc-bypass-%'
                              OR cc_id LIKE 'cc-cand-edited-%'
                              OR cc_id LIKE 'cc-review-test-%'`
  );
  if (clientId) await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);

  // Contractor profiles (FK to users).
  const userIds = [
    adminId, managerId, clientUserId,
    stubUserId, realUserId, stubUserBId, realUserBId,
    stubUserCId, realUserCId, stubUserDId, dummyTargetStubId,
    stubUserFId, realUserFId,
  ].filter(Boolean);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])`, [userIds]);

  // Audit log mentioning any of these users.
  for (const id of userIds) {
    await pool.query(`DELETE FROM admin_audit_log WHERE actor_user_id = $1 OR target_user_id = $1`, [id]);
  }

  // Also clean any newly-created stub users from create-stub success path.
  await pool.query(
    `DELETE FROM admin_audit_log WHERE action LIKE 'cc_review_%'
                                   AND created_at > NOW() - INTERVAL '1 hour'`
  );

  // Explicit delete of the create-stub-success user (captured at test runtime).
  // The success path produces emails like 'legacy-cc-createstubfixture-<hash>@drbartender.local'
  // which the broader pattern-delete below doesn't match.
  if (createdStubUserId) {
    await pool.query(`DELETE FROM contractor_profiles WHERE user_id = $1`, [createdStubUserId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [createdStubUserId]);
  }

  // Stub users created by create-stub success path land here. Parens around the
  // OR are load-bearing — `AND ... OR ...` binds AND tighter than OR, so without
  // parens the second branch would match any user whose email starts with
  // `legacy-cc-solopayee-` regardless of cc_id.
  await pool.query(
    `DELETE FROM contractor_profiles WHERE user_id IN (
       SELECT id FROM users
        WHERE cc_id LIKE 'legacy_cc:%'
          AND email LIKE '%@drbartender.local'
          AND (email LIKE 'legacy-cc-linkedalready-%'
            OR email LIKE 'legacy-cc-solopayee-%'
            OR email LIKE 'legacy-cc-createstubfixture-%')
     )`
  );
  await pool.query(
    `DELETE FROM users
      WHERE cc_id LIKE 'legacy_cc:%'
        AND (email LIKE 'legacy-cc-linkedalready-%@drbartender.local'
          OR email LIKE 'legacy-cc-solopayee-%@drbartender.local'
          OR email LIKE 'legacy-cc-createstubfixture-%@drbartender.local')`
  );
  // Finally, our explicit fixture users.
  for (const id of userIds) {
    await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
  }

  await pool.end();
});

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request(
      {
        method, hostname: url.hostname, port: url.port,
        path: url.pathname + (url.search || ''), headers,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── GET /review ───────────────────────────────────────────────────

test('GET /review returns all 7 sections and lastRun', async () => {
  const r = await req('GET', '/api/admin/cc-import/review', adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  for (const k of [
    'duplicates', 'orphans', 'unmatchedPayees', 'unmatchedStaff',
    'errored', 'skipped', 'phase0Eligible', 'phase0Done', 'lastRun',
  ]) {
    assert.ok(k in body, `body must include "${k}"`);
  }
  // Our fixture rows must appear in their sections.
  assert.ok(body.duplicates.find((row) => row.id === rawDupReviewId));
  assert.ok(body.orphans.find((row) => row.id === orphanPaymentId));
  // unmatchedPayees only lists rows where payee_user_id IS NULL — use the
  // no-stub fixture row, not the stub-linked one.
  assert.ok(body.unmatchedPayees.find((row) => row.id === unmatchedPayoutNoStubId));
  assert.ok(body.errored.find((row) => row.id === rawErroredEventsId));
  assert.ok(body.skipped.find((row) => row.id === rawSkippedId));
  assert.ok(body.phase0Eligible.find((row) => row.id === phase0EligibleId));
  assert.ok(body.phase0Done.find((row) => row.id === phase0DoneId));
});

// ── Auth (spot-check) ─────────────────────────────────────────────

test('GET /review returns 401 without token', async () => {
  const r = await req('GET', '/api/admin/cc-import/review', null);
  assert.equal(r.status, 401);
});

test('GET /review returns 403 for a non-admin/non-manager role', async () => {
  const r = await req('GET', '/api/admin/cc-import/review', clientToken);
  assert.equal(r.status, 403);
});

// ── §1 duplicate/:row_id/confirm ─────────────────────────────────

test('POST /duplicate/:id/confirm rejects non-integer row_id', async () => {
  const r = await req('POST', '/api/admin/cc-import/review/duplicate/abc/confirm', adminToken, {});
  assert.equal(r.status, 400);
});

test('POST /duplicate/:id/confirm 404 on unknown id', async () => {
  const r = await req('POST', '/api/admin/cc-import/review/duplicate/999999999/confirm', adminToken, {});
  assert.equal(r.status, 404);
});

test('POST /duplicate/:id/confirm 409 when row is not in duplicate_review', async () => {
  const r = await req('POST', `/api/admin/cc-import/review/duplicate/${rawDupConfirmedId}/confirm`, adminToken, {});
  assert.equal(r.status, 409);
});

test('POST /duplicate/:id/confirm flips status + writes decision note', async () => {
  const r = await req('POST', `/api/admin/cc-import/review/duplicate/${rawDupReviewId}/confirm`, adminToken, {});
  assert.equal(r.status, 200);
  const after = await pool.query(
    `SELECT import_status, import_notes FROM legacy_cc_raw_imports WHERE id = $1`,
    [rawDupReviewId]
  );
  assert.equal(after.rows[0].import_status, 'duplicate_confirmed');
  assert.equal(after.rows[0].import_notes.decision, 'duplicate');
});

// ── §1 duplicate/:row_id/promote ─────────────────────────────────

test('POST /duplicate/:id/promote rejects non-integer row_id', async () => {
  const r = await req('POST', '/api/admin/cc-import/review/duplicate/abc/promote', adminToken, {});
  assert.equal(r.status, 400);
});

test('POST /duplicate/:id/promote 404 on unknown id', async () => {
  const r = await req('POST', '/api/admin/cc-import/review/duplicate/999999999/promote', adminToken, {});
  assert.equal(r.status, 404);
});

test('POST /duplicate/:id/promote returns 409 CC_CANDIDATE_EDITED when candidate edited', async () => {
  const r = await req(
    'POST',
    `/api/admin/cc-import/review/duplicate/${rawDupReviewEditedId}/promote`,
    adminToken,
    {}
  );
  assert.equal(r.status, 409);
  const body = JSON.parse(r.body);
  assert.equal(body.code, 'CC_CANDIDATE_EDITED');
});

test('POST /duplicate/:id/promote succeeds with confirm_candidate_edited: true (bypass)', async () => {
  const r = await req(
    'POST',
    `/api/admin/cc-import/review/duplicate/${rawDupReviewEditedBypassId}/promote`,
    adminToken,
    { confirm_candidate_edited: true }
  );
  // The phase3 path may legitimately fail (no live mapping); we only care
  // that the candidate-edited gate did NOT trip. So: NOT 409 with
  // CC_CANDIDATE_EDITED. Either 200 (already_promoted) or 409 with a
  // different code (CC_PROMOTE_FAILED) is acceptable for "the gate was passed".
  const body = r.body ? JSON.parse(r.body) : {};
  if (r.status === 409) {
    assert.notEqual(body.code, 'CC_CANDIDATE_EDITED',
      'bypass must NOT trip candidate-edited gate');
  } else {
    assert.equal(r.status, 200);
  }
});

// ── §2 orphan-payment/:id/link ────────────────────────────────────

test('POST /orphan-payment/:id/link rejects non-integer legacy_id', async () => {
  const r = await req(
    'POST', '/api/admin/cc-import/review/orphan-payment/abc/link', adminToken,
    { proposal_id: proposalCcId }
  );
  assert.equal(r.status, 400);
});

test('POST /orphan-payment/:id/link rejects non-integer proposal_id', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/orphan-payment/${orphanPaymentId}/link`, adminToken,
    { proposal_id: 'abc' }
  );
  assert.equal(r.status, 400);
});

test('POST /orphan-payment/:id/link 404 on unknown legacy_id', async () => {
  const r = await req(
    'POST', '/api/admin/cc-import/review/orphan-payment/999999999/link', adminToken,
    { proposal_id: proposalCcId }
  );
  assert.equal(r.status, 404);
});

test('POST /orphan-payment/:id/link 404 on unknown proposal_id', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/orphan-payment/${orphanPaymentNativeTargetTestId}/link`, adminToken,
    { proposal_id: 999999999 }
  );
  assert.equal(r.status, 404);
});

test('POST /orphan-payment/:id/link 409 when target proposal is not a cc proposal', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/orphan-payment/${orphanPaymentNativeTargetTestId}/link`, adminToken,
    { proposal_id: proposalNativeId }
  );
  assert.equal(r.status, 409);
});

test('POST /orphan-payment/:id/link 409 when row already promoted', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/orphan-payment/${orphanPromotedId}/link`, adminToken,
    { proposal_id: proposalCcId }
  );
  assert.equal(r.status, 409);
});

test('POST /orphan-payment/:id/link 409 when row already dismissed', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/orphan-payment/${orphanDismissedId}/link`, adminToken,
    { proposal_id: proposalCcId }
  );
  assert.equal(r.status, 409);
});

test('POST /orphan-payment/:id/link suppresses stale balance reminders when legacy payment fully settles a future proposal', async () => {
  // A cc-imported proposal with a future event_date and a pending balance_reminder.
  // The legacy payment we link covers total_price in full, so post-link the
  // proposal is paid AND the pending reminder must flip to 'suppressed' (otherwise
  // it fires even though balance is 0).
  const cliRes = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('Fix1 Client', $1, '555-0190') RETURNING id`,
    [`fix1-${Date.now()}@example.com`]
  );
  const fix1ClientId = cliRes.rows[0].id;
  const propRes = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, total_price, amount_paid, cc_id, token, event_type)
     VALUES ($1, 'confirmed', CURRENT_DATE + INTERVAL '30 days', 500, 0,
             'cc-fix1-' || gen_random_uuid()::text, gen_random_uuid(), 'birthday-party')
     RETURNING id, cc_id`,
    [fix1ClientId]
  );
  const proposalId = propRes.rows[0].id;
  const proposalCcIdLocal = propRes.rows[0].cc_id;

  const smRes = await pool.query(
    `INSERT INTO scheduled_messages
       (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ('proposal', $1, 'balance_reminder_non_autopay_t3', 'client', $2, 'email',
             NOW() + INTERVAL '20 days', 'pending')
     RETURNING id`,
    [proposalId, fix1ClientId]
  );
  const smId = smRes.rows[0].id;

  const rawIns = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, payload, import_status)
     VALUES ('review-test', 'payments', $1, $2, '{}'::jsonb, 'pending')
     RETURNING id`,
    [nextSrn(), nextHash('fix1-orphan')]
  );
  const rawImportId = rawIns.rows[0].id;

  const legacyRes = await pool.query(
    `INSERT INTO legacy_cc_payments
       (cc_event_title, cc_type, paid_on, payment_applied_cents, payment_method, raw_import_id)
     VALUES ('Fix1 Test', 'Payment', CURRENT_DATE - INTERVAL '5 days', 50000, 'card', $1)
     RETURNING id`,
    [rawImportId]
  );
  const legacyId = legacyRes.rows[0].id;

  try {
    const r = await req('POST', `/api/admin/cc-import/review/orphan-payment/${legacyId}/link`,
      adminToken, { proposal_id: proposalId, cc_event_id: proposalCcIdLocal });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.ok, true);

    const after = await pool.query('SELECT status FROM scheduled_messages WHERE id = $1', [smId]);
    assert.equal(after.rows[0].status, 'suppressed');
  } finally {
    await pool.query('DELETE FROM scheduled_messages WHERE id = $1', [smId]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM legacy_cc_payments WHERE id = $1', [legacyId]);
    await pool.query('DELETE FROM legacy_cc_raw_imports WHERE id = $1', [rawImportId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
    await pool.query('DELETE FROM clients WHERE id = $1', [fix1ClientId]);
  }
});

test('POST /orphan-payment/:id/link rolls back cc_event_id and 409s on errored promote status', async () => {
  // promoteSingleLegacyPayment is mocked to return errored; the new code in the
  // route throws ConflictError, and the BEGIN rolls back the cc_event_id UPDATE.
  // We can't reproduce 'errored' from a seed alone because the helper resolves
  // any matching proposal cleanly (see phase4.js:357-485).
  //
  // Spy is installed AFTER all seeds so a seed failure can't leak it across tests.
  const rawIns = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, payload, import_status)
     VALUES ('review-test', 'payments', $1, $2, '{}'::jsonb, 'pending')
     RETURNING id`,
    [nextSrn(), nextHash('fix2-err')]
  );
  const rawImportId = rawIns.rows[0].id;

  const legacyRes = await pool.query(
    `INSERT INTO legacy_cc_payments (cc_event_title, cc_type, paid_on, payment_applied_cents, raw_import_id)
     VALUES ('Fix2 Err', 'Payment', CURRENT_DATE, 10000, $1)
     RETURNING id`,
    [rawImportId]
  );
  const legacyId = legacyRes.rows[0].id;

  const cliRes = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('Fix2 Err Client', $1, '555-0191') RETURNING id`,
    [`fix2-err-${Date.now()}@example.com`]
  );
  const fix2ErrClientId = cliRes.rows[0].id;
  const propRes = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, total_price, amount_paid, cc_id, token, event_type)
     VALUES ($1, 'confirmed', CURRENT_DATE + INTERVAL '30 days', 500, 0,
             'cc-fix2-err-' || gen_random_uuid()::text, gen_random_uuid(), 'birthday-party')
     RETURNING id, cc_id`,
    [fix2ErrClientId]
  );
  const proposalId = propRes.rows[0].id;
  const proposalCcId = propRes.rows[0].cc_id;

  const phase4 = require('../../../../scripts/cc-import/phases/phase4');
  const { mock } = require('node:test');
  const spy = mock.method(phase4, 'promoteSingleLegacyPayment',
    async () => ({ status: 'errored', error: 'forced_for_test' }));

  try {
    const r = await req('POST', `/api/admin/cc-import/review/orphan-payment/${legacyId}/link`,
      adminToken, { proposal_id: proposalId, cc_event_id: proposalCcId });
    assert.equal(r.status, 409);
    const body = JSON.parse(r.body);
    assert.equal(body.code, 'CC_PROMOTE_FAILED');

    // Load-bearing: cc_event_id stays NULL — proves BEGIN/ROLLBACK fired
    // even though the promote helper was mocked.
    const after = await pool.query('SELECT cc_event_id FROM legacy_cc_payments WHERE id = $1', [legacyId]);
    assert.equal(after.rows[0].cc_event_id, null);
  } finally {
    spy.mock.restore();
    await pool.query('DELETE FROM legacy_cc_payments WHERE id = $1', [legacyId]);
    await pool.query('DELETE FROM legacy_cc_raw_imports WHERE id = $1', [rawImportId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
    await pool.query('DELETE FROM clients WHERE id = $1', [fix2ErrClientId]);
  }
});

test('POST /orphan-payment/:id/link still succeeds and persists cc_event_id on promoted status', async () => {
  // Regression guard: the refactor must not break the happy path.
  const cliRes = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('Fix2 OK Client', $1, '555-0192') RETURNING id`,
    [`fix2-ok-${Date.now()}@example.com`]
  );
  const fix2OkClientId = cliRes.rows[0].id;
  const propRes = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, total_price, amount_paid, cc_id, token, event_type)
     VALUES ($1, 'confirmed', CURRENT_DATE + INTERVAL '60 days', 500, 0,
             'cc-fix2-ok-' || gen_random_uuid()::text, gen_random_uuid(), 'birthday-party')
     RETURNING id, cc_id`,
    [fix2OkClientId]
  );
  const proposalId = propRes.rows[0].id;
  const proposalCcId = propRes.rows[0].cc_id;

  const rawIns = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, payload, import_status)
     VALUES ('review-test', 'payments', $1, $2, '{}'::jsonb, 'pending')
     RETURNING id`,
    [nextSrn(), nextHash('fix2-ok')]
  );
  const rawImportId = rawIns.rows[0].id;

  const legacyRes = await pool.query(
    `INSERT INTO legacy_cc_payments (cc_event_title, cc_type, paid_on, payment_applied_cents, raw_import_id)
     VALUES ('Fix2 Happy', 'Payment', CURRENT_DATE, 10000, $1)
     RETURNING id`,
    [rawImportId]
  );
  const legacyId = legacyRes.rows[0].id;

  try {
    const r = await req('POST', `/api/admin/cc-import/review/orphan-payment/${legacyId}/link`,
      adminToken, { proposal_id: proposalId, cc_event_id: proposalCcId });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.ok, true);
    assert.equal(body.promote_status, 'promoted');

    const after = await pool.query(
      'SELECT cc_event_id, promoted_payment_id FROM legacy_cc_payments WHERE id = $1', [legacyId]);
    assert.equal(after.rows[0].cc_event_id, proposalCcId);
    assert.notEqual(after.rows[0].promoted_payment_id, null);
  } finally {
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM legacy_cc_payments WHERE id = $1', [legacyId]);
    await pool.query('DELETE FROM legacy_cc_raw_imports WHERE id = $1', [rawImportId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
    await pool.query('DELETE FROM clients WHERE id = $1', [fix2OkClientId]);
  }
});

test('POST /orphan-payment/:id/link does NOT capture ConflictError to Sentry on non-success promote', async () => {
  // The point of the `if (!(err instanceof ConflictError))` guard around
  // reportException is that operator-visible failures should NOT spam Sentry.
  // Spies installed AFTER all seeds so a seed failure can't leak them.
  const rawIns = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, payload, import_status)
     VALUES ('review-test', 'payments', $1, $2, '{}'::jsonb, 'pending')
     RETURNING id`,
    [nextSrn(), nextHash('fix2-sentry')]
  );
  const rawImportId = rawIns.rows[0].id;
  const legacyRes = await pool.query(
    `INSERT INTO legacy_cc_payments (cc_event_title, cc_type, paid_on, payment_applied_cents, raw_import_id)
     VALUES ('Fix2 Sentry', 'Payment', CURRENT_DATE, 10000, $1) RETURNING id`,
    [rawImportId]
  );
  const legacyId = legacyRes.rows[0].id;
  const cliRes = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('Fix2 Sentry Client', $1, '555-0193') RETURNING id`,
    [`fix2-sentry-${Date.now()}@example.com`]
  );
  const fix2SentryClientId = cliRes.rows[0].id;
  const propRes = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, total_price, amount_paid, cc_id, token, event_type)
     VALUES ($1, 'confirmed', CURRENT_DATE + INTERVAL '30 days', 500, 0,
             'cc-fix2-sentry-' || gen_random_uuid()::text, gen_random_uuid(), 'birthday-party')
     RETURNING id, cc_id`,
    [fix2SentryClientId]
  );
  const proposalId = propRes.rows[0].id;
  const proposalCcId = propRes.rows[0].cc_id;

  const Sentry = require('@sentry/node');
  const phase4 = require('../../../../scripts/cc-import/phases/phase4');
  const { mock } = require('node:test');
  const promoteSpy = mock.method(phase4, 'promoteSingleLegacyPayment',
    async () => ({ status: 'errored', error: 'forced_for_test' }));
  const sentrySpy = mock.method(Sentry, 'captureException', () => {});

  try {
    const r = await req('POST', `/api/admin/cc-import/review/orphan-payment/${legacyId}/link`,
      adminToken, { proposal_id: proposalId, cc_event_id: proposalCcId });
    assert.equal(r.status, 409);
    assert.equal(sentrySpy.mock.callCount(), 0, 'ConflictError must not be sent to Sentry');
  } finally {
    promoteSpy.mock.restore();
    sentrySpy.mock.restore();
    await pool.query('DELETE FROM legacy_cc_payments WHERE id = $1', [legacyId]);
    await pool.query('DELETE FROM legacy_cc_raw_imports WHERE id = $1', [rawImportId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
    await pool.query('DELETE FROM clients WHERE id = $1', [fix2SentryClientId]);
  }
});

test('POST /orphan-payment/:id/link refund-branch manual_skipped is treated as success (cc_event_id stays set)', async () => {
  // Regression for W1 from the Task 2 code-review checkpoint: a refund whose
  // paid_on+amount matches an existing 'Manual Stripe reconciliation' row
  // returns { status: 'manual_skipped' } from promoteSingleLegacyRefund. The
  // helper has already COMMITted promoted_refund_id, so the route MUST treat
  // this as success — return 200, keep cc_event_id set.
  const rawIns = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, payload, import_status)
     VALUES ('review-test', 'payments', $1, $2, '{}'::jsonb, 'pending')
     RETURNING id`,
    [nextSrn(), nextHash('fix2-refund-ms')]
  );
  const rawImportId = rawIns.rows[0].id;
  const legacyRes = await pool.query(
    `INSERT INTO legacy_cc_payments (cc_event_title, cc_type, paid_on, payment_applied_cents, raw_import_id)
     VALUES ('Fix2 Refund MS', 'Refund', CURRENT_DATE, 5000, $1) RETURNING id`,
    [rawImportId]
  );
  const legacyId = legacyRes.rows[0].id;
  const cliRes = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('Fix2 Refund MS Client', $1, '555-0194') RETURNING id`,
    [`fix2-refund-ms-${Date.now()}@example.com`]
  );
  const fix2RefundClientId = cliRes.rows[0].id;
  const propRes = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, total_price, amount_paid, cc_id, token, event_type)
     VALUES ($1, 'confirmed', CURRENT_DATE + INTERVAL '30 days', 500, 0,
             'cc-fix2-refund-ms-' || gen_random_uuid()::text, gen_random_uuid(), 'birthday-party')
     RETURNING id, cc_id`,
    [fix2RefundClientId]
  );
  const proposalId = propRes.rows[0].id;
  const proposalCcId = propRes.rows[0].cc_id;

  const phase4 = require('../../../../scripts/cc-import/phases/phase4');
  const { mock } = require('node:test');
  const spy = mock.method(phase4, 'promoteSingleLegacyRefund',
    async () => ({ status: 'manual_skipped', refundId: 999 }));

  try {
    const r = await req('POST', `/api/admin/cc-import/review/orphan-payment/${legacyId}/link`,
      adminToken, { proposal_id: proposalId, cc_event_id: proposalCcId });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.ok, true);
    assert.equal(body.promote_status, 'manual_skipped');

    // cc_event_id IS set — the manual_skipped path linked the row and must NOT
    // be rolled back to NULL.
    const after = await pool.query('SELECT cc_event_id FROM legacy_cc_payments WHERE id = $1', [legacyId]);
    assert.equal(after.rows[0].cc_event_id, proposalCcId);
  } finally {
    spy.mock.restore();
    await pool.query('DELETE FROM legacy_cc_payments WHERE id = $1', [legacyId]);
    await pool.query('DELETE FROM legacy_cc_raw_imports WHERE id = $1', [rawImportId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
    await pool.query('DELETE FROM clients WHERE id = $1', [fix2RefundClientId]);
  }
});

// ── §2 orphan-payment/:id/dismiss ─────────────────────────────────

test('POST /orphan-payment/:id/dismiss rejects non-integer legacy_id', async () => {
  const r = await req(
    'POST', '/api/admin/cc-import/review/orphan-payment/abc/dismiss', adminToken, {}
  );
  assert.equal(r.status, 400);
});

test('POST /orphan-payment/:id/dismiss rejects reason > 2000 chars', async () => {
  const big = 'x'.repeat(2001);
  const r = await req(
    'POST', `/api/admin/cc-import/review/orphan-payment/${orphanPaymentId}/dismiss`, adminToken,
    { reason: big }
  );
  assert.equal(r.status, 400);
});

test('POST /orphan-payment/:id/dismiss 404 on unknown legacy_id', async () => {
  const r = await req(
    'POST', '/api/admin/cc-import/review/orphan-payment/999999999/dismiss', adminToken, {}
  );
  assert.equal(r.status, 404);
});

test('POST /orphan-payment/:id/dismiss 409 when already dismissed', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/orphan-payment/${orphanDismissedId}/dismiss`, adminToken, {}
  );
  assert.equal(r.status, 409);
});

test('POST /orphan-payment/:id/dismiss sets dismissed_at + notes', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/orphan-payment/${orphanPaymentId}/dismiss`, adminToken,
    { reason: 'not a real payment' }
  );
  assert.equal(r.status, 200);
  const after = await pool.query(
    `SELECT dismissed_at, notes FROM legacy_cc_payments WHERE id = $1`,
    [orphanPaymentId]
  );
  assert.ok(after.rows[0].dismissed_at !== null);
  assert.equal(after.rows[0].notes, 'not a real payment');
});

// ── §3 unmatched-payee/:id/link ──────────────────────────────────

test('POST /unmatched-payee/:id/link rejects non-integer legacy_payout_id', async () => {
  const r = await req(
    'POST', '/api/admin/cc-import/review/unmatched-payee/abc/link', adminToken,
    { user_id: realUserId }
  );
  assert.equal(r.status, 400);
});

test('POST /unmatched-payee/:id/link rejects non-integer user_id', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/unmatched-payee/${unmatchedPayoutStubId}/link`, adminToken,
    { user_id: 'abc' }
  );
  assert.equal(r.status, 400);
});

test('POST /unmatched-payee/:id/link 404 on unknown user_id', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/unmatched-payee/${unmatchedPayoutStubId}/link`, adminToken,
    { user_id: 999999999 }
  );
  assert.equal(r.status, 404);
});

test('POST /unmatched-payee/:id/link 409 CC_TARGET_IS_STUB when linking to a stub', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/unmatched-payee/${unmatchedPayoutStubId}/link`, adminToken,
    { user_id: dummyTargetStubId }
  );
  assert.equal(r.status, 409);
  assert.equal(JSON.parse(r.body).code, 'CC_TARGET_IS_STUB');
});

test('POST /unmatched-payee/:id/link 404 on unknown legacy_payout_id', async () => {
  const r = await req(
    'POST', '/api/admin/cc-import/review/unmatched-payee/999999999/link', adminToken,
    { user_id: realUserId }
  );
  assert.equal(r.status, 404);
});

test('POST /unmatched-payee/:id/link reassign-only: 2 shifts inherited, activity log written', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/unmatched-payee/${unmatchedPayoutStubId}/link`, adminToken,
    { user_id: realUserId }
  );
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.inherited_proposal_count, 2);
  assert.equal(body.deleted_pending_or_denied, 0);
  assert.equal(body.deleted_dup_stub_rows, 0);
  assert.equal(body.stub_user_id, stubUserId);

  // shift_requests should now point at realUserId on both shifts; stub should have none.
  const real = await pool.query(
    `SELECT shift_id FROM shift_requests WHERE user_id = $1 AND status = 'approved'
      AND shift_id = ANY($2::int[])`,
    [realUserId, [shiftId, shiftOtherId]]
  );
  assert.equal(real.rowCount, 2, 'real user now has both approved shift_requests');

  const stub = await pool.query(
    `SELECT shift_id FROM shift_requests WHERE user_id = $1 AND shift_id = ANY($2::int[])`,
    [stubUserId, [shiftId, shiftOtherId]]
  );
  assert.equal(stub.rowCount, 0, 'stub user has no shift_requests on those shifts');

  // Two distinct proposals → activity log entries on both.
  const log = await pool.query(
    `SELECT proposal_id FROM proposal_activity_log
       WHERE action = 'cc_link_shift_request_dedup'
         AND proposal_id = ANY($1::int[])`,
    [[proposalCcId, proposalCcOtherId]]
  );
  assert.equal(log.rowCount, 2, 'one activity log entry per inherited proposal');
});

test('POST /unmatched-payee/:id/link DELETE 1a: stub approved + real pending → real pending deleted', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/unmatched-payee/${unmatchedPayoutDelete1aId}/link`, adminToken,
    { user_id: realUserBId }
  );
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.deleted_pending_or_denied, 1, 'one pending row deleted by DELETE 1a');
  assert.equal(body.deleted_dup_stub_rows, 0);

  // Real should now own the approved row that was the stub's.
  const real = await pool.query(
    `SELECT status FROM shift_requests WHERE shift_id = $1 AND user_id = $2`,
    [shift1aId, realUserBId]
  );
  assert.equal(real.rowCount, 1);
  assert.equal(real.rows[0].status, 'approved');

  // The original real-pending row id should no longer exist.
  const dead = await pool.query(`SELECT id FROM shift_requests WHERE id = $1`, [shiftRequest1aRealPendingId]);
  assert.equal(dead.rowCount, 0, 'real-user pending row was deleted');
});

test('POST /unmatched-payee/:id/link DELETE 1b: stub approved + real approved → stub row deleted', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/unmatched-payee/${unmatchedPayoutDelete1bId}/link`, adminToken,
    { user_id: realUserCId }
  );
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.deleted_dup_stub_rows, 1, 'one true-dup stub row deleted by DELETE 1b');
  assert.equal(body.deleted_pending_or_denied, 0);

  // Real should keep its approved row (the surviving one).
  const real = await pool.query(`SELECT id, status FROM shift_requests WHERE id = $1`, [shiftRequest1bRealApprovedId]);
  assert.equal(real.rowCount, 1);
  assert.equal(real.rows[0].status, 'approved');

  // Stub should have nothing left on shift1bId.
  const stub = await pool.query(
    `SELECT id FROM shift_requests WHERE shift_id = $1 AND user_id = $2`,
    [shift1bId, stubUserCId]
  );
  assert.equal(stub.rowCount, 0, 'stub row removed by DELETE 1b');
});

test('POST /unmatched-payee/:id/link 409 CC_LINK_NON_APPROVED_COLLISION when both non-approved on same shift', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/unmatched-payee/${unmatchedPayoutCollisionId}/link`, adminToken,
    { user_id: realUserFId }
  );
  assert.equal(r.status, 409);
  const body = JSON.parse(r.body);
  assert.equal(body.code, 'CC_LINK_NON_APPROVED_COLLISION');

  // Neither shift_request was deleted (txn ROLLBACK should preserve both).
  const stubStill = await pool.query(`SELECT id, status FROM shift_requests WHERE id = $1`, [shiftRequestCollisionStubId]);
  assert.equal(stubStill.rowCount, 1, 'stub pending row still exists after collision rejection');
  assert.equal(stubStill.rows[0].status, 'pending');
  const realStill = await pool.query(`SELECT id, status FROM shift_requests WHERE id = $1`, [shiftRequestCollisionRealId]);
  assert.equal(realStill.rowCount, 1, 'real denied row still exists after collision rejection');
  assert.equal(realStill.rows[0].status, 'denied');

  // payee_user_id rollback: stub still linked to the payout.
  const payout = await pool.query(`SELECT payee_user_id FROM legacy_cc_payouts WHERE id = $1`, [unmatchedPayoutCollisionId]);
  assert.equal(payout.rows[0].payee_user_id, stubUserFId, 'payout still linked to stub after rollback');
});

test('POST /unmatched-payee/:id/link no_stub_path when payout.payee_user_id IS NULL', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/unmatched-payee/${unmatchedPayoutNoStubId}/link`, adminToken,
    { user_id: realUserId }
  );
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.no_stub_path, true);
  assert.equal(body.inherited_proposal_count, 0);

  const after = await pool.query(
    `SELECT payee_user_id FROM legacy_cc_payouts WHERE id = $1`,
    [unmatchedPayoutNoStubId]
  );
  assert.equal(after.rows[0].payee_user_id, realUserId);
});

// ── §3 unmatched-payee/:id/create-stub ───────────────────────────

test('POST /unmatched-payee/:id/create-stub rejects non-integer legacy_payout_id', async () => {
  const r = await req('POST', '/api/admin/cc-import/review/unmatched-payee/abc/create-stub', adminToken, {});
  assert.equal(r.status, 400);
});

test('POST /unmatched-payee/:id/create-stub 404 on unknown legacy_payout_id', async () => {
  const r = await req(
    'POST', '/api/admin/cc-import/review/unmatched-payee/999999999/create-stub', adminToken, {}
  );
  assert.equal(r.status, 404);
});

test('POST /unmatched-payee/:id/create-stub 409 when payout is already linked', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/unmatched-payee/${unmatchedPayoutLinkedId}/create-stub`, adminToken, {}
  );
  assert.equal(r.status, 409);
});

test('POST /unmatched-payee/:id/create-stub success: stub user created + payout linked', async () => {
  // Use a fresh fixture payout (no stub yet). We create one here so the
  // success path doesn't clash with the no_stub_path test (which already
  // consumed unmatchedPayoutNoStubId).
  const rawR = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, payload)
     VALUES ('review-test', 'payouts', $1, $2, '{}'::jsonb)
     RETURNING id`,
    [nextSrn(), nextHash('cs-success')]
  );
  const fresh = await pool.query(
    `INSERT INTO legacy_cc_payouts (payee_name, payee_name_normalized, payee_user_id, paid_on, amount_cents, raw_import_id)
     VALUES ('CreateStub Fixture', 'createstub fixture', NULL, CURRENT_DATE - INTERVAL '110 days', 12300, $1)
     RETURNING id`,
    [rawR.rows[0].id]
  );
  const payoutId = fresh.rows[0].id;

  const r = await req('POST', `/api/admin/cc-import/review/unmatched-payee/${payoutId}/create-stub`, adminToken, {});
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.ok(body.user_id);
  assert.ok(/^legacy_cc:/.test(body.cc_id || ''));
  // Capture for explicit cleanup in after() — this user's email shape
  // (`legacy-cc-createstubfixture-<hash>@...`) doesn't get auto-fixtured.
  createdStubUserId = body.user_id;

  const u = await pool.query(`SELECT cc_id, onboarding_status FROM users WHERE id = $1`, [body.user_id]);
  assert.equal(u.rowCount, 1);
  assert.match(u.rows[0].cc_id, /^legacy_cc:/);
  assert.equal(u.rows[0].onboarding_status, 'deactivated');

  const cp = await pool.query(`SELECT user_id FROM contractor_profiles WHERE user_id = $1`, [body.user_id]);
  assert.equal(cp.rowCount, 1);

  const linked = await pool.query(`SELECT payee_user_id FROM legacy_cc_payouts WHERE id = $1`, [payoutId]);
  assert.equal(linked.rows[0].payee_user_id, body.user_id);
});

// ── §5 errored-row/:id/retry ─────────────────────────────────────

test('POST /errored-row/:id/retry rejects non-integer row_id', async () => {
  const r = await req('POST', '/api/admin/cc-import/review/errored-row/abc/retry', adminToken, {});
  assert.equal(r.status, 400);
});

test('POST /errored-row/:id/retry 404 on unknown row_id', async () => {
  const r = await req(
    'POST', '/api/admin/cc-import/review/errored-row/999999999/retry', adminToken, {}
  );
  assert.equal(r.status, 404);
});

test('POST /errored-row/:id/retry 409 on row not in errored state', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/errored-row/${rawNotErroredId}/retry`, adminToken, {}
  );
  assert.equal(r.status, 409);
});

test('POST /errored-row/:id/retry rejects non-object payload_override', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/errored-row/${rawErroredEventsId}/retry`, adminToken,
    { payload_override: 'not-an-object' }
  );
  assert.equal(r.status, 400);
});

test('POST /errored-row/:id/retry returns 409 CC_RETRY_PAYMENT_NOT_SUPPORTED for payments rows', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/errored-row/${rawErroredPaymentsId}/retry`, adminToken, {}
  );
  assert.equal(r.status, 409);
  assert.equal(JSON.parse(r.body).code, 'CC_RETRY_PAYMENT_NOT_SUPPORTED');
});

// ── §6 skipped-event/:id/promote ─────────────────────────────────

test('POST /skipped-event/:id/promote rejects non-integer row_id', async () => {
  const r = await req('POST', '/api/admin/cc-import/review/skipped-event/abc/promote', adminToken, {});
  assert.equal(r.status, 400);
});

test('POST /skipped-event/:id/promote 404 on unknown row_id', async () => {
  const r = await req(
    'POST', '/api/admin/cc-import/review/skipped-event/999999999/promote', adminToken, {}
  );
  assert.equal(r.status, 404);
});

test('POST /skipped-event/:id/promote 409 on non-skipped row', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/skipped-event/${rawNotSkippedId}/promote`, adminToken, {}
  );
  assert.equal(r.status, 409);
});

// ── §7 phase0-failure/:id/accept-loss ────────────────────────────

test('POST /phase0-failure/:id/accept-loss rejects non-integer row_id', async () => {
  const r = await req(
    'POST', '/api/admin/cc-import/review/phase0-failure/abc/accept-loss', adminToken,
    { reason: 'real reason' }
  );
  assert.equal(r.status, 400);
});

test('POST /phase0-failure/:id/accept-loss rejects missing reason', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/phase0-failure/${phase0EligibleId}/accept-loss`, adminToken, {}
  );
  assert.equal(r.status, 400);
});

test('POST /phase0-failure/:id/accept-loss rejects reason > 500 chars', async () => {
  const big = 'x'.repeat(501);
  const r = await req(
    'POST', `/api/admin/cc-import/review/phase0-failure/${phase0EligibleId}/accept-loss`, adminToken,
    { reason: big }
  );
  assert.equal(r.status, 400);
});

test('POST /phase0-failure/:id/accept-loss 404 on unknown row_id', async () => {
  const r = await req(
    'POST', '/api/admin/cc-import/review/phase0-failure/999999999/accept-loss', adminToken,
    { reason: 'x' }
  );
  assert.equal(r.status, 404);
});

test('POST /phase0-failure/:id/accept-loss 409 when attempt_count < 10', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/phase0-failure/${phase0NotEligibleId}/accept-loss`, adminToken,
    { reason: 'tried 3 times then gave up' }
  );
  assert.equal(r.status, 409);
});

test('POST /phase0-failure/:id/accept-loss sets given_up_at + reason', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/phase0-failure/${phase0EligibleId}/accept-loss`, adminToken,
    { reason: 'permanently dead url' }
  );
  assert.equal(r.status, 200);
  const after = await pool.query(
    `SELECT given_up_at, given_up_reason FROM cc_import_phase0_failures WHERE id = $1`,
    [phase0EligibleId]
  );
  assert.ok(after.rows[0].given_up_at !== null);
  assert.equal(after.rows[0].given_up_reason, 'permanently dead url');
});

// ── §7 phase0-failure/:id/revert-give-up ─────────────────────────

test('POST /phase0-failure/:id/revert-give-up rejects non-integer row_id', async () => {
  const r = await req('POST', '/api/admin/cc-import/review/phase0-failure/abc/revert-give-up', adminToken, {});
  assert.equal(r.status, 400);
});

test('POST /phase0-failure/:id/revert-give-up 404 on unknown row_id', async () => {
  const r = await req(
    'POST', '/api/admin/cc-import/review/phase0-failure/999999999/revert-give-up', adminToken, {}
  );
  assert.equal(r.status, 404);
});

test('POST /phase0-failure/:id/revert-give-up 409 on row not yet given up', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/phase0-failure/${phase0NotEligibleId}/revert-give-up`, adminToken, {}
  );
  assert.equal(r.status, 409);
});

test('POST /phase0-failure/:id/revert-give-up clears given_up_at + resets attempt_count', async () => {
  const r = await req(
    'POST', `/api/admin/cc-import/review/phase0-failure/${phase0DoneId}/revert-give-up`, adminToken, {}
  );
  assert.equal(r.status, 200);
  const after = await pool.query(
    `SELECT given_up_at, given_up_reason, attempt_count FROM cc_import_phase0_failures WHERE id = $1`,
    [phase0DoneId]
  );
  assert.equal(after.rows[0].given_up_at, null);
  assert.equal(after.rows[0].attempt_count, 0);
});

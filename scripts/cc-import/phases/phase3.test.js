const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { pool } = require('../lib/db');
const phase3 = require('./phase3');

// ── Fixture conventions ─────────────────────────────────────────────────
// Pinned negative ids keep us miles away from real production rows. Range:
//   clients : -93500 .. -93520
//   shifts  : -93530 .. -93540  (NOT pre-inserted; we just scrub any with
//             a 'fix3-' tagged proposal_id afterwards)
//   users   : -93550 .. -93560  (for shift_requests staff matching)
const FIXTURE_CCID_PREFIX = 'fix3-';
const FIXTURE_CLIENT_IDS = Array.from({ length: 21 }, (_, i) => -93500 - i);
const FIXTURE_USER_IDS = Array.from({ length: 11 }, (_, i) => -93550 - i);
const FIXTURE_EMAIL_DOMAIN = '@phase3-fixture.local';
const FIXTURE_STAFF_NAME = 'Phase3 Fixture Bartender';

async function scrubFixtures() {
  // Scrub in FK-safe order. We first remove anything tied to fixture proposals,
  // then the proposals themselves, then clients/users/raw_imports.

  // 1. proposal-children for fixture proposals (cc_id LIKE 'fix3-%'):
  //    activity_log, scheduled_messages, shift_requests via shifts, shifts.
  const fixProposalIds = (
    await pool.query(`SELECT id FROM proposals WHERE cc_id LIKE $1`, [`${FIXTURE_CCID_PREFIX}%`])
  ).rows.map((r) => r.id);
  if (fixProposalIds.length) {
    // shift_requests via shifts attached to these proposals.
    await pool.query(
      `DELETE FROM shift_requests
        WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = ANY($1::int[]))`,
      [fixProposalIds]
    );
    await pool.query(`DELETE FROM shifts WHERE proposal_id = ANY($1::int[])`, [fixProposalIds]);
    await pool.query(`DELETE FROM scheduled_messages WHERE entity_type='proposal' AND entity_id = ANY($1::int[])`, [fixProposalIds]);
    await pool.query(`DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])`, [fixProposalIds]);
    await pool.query(`DELETE FROM proposals WHERE id = ANY($1::int[])`, [fixProposalIds]);
  }

  // 2. Bucket C archive rows.
  await pool.query(`DELETE FROM legacy_cc_proposals WHERE cc_id LIKE $1`, [`${FIXTURE_CCID_PREFIX}%`]);

  // 3. legacy_cc_raw_imports tagged with our cc_id prefix.
  await pool.query(`DELETE FROM legacy_cc_raw_imports WHERE cc_id LIKE $1`, [`${FIXTURE_CCID_PREFIX}%`]);

  // 4. Pinned-id fixture users (CASCADE clears contractor_profiles via FK).
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])`, [FIXTURE_USER_IDS]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [FIXTURE_USER_IDS]);

  // 5. Pinned-id fixture clients (some proposals had FK ON DELETE SET NULL so
  //    they may still hold stale client_id; we already deleted the proposals).
  await pool.query(`DELETE FROM clients WHERE id = ANY($1::int[])`, [FIXTURE_CLIENT_IDS]);
  await pool.query(`DELETE FROM clients WHERE email LIKE $1`, [`%${FIXTURE_EMAIL_DOMAIN}`]);
}

before(async () => { await scrubFixtures(); });
beforeEach(async () => { await scrubFixtures(); });
after(async () => {
  await scrubFixtures();
  await pool.end();
});

// Build a temp ccDir holding only `report (10).csv` with the supplied rows.
function makeCcDir(rows) {
  const header = [
    'ID','Name','Status','Event Date','Start Time','End Time','Length','Booked At','Brand','Service Name',
    'Package Group Name','Package Name','Package Details','Package Amount','Add On Names','Add On Name, Quantity & Price',
    'Extra Names','Extra Name, Quantity & Price','Backdrop Selected','Backdrop Amount','Venue Name','Venue Full Address',
    'Venue Street Address','Venue City','Venue State/Province','Venue Postal Code','User Email(s)','User Phone(s)',
    'User Name(s)','User Details','User Address: Full Address','User Address: Street','User Address: City',
    'User Address: State/Province','User Address: Postal Code','Contact Email(s)','Contact Phone(s)','Contact Name(s)',
    'Contacts','Public Notes','Private Notes','Assigned Staff','Unit Count','Unit Name','Unit Range','Origin','Event Type',
    'Source','Estimated Number of Guests','Lead Type','Setup Location','Contact Preference','PO Number','Stair Setup',
    'Setup At','Dropoff At','Pickup At',
  ];
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  // Header values that contain commas (e.g. "Add On Name, Quantity & Price")
  // must be quoted, otherwise csv-parse splits them into two columns and
  // every column after that gets shifted.
  const lines = [header.map(escape).join(',')];
  for (const row of rows) {
    lines.push(header.map((h) => escape(row[h] || '')).join(','));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-test-'));
  fs.writeFileSync(path.join(dir, 'report (10).csv'), lines.join('\n') + '\n', 'utf8');
  return dir;
}

// Seed a fixture client + (optional) bartender user.
async function seedClient({ id, email, name }) {
  await pool.query(
    `INSERT INTO clients (id, name, email, source) VALUES ($1, $2, $3, 'direct')`,
    [id, name, email]
  );
  return id;
}

async function seedBartender({ id, email, preferredName }) {
  // bcryptjs hash for a throwaway password — never used to log in.
  const passwordHash = '$2a$10$abcdefghijklmnopqrstuvWXYZ1234567890abcdefghijkl0123456';
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, onboarding_status, pre_hired)
     VALUES ($1, $2, $3, 'staff', 'hired', false)`,
    [id, email, passwordHash]
  );
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET preferred_name = EXCLUDED.preferred_name`,
    [id, preferredName]
  );
  return id;
}

// Helper: future date (event-date for Bucket A) and past date (for Bucket B).
function futureDateCc(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}-${dd}-${d.getUTCFullYear()}`;
}
function pastDateCc(daysAgo) {
  return futureDateCc(-daysAgo);
}

// ── Tests ───────────────────────────────────────────────────────────────

test('Phase 3 Bucket A: clean promotion — proposals + shifts + shift_requests + activity_log written', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}A001`;
  const clientId = -93501;
  const email = `bucketa.client${FIXTURE_EMAIL_DOMAIN}`;
  await seedClient({ id: clientId, email, name: 'Bucket A Client' });

  const dir = makeCcDir([{
    'ID': ccId,
    'Name': "Bucket A Client's Bartending Services",
    'Status': 'Confirmed',
    'Event Date': futureDateCc(30),
    'Start Time': '6:00 PM',
    'End Time': '10:00 PM',
    'Length': '4 hours',
    'Booked At': '03-25-2025 12:59 PM',
    'Brand': 'Dr. Bartender',
    'Service Name': 'Private',
    'Package Name': 'The Core Reaction',
    'Package Amount': '$650',
    'Venue Name': 'Test Venue',
    'Venue Street Address': '123 Test St',
    'Venue City': 'Chicago',
    'Venue State/Province': 'IL',
    'Venue Postal Code': '60661',
    'Contact Email(s)': email,
    'Estimated Number of Guests': '75',
    'Public Notes': 'Use the main entrance.',
    'Private Notes': 'Client prefers vodka.',
  }]);

  const res = await phase3.run({
    ccDir: dir,
    captureMessage: () => {},
    captureException: () => {},
  });

  assert.strictEqual(res.processed, 1);
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.bucketCounts.A, 1);

  const pr = await pool.query(
    `SELECT id, status, event_date, event_start_time, event_duration_hours,
            guest_count, total_price, amount_paid, payment_type,
            balance_due_date, admin_notes, pricing_snapshot, autopay_enrolled,
            venue_name, venue_city, sent_at, accepted_at, client_id
       FROM proposals WHERE cc_id = $1`,
    [ccId]
  );
  assert.strictEqual(pr.rowCount, 1);
  const p = pr.rows[0];
  assert.strictEqual(p.status, 'confirmed');
  assert.strictEqual(p.client_id, clientId);
  assert.strictEqual(Number(p.event_duration_hours), 4);
  assert.strictEqual(p.event_start_time, '6:00 PM');
  assert.strictEqual(p.guest_count, 75);
  assert.strictEqual(Number(p.total_price), 650);
  assert.strictEqual(Number(p.amount_paid), 0);
  assert.strictEqual(p.payment_type, 'deposit');
  assert.strictEqual(p.autopay_enrolled, false);
  assert.strictEqual(p.venue_name, 'Test Venue');
  assert.strictEqual(p.venue_city, 'Chicago');
  assert.ok(p.balance_due_date, 'balance_due_date should be set for Bucket A');
  assert.ok(p.sent_at, 'sent_at should be set');
  assert.ok(p.accepted_at, 'accepted_at should be set');
  assert.strictEqual(p.admin_notes, 'Client prefers vodka.');
  assert.strictEqual(p.pricing_snapshot.package.name, 'The Core Reaction');
  assert.strictEqual(p.pricing_snapshot.package.amount_cents, 65000);
  assert.strictEqual(p.pricing_snapshot._cc_imported, true);
  assert.deepStrictEqual(p.pricing_snapshot.breakdown, []);
  assert.deepStrictEqual(p.pricing_snapshot.line_items, []);

  // Shift was created with status='open'.
  const sr = await pool.query(
    `SELECT id, status, start_time, end_time, location, positions_needed, notes
       FROM shifts WHERE proposal_id = $1`,
    [p.id]
  );
  assert.strictEqual(sr.rowCount, 1);
  const s = sr.rows[0];
  assert.strictEqual(s.status, 'open');
  assert.strictEqual(s.start_time, '6:00 PM');
  assert.strictEqual(s.end_time, '10:00 PM');
  assert.strictEqual(s.notes, `Imported from Check Cherry (cc_id=${ccId})`);
  assert.ok(s.location && s.location.includes('Chicago'));
  // positions_needed is a JSON-encoded array.
  assert.deepStrictEqual(JSON.parse(s.positions_needed), ['Bartender']);

  // Activity-log: cc_import_promoted + cc_import_public_note.
  const al = await pool.query(
    `SELECT action, details FROM proposal_activity_log
      WHERE proposal_id = $1 ORDER BY id`,
    [p.id]
  );
  assert.strictEqual(al.rowCount, 2);
  assert.strictEqual(al.rows[0].action, 'cc_import_promoted');
  assert.strictEqual(al.rows[0].details.bucket, 'A');
  assert.strictEqual(al.rows[0].details.cc_id, ccId);
  assert.ok(al.rows[0].details.source_run_id);
  assert.strictEqual(al.rows[1].action, 'cc_import_public_note');
  assert.strictEqual(al.rows[1].details.public_notes, 'Use the main entrance.');

  // Raw row marked promoted.
  const rr = await pool.query(
    `SELECT import_status, import_notes FROM legacy_cc_raw_imports WHERE cc_id = $1`,
    [ccId]
  );
  assert.strictEqual(rr.rows[0].import_status, 'promoted');
  assert.strictEqual(rr.rows[0].import_notes.bucket, 'A');
});

test('Phase 3 Bucket B: past-event promotion — status=completed, shift.status=completed, no balance_due_date', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}B001`;
  const clientId = -93502;
  const email = `bucketb.client${FIXTURE_EMAIL_DOMAIN}`;
  await seedClient({ id: clientId, email, name: 'Bucket B Client' });

  const dir = makeCcDir([{
    'ID': ccId,
    'Name': "Bucket B Past",
    'Status': 'Confirmed',
    'Event Date': pastDateCc(30),
    'Start Time': '7:00 PM',
    'Length': '3 hours',
    'Booked At': '03-25-2025 12:59 PM',
    'Package Name': 'The Midrange Reaction',
    'Package Amount': '$400',
    'Venue Name': 'Past Venue',
    'Venue City': 'Chicago',
    'Venue State/Province': 'IL',
    'Contact Email(s)': email,
    'Estimated Number of Guests': '50',
  }]);

  const res = await phase3.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.bucketCounts.B, 1);

  const pr = await pool.query(
    `SELECT status, balance_due_date FROM proposals WHERE cc_id = $1`,
    [ccId]
  );
  assert.strictEqual(pr.rowCount, 1);
  assert.strictEqual(pr.rows[0].status, 'completed');
  assert.strictEqual(pr.rows[0].balance_due_date, null);

  const sr = await pool.query(
    `SELECT status FROM shifts WHERE proposal_id = (SELECT id FROM proposals WHERE cc_id = $1)`,
    [ccId]
  );
  assert.strictEqual(sr.rows[0].status, 'completed');
});

test('Phase 3 Bucket C: non-Confirmed status archived to legacy_cc_proposals', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}C001`;
  const dir = makeCcDir([{
    'ID': ccId,
    'Name': 'Lost Lead',
    'Status': 'Canceled Proposal',
    'Event Date': futureDateCc(60),
    'Length': '4 hours',
    'Package Name': 'The Enhanced Solution',
    'Package Amount': '$800',
    'Venue Full Address': 'TBD',
    'Venue City': 'Chicago',
    'Venue State/Province': 'IL',
    'Contact Email(s)': `bucketc${FIXTURE_EMAIL_DOMAIN}`,
    'Source': 'Google',
    'Lead Type': 'New',
    'Public Notes': 'Asked for follow-up.',
  }]);

  const res = await phase3.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.bucketCounts.C, 1);

  // No native proposal.
  const pr = await pool.query(`SELECT id FROM proposals WHERE cc_id = $1`, [ccId]);
  assert.strictEqual(pr.rowCount, 0);

  // Archive row exists.
  const ar = await pool.query(
    `SELECT cc_id, status, package_name, package_amount_cents, public_notes, source, lead_type
       FROM legacy_cc_proposals WHERE cc_id = $1`,
    [ccId]
  );
  assert.strictEqual(ar.rowCount, 1);
  assert.strictEqual(ar.rows[0].status, 'Canceled Proposal');
  assert.strictEqual(ar.rows[0].package_name, 'The Enhanced Solution');
  assert.strictEqual(ar.rows[0].package_amount_cents, 80000);
  assert.strictEqual(ar.rows[0].public_notes, 'Asked for follow-up.');
  assert.strictEqual(ar.rows[0].source, 'Google');
  assert.strictEqual(ar.rows[0].lead_type, 'New');

  // Raw row marked archived.
  const rr = await pool.query(
    `SELECT import_status FROM legacy_cc_raw_imports WHERE cc_id = $1`,
    [ccId]
  );
  assert.strictEqual(rr.rows[0].import_status, 'archived');
});

test('Phase 3 Bucket D: skip-list package — raw row marked skipped, no other DB state', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}D001`;
  const dir = makeCcDir([{
    'ID': ccId,
    'Name': 'Internal Placeholder',
    'Status': 'Confirmed',
    'Event Date': futureDateCc(15),
    'Length': '4 hours',
    'Package Name': 'Inventory', // skip-list package
    'Package Amount': '$0',
    'Contact Email(s)': `bucketd${FIXTURE_EMAIL_DOMAIN}`,
  }]);

  const res = await phase3.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.bucketCounts.D, 1);

  // No proposal, no archive row.
  assert.strictEqual(
    (await pool.query(`SELECT id FROM proposals WHERE cc_id = $1`, [ccId])).rowCount, 0
  );
  assert.strictEqual(
    (await pool.query(`SELECT cc_id FROM legacy_cc_proposals WHERE cc_id = $1`, [ccId])).rowCount, 0
  );

  // Raw row marked skipped with the right reason.
  const rr = await pool.query(
    `SELECT import_status, import_notes FROM legacy_cc_raw_imports WHERE cc_id = $1`,
    [ccId]
  );
  assert.strictEqual(rr.rows[0].import_status, 'skipped');
  assert.strictEqual(rr.rows[0].import_notes.reason, 'package_in_skip_list');
  assert.strictEqual(rr.rows[0].import_notes.package_name, 'Inventory');
});

test('Phase 3 Bucket A dedup: pre-seeded native proposal within ±14d → duplicate_review', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}A002`;
  const clientId = -93503;
  const email = `dedup.client${FIXTURE_EMAIL_DOMAIN}`;
  await seedClient({ id: clientId, email, name: 'Dedup Client' });

  // Pre-seed a native proposal for this client 7 days from now.
  const sevenDays = new Date(Date.now() + 7 * 86400000);
  const sevenIso = sevenDays.toISOString().slice(0, 10);
  const seededRes = await pool.query(
    `INSERT INTO proposals (client_id, event_date, total_price, status)
     VALUES ($1, $2, 500, 'sent') RETURNING id`,
    [clientId, sevenIso]
  );
  const seededId = seededRes.rows[0].id;

  try {
    const dir = makeCcDir([{
      'ID': ccId,
      'Name': "Dedup Conflict",
      'Status': 'Confirmed',
      'Event Date': futureDateCc(10), // within ±14d of the pre-seeded
      'Start Time': '6:00 PM',
      'Length': '4 hours',
      'Package Name': 'The Core Reaction',
      'Package Amount': '$650',
      'Venue Name': 'Conflicting Venue',
      'Venue City': 'Chicago',
      'Venue State/Province': 'IL',
      'Contact Email(s)': email,
      'Estimated Number of Guests': '50',
    }]);

    const res = await phase3.run({
      ccDir: dir, captureMessage: () => {}, captureException: () => {},
    });
    assert.strictEqual(res.errored, 0);
    assert.strictEqual(res.bucketCounts.dup, 1);

    // No native proposal created for this cc_id.
    assert.strictEqual(
      (await pool.query(`SELECT id FROM proposals WHERE cc_id = $1`, [ccId])).rowCount, 0
    );

    // Raw row marked duplicate_review with candidate id.
    const rr = await pool.query(
      `SELECT import_status, import_notes FROM legacy_cc_raw_imports WHERE cc_id = $1`,
      [ccId]
    );
    assert.strictEqual(rr.rows[0].import_status, 'duplicate_review');
    assert.strictEqual(rr.rows[0].import_notes.candidate_proposal_id, seededId);
    assert.strictEqual(rr.rows[0].import_notes.match_reason, 'client_id+date_within_14d');
  } finally {
    // Scrub the pre-seeded proposal.
    await pool.query(`DELETE FROM proposals WHERE id = $1`, [seededId]);
  }
});

test('promoteBucketA({ skipDedup: true }) bypasses dedup and writes the proposal', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}A003`;
  const clientId = -93504;
  const email = `skipdedup.client${FIXTURE_EMAIL_DOMAIN}`;
  await seedClient({ id: clientId, email, name: 'SkipDedup Client' });

  // Pre-seed a native proposal close in time — would normally trigger dedup.
  const tenDays = new Date(Date.now() + 10 * 86400000);
  const tenIso = tenDays.toISOString().slice(0, 10);
  const seeded = await pool.query(
    `INSERT INTO proposals (client_id, event_date, total_price, status)
     VALUES ($1, $2, 500, 'sent') RETURNING id`,
    [clientId, tenIso]
  );
  const seededId = seeded.rows[0].id;

  try {
    const payload = {
      'ID': ccId,
      'Status': 'Confirmed',
      'Event Date': futureDateCc(12),
      'Start Time': '6:00 PM',
      'Length': '4 hours',
      'Package Name': 'The Core Reaction',
      'Package Amount': '$650',
      'Venue Name': 'V',
      'Venue City': 'Chicago',
      'Venue State/Province': 'IL',
      'Contact Email(s)': email,
      'Estimated Number of Guests': '50',
    };

    const r = await phase3.promoteBucketA(payload, { skipDedup: true, sourceRunId: 9999 });
    assert.strictEqual(r.status, 'promoted', `expected promoted, got ${JSON.stringify(r)}`);
    assert.ok(r.proposalId);
    assert.ok(r.shiftId);

    // Proposal landed despite the existing one being within ±14d.
    const pr = await pool.query(`SELECT status FROM proposals WHERE cc_id = $1`, [ccId]);
    assert.strictEqual(pr.rowCount, 1);
    assert.strictEqual(pr.rows[0].status, 'confirmed');

    // Activity log includes the source_run_id we passed.
    const al = await pool.query(
      `SELECT details FROM proposal_activity_log
        WHERE proposal_id = $1 AND action = 'cc_import_promoted'`,
      [r.proposalId]
    );
    assert.strictEqual(al.rows[0].details.source_run_id, 9999);
  } finally {
    await pool.query(`DELETE FROM proposals WHERE id = $1`, [seededId]);
  }
});

test('Phase 3 Bucket A: Assigned Staff matches existing user → shift_request inserted with position=Bartender', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}A004`;
  const clientId = -93505;
  const userId = -93550;
  const email = `staff.client${FIXTURE_EMAIL_DOMAIN}`;
  const bartenderEmail = `bartender${FIXTURE_EMAIL_DOMAIN}`;

  await seedClient({ id: clientId, email, name: 'Staff Client' });
  await seedBartender({
    id: userId,
    email: bartenderEmail,
    preferredName: FIXTURE_STAFF_NAME,
  });

  const dir = makeCcDir([{
    'ID': ccId,
    'Status': 'Confirmed',
    'Event Date': futureDateCc(45),
    'Start Time': '6:00 PM',
    'Length': '4 hours',
    'Package Name': 'The Core Reaction',
    'Package Amount': '$650',
    'Venue Name': 'V',
    'Venue City': 'Chicago',
    'Venue State/Province': 'IL',
    'Contact Email(s)': email,
    'Assigned Staff': FIXTURE_STAFF_NAME,
    'Estimated Number of Guests': '50',
  }]);

  const res = await phase3.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.bucketCounts.A, 1);

  const sr = await pool.query(
    `SELECT sr.user_id, sr.status, sr.position
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       JOIN proposals p ON p.id = s.proposal_id
      WHERE p.cc_id = $1`,
    [ccId]
  );
  assert.strictEqual(sr.rowCount, 1);
  assert.strictEqual(sr.rows[0].user_id, userId);
  assert.strictEqual(sr.rows[0].status, 'approved');
  // LOAD-BEARING — payroll filters on position='Bartender'.
  assert.strictEqual(sr.rows[0].position, 'Bartender');
});

test('Phase 3 Bucket A: pricing_snapshot shape matches both consumer families (display + payroll)', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}A005`;
  const clientId = -93506;
  const email = `pricing.client${FIXTURE_EMAIL_DOMAIN}`;
  await seedClient({ id: clientId, email, name: 'Pricing Client' });

  const dir = makeCcDir([{
    'ID': ccId,
    'Status': 'Confirmed',
    'Event Date': futureDateCc(50),
    'Start Time': '6:00 PM',
    'Length': '4 hours',
    'Package Name': 'The Core Reaction',
    'Package Amount': '$450',
    'Add On Names': 'Glassware Rental, Specialty Mixers',
    'Add On Name, Quantity & Price': '1 x Glassware Rental ($200), 1 x Specialty Mixers ($50)',
    'Venue City': 'Chicago',
    'Venue State/Province': 'IL',
    'Contact Email(s)': email,
    'Estimated Number of Guests': '50',
  }]);

  const res = await phase3.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  assert.strictEqual(res.errored, 0);

  const pr = await pool.query(
    `SELECT total_price, pricing_snapshot FROM proposals WHERE cc_id = $1`,
    [ccId]
  );
  assert.strictEqual(pr.rowCount, 1);

  const snap = pr.rows[0].pricing_snapshot;
  // Display consumers
  assert.strictEqual(snap.package.name, 'The Core Reaction');
  assert.strictEqual(snap.package.amount_cents, 45000);
  assert.strictEqual(snap.gratuity_cents, 0);
  assert.strictEqual(snap.line_items.length, 2);
  assert.strictEqual(snap.line_items[0].name, 'Glassware Rental');
  assert.strictEqual(snap.line_items[0].amount_cents, 20000);
  assert.strictEqual(snap.line_items[1].name, 'Specialty Mixers');
  assert.strictEqual(snap.line_items[1].amount_cents, 5000);
  // Payroll consumer — payrollMath::extractGratuityCents reads breakdown[]
  assert.deepStrictEqual(snap.breakdown, []);
  // CC marker
  assert.strictEqual(snap._cc_imported, true);
  assert.strictEqual(snap._cc_id, ccId);

  // total_price = (45000 + 20000 + 5000) / 100 = 700.00
  assert.strictEqual(Number(pr.rows[0].total_price), 700);
});

test('Phase 3 Bucket A: auto-comms enrollment writes scheduled_messages rows', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}A006`;
  const clientId = -93507;
  const email = `comms.client${FIXTURE_EMAIL_DOMAIN}`;
  await seedClient({ id: clientId, email, name: 'Comms Client' });

  const dir = makeCcDir([{
    'ID': ccId,
    'Status': 'Confirmed',
    // Far-future event so scheduleNewYearHello / scheduleSixMonthsOut both fire.
    'Event Date': futureDateCc(400),
    'Start Time': '6:00 PM',
    'Length': '4 hours',
    'Package Name': 'The Core Reaction',
    'Package Amount': '$650',
    'Venue City': 'Chicago',
    'Venue State/Province': 'IL',
    'Contact Email(s)': email,
    'Estimated Number of Guests': '50',
  }]);

  const res = await phase3.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.bucketCounts.A, 1);
  assert.strictEqual(res.bucketAPromotedIds.length, 1);

  const proposalId = res.bucketAPromotedIds[0];

  // scheduleDepositPaidReminders writes balance reminders + pre-event reminders.
  // onProposalSignedAndPaid additionally writes new_year_hello + six_months_out.
  // We don't assert exact message_types because the comms graph evolves — just
  // verify at least one row was written.
  const sm = await pool.query(
    `SELECT message_type FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1
      ORDER BY message_type`,
    [proposalId]
  );
  assert.ok(sm.rowCount > 0, `expected at least one scheduled_message, got ${sm.rowCount}`);
});

test('Phase 3 Bucket B: auto-comms NOT enrolled for past events', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}B002`;
  const clientId = -93508;
  const email = `bcomms.client${FIXTURE_EMAIL_DOMAIN}`;
  await seedClient({ id: clientId, email, name: 'B Comms Client' });

  const dir = makeCcDir([{
    'ID': ccId,
    'Status': 'Confirmed',
    'Event Date': pastDateCc(60),
    'Start Time': '6:00 PM',
    'Length': '4 hours',
    'Package Name': 'The Core Reaction',
    'Package Amount': '$650',
    'Venue City': 'Chicago',
    'Venue State/Province': 'IL',
    'Contact Email(s)': email,
    'Estimated Number of Guests': '50',
  }]);

  const res = await phase3.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  assert.strictEqual(res.errored, 0);
  assert.strictEqual(res.bucketCounts.B, 1);
  // bucketAPromotedIds drives auto-comms — Bucket B must NOT appear.
  assert.strictEqual(res.bucketAPromotedIds.length, 0);

  const pr = await pool.query(`SELECT id FROM proposals WHERE cc_id = $1`, [ccId]);
  const proposalId = pr.rows[0].id;
  const sm = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1`,
    [proposalId]
  );
  assert.strictEqual(sm.rows[0].n, 0);
});

test('Phase 3: re-run is idempotent — second run with same CSV does not double-write', async () => {
  const ccId = `${FIXTURE_CCID_PREFIX}A007`;
  const clientId = -93509;
  const email = `idem.client${FIXTURE_EMAIL_DOMAIN}`;
  await seedClient({ id: clientId, email, name: 'Idem Client' });

  const csvRow = {
    'ID': ccId,
    'Status': 'Confirmed',
    'Event Date': futureDateCc(30),
    'Start Time': '6:00 PM',
    'Length': '4 hours',
    'Package Name': 'The Core Reaction',
    'Package Amount': '$650',
    'Venue City': 'Chicago',
    'Venue State/Province': 'IL',
    'Contact Email(s)': email,
    'Estimated Number of Guests': '50',
  };
  const dir = makeCcDir([csvRow]);

  const r1 = await phase3.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  assert.strictEqual(r1.bucketCounts.A, 1);
  assert.strictEqual(r1.errored, 0);

  const r2 = await phase3.run({
    ccDir: dir, captureMessage: () => {}, captureException: () => {},
  });
  // Second run: proposal already exists, ON CONFLICT (cc_id) DO NOTHING fires.
  // The raw row is re-recorded; phase3 treats it as 'skipped' (cc_id_already_present).
  assert.strictEqual(r2.errored, 0);
  assert.strictEqual(r2.skipped, 1);

  // Exactly one proposal with this cc_id.
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM proposals WHERE cc_id = $1`,
    [ccId]
  );
  assert.strictEqual(countRes.rows[0].n, 1);
});

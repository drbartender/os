require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pool } = require('../../db');
const {
  parseMappingRows, planWrites, planSkips, applyWrites, toYmd, exitCodeFor,
  REQUIRED_MAPPING_COLUMNS,
} = require('./applySeniorityBackfill');
// The producer's column list, imported rather than hand-copied: this is the
// only thing that pins the generator→apply CSV contract in code. A renamed
// column in one script now fails a test instead of silently under-applying.
const { MAPPING_COLUMNS } = require('./generateSeniorityMapping');

if (process.env.NODE_ENV === 'production') {
  throw new Error('seniorityBackfill.test.js refuses to run against production');
}

// hire_date comes back from `pg` as a Date at LOCAL midnight. Assert through
// toYmd, never String(row.hire_date).slice(0,10) — that yields "Tue Jun 10".

const HEADER = MAPPING_COLUMNS.join(',');
const CSV = [
  HEADER,
  'Kaitlyn Freyer,2025-05-22,32,7,Kaitlyn,approved,2025-06-10,2025-05-22,3,32,yes,',
  'Someone Else,2025-05-01,5,,,,,2025-05-01,0,5,no,unmatched',
  'Inactive Vet,2025-04-01,4,9,Vet,deactivated,,2025-04-01,0,4,no,',
].join('\n');

// ── The generator → apply CSV contract ─────────────────────────────
test('every column the apply script consumes is one the generator writes', () => {
  for (const name of REQUIRED_MAPPING_COLUMNS) {
    assert.ok(MAPPING_COLUMNS.includes(name),
      `applySeniorityBackfill reads "${name}", which generateSeniorityMapping does not write`);
  }
  // And the fixtures in this file speak the producer's header verbatim.
  assert.equal(HEADER.split(',').length, MAPPING_COLUMNS.length);
});

// ── Pure core: parsing ─────────────────────────────────────────────
test('parseMappingRows reads every row with typed fields', () => {
  const rows = parseMappingRows(CSV);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    rowNumber: 2, name: 'Kaitlyn Freyer', userId: 7, hireDate: '2025-05-22',
    historical: 32, include: true, flags: '',
  });
});

test('planWrites keeps only include=yes rows with a matched user', () => {
  const writes = planWrites(parseMappingRows(CSV));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { userId: 7, hireDate: '2025-05-22', historical: 32 });
});

// ── Pure core: the mapping CSV is untrusted input ──────────────────

// The verified spreadsheet scenario: a round-trip renames or drops a column,
// every lookup returns '', and the old `parseInt(cell || '0') || 0` quietly
// committed 0 over every backfilled baseline. Each consumed column is checked,
// because a renamed matched_user_id silently under-applies and a renamed
// proposed_hire_date would mass-NULL hire_date.
test('a missing required header aborts before any row is parsed', () => {
  for (const name of REQUIRED_MAPPING_COLUMNS) {
    const mangled = CSV.replace(new RegExp(`(^|,)${name}(,|$)`, 'm'), `$1RENAMED_${name}$2`);
    assert.throws(() => parseMappingRows(mangled), new RegExp(`missing required column\\(s\\): ${name}`),
      `a renamed ${name} must abort the run`);
  }
});

test('an empty mapping file aborts with a readable message, not a TypeError', () => {
  for (const empty of ['', '   ', '\n']) {
    assert.throws(() => parseMappingRows(empty), /Mapping file is empty/);
  }
});

test('a non-numeric proposed_historical aborts the run naming the row', () => {
  for (const bad of ['thirty-two', ' ', '12.9', '1e3', '0x10', '-5', '']) {
    const csv = [HEADER, `Kaitlyn Freyer,2025-05-22,32,7,Kaitlyn,approved,2025-06-10,2025-05-22,3,${bad},yes,`].join('\n');
    assert.throws(() => parseMappingRows(csv), (err) => {
      assert.match(err.message, /row 2 \(Kaitlyn Freyer\): proposed_historical/);
      return true;
    }, `expected an abort for proposed_historical=${JSON.stringify(bad)}`);
  }
});

test('proposed_historical above the route ceiling aborts', () => {
  const csv = [HEADER, 'Vet,2025-05-22,1,7,Vet,approved,,2025-05-22,0,100001,yes,'].join('\n');
  assert.throws(() => parseMappingRows(csv), /must be between 0 and 100000/);
});

test('an excluded row is not held to the numeric contract', () => {
  // include=no, so nothing from this row is ever bound to a query.
  const csv = [HEADER, 'Ghost,2025-05-01,5,,,,,2025-05-01,0,not-a-number,no,unmatched'].join('\n');
  const rows = parseMappingRows(csv);
  assert.equal(rows[0].historical, null);
  assert.equal(planWrites(rows).length, 0);
});

test('a mis-keyed include cell aborts instead of silently dropping the row', () => {
  const csv = [HEADER, 'Kaitlyn Freyer,2025-05-22,32,7,Kaitlyn,approved,,2025-05-22,3,32,y,'].join('\n');
  assert.throws(() => parseMappingRows(csv), /include must be exactly "yes" or "no"/);
});

test('a non-numeric matched_user_id aborts', () => {
  const csv = [HEADER, 'Kaitlyn Freyer,2025-05-22,32,seven,Kaitlyn,approved,,2025-05-22,3,32,yes,'].join('\n');
  assert.throws(() => parseMappingRows(csv), /matched_user_id must be a whole number/);
});

test('a proposed_hire_date that is not YYYY-MM-DD aborts before it reaches a DATE column', () => {
  const csv = [HEADER, 'Kaitlyn Freyer,2025-05-22,32,7,Kaitlyn,approved,,Tue Jun 10,3,32,yes,'].join('\n');
  assert.throws(() => parseMappingRows(csv), /proposed_hire_date must be YYYY-MM-DD/);
});

test('a blank line in the middle of the file is ignored, and row numbers stay true', () => {
  const csv = [HEADER, '', 'Kaitlyn Freyer,2025-05-22,32,7,Kaitlyn,approved,,2025-05-22,3,32,yes,'].join('\n');
  const rows = parseMappingRows(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rowNumber, 3);
});

// ── Pure core: blank hire date is a reported skip, never a NULL write ──
test('a blank proposed_hire_date is skipped and reported, not written', () => {
  const csv = [HEADER, 'Blank Date Vet,,12,7,Vet,approved,2025-06-10,,0,12,yes,'].join('\n');
  const rows = parseMappingRows(csv);
  assert.equal(planWrites(rows).length, 0, 'never writes a NULL hire_date');
  const skips = planSkips(rows);
  assert.equal(skips.length, 1);
  assert.equal(skips[0].userId, 7);
  assert.equal(skips[0].name, 'Blank Date Vet');
  assert.match(skips[0].reason, /blank proposed_hire_date/);
});

// ── Pure core: duplicate matched_user_id ───────────────────────────
test('two rows resolving to one OS user abort the run naming both rows', () => {
  const csv = [
    HEADER,
    'Katie Freyer,2025-05-22,32,7,Kaitlyn,approved,,2025-05-22,3,32,yes,duplicate-match',
    'Kaitlyn Freyer,2025-01-02,9,7,Kaitlyn,approved,,2025-01-02,3,9,yes,duplicate-match',
  ].join('\n');
  assert.throws(() => planWrites(parseMappingRows(csv)), (err) => {
    assert.match(err.message, /Duplicate matched_user_id 7/);
    assert.match(err.message, /row 2 \(Katie Freyer\)/);
    assert.match(err.message, /row 3 \(Kaitlyn Freyer\)/);
    return true;
  });
});

test('applyWrites refuses a duplicated write set without issuing a query', async () => {
  const deadClient = { query: () => { throw new Error('applyWrites must not query on a duplicated write set'); } };
  await assert.rejects(
    applyWrites(deadClient, [
      { userId: 7, hireDate: '2025-05-22', historical: 32 },
      { userId: 7, hireDate: '2025-01-02', historical: 9 },
    ], { apply: true }),
    /duplicate user id 7/);
});

// ── Pure core: exit code ───────────────────────────────────────────
test('exitCodeFor never reports success for a partial run', () => {
  assert.equal(exitCodeFor({ apply: true, writeCount: 2, changed: 2, skippedCount: 0, missingCount: 0 }), 0);
  assert.equal(exitCodeFor({ apply: false, writeCount: 2, changed: 0, skippedCount: 0, missingCount: 0 }), 0);
  assert.equal(exitCodeFor({ apply: true, writeCount: 2, changed: 1, skippedCount: 0, missingCount: 0 }), 1);
  assert.equal(exitCodeFor({ apply: true, writeCount: 2, changed: 2, skippedCount: 1, missingCount: 0 }), 1);
  assert.equal(exitCodeFor({ apply: true, writeCount: 2, changed: 2, skippedCount: 0, missingCount: 1 }), 1);
  // A dry run that found unapplicable rows still signals, so the operator sees
  // it before --apply.
  assert.equal(exitCodeFor({ apply: false, writeCount: 2, changed: 0, skippedCount: 1, missingCount: 0 }), 1);
});

// ── DB-backed: applyWrites is exact, idempotent, and only touches its targets ──
const PREFIX = 'seniority-apply-test-';
let uid, otherUid, blankUid, noProfileUid, tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seniority-cli-'));
  const mkUser = async (suffix) => {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1,'x','staff','approved') RETURNING id`,
      [`${PREFIX}${suffix}@example.com`]);
    return u.rows[0].id;
  };
  const mkProfile = (id, name, hire, hist) => pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, hire_date, historical_events_worked) VALUES ($1,$2,$3,$4)`,
    [id, name, hire, hist]);

  uid = await mkUser('a');
  await mkProfile(uid, `${PREFIX}A`, '2025-06-10', 0);
  otherUid = await mkUser('b');
  await mkProfile(otherUid, `${PREFIX}B`, '2025-07-01', 1);
  blankUid = await mkUser('c');
  await mkProfile(blankUid, `${PREFIX}C`, '2025-03-03', 2);
  // Deliberately NO contractor_profiles row: several approved users on the real
  // dev DB are in exactly this state (ids 1, 3978, 3979 among them), so a
  // mapping can legitimately name a user the UPDATE will never match.
  noProfileUid = await mkUser('d');
});

after(async () => {
  // Keyed on the fixture PREFIX, never on the captured ids: if before() failed
  // partway those ids are undefined and an id-keyed cleanup would leak rows.
  await pool.query(
    `DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}%`]);
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  await pool.end();
});

const readProfile = async (id) => (await pool.query(
  'SELECT hire_date, historical_events_worked FROM contractor_profiles WHERE user_id = $1', [id])).rows[0];

test('applyWrites apply=false writes nothing and changes nothing (dry-run)', async () => {
  const client = await pool.connect();
  let result;
  try {
    result = await applyWrites(client, [{ userId: uid, hireDate: '2025-05-22', historical: 32 }], { apply: false });
  } finally { client.release(); }
  assert.equal(result.changed, 0, 'a dry run reports zero changes');
  const r = await readProfile(uid);
  assert.equal(toYmd(r.hire_date), '2025-06-10');   // unchanged
  assert.equal(r.historical_events_worked, 0);
});

test('applyWrites apply=true writes exactly, and a re-run leaves identical values (idempotent)', async () => {
  const w = [{ userId: uid, hireDate: '2025-05-22', historical: 32 }];
  const client = await pool.connect();
  try {
    await applyWrites(client, w, { apply: true });
    await applyWrites(client, w, { apply: true });   // second run: same values, no drift
  } finally { client.release(); }
  const r = await readProfile(uid);
  assert.equal(toYmd(r.hire_date), '2025-05-22');
  assert.equal(r.historical_events_worked, 32);
  // The other profile was never in the write set, so it is untouched.
  const o = await readProfile(otherUid);
  assert.equal(toYmd(o.hire_date), '2025-07-01');
  assert.equal(o.historical_events_worked, 1);
});

// The rollback snapshot is the ONLY thing that makes an --apply run reversible,
// and it is built from applyWrites' `before` array. Pin its shape here rather
// than trusting the console log: a Date leaking through unformatted would write
// a comma-bearing "Tue Jun 10 2025 00:00:00 GMT-0500 (...)" into the backup CSV
// and break both the column count and the restore.
test('applyWrites returns a before-snapshot with YYYY-MM-DD dates', async () => {
  const client = await pool.connect();
  let before;
  try {
    ({ before } = await applyWrites(client, [{ userId: otherUid, hireDate: '2025-09-09', historical: 4 }], { apply: false }));
  } finally { client.release(); }
  assert.equal(before.length, 1);
  assert.equal(before[0].userId, otherUid);
  assert.equal(before[0].hire_date, '2025-07-01');
  assert.equal(before[0].historical_events_worked, 1);
  assert.ok(!/,/.test(String(before[0].hire_date)), 'snapshot date must not contain a comma');
});

// The snapshot is taken in ONE pre-pass before any UPDATE. A per-row re-SELECT
// inside the transaction records an earlier row's write as a later row's "prior
// state", which silently corrupts the rollback file.
test('the before-snapshot is taken before any write, for every row', async () => {
  const client = await pool.connect();
  let before;
  try {
    await client.query('BEGIN');
    ({ before } = await applyWrites(client, [
      { userId: otherUid, hireDate: '2026-01-01', historical: 77 },
      { userId: blankUid, hireDate: '2026-02-02', historical: 88 },
    ], { apply: true }));
    await client.query('ROLLBACK');
  } finally { client.release(); }
  assert.deepEqual(before, [
    { userId: otherUid, hire_date: '2025-07-01', historical_events_worked: 1 },
    { userId: blankUid, hire_date: '2025-03-03', historical_events_worked: 2 },
  ]);
  // ROLLBACK means nothing landed.
  const o = await readProfile(otherUid);
  assert.equal(toYmd(o.hire_date), '2025-07-01');
  assert.equal(o.historical_events_worked, 1);
});

test('a blank proposed_hire_date leaves the stored hire_date and baseline intact', async () => {
  const csv = [HEADER, `Blank Date Vet,,12,${blankUid},Vet,approved,2025-03-03,,0,12,yes,`].join('\n');
  const rows = parseMappingRows(csv);
  const writes = planWrites(rows);
  assert.equal(writes.length, 0);
  assert.equal(planSkips(rows).length, 1);
  const client = await pool.connect();
  try {
    await applyWrites(client, writes, { apply: true });
  } finally { client.release(); }
  const r = await readProfile(blankUid);
  assert.equal(toYmd(r.hire_date), '2025-03-03', 'the stored hire_date survived');
  assert.equal(r.historical_events_worked, 2);
});

test('a matched user with no contractor profile is reported, never counted as written', async () => {
  const client = await pool.connect();
  let result;
  try {
    result = await applyWrites(client, [
      { userId: noProfileUid, hireDate: '2025-05-22', historical: 12 },
    ], { apply: true });
  } finally { client.release(); }
  assert.equal(result.changed, 0, 'the UPDATE matched no row');
  assert.deepEqual(result.missingProfile, [noProfileUid]);
  assert.equal(exitCodeFor({ apply: true, writeCount: 1, changed: result.changed, skippedCount: 0, missingCount: result.missingProfile.length }), 1);
});

// ── CLI: the operator-facing contract ──────────────────────────────
const SCRIPT = path.join(__dirname, 'applySeniorityBackfill.js');
function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : 0, stdout, stderr });
    });
  });
}

test('the CLI exits non-zero and names the id when an approved row has no contractor profile', async () => {
  const file = path.join(tmpDir, 'seniority-mapping.csv');
  fs.writeFileSync(file, [HEADER, `No Profile Vet,2025-05-22,12,${noProfileUid},Vet,approved,,2025-05-22,0,12,yes,`].join('\n') + '\n');
  const dry = await runCli(['--file', file]);
  assert.match(dry.stdout, /DRY-RUN/);
  assert.match(dry.stdout, new RegExp(`no contractor profile[^\\n]*${noProfileUid}`));
  assert.equal(dry.code, 1, 'a dry run that found unapplicable rows signals before --apply');

  const applied = await runCli(['--file', file, '--apply']);
  assert.match(applied.stdout, /APPLY/);
  assert.match(applied.stderr, /PARTIAL: 0 of 1 row\(s\) written/);
  assert.equal(applied.code, 1, 'the bulk writer must not report success');
});

// `--file=value` is the form config.js deliberately supports and every sibling
// script accepts. Ignoring it would silently fall back to the DEFAULT path,
// i.e. apply the generator's unreviewed output instead of the reviewed copy.
test('the CLI honors the --file=value form, not just --file value', async () => {
  const file = path.join(tmpDir, 'equals-form.csv');
  fs.writeFileSync(file, [HEADER, `Equals Form,2025-05-22,3,${uid},A,approved,,2025-05-22,0,3,yes,`].join('\n') + '\n');
  const { stdout, code } = await runCli([`--file=${file}`]);
  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`file=${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(stdout, /1 row\(s\) to write/);
});

test('the CLI banner names the target database and never leaks credentials', async () => {
  const file = path.join(tmpDir, 'banner.csv');
  fs.writeFileSync(file, `${HEADER}\n`);
  const { stdout, code } = await runCli(['--file', file]);
  assert.equal(code, 0);
  assert.match(stdout, /db=[^\s]+/);
  const pw = (() => { try { return new URL(process.env.DATABASE_URL).password; } catch { return ''; } })();
  if (pw) assert.ok(!stdout.includes(pw), 'the banner must never print the DB password');
});

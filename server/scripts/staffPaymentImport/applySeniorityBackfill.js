// Apply the HUMAN-APPROVED seniority mapping. Dry-run by default (prints the
// before→after per row, writes nothing); --apply performs the writes inside a
// transaction. Idempotent: an explicit SET to the approved values, so a second
// --apply run is a no-op. Only include=yes rows with a matched user are written.
//
// The mapping CSV is an UNTRUSTED input: it goes through a spreadsheet and a
// human before it reaches this script, so every cell that gets bound to a query
// is type-checked BEFORE coercion and a non-conforming cell aborts the whole run
// naming the row. Silent coercion is how a mangled export writes zeros over a
// real baseline.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const fs = require('fs');
const { parseCsv } = require('./parsers/csvUtil');
// Shared flag parser: honors BOTH `--file value` and `--file=value`, which is
// what every sibling in this directory uses. Hand-rolling `indexOf('--file')`
// would silently ignore the equals form and fall back to the DEFAULT path,
// i.e. apply the generator's unreviewed output instead of the reviewed copy.
const { getArg } = require('./config');

function expand(p) { return path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME || '~')); }

// Same helper as generateSeniorityMapping.js, duplicated rather than
// cross-imported so neither script depends on the other (the generator already
// duplicates csvCell from exportKnownPeople.js for the same reason). A pg DATE
// arrives as a Date at local midnight; String(...).slice(0,10) would write
// "Tue Jun 10" into the rollback snapshot below and quietly destroy the only
// artifact that makes an --apply run reversible.
function toYmd(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// Name the database that is about to be written, so a forgotten or stale
// DATABASE_URL is visible in the banner rather than discovered afterwards.
// Host + database name only, never the credentials in the URL's userinfo.
function dbTarget() {
  const url = process.env.DATABASE_URL;
  if (!url) return '(DATABASE_URL not set)';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

// Every header parseMappingRows reads, asserted BEFORE any row is parsed. A
// spreadsheet round-trip that renames or drops `proposed_historical` would
// otherwise leave every lookup returning '' and commit 0 over every baseline.
const REQUIRED_MAPPING_COLUMNS = ['cc_name', 'matched_user_id', 'proposed_hire_date', 'proposed_historical', 'include', 'flags'];
const MAX_HISTORICAL = 100000;   // the same ceiling the admin seniority route enforces

// Mirrors parseSeniorityInt in server/routes/admin/users.js: TYPE-CHECK BEFORE
// COERCION. parseInt('thirty-two') is NaN and `|| 0` turns that into a zero
// write; parseInt('12.9') is 12; Number('1e3') is 1000; Number(' ') is 0. Each
// writes a number nobody approved. A CSV cell is always a string, so the only
// accepted shape is a trimmed run of digits.
function parseMappingInt(raw, { label, max }) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`${label} must be a whole number of 0 or more, got ${JSON.stringify(raw)}`);
  }
  const n = Number(s);
  if (!Number.isInteger(n) || n > max) {
    throw new Error(`${label} must be between 0 and ${max}, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseMappingRows(csvText) {
  const records = parseCsv(csvText);
  if (!records.length || !records[0] || !records[0].some((c) => String(c).trim() !== '')) {
    throw new Error('Mapping file is empty: expected the generateSeniorityMapping.js header row plus one row per CheckCherry contact.');
  }
  const header = records[0].map((c) => c.trim());
  const missing = REQUIRED_MAPPING_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new Error(`Mapping file is missing required column(s): ${missing.join(', ')}. Found: ${header.join(', ')}. Re-export with generateSeniorityMapping.js; a spreadsheet round-trip has renamed or dropped columns.`);
  }
  const col = {}; header.forEach((n, i) => { col[n] = i; });
  const get = (r, name) => (col[name] !== undefined ? (r[col[name]] || '').trim() : '');

  return records.slice(1)
    .map((r, i) => ({ r, rowNumber: i + 2 }))          // +2: 1-based line number, past the header
    .filter(({ r }) => r.length && r.some((c) => String(c).trim() !== ''))
    .map(({ r, rowNumber }) => {
      const name = get(r, 'cc_name');
      const where = `row ${rowNumber} (${name || 'unnamed'})`;

      const rawInclude = get(r, 'include').toLowerCase();
      if (rawInclude !== 'yes' && rawInclude !== 'no') {
        throw new Error(`${where}: include must be exactly "yes" or "no", got ${JSON.stringify(get(r, 'include'))}`);
      }
      const include = rawInclude === 'yes';

      const rawId = get(r, 'matched_user_id');
      if (rawId && !/^\d+$/.test(rawId)) {
        throw new Error(`${where}: matched_user_id must be a whole number, got ${JSON.stringify(rawId)}`);
      }
      const userId = rawId ? Number(rawId) : null;

      const rawHire = get(r, 'proposed_hire_date');
      if (rawHire && !/^\d{4}-\d{2}-\d{2}$/.test(rawHire)) {
        throw new Error(`${where}: proposed_hire_date must be YYYY-MM-DD, got ${JSON.stringify(rawHire)}`);
      }

      // Only rows this run would actually write are held to the numeric
      // contract. An excluded row's cells are never bound to a query, and
      // being strict about them would block the run over a row the operator
      // already decided to leave out.
      const historical = (include && userId)
        ? parseMappingInt(get(r, 'proposed_historical'), { label: `${where}: proposed_historical`, max: MAX_HISTORICAL })
        : null;

      // `flags` is carried for operator-facing reporting and is deliberately
      // ADVISORY, never a write gate. Every flag that could corrupt a write is
      // already enforced structurally and does not depend on the cell's text:
      // duplicate-match by assertNoDuplicateUsers, unmatched by the missing
      // matched_user_id (such a row can never enter the write set),
      // no-proposed-date by planSkips. What is left (zero-events,
      // date-moves-later) describes legitimate decisions that are the human's
      // to make, and gating on the text would also fight the operator whenever
      // they resolve a flag by hand without clearing the cell.
      return { rowNumber, name, userId, hireDate: rawHire || null, historical, include, flags: get(r, 'flags') };
    });
}

// include=yes rows that resolved to an OS user. Writes and reported skips are a
// partition of this set.
function approvedRows(rows) {
  return rows.filter((r) => r.include && r.userId);
}

// Two mapping rows resolving to one OS user is exactly what the generator's
// duplicate-match flag warns about (RAW_ALIASES manufactures the case). Writing
// both means last-row-in-file silently wins, so refuse the whole run instead.
function assertNoDuplicateUsers(rows) {
  const seen = new Map();
  for (const r of rows) {
    const first = seen.get(r.userId);
    if (first) {
      throw new Error(`Duplicate matched_user_id ${r.userId}: row ${first.rowNumber} (${first.name}) and row ${r.rowNumber} (${r.name}) both write the same OS user. Resolve the duplicate-match in the mapping before applying.`);
    }
    seen.set(r.userId, r);
  }
}

function planWrites(rows) {
  const approved = approvedRows(rows);
  assertNoDuplicateUsers(approved);
  return approved.filter((r) => r.hireDate)
    .map((r) => ({ userId: r.userId, hireDate: r.hireDate, historical: r.historical }));
}

// Approved rows that cannot be written as-is. A blank proposed_hire_date is
// reachable straight from the generator (ccDateToIso returns '' for anything
// that is not MM-DD-YYYY, while include stays yes), and binding that empty
// string as NULL would wipe a stored hire_date. Such a row is skipped WHOLE and
// reported by name, so the stored values are kept, which is the posture the
// admin seniority route takes with COALESCE for an omitted field. Skipping the
// whole row also keeps the invariant that a mapping row is applied entirely or
// not at all, so the CSV always describes what is on disk.
function planSkips(rows) {
  return approvedRows(rows)
    .filter((r) => !r.hireDate)
    .map((r) => ({ rowNumber: r.rowNumber, userId: r.userId, name: r.name, reason: 'blank proposed_hire_date (stored hire_date and baseline kept)' }));
}

// A bulk writer must never report success for a partial run: anything the
// operator approved that did not land makes the process exit non-zero.
function exitCodeFor({ apply, writeCount, changed, skippedCount, missingCount }) {
  if (skippedCount > 0 || missingCount > 0) return 1;
  if (apply && changed !== writeCount) return 1;
  return 0;
}

// Read current state, print before->after for each row, and (when apply) UPDATE.
// Extracted + exported so a DB-backed test can drive it with an injected client.
// Returns { changed, before, missingProfile }; `before` snapshots prior values
// for the rollback file.
async function applyWrites(client, writes, { apply }) {
  const ids = writes.map((w) => w.userId);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) {
    throw new Error(`applyWrites received duplicate user id ${dup} in the write set; the rollback snapshot could not describe prior state.`);
  }

  // ONE pre-pass snapshot, taken BEFORE any UPDATE. Re-SELECTing per row inside
  // the transaction would record an earlier row's write as a later row's "prior
  // state" and hand back a rollback file that restores the wrong values.
  const prior = new Map();
  if (ids.length) {
    const res = await client.query(
      'SELECT user_id, hire_date, historical_events_worked FROM contractor_profiles WHERE user_id = ANY($1::int[])', [ids]);
    for (const row of res.rows) prior.set(row.user_id, row);
  }

  const before = [];
  const missingProfile = [];
  let changed = 0;
  for (const w of writes) {
    const b = prior.get(w.userId) || {};
    const priorHire = toYmd(b.hire_date);
    before.push({ userId: w.userId, hire_date: priorHire, historical_events_worked: b.historical_events_worked ?? '' });
    const absent = !prior.has(w.userId);
    if (absent) missingProfile.push(w.userId);
    console.log(`  user ${w.userId}: hire_date ${priorHire || '(unset)'} -> ${w.hireDate}, historical ${b.historical_events_worked ?? '(unset)'} -> ${w.historical}${absent ? '   [NO CONTRACTOR PROFILE - nothing will be written]' : ''}`);
    if (apply) {
      const res = await client.query(
        'UPDATE contractor_profiles SET hire_date = $1, historical_events_worked = $2 WHERE user_id = $3',
        [w.hireDate, w.historical, w.userId]);
      changed += res.rowCount;
    }
  }
  return { changed, before, missingProfile };
}

// The reporting + write body, split out so main stays readable.
async function reportAndWrite(client, writes, { apply, resolved, skipped }) {
  const { changed, before, missingProfile } = await applyWrites(client, writes, { apply });

  if (skipped.length) {
    console.log('[applySeniorityBackfill] SKIPPED (nothing written, stored values kept):');
    for (const s of skipped) console.log(`  row ${s.rowNumber} user ${s.userId} (${s.name}): ${s.reason}`);
  }
  if (missingProfile.length) {
    console.log(`[applySeniorityBackfill] SKIPPED (no contractor profile, nothing written): user id(s) ${missingProfile.join(', ')}`);
  }

  if (apply) {
    // Snapshot prior state for rollback (written before COMMIT; harmless on rollback).
    const backup = `${resolved.replace(/\.csv$/i, '')}.backup-${Date.now()}.csv`;
    fs.writeFileSync(backup, ['user_id,hire_date,historical_events_worked',
      ...before.map((r) => `${r.userId},${r.hire_date},${r.historical_events_worked}`)].join('\n') + '\n');
    console.log(`[applySeniorityBackfill] wrote ${changed} update(s). Prior state saved to ${backup}`);
  } else {
    console.log('[applySeniorityBackfill] dry-run only; pass --apply to write.');
  }
  return { changed, missingProfile };
}

async function main() {
  const argv = process.argv.slice(2);
  const file = getArg(argv, '--file')
    || path.join(process.env.HOME || '.', 'win-share/payments/review/seniority-mapping.csv');
  const apply = argv.includes('--apply');
  const resolved = expand(file);
  const rows = parseMappingRows(fs.readFileSync(resolved, 'utf8'));
  const writes = planWrites(rows);
  const skipped = planSkips(rows);

  const { pool } = require('../../db');
  console.log(`[applySeniorityBackfill] ${apply ? 'APPLY' : 'DRY-RUN'}  file=${resolved}  db=${dbTarget()}`);
  console.log(`[applySeniorityBackfill] ${writes.length} row(s) to write, ${skipped.length} approved row(s) skipped`);
  let changed = 0;
  let missingProfile = [];
  const client = await pool.connect();
  try {
    if (apply) await client.query('BEGIN');
    ({ changed, missingProfile } = await reportAndWrite(client, writes, { apply, resolved, skipped }));
    if (apply) await client.query('COMMIT');
  } catch (err) {
    if (apply) {
      // Its own try: a dead connection here must not replace the real failure.
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error(`[applySeniorityBackfill] ROLLBACK also failed: ${rollbackErr.message}`);
      }
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }

  const code = exitCodeFor({ apply, writeCount: writes.length, changed, skippedCount: skipped.length, missingCount: missingProfile.length });
  if (code !== 0) {
    const unapplied = skipped.length + missingProfile.length;
    console.error(apply
      ? `[applySeniorityBackfill] PARTIAL: ${changed} of ${writes.length} row(s) written. The committed writes stand, but ${unapplied} approved row(s) never landed. Fix the mapping and re-run.`
      : `[applySeniorityBackfill] ${unapplied} approved row(s) could NOT be applied. Fix the mapping before running with --apply.`);
  }
  return code;
}

if (require.main === module) {
  main().then((code) => process.exit(code))
    .catch((err) => { console.error('[applySeniorityBackfill] failed:', err.message); process.exit(1); });
}

module.exports = {
  parseMappingRows, planWrites, planSkips, applyWrites, toYmd, exitCodeFor,
  REQUIRED_MAPPING_COLUMNS,
};

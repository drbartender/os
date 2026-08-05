// READ-ONLY generator: CheckCherry contacts × OS staff → a human-review CSV of
// proposed hire_date + historical_events_worked. Run exportKnownPeople.js first
// (it writes <review-dir>/known-people.csv). This script only READS the DB
// (current hire_date + live event count per matched user); it writes no rows.
//
// Usage:
//   DATABASE_URL=... node server/scripts/staffPaymentImport/exportKnownPeople.js --review-dir DIR
//   DATABASE_URL=... node server/scripts/staffPaymentImport/generateSeniorityMapping.js \
//     --review-dir DIR --contacts ~/win-share/payments/cc-report-contacts.csv
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const fs = require('fs');
const { pool } = require('../../db');
const { parseCsv } = require('./parsers/csvUtil');
const { buildDictionary } = require('./dictionary');
const { ccDateToIso } = require('./ccReports');
// Shared flag parser: honors BOTH `--flag value` and `--flag=value`, which is
// what every sibling in this directory uses. Hand-rolling `indexOf(flag)` would
// silently ignore the equals form and fall back to the default path.
const { getArg } = require('./config');
function expand(p) { return path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME || '~')); }
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// A DATE column comes back from `pg` as a JS Date at LOCAL midnight, and
// `String(thatDate).slice(0,10)` is "Tue Jun 10", not "2025-06-10". Use the
// codebase's idiom (server/utils/paystubData.js:20, admin/payroll.js:129):
// branch on `instanceof Date` and go through toISOString. Chicago is behind
// UTC, so local midnight lands at 05:00/06:00Z on the SAME calendar day and
// the YMD round-trips exactly. Strings pass through untouched.
function toYmd(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
// Name the database being read, so a forgotten or stale DATABASE_URL is visible
// in the banner. Host + database name only, never the URL's credentials.
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
const STAFF_ROLE = /bartender|barback|server|staff|manager|captain/i;
const ACTIVE_STATUS = new Set(['approved', 'hired']);
const MAPPING_COLUMNS = ['cc_name', 'cc_created_date', 'cc_events', 'matched_user_id', 'os_preferred_name', 'onboarding_status', 'current_hire_date', 'proposed_hire_date', 'current_live_events', 'proposed_historical', 'include', 'flags'];

// Pure: given a CC contact and its matched OS current-state, produce the review
// row (include default + flags). Exported for unit testing.
function shapeMappingRow({ name, created, events, matchedUserId, onboardingStatus, current = {}, dupCount = 1 }) {
  // toYmd, NOT String(...).slice(0,10): `current` is a raw pg row, so hire_date
  // is a Date object. Getting this wrong does not throw — it silently produces
  // "Tue Jun 10", which then loses every `date-moves-later` string comparison
  // below ('2' < 'T'), so the spec §4 tenure-shortening flag would never fire
  // for a single real row while the pure unit tests (which pass strings) stayed
  // green. See the toYmd/pg-Date tests for the regression that pins this.
  const curHire = toYmd(current.hire_date);
  const flags = [];
  if (!matchedUserId) flags.push('unmatched');
  if (matchedUserId && dupCount > 1) flags.push('duplicate-match');
  if (events === 0) flags.push('zero-events');
  // A proposed date LATER than the stored hire_date would SHORTEN the
  // person's tenure, and computeSeniorityScore ranks on tenure — so an
  // unreviewed date-moves-later row demotes them in every auto-assign pick.
  // The backfill exists to CREDIT pre-migration tenure; a row that reduces it
  // is almost certainly a bad match, so it defaults OUT of the run like an
  // unmatched row does. The operator can still flip include to yes by hand
  // after looking at it — that is the review the flag exists to force.
  const dateMovesLater = Boolean(curHire && created && created > curHire);
  if (dateMovesLater) flags.push('date-moves-later');
  // A missing or unparseable CheckCherry "Created At" leaves `created` empty
  // (the call site in main() blanks anything that is not strict YYYY-MM-DD,
  // and the column is absent entirely from some exports). Proposing an empty
  // hire date on an include=yes row would push the whole decision onto the
  // apply script's skip guard, where the human never sees it. Fail safe the
  // same way an unmatched row does: flag it AND default it out of the run.
  if (!created) flags.push('no-proposed-date');
  return {
    cc_name: name, cc_created_date: created, cc_events: events,
    matched_user_id: matchedUserId || '', os_preferred_name: current.preferred_name || '',
    onboarding_status: onboardingStatus, current_hire_date: curHire, proposed_hire_date: created,
    current_live_events: current.live_events || 0, proposed_historical: events,
    include: matchedUserId && created && !dateMovesLater && ACTIVE_STATUS.has(onboardingStatus) ? 'yes' : 'no',
    flags: flags.join('|'),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const reviewDir = expand(getArg(argv, '--review-dir') || path.join(process.env.HOME || '.', 'win-share/payments/review'));
  const contactsPath = expand(getArg(argv, '--contacts') || path.join(process.env.HOME || '.', 'win-share/payments/cc-report-contacts.csv'));
  const knownPeopleCsv = path.join(reviewDir, 'known-people.csv');
  const outPath = path.join(reviewDir, 'seniority-mapping.csv');
  if (!fs.existsSync(knownPeopleCsv)) {
    throw new Error(`Missing ${knownPeopleCsv}. Run exportKnownPeople.js --review-dir first.`);
  }
  if (!fs.existsSync(contactsPath)) {
    throw new Error(`Missing CheckCherry contacts CSV: ${contactsPath} (pass --contacts).`);
  }
  // The mapping is hand-reviewed (include toggles, corrected matches) between
  // generation and apply. A bare re-run would silently destroy that review, so
  // refuse unless the operator says to. Checked before any work is done.
  if (fs.existsSync(outPath) && !process.argv.includes('--force')) {
    throw new Error(`${outPath} already exists and may hold hand-review edits. Move it aside, or pass --force to overwrite.`);
  }
  console.log(`[generateSeniorityMapping] review-dir=${reviewDir}  contacts=${contactsPath}  db=${dbTarget()}`);

  // Name→OS matching via the shared cluster dictionary (carries osUserId + status).
  const dict = buildDictionary({ knownPeopleCsv, ccContactsCsv: contactsPath });

  // Read the CC contacts CSV directly for the seniority fields.
  const records = parseCsv(fs.readFileSync(contactsPath, 'utf8'));
  const header = records[0].map((c) => c.trim());
  const col = {}; header.forEach((n, i) => { col[n] = i; });
  const get = (r, name) => (col[name] !== undefined ? (r[col[name]] || '').trim() : '');

  const contacts = records.slice(1).filter((r) => r.length).map((r) => ({
    // ccDateToIso passes a NON-matching value through verbatim (that is right
    // for its money-path callers, where a mangled date must surface loudly,
    // not vanish). Here a non-ISO leftover must read as "no date" so the
    // no-proposed-date flag fires and the row defaults OUT of the run —
    // otherwise a garbage Created At becomes a truthy proposed_hire_date and
    // only the apply script's regex catches it, out of the operator's sight.
    created: ((v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''))(ccDateToIso(get(r, 'Created At'))),
    name: get(r, 'Name') || `${get(r, 'First Name')} ${get(r, 'Last Name')}`.trim(),
    // Locale exports write "1,234"; bare parseInt reads that as 1 and proposes
    // a plausible-looking tiny baseline. Strip ONLY digit-grouping commas,
    // then parse; anything still non-numeric falls to 0 and trips the
    // zero-events flag instead of writing a number nobody approved.
    events: parseInt((get(r, 'Staff Events: Count') || '0').replace(/,(?=\d{3}\b)/g, ''), 10) || 0,
    roles: get(r, 'Roles'),
  })).filter((c) => c.name && (STAFF_ROLE.test(c.roles) || c.events > 0));

  // Resolve each contact → OS cluster → user id + onboarding status.
  const rows = contacts.map((c) => {
    const key = dict.resolve(c.name);
    const cluster = key ? dict.getCluster(key) : null;
    return {
      ...c,
      matched_user_id: cluster?.osUserId || null,
      onboarding_status: cluster?.onboardingStatus || '',
    };
  });

  // One DB read for current hire_date + live event count per matched user.
  const ids = [...new Set(rows.map((r) => r.matched_user_id).filter(Boolean))];
  const cur = new Map();
  if (ids.length) {
    const q = await pool.query(`
      SELECT cp.user_id, cp.preferred_name, cp.hire_date,
             (SELECT COUNT(*) FROM shift_requests sr JOIN shifts s ON s.id = sr.shift_id
               WHERE sr.user_id = cp.user_id AND sr.status = 'approved'
                 AND sr.dropped_at IS NULL AND s.event_date < CURRENT_DATE) AS live_events
      FROM contractor_profiles cp WHERE cp.user_id = ANY($1)
    `, [ids]);
    for (const row of q.rows) cur.set(row.user_id, row);
  }

  // Duplicate-match detection: two CC contacts resolve to one OS user.
  const idCounts = {};
  for (const r of rows) if (r.matched_user_id) idCounts[r.matched_user_id] = (idCounts[r.matched_user_id] || 0) + 1;

  const shapedRows = rows.map((r) => shapeMappingRow({
    name: r.name, created: r.created, events: r.events,
    matchedUserId: r.matched_user_id, onboardingStatus: r.onboarding_status,
    current: cur.get(r.matched_user_id) || {}, dupCount: idCounts[r.matched_user_id] || 0,
  }));
  const lines = shapedRows.map((shaped) => MAPPING_COLUMNS.map((k) => csvCell(shaped[k])).join(','));

  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(outPath, `${MAPPING_COLUMNS.join(',')}\n${lines.join('\n')}\n`);
  console.log(`[generateSeniorityMapping] wrote ${lines.length} rows -> ${outPath}`);
  // Counted off the shaped rows, not a ',yes,' substring scan of the rendered
  // line, which any cell containing that text would inflate.
  console.log(`  matched: ${rows.filter((r) => r.matched_user_id).length}, default-include: ${shapedRows.filter((s) => s.include === 'yes').length}`);
}

if (require.main === module) {
  main().then(() => pool.end()).then(() => process.exit(0))
    .catch((err) => { console.error('[generateSeniorityMapping] failed:', err.message); process.exit(1); });
}

module.exports = { shapeMappingRow, MAPPING_COLUMNS, toYmd };

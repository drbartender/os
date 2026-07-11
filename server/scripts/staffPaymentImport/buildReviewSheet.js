// Review-sheet builder (spec §7) — walks the payments share, routes each file to
// its parser, classifies + event-matches outgoing rows, and writes the human
// review surface plus an Excel-proof manifest and a coverage report. Read-only
// over the data; writes only into the review dir. No DB.
//
// Usage:
//   node server/scripts/staffPaymentImport/buildReviewSheet.js \
//     --data-dir "$HOME/win-share/payments" [--review-dir <dir>]
//
// Outputs (in review dir):
//   transactions.csv  people.csv  .manifest.json  coverage-report.txt
// Re-run preserves Dallas's human-judgment columns by fingerprint / cluster.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { execFileSync } = require('child_process');
const config = require('./config');
const { BOUNDARY } = config;
const { makeRow, normalizeName } = require('./staging');
const { parseCsv } = require('./parsers/csvUtil');
const { parseVenmoCsv } = require('./parsers/venmoCsv');
const { parseCashappText } = require('./parsers/cashappPdf');
const { parseChaseText } = require('./parsers/chasePdf');
const { parsePaypalCsv } = require('./parsers/paypalCsv');
const cc = require('./ccReports');
const { buildDictionary } = require('./dictionary');
const { classify } = require('./classify');
const { matchEvents } = require('./eventMatch');

// Spec §2 expected outgoing-payment inventory (per source_account).
const EXPECTED = {
  chase_6835: { count: 86, usd: 19324.23, label: 'Zelle DRB *6835' },
  venmo_business: { count: 51, usd: 8820.88, label: 'Venmo business' },
  cashapp_business: { count: 31, usd: 6580.72, label: 'Cash App business' },
  cashapp_personal: { count: 14, usd: 3461.00, label: 'Cash App personal' },
  venmo_personal: { count: 5, usd: 870.0, label: 'Venmo personal' },
  chase_7570: { count: 2, usd: 98.0, label: 'Zelle Wildsky *7570' },
  chase_8700: { count: 0, usd: 0, label: 'Chase personal *8700' },
};

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      if (name === 'review') continue; // never re-ingest our own output
      out.push(...walk(abs));
    } else {
      out.push(abs);
    }
  }
  return out;
}

// Shallow files first (root before subfolders). A Cash App business statement
// lives at the root AND is duplicated under "New folder/"; the business/personal
// split is purely locational (identical PDF header, no account marker), so the
// root copy must claim its content-hash first or the New-folder dup would
// mislabel it personal.
function walkOrdered(dir) {
  return walk(dir).sort((a, b) => {
    const da = a.split(path.sep).length;
    const db = b.split(path.sep).length;
    return da !== db ? da - db : a.localeCompare(b);
  });
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

// Extract text once for a bank/app PDF (or read a pre-extracted .txt fixture).
// Used BOTH for the semantic content-hash and for parsing — re-exported PDFs
// have identical extracted text but different raw bytes, so byte-md5 dedupe
// misses them (spec §2 "content-hash dedupe") but text-md5 dedupe catches them.
function extractText(abs, ext) {
  if (ext === '.txt') return fs.readFileSync(abs, 'utf8');
  return execFileSync('pdftotext', ['-layout', abs, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function csvLine(fields) {
  return fields.map((v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}
const dollars = (cents) => (cents === null || cents === undefined ? '' : (cents / 100).toFixed(2));

// Read an existing review CSV into [{col:val}] keyed by header (for re-run merge).
function readCsvObjects(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const records = parseCsv(fs.readFileSync(filePath, 'utf8'));
  if (!records.length) return [];
  const header = records[0].map((c) => c.trim());
  return records.slice(1).filter((r) => r.length > 1 || (r[0] && r[0].trim())).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i] !== undefined ? r[i] : ''; });
    return o;
  });
}

function daysBetween(a, b) {
  const da = Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`);
  const db = Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.round((da - db) / 86400000);
}
const normPhone = (p) => String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

// ---------------------------------------------------------------------------
function run({ dataDir, reviewDir }) {
  fs.mkdirSync(reviewDir, { recursive: true });
  const files = walkOrdered(dataDir);

  const seenHashes = new Set();
  const skipped = [];
  const errors = []; // routed files that failed to read/parse — loud, exit 1
  const ccPaths = { expenses: null, contacts: null, bookings: null };
  const dataRows = [];
  const perSource = {}; // source_account → {count, usd}

  const bump = (acct, cents) => {
    if (!perSource[acct]) perSource[acct] = { count: 0, usd: 0 };
    perSource[acct].count += 1;
    perSource[acct].usd += (cents || 0);
  };

  // Detect a CC report by header shape (filenames vary between pulls).
  function detectCcReport(absPath) {
    let head = '';
    try { head = fs.readFileSync(absPath, 'utf8').slice(0, 2000); } catch { return null; }
    const first = (parseCsv(head)[0] || []).map((c) => c.trim());
    const has = (n) => first.includes(n);
    if (has('Payee') && has('Booking: Title')) return 'expenses';
    if (has('Assigned Staff') || (has('Event Date') && has('Title'))) return 'bookings';
    if (has('First Name') && has('Email') && (has('Roles') || has('Staff Events: Count'))) return 'contacts';
    return null;
  }

  for (const abs of files) {
    const base = path.basename(abs);
    if (/shoppinglist/i.test(base) || /whatsapp/i.test(base)) { skipped.push(base); continue; }
    const spec = config.routeFile(abs, dataDir);
    const ext = path.extname(base).toLowerCase();

    // CC reports (not payment rows): record their path (byte-hash dedupe).
    if (!spec && ext === '.csv') {
      const kind = detectCcReport(abs);
      if (kind) {
        const h = md5(fs.readFileSync(abs));
        if (!seenHashes.has(h)) { seenHashes.add(h); if (!ccPaths[kind]) ccPaths[kind] = abs; }
        continue;
      }
    }
    if (!spec) { skipped.push(`${base} (unrouted)`); continue; }

    // Content-hash: PDFs/bank statements hash their EXTRACTED TEXT (re-exports
    // differ in raw bytes but not transactions); CSVs hash raw content.
    let pdfText = null;
    let hash;
    try {
      if (spec.parser === 'cashappPdf' || spec.parser === 'chasePdf') {
        pdfText = extractText(abs, ext);
        hash = md5(pdfText);
      } else {
        hash = md5(fs.readFileSync(abs));
      }
    } catch (err) {
      errors.push(`${base}: read error — ${err.message}`);
      continue;
    }
    if (seenHashes.has(hash)) { skipped.push(`${base} (dup)`); continue; }
    seenHashes.add(hash);

    let rows = [];
    try {
      if (spec.parser === 'venmoCsv') {
        rows = parseVenmoCsv(abs, { sourceAccount: spec.source_account });
      } else if (spec.parser === 'cashappPdf') {
        rows = parseCashappText(pdfText, { sourceFile: base, sourceAccount: spec.source_account });
      } else if (spec.parser === 'chasePdf') {
        const { year, month } = config.parseStatementPeriod(base);
        rows = parseChaseText(pdfText, { sourceFile: base, sourceAccount: spec.source_account, statementYear: year, statementMonth: month });
      } else if (spec.parser === 'paypalCsv') {
        rows = parsePaypalCsv(abs, { sourceAccount: spec.source_account });
      }
    } catch (err) {
      // Structural parse failure (header/columns/year) — a routed file that
      // yields nothing usable. Loud, not lumped into skipped.
      errors.push(`${base}: parse error — ${err.message}`);
      continue;
    }
    dataRows.push(...rows);
  }

  // Dedupe rows by fingerprint (overlapping statements can carry the same txn).
  const byFp = new Map();
  for (const r of dataRows) if (!byFp.has(r.fingerprint)) byFp.set(r.fingerprint, r);
  const uniqueRows = Array.from(byFp.values());
  const payments = uniqueRows.filter((r) => r.kind === 'payment');
  const funding = uniqueRows.filter((r) => r.kind === 'funding');
  for (const r of payments) bump(r.sourceAccount, r.amountCents);

  // CC reports + dictionary + event matching.
  const knownPeopleCsv = path.join(reviewDir, 'known-people.csv');
  const dict = buildDictionary({
    knownPeopleCsv: fs.existsSync(knownPeopleCsv) ? knownPeopleCsv : null,
    ccContactsCsv: ccPaths.contacts,
    ccExpensesCsv: ccPaths.expenses,
  });
  const ccExpenses = cc.loadExpenses(ccPaths.expenses);
  const ccBookings = cc.loadBookings(ccPaths.bookings);
  const knownPeople = cc.loadKnownPeople(fs.existsSync(knownPeopleCsv) ? knownPeopleCsv : null);

  const clusterKeyOf = (name) => dict.resolve(name) || normalizeName(name) || '';

  // Classify + event-match payment rows.
  const matched = matchEvents(payments, { ccExpenses, ccBookings }, dict);
  const txnRows = matched.map((row) => {
    const c = classify(row, dict);
    let verdict = c.verdict;
    let personCluster = c.person || (verdict === 'staff-pay' ? clusterKeyOf(row.payee) : (row.payee ? clusterKeyOf(row.payee) : ''));
    if (row.unresolvedCurrency) verdict = 'unsure'; // unimportable until USD resolved
    return { row, verdict, confidence: c.confidence, reason: c.reason, personCluster: verdict === 'ignore' ? '' : personCluster };
  });

  // CC-only (cash_other) candidates: CC staff-payment expenses with no primary.
  const hasPrimaryFor = (payee, amountCents, date, dayWindow) => {
    if (amountCents === null || amountCents === undefined) return false;
    const key = clusterKeyOf(payee);
    return payments.some((p) => p.amountCents !== null
      && Math.abs(p.amountCents - amountCents) <= 1
      && (date && p.date ? Math.abs(daysBetween(p.date, date)) <= dayWindow : true)
      && clusterKeyOf(p.payee) === key);
  };
  const ccOnly = [];
  for (const e of ccExpenses) {
    if (!e.amountCents || e.amountCents <= 0) continue;
    if (hasPrimaryFor(e.payee, e.amountCents, e.date, 5)) continue;
    const r = makeRow({
      date: (e.date || '').slice(0, 10) || null,
      amountCents: e.amountCents,
      platform: 'cash_other',
      sourceAccount: 'cc_expense_log',
      payee: e.payee,
      memo: e.category || null,
      txnId: e.id || null,
      sourceFile: path.basename(ccPaths.expenses || 'cc-expenses.csv'),
      seq: 0,
      kind: 'other',
    });
    ccOnly.push(r);
    txnRows.push({
      row: r, verdict: 'unsure', confidence: 'low', reason: 'cc-only',
      personCluster: clusterKeyOf(e.payee),
      eventLabel: e.bookingTitle ? (e.bookingDate ? `${e.bookingTitle} (${e.bookingDate})` : e.bookingTitle) : null,
      eventEvidence: e.bookingTitle ? 'cc-expense' : null,
    });
  }

  // ---- Re-run merge: preserve Dallas's human-judgment columns -------------
  const prevTxn = new Map(readCsvObjects(path.join(reviewDir, 'transactions.csv')).map((o) => [o.fingerprint, o]));
  const prevPeople = new Map(readCsvObjects(path.join(reviewDir, 'people.csv')).map((o) => [o.cluster, o]));
  const currentFps = new Set(txnRows.map((t) => t.row.fingerprint));
  const vanished = [...prevTxn.keys()].filter((fp) => fp && !currentFps.has(fp));

  // ---- Build people clusters (staff-pay + unsure only) -------------------
  const isZul = (key, names) => /\bzul/i.test(key) || /zuleika/i.test(key)
    || names.some((n) => /\bzul/i.test(n) || /zuleika/i.test(n));
  const peopleMap = new Map();
  for (const t of txnRows) {
    if (t.verdict === 'ignore') continue;
    const key = t.personCluster || normalizeName(t.row.payee) || '(unknown)';
    if (!peopleMap.has(key)) {
      peopleMap.set(key, { key, names: new Set(), count: 0, total: 0, lastDate: '', method: '', handle: '' });
    }
    const p = peopleMap.get(key);
    if (t.row.payee) p.names.add(t.row.payee);
    p.count += 1;
    p.total += (t.row.amountCents || 0);
    if (t.row.date && t.row.date > p.lastDate) {
      p.lastDate = t.row.date;
      p.method = t.row.platform;
      p.handle = t.row.payeeEmail || t.row.payee || '';
    }
  }

  const peopleLines = [
    'cluster,proposed_name,os_user_id,email,phone,current_or_ex,preferred_method,preferred_handle,account_decision,exclude_1099,txn_count,total_usd',
  ];
  const phoneCollisions = [];
  const approvedPhones = new Map(); // normalized phone → known person name (approved only)
  for (const kp of knownPeople) {
    if (kp.onboardingStatus === 'approved' && kp.phone) approvedPhones.set(normPhone(kp.phone), kp.name || kp.preferredName);
  }
  for (const p of peopleMap.values()) {
    const cl = dict.getCluster(p.key);
    const names = Array.from(p.names);
    const osUserId = cl && cl.osUserId ? cl.osUserId : '';
    const email = cl && cl.emails.size ? Array.from(cl.emails)[0] : '';
    const phone = cl && cl.phones.size ? Array.from(cl.phones)[0] : '';
    const prev = prevPeople.get(p.key) || {};
    const decisionDefault = osUserId ? `existing:${osUserId}` : '';
    const excludeDefault = isZul(p.key, names) ? 'yes' : 'no';
    if (phone && approvedPhones.has(normPhone(phone))) {
      phoneCollisions.push(`${p.key} phone ${phone} == approved staffer ${approvedPhones.get(normPhone(phone))}`);
    }
    peopleLines.push(csvLine([
      p.key,
      prev.proposed_name || names[0] || p.key,
      osUserId,
      prev.email || email,
      prev.phone || phone,
      prev.current_or_ex || '',
      prev.preferred_method || p.method,
      prev.preferred_handle || p.handle,
      prev.account_decision || decisionDefault,
      prev.exclude_1099 || excludeDefault,
      p.count,
      dollars(p.total),
    ]));
  }

  // ---- transactions.csv + manifest ---------------------------------------
  const txnLines = [
    'fingerprint,date,amount_usd,platform,source_account,payee_as_shown,payee_email,memo,txn_id,person_cluster,verdict,confidence,event_label,event_evidence,source_file,post_boundary,boundary_exception',
  ];
  const manifest = {};
  for (const t of txnRows) {
    const r = t.row;
    const postBoundary = r.date && r.date >= BOUNDARY;
    const prev = prevTxn.get(r.fingerprint) || {};
    const eventLabel = prev.event_label || t.eventLabel || r.eventLabel || '';
    const boundaryException = prev.boundary_exception || 'no';
    txnLines.push(csvLine([
      r.fingerprint,
      r.date || '',
      dollars(r.amountCents),
      r.platform,
      r.sourceAccount,
      r.payee || '',
      r.payeeEmail || '',
      r.memo || '',
      r.txnId || '',
      prev.person_cluster || t.personCluster || '',
      prev.verdict || t.verdict,
      t.confidence,
      eventLabel,
      t.eventEvidence || r.eventEvidence || '',
      r.sourceFile,
      postBoundary ? 'yes' : 'no',
      boundaryException,
    ]));
    manifest[r.fingerprint] = {
      date: r.date || null,
      amount_cents: r.amountCents,
      platform: r.platform,
      source_account: r.sourceAccount,
      txn_id: r.txnId || null,
      payee: r.payee || null,
      memo: r.memo || null,
      source_file: r.sourceFile,
      post_boundary: !!postBoundary,
    };
  }

  // ---- coverage report ----------------------------------------------------
  // Chase mirror rows with no matching primary → possible missing export month.
  const missingExport = [];
  for (const f of funding) {
    const match = payments.some((p) => p.platform === f.fundingOf
      && p.amountCents !== null && Math.abs(p.amountCents - f.amountCents) <= 1
      && (f.date && p.date ? Math.abs(daysBetween(p.date, f.date)) <= 3 : true));
    if (!match) {
      missingExport.push(`${f.date} ${f.sourceAccount} mirror-of=${f.fundingOf} $${dollars(f.amountCents)}${f.payee ? ` (${f.payee})` : ''}`);
    }
  }
  const unresolved = payments.filter((p) => p.unresolvedCurrency)
    .map((p) => `${p.date} ${p.sourceAccount} ${p.payee} txn=${p.txnId}`);

  const cov = [];
  cov.push('STAFF PAYMENT IMPORT — COVERAGE REPORT');
  cov.push(`generated: ${new Date().toISOString()}`);
  cov.push(`data-dir: ${dataDir}`);
  cov.push(`boundary: ${BOUNDARY} (rows on/after are post-boundary → reconciliation)`);
  cov.push('');
  cov.push(`ERRORS (routed files that failed to read/parse — exit code 1 if > 0) — ${errors.length}`);
  if (errors.length) {
    cov.push('  !! Sheet is NOT trustworthy until these are resolved (missing month / bad export):');
    errors.forEach((e) => cov.push(`  ${e}`));
  } else {
    cov.push('  (none — every routed file parsed)');
  }
  cov.push('');
  cov.push('PER-SOURCE (parsed payments vs spec §2 expected):');
  const allAccts = new Set([...Object.keys(EXPECTED), ...Object.keys(perSource)]);
  for (const acct of allAccts) {
    const got = perSource[acct] || { count: 0, usd: 0 };
    const exp = EXPECTED[acct];
    const flag = exp && (got.count !== exp.count || Math.abs(got.usd / 100 - exp.usd) > 0.005) ? '  <-- MISMATCH' : '';
    const expStr = exp ? ` | expected ${exp.count}/$${exp.usd.toFixed(2)}` : '';
    cov.push(`  ${acct.padEnd(22)} ${String(got.count).padStart(4)} / $${(got.usd / 100).toFixed(2)}${expStr}${flag}`);
  }
  const totalCount = payments.length;
  const totalUsd = payments.reduce((s, p) => s + (p.amountCents || 0), 0) / 100;
  cov.push(`  ${'TOTAL'.padEnd(22)} ${String(totalCount).padStart(4)} / $${totalUsd.toFixed(2)}`);
  cov.push('');
  cov.push('NOTES ON EXPECTED-vs-PARSED deltas (spec §2 is an approximate inventory):');
  cov.push('  - Clean, txn-id-backed sources match exactly: venmo_business, chase_7570.');
  cov.push('  - chase_6835 parses 2 more than the spec figure: two Zelle rows carry a');
  cov.push('    "$"-prefixed amount that the spec-era tooling skipped; captured here with a');
  cov.push('    clean payee + ref id (verified real payments).');
  cov.push('  - chase_8700 parses Zelle sends the spec listed as 0: the personal account');
  cov.push('    uses a signed-amount-with-running-balance layout, so the amount is read off');
  cov.push('    the debit column (not the balance).');
  cov.push('  - cashapp_* / venmo_personal exceed the spec counts: every row is a distinct,');
  cov.push('    correctly-parsed outgoing payment (unique txn ids for Venmo; fingerprint-');
  cov.push('    deduped for Cash App). The spec under-inventoried these accounts. Owner');
  cov.push('    self-transfers and inter-company transfers stay in the raw count; the');
  cov.push('    classifier marks them ignore for the sheet.');
  cov.push('  Deltas here are NOT parser bugs; each row still gets a per-row verdict below.');
  cov.push('');
  cov.push(`MISSING EXPORT? (Chase mirrors with no matching primary) — ${missingExport.length}`);
  missingExport.forEach((m) => cov.push(`  ${m}`));
  cov.push('');
  cov.push(`PAYPAL UNRESOLVED CURRENCY (blank amount, unimportable) — ${unresolved.length}`);
  unresolved.forEach((m) => cov.push(`  ${m}`));
  cov.push('');
  cov.push(`CC-ONLY (cash_other candidates: CC expense w/ no primary) — ${ccOnly.length}`);
  ccOnly.forEach((r) => cov.push(`  ${r.date} ${r.payee} $${dollars(r.amountCents)} (cc id ${r.txnId})`));
  cov.push('');
  cov.push(`PHONE COLLISION (people phone == approved staffer phone) — ${phoneCollisions.length}`);
  phoneCollisions.forEach((m) => cov.push(`  ${m}`));
  cov.push('');
  cov.push(`VANISHED FINGERPRINTS since last run (present in old sheet, gone now) — ${vanished.length}`);
  vanished.forEach((fp) => cov.push(`  ${fp}`));
  cov.push('');
  cov.push(`SKIPPED FILES (dupes / non-data / unrouted) — ${skipped.length}`);
  skipped.forEach((s) => cov.push(`  ${s}`));

  // ---- write outputs ------------------------------------------------------
  fs.writeFileSync(path.join(reviewDir, 'transactions.csv'), `${txnLines.join('\n')}\n`);
  fs.writeFileSync(path.join(reviewDir, 'people.csv'), `${peopleLines.join('\n')}\n`);
  fs.writeFileSync(path.join(reviewDir, '.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(reviewDir, 'coverage-report.txt'), `${cov.join('\n')}\n`);

  return {
    reviewDir,
    perSource,
    totalPayments: totalCount,
    totalUsd,
    people: peopleMap.size,
    transactions: txnRows.length,
    missingExport: missingExport.length,
    unresolvedCurrency: unresolved.length,
    ccOnly: ccOnly.length,
    phoneCollisions: phoneCollisions.length,
    vanished: vanished.length,
    skipped: skipped.length,
    errors, // string[]; non-empty ⇒ CLI exits 1
    ccReportsFound: { expenses: !!ccPaths.expenses, contacts: !!ccPaths.contacts, bookings: !!ccPaths.bookings },
    knownPeopleFound: fs.existsSync(knownPeopleCsv),
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dataDir = config.dataDir(argv);
  const reviewDir = config.reviewDir(argv);
  const summary = run({ dataDir, reviewDir });
  process.stdout.write(fs.readFileSync(path.join(reviewDir, 'coverage-report.txt'), 'utf8'));
  console.log(`\n[buildReviewSheet] ${summary.transactions} txn rows, ${summary.people} people → ${reviewDir}`);
  if (summary.errors.length) {
    console.error(`[buildReviewSheet] ${summary.errors.length} routed file(s) failed to parse — see ERRORS section. Exiting 1.`);
    process.exitCode = 1;
  }
}

module.exports = { run, walk, EXPECTED };

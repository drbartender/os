// Transactional import of the reviewed sheet → users + profiles + ledger, in ONE
// BEGIN/COMMIT (spec §6/§7, plan C2). DRY-RUN by DEFAULT: it does the full write
// inside a transaction, prints the write plan + per-person/per-year totals, then
// ROLLBACKs. Pass --execute to COMMIT. No email/SMS/activity writes — created
// users are silent (spec §6); the claim path is the existing forgot-password flow.
//
// Usage (borrow os/.env for DATABASE_URL against the SHARED DEV DB):
//   DOTENV_CONFIG_PATH=/home/drbartender/projects/os/.env node -r dotenv/config \
//     server/scripts/staffPaymentImport/importFromSheet.js \
//     --review-dir <dir> [--execute] [--operator <name>]
//
// Reads FACTS from <review-dir>/.manifest.json and only human-judgment columns
// from people.csv / transactions.csv (Excel-proofing §7.3). Idempotent: a re-run
// on unchanged input inserts ZERO ledger rows; attribution fixes (contractor_id/
// event_label/memo) propagate via ON CONFLICT DO UPDATE (spec §5).
//
// Path nesting note (CLAUDE.md): from this dir the DB import is ../../db and
// dotenv is ../../../.env (one deeper than createAdmin.js).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../../db');
const { parseCsv } = require('./parsers/csvUtil');
const { getArg } = require('./config');
const { validateSheets, planPeopleEmails, checkAttachRole, checkBoundaryNoDoubleCount, checkPlaceholderNameMatch } = require('./importValidation');

// ---- sheet readers ----------------------------------------------------------
function readCsvObjects(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const records = parseCsv(fs.readFileSync(filePath, 'utf8'));
  if (!records.length) return [];
  const header = records[0].map((c) => c.trim());
  return records.slice(1)
    .filter((r) => r.length > 1 || (r[0] && r[0].trim()))
    .map((r) => {
      const o = {};
      header.forEach((h, i) => { o[h] = r[i] !== undefined ? r[i] : ''; });
      return o;
    });
}

function loadSheet(reviewDir) {
  const manifestPath = path.join(reviewDir, '.manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`missing ${manifestPath} — run buildReviewSheet first`);
  const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
  const peopleRaw = fs.readFileSync(path.join(reviewDir, 'people.csv'), 'utf8');
  const txnRaw = fs.readFileSync(path.join(reviewDir, 'transactions.csv'), 'utf8');
  return {
    manifest: JSON.parse(manifestRaw),
    people: readCsvObjects(path.join(reviewDir, 'people.csv')),
    transactions: readCsvObjects(path.join(reviewDir, 'transactions.csv')),
    checksum: crypto.createHash('md5').update(manifestRaw + peopleRaw + txnRaw).digest('hex'),
  };
}

// ---- retraction guard (VECTOR 2 / E2) ---------------------------------------
// Read every durable run log the review dir already holds. Prior --execute runs
// each drop an import-run-<ts>.json carrying the fingerprints they imported. A
// corrupt/unparseable log is a HARD ERROR naming the file (fail-closed): silently
// dropping it would shrink the union and let a real orphan slip through.
function readPriorRunLogs(reviewDir) {
  if (!fs.existsSync(reviewDir)) return [];
  return fs.readdirSync(reviewDir)
    .filter((f) => /^import-run-.*\.json$/.test(f))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(reviewDir, f), 'utf8')); }
      catch (e) { throw new Error(`corrupt run log ${f}: ${e.message} — fix or remove it (fail-closed: cannot compute orphans from a partial log set)`); }
    });
}

const RETRACTIONS_FILE = 'retractions.json';

// Retraction ledger (E2a): fingerprints an operator has manually DELETEd from the
// ledger and formally recorded, so future runs stop flagging them. Fail-closed on
// a corrupt file (same reasoning as run logs).
function readRetractions(reviewDir) {
  const p = path.join(reviewDir, RETRACTIONS_FILE);
  if (!fs.existsSync(p)) return [];
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`corrupt ${RETRACTIONS_FILE}: ${e.message} — fix or remove it (fail-closed)`); }
  return Array.isArray(parsed.fingerprints) ? parsed.fingerprints : [];
}

function writeRetractions(reviewDir, fingerprints, operator) {
  const out = {
    updated: new Date().toISOString(),
    operator: operator || process.env.USER || 'unknown',
    fingerprints,
  };
  fs.writeFileSync(path.join(reviewDir, RETRACTIONS_FILE), `${JSON.stringify(out, null, 2)}\n`);
}

// PURE. Fingerprints a prior run imported that are ABSENT from the current toImport
// (verdict flipped to ignore/unsure, or the row removed) AND not formally retracted.
// The import is insert/update-only, so these ledger rows would silently persist —
// return them (deduped, sorted) so the caller can REFUSE and print the retraction path.
function findOrphanedFingerprints(priorRunLogs, toImport, retracted = []) {
  const accounted = new Set([...toImport.map((r) => r.fingerprint), ...retracted]);
  const orphaned = new Set();
  for (const log of priorRunLogs) {
    const fps = log && Array.isArray(log.fingerprints) ? log.fingerprints : [];
    for (const fp of fps) if (!accounted.has(fp)) orphaned.add(fp);
  }
  return [...orphaned].sort();
}

// PURE (E2a). A retraction whitelists a fingerprint forever, so a retracted fp that
// REAPPEARS as staff-pay in the current sheet must be a HARD ERROR — silently
// reconciling it back would make any later re-drop invisible to both guards. Returns
// the toImport ∩ retracted overlap (deduped, sorted); the operator must explicitly
// un-retract (remove from retractions.json) to re-import.
function findReimportedRetractions(toImport, retracted) {
  const retractedSet = new Set(retracted || []);
  const hits = new Set();
  for (const r of toImport) if (retractedSet.has(r.fingerprint)) hits.add(r.fingerprint);
  return [...hits].sort();
}

// PURE (E2b). Union of every user id a surviving run log recorded (created / reused /
// existing). verifyImport widens its residue scan to these so a FULLY-dropped person's
// stale ledger rows are still scanned when the log survives.
function runLogUserIds(priorRunLogs) {
  const ids = new Set();
  for (const log of priorRunLogs || []) {
    for (const key of ['created_user_ids', 'reused_user_ids', 'existing_user_ids']) {
      for (const id of (Array.isArray(log[key]) ? log[key] : [])) ids.add(id);
    }
  }
  return [...ids];
}

// CLI mode: record a manual retraction (E2a). VERIFIES via SELECT that the given
// fingerprints are truly ABSENT from staff_payment_history (the operator must run
// the DELETE first), then appends them to retractions.json. Refuses if any are
// still present — never deletes anything itself (retraction stays manual).
async function recordRetraction({ reviewDir, fingerprints, operator }) {
  const fps = [...new Set((fingerprints || []).map((f) => String(f).trim()).filter(Boolean))];
  if (!fps.length) { console.error('[retraction] no fingerprints given (--record-retraction=<fp,fp>)'); return { ok: false, errors: ['no fingerprints'] }; }

  const present = (await pool.query('SELECT row_fingerprint FROM staff_payment_history WHERE row_fingerprint = ANY($1)', [fps])).rows.map((r) => r.row_fingerprint);
  if (present.length) {
    console.error(`[retraction] REFUSED — ${present.length} fingerprint(s) are STILL in staff_payment_history; DELETE them first, then record:`);
    present.forEach((fp) => console.error(`  - ${fp}`));
    return { ok: false, errors: present };
  }

  const merged = [...new Set([...readRetractions(reviewDir), ...fps])].sort();
  writeRetractions(reviewDir, merged, operator);
  console.log(`[retraction] recorded ${fps.length} fingerprint(s); ${RETRACTIONS_FILE} now holds ${merged.length}.`);
  return { ok: true, recorded: fps, total: merged.length };
}

const dollars = (cents) => (cents / 100).toFixed(2);
function dbHost() {
  try { return new URL(process.env.DATABASE_URL).host; } catch { return 'unknown'; }
}

// ---- pre-flight (BEFORE BEGIN): resolve every create-* email to reuse|insert|error
async function preflight(peopleActions, clusterToEmail, allowAdminIds = new Set()) {
  const errors = [];
  const plan = new Map(); // cluster → { mode:'insert'|'reuse'|'existing', userId?, email? }

  const emails = [...clusterToEmail.values()];
  const emailRows = emails.length
    ? (await pool.query(
      `SELECT u.id, lower(u.email) AS email, u.import_source, u.exclude_from_1099, cp.preferred_name
         FROM users u LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
        WHERE lower(u.email) = ANY($1)`, [emails])).rows
    : [];
  const byEmail = new Map(emailRows.map((r) => [r.email, r]));

  const existingIds = peopleActions.filter((p) => p.action === 'existing').map((p) => p.existingId);
  const idRows = existingIds.length
    ? (await pool.query(
      `SELECT u.id, u.role, u.email, u.exclude_from_1099, cp.preferred_name
         FROM users u LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
        WHERE u.id = ANY($1)`, [existingIds])).rows
    : [];
  const byId = new Map(idRows.map((r) => [r.id, r]));

  for (const p of peopleActions) {
    if (p.action === 'existing') {
      const u = byId.get(p.existingId);
      if (!u) { errors.push(`existing:${p.existingId} for "${p.cluster}" — no such user`); continue; }
      // staff/manager attach silently; admin only with an explicit
      // --allow-admin-ids entry (Zul is a real admin + the largest payee).
      const roleCheck = checkAttachRole({ id: u.id, role: u.role, email: u.email }, allowAdminIds);
      if (!roleCheck.ok) { errors.push(roleCheck.error); continue; }
      plan.set(p.cluster, { mode: 'existing', userId: u.id, email: u.email, role: u.role, name: u.preferred_name || '', priorExclude: u.exclude_from_1099 });
      continue;
    }
    const email = clusterToEmail.get(p.cluster);
    const hit = byEmail.get(email);
    if (!hit) { plan.set(p.cluster, { mode: 'insert', email }); continue; }
    if (hit.import_source === 'payment_history_import') {
      // (E1 belt, now a WARN) Injective placeholder emails already guarantee email
      // match ⇒ same cluster, so a name mismatch here is not proof of a wrong merge —
      // it also fires legitimately after a claimed user renames their profile. Surface
      // it as a visible warning on the plan line instead of blocking a valid re-run.
      const nameCheck = checkPlaceholderNameMatch({ email, profileName: hit.preferred_name, proposedName: p.proposed_name });
      plan.set(p.cluster, { mode: 'reuse', userId: hit.id, email, priorExclude: hit.exclude_from_1099, nameWarn: nameCheck.ok ? null : nameCheck.error }); // our own prior placeholder/row → idempotent
    } else {
      errors.push(`create-* person "${p.cluster}" email ${email} already belongs to a non-import user (id ${hit.id}) — use existing:${hit.id}`);
    }
  }
  return { errors, plan };
}

// ---- one transaction: users + profiles + ledger -----------------------------
async function runImport({ reviewDir, execute, operator, allowAdminIds = new Set() }) {
  const { manifest, people, transactions, checksum } = loadSheet(reviewDir);
  const { errors, toImport, toReconcile, peopleActions, skippedUnsure } = validateSheets({ manifest, people, transactions });
  if (errors.length) {
    console.error(`\n[import] VALIDATION FAILED — ${errors.length} error(s); nothing written:`);
    errors.forEach((e) => console.error(`  - ${e}`));
    return { ok: false, errors };
  }

  const retracted = readRetractions(reviewDir);

  // (E2a) A retracted fingerprint that reappears as staff-pay must be un-retracted
  // explicitly — silently reconciling it back would hide any later re-drop. Refuse.
  const reimported = findReimportedRetractions(toImport, retracted);
  if (reimported.length) {
    console.error(`\n[import] RETRACTED-YET-PRESENT — ${reimported.length} fingerprint(s) are in retractions.json but present as staff-pay in the sheet; refusing:`);
    reimported.forEach((fp) => console.error(`  - fingerprint ${fp} is retracted but present as staff-pay — if re-importing intentionally, remove it from retractions.json first`));
    return { ok: false, errors: [`retracted-yet-present — ${reimported.length} fingerprint(s): ${reimported.join(', ')}`] };
  }

  // (VECTOR 2 / E2) Retraction guard — runs on EVERY run (dry + execute). A finger-
  // print a PRIOR run imported that is no longer in toImport AND not formally
  // retracted is an orphan this insert/update-only import cannot retract; refuse and
  // print the manual retraction path (DELETE, then record — never an auto-DELETE).
  const orphaned = findOrphanedFingerprints(readPriorRunLogs(reviewDir), toImport, retracted);
  if (orphaned.length) {
    const inList = orphaned.map((fp) => `'${fp}'`).join(', ');
    console.error(`\n[import] RETRACTION REQUIRED — ${orphaned.length} previously-imported fingerprint(s) are no longer in the sheet; refusing to proceed (insert/update-only never retracts):`);
    orphaned.forEach((fp) => console.error(`  - ${fp}`));
    console.error('  1) Delete the orphaned ledger rows manually (see the undo runbook):');
    console.error(`       DELETE FROM staff_payment_history WHERE row_fingerprint IN (${inList});`);
    console.error('  2) Record the retraction so future runs proceed (verifies they are gone first):');
    console.error(`       node server/scripts/staffPaymentImport/importFromSheet.js --record-retraction=${orphaned.join(',')} --review-dir ${reviewDir}`);
    return { ok: false, errors: [`retraction required — ${orphaned.length} orphaned fingerprint(s): ${orphaned.join(', ')}`] };
  }

  const clusterToEmail = planPeopleEmails(peopleActions);
  const pre = await preflight(peopleActions, clusterToEmail, allowAdminIds);
  if (pre.errors.length) {
    console.error(`\n[import] PRE-FLIGHT FAILED — ${pre.errors.length} error(s); nothing written:`);
    pre.errors.forEach((e) => console.error(`  - ${e}`));
    return { ok: false, errors: pre.errors };
  }

  const client = await pool.connect();
  const created = []; const reused = []; const existing = [];
  const clusterToUserId = new Map();
  let inserted = 0; let attributionUpdated = 0; let unchanged = 0;
  try {
    await client.query('BEGIN');

    // 1) People → user ids.
    for (const p of peopleActions) {
      const decision = pre.plan.get(p.cluster);
      // (fix 4) blank exclude_1099 = NO CHANGE — only an explicit yes|no writes the
      // flag, so a blank cell can never silently strip an existing exclusion (Zul).
      // The plan shows the effective value (prior when untouched) so no spurious
      // true→false CHANGED prints on a blank.
      const effExclude = p.exclude_1099_provided ? p.exclude_1099 : decision.priorExclude;
      if (decision.mode === 'existing') {
        if (p.exclude_1099_provided) await client.query('UPDATE users SET exclude_from_1099 = $1 WHERE id = $2', [p.exclude_1099, decision.userId]);
        clusterToUserId.set(p.cluster, decision.userId);
        existing.push({ cluster: p.cluster, userId: decision.userId, email: decision.email, role: decision.role, name: decision.name, priorExclude: decision.priorExclude, exclude: effExclude });
      } else if (decision.mode === 'reuse') {
        if (p.exclude_1099_provided) await client.query('UPDATE users SET exclude_from_1099 = $1 WHERE id = $2', [p.exclude_1099, decision.userId]);
        clusterToUserId.set(p.cluster, decision.userId);
        reused.push({ cluster: p.cluster, userId: decision.userId, email: decision.email, priorExclude: decision.priorExclude, exclude: effExclude, nameWarn: decision.nameWarn });
      } else {
        const status = p.action === 'create-current' ? 'in_progress' : 'deactivated';
        const preHired = p.action === 'create-current';
        const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12); // secret discarded
        const { rows } = await client.query(
          `INSERT INTO users (email, password_hash, role, onboarding_status, pre_hired, exclude_from_1099, import_source)
           VALUES ($1, $2, 'staff', $3, $4, $5, 'payment_history_import') RETURNING id`,
          [decision.email, hash, status, preHired, p.exclude_1099],
        );
        const userId = rows[0].id;
        if (p.action === 'create-current') {
          await client.query('INSERT INTO onboarding_progress (user_id, account_created) VALUES ($1, true)', [userId]);
        }
        await client.query(
          'INSERT INTO contractor_profiles (user_id, preferred_name, phone, email) VALUES ($1, $2, $3, $4)',
          [userId, p.proposed_name, p.phone || null, p.emailProvided ? p.email : null],
        );
        await client.query(
          'INSERT INTO payment_profiles (user_id, preferred_payment_method, payment_username) VALUES ($1, $2, $3)',
          [userId, p.preferred_method || null, p.preferred_handle || null],
        );
        clusterToUserId.set(p.cluster, userId);
        created.push({ cluster: p.cluster, userId, email: decision.email, status, exclude: p.exclude_1099 });
      }
    }

    // 2) Ledger — classify against pre-run state, then upsert.
    const fps = toImport.map((r) => r.fingerprint);
    const priorRows = fps.length
      ? (await client.query('SELECT row_fingerprint, contractor_id, event_label, memo FROM staff_payment_history WHERE row_fingerprint = ANY($1)', [fps])).rows
      : [];
    const prior = new Map(priorRows.map((r) => [r.row_fingerprint, r]));

    for (const r of toImport) {
      const contractorId = clusterToUserId.get(r.cluster);
      const p = prior.get(r.fingerprint);
      if (!p) inserted += 1;
      else if (p.contractor_id !== contractorId || (p.event_label || null) !== r.event_label || (p.memo || null) !== r.memo) attributionUpdated += 1;
      else unchanged += 1;

      await client.query(
        `INSERT INTO staff_payment_history
           (contractor_id, paid_on, amount_cents, platform, source_account, external_txn_id,
            payee_handle, memo, event_label, boundary_exception, row_fingerprint, source_file)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (row_fingerprint) DO UPDATE
           SET contractor_id = EXCLUDED.contractor_id,
               event_label   = EXCLUDED.event_label,
               memo          = EXCLUDED.memo`,
        [contractorId, r.paid_on, r.amount_cents, r.platform, r.source_account, r.external_txn_id,
          r.payee_handle, r.memo, r.event_label, r.boundary_exception, r.fingerprint, r.source_file],
      );
    }

    // (fix 3) No-double-count assert INSIDE the transaction, BEFORE COMMIT — every
    // boundary_exception row must clash with no payout (same contractor, |amount|
    // ≤ 1¢, within the collection window). A clash throws → the catch ROLLBACKs,
    // even under --execute, instead of committing a double-count and only catching
    // it in verifyImport after the money already landed.
    const exceptionRows = toImport
      .filter((r) => r.boundary_exception)
      .map((r) => ({ row_fingerprint: r.fingerprint, contractor_id: clusterToUserId.get(r.cluster), amount_cents: r.amount_cents, paid_on: r.paid_on }));
    if (exceptionRows.length) {
      const { rows: payouts } = await client.query(
        `SELECT po.id, po.contractor_id, po.total_cents, po.status, pp.start_date, pp.payday
           FROM payouts po JOIN pay_periods pp ON pp.id = po.pay_period_id`);
      const dbl = checkBoundaryNoDoubleCount(exceptionRows, payouts);
      if (dbl.length) throw new Error(`boundary no-double-count check failed (aborting, nothing committed):\n  ${dbl.join('\n  ')}`);
    }

    printPlan({ reviewDir, execute, checksum, created, reused, existing, toImport, toReconcile, clusterToUserId, inserted, attributionUpdated, unchanged, skippedUnsure });

    if (execute) await client.query('COMMIT');
    else await client.query('ROLLBACK');
  } catch (err) {
    // A dead-connection ROLLBACK must not mask the real error.
    try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('[import] ROLLBACK also failed:', rbErr.message); }
    throw err;
  } finally {
    client.release();
  }

  let runLogPath = null;
  if (execute) {
    runLogPath = writeRunLog({
      reviewDir, checksum, operator, created, reused, existing, toImport,
      counts: { inserted, attributionUpdated, unchanged, reconcile: toReconcile.length, skippedUnsure },
    });
    console.log(`\n[import] COMMITTED. run log → ${runLogPath}`);
  } else {
    console.log('\n[import] ROLLBACK (dry run) — pass --execute to commit.');
  }
  return { ok: true, inserted, attributionUpdated, unchanged, created, reused, existing, toReconcile, runLogPath };
}

// ---- write plan + per-person/per-year ---------------------------------------
function printPlan({ reviewDir, execute, checksum, created, reused, existing, toImport, toReconcile, clusterToUserId, inserted, attributionUpdated, unchanged, skippedUnsure = 0 }) {
  console.log(`\n=== STAFF PAYMENT IMPORT — ${execute ? 'EXECUTE' : 'DRY RUN'} ===`);
  console.log(`review-dir: ${reviewDir}`);
  console.log(`db host:    ${dbHost()}`);
  console.log(`checksum:   ${checksum}`);

  // Show a flag change as before→after so a blank sheet cell silently clearing a
  // set flag is visible in the plan; unchanged just prints the value.
  const excl = (c) => (c.priorExclude !== undefined && c.priorExclude !== c.exclude
    ? `exclude_1099: ${c.priorExclude}→${c.exclude}  (CHANGED)`
    : `exclude_1099=${c.exclude}`);
  console.log(`\nPEOPLE (${created.length + reused.length + existing.length} actions):`);
  created.forEach((c) => console.log(`  CREATE(${c.status === 'in_progress' ? 'current' : 'ex'})  ${c.cluster.padEnd(20)} ${c.email.padEnd(34)} exclude_1099=${c.exclude}`));
  reused.forEach((c) => {
    console.log(`  REUSE(import)      ${c.cluster.padEnd(20)} ${c.email.padEnd(34)} id=${String(c.userId).padEnd(6)} ${excl(c)}`);
    if (c.nameWarn) console.log(`      WARN name-mismatch: ${c.nameWarn} (proceeding; injective email confirms the account)`);
  });
  // EXISTING attaches history to a real account — print email/role/name so the
  // operator can eyeball identity, not just an id.
  existing.forEach((c) => console.log(`  EXISTING           ${c.cluster.padEnd(20)} id=${c.userId} ${c.role} <${c.email}> "${c.name}"  ${excl(c)}`));

  console.log(`\nLEDGER: ${inserted} inserted / ${attributionUpdated} attribution-updated / ${unchanged} unchanged   (toImport total = ${toImport.length})`);

  const byPy = new Map(); // cluster|year → {count, cents}
  for (const r of toImport) {
    const year = String(r.paid_on).slice(0, 4);
    const key = `${r.cluster}|${year}`;
    if (!byPy.has(key)) byPy.set(key, { cluster: r.cluster, year, count: 0, cents: 0 });
    const g = byPy.get(key); g.count += 1; g.cents += r.amount_cents;
  }
  console.log('\nPER-PERSON PER-YEAR:');
  [...byPy.values()].sort((a, b) => a.cluster.localeCompare(b.cluster) || a.year.localeCompare(b.year))
    .forEach((g) => console.log(`  ${g.cluster.padEnd(24)} ${g.year}  ${String(g.count).padStart(3)}  $${dollars(g.cents)}  → contractor_id=${clusterToUserId.get(g.cluster)}`));

  console.log(`\nRECONCILE (post-boundary staff-pay, NOT imported): ${toReconcile.length} row(s) → run reconcile.js`);
  console.log(`skipped (unsure): ${skippedUnsure}`);
}

// ---- durable run log (execute only; spec §7.4 audit + undo path) -------------
function writeRunLog({ reviewDir, checksum, operator, created, reused, existing, toImport, counts }) {
  const ts = new Date().toISOString();
  const log = {
    timestamp: ts,
    operator: operator || process.env.USER || 'unknown',
    database_host: dbHost(),
    sheet_checksum: checksum,
    counts: {
      users_created: created.length,
      users_reused: reused.length,
      users_flag_updated: existing.length,
      ledger_inserted: counts.inserted,
      ledger_attribution_updated: counts.attributionUpdated,
      ledger_unchanged: counts.unchanged,
      reconcile_pending: counts.reconcile,
      skipped_unsure: counts.skippedUnsure,
    },
    created_user_ids: created.map((c) => c.userId),
    reused_user_ids: reused.map((c) => c.userId),
    existing_user_ids: existing.map((c) => c.userId),
    fingerprints: toImport.map((r) => r.fingerprint),
  };
  const outPath = path.join(reviewDir, `import-run-${ts.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(log, null, 2)}\n`);
  return outPath;
}

// ---- CLI --------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const reviewDir = getArg(argv, '--review-dir');
  if (!reviewDir) { console.error('--review-dir <dir> is required'); process.exit(1); }
  const operator = getArg(argv, '--operator');

  // Retraction-record mode (E2a): --record-retraction=<fp,fp>. Verifies absence in
  // the ledger, then appends to retractions.json. Never runs an import. ANY argv
  // starting with --record-retraction that does NOT parse to a non-empty fp list is a
  // HARD usage error — never a silent fall-through to a dry-run import (E2c).
  const recordArg = argv.find((a) => a.startsWith('--record-retraction'));
  if (recordArg) {
    const eq = recordArg.indexOf('=');
    const fingerprints = eq === -1 ? [] : recordArg.slice(eq + 1).split(',').map((s) => s.trim()).filter(Boolean);
    if (!fingerprints.length) {
      console.error('--record-retraction requires a non-empty comma-separated fingerprint list: --record-retraction=<fp,fp>');
      process.exit(1);
    }
    recordRetraction({ reviewDir: path.resolve(reviewDir), fingerprints, operator })
      .then((res) => pool.end().then(() => process.exit(res.ok ? 0 : 1)))
      .catch((err) => { console.error('[retraction] FAILED:', err.message); pool.end().then(() => process.exit(1)); });
  } else {
    const execute = argv.includes('--execute');
    // Admin ids approved to receive attached history — lives in the operator's
    // command, never in the editable sheet (tamper-resistant).
    const allowAdminIds = new Set((getArg(argv, '--allow-admin-ids') || '')
      .split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isInteger));
    runImport({ reviewDir: path.resolve(reviewDir), execute, operator, allowAdminIds })
      .then((res) => pool.end().then(() => process.exit(res.ok ? 0 : 1)))
      .catch((err) => { console.error('[import] FAILED:', err.message); pool.end().then(() => process.exit(1)); });
  }
}

module.exports = {
  runImport, loadSheet, readCsvObjects, preflight,
  findOrphanedFingerprints, readPriorRunLogs, readRetractions, writeRetractions, recordRetraction,
  findReimportedRetractions, runLogUserIds,
};

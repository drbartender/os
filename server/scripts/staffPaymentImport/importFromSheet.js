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
const { validateSheets, planPeopleEmails, checkAttachRole } = require('./importValidation');

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
    ? (await pool.query('SELECT id, lower(email) AS email, import_source, exclude_from_1099 FROM users WHERE lower(email) = ANY($1)', [emails])).rows
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
      plan.set(p.cluster, { mode: 'reuse', userId: hit.id, email, priorExclude: hit.exclude_from_1099 }); // our own prior placeholder/row → idempotent
    } else {
      errors.push(`create-* person "${p.cluster}" email ${email} already belongs to a non-import user (id ${hit.id}) — use existing:${hit.id}`);
    }
  }
  return { errors, plan };
}

// ---- one transaction: users + profiles + ledger -----------------------------
async function runImport({ reviewDir, execute, operator, allowAdminIds = new Set() }) {
  const { manifest, people, transactions, checksum } = loadSheet(reviewDir);
  const { errors, toImport, toReconcile, peopleActions } = validateSheets({ manifest, people, transactions });
  if (errors.length) {
    console.error(`\n[import] VALIDATION FAILED — ${errors.length} error(s); nothing written:`);
    errors.forEach((e) => console.error(`  - ${e}`));
    return { ok: false, errors };
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
      if (decision.mode === 'existing') {
        await client.query('UPDATE users SET exclude_from_1099 = $1 WHERE id = $2', [p.exclude_1099, decision.userId]);
        clusterToUserId.set(p.cluster, decision.userId);
        existing.push({ cluster: p.cluster, userId: decision.userId, email: decision.email, role: decision.role, name: decision.name, priorExclude: decision.priorExclude, exclude: p.exclude_1099 });
      } else if (decision.mode === 'reuse') {
        await client.query('UPDATE users SET exclude_from_1099 = $1 WHERE id = $2', [p.exclude_1099, decision.userId]);
        clusterToUserId.set(p.cluster, decision.userId);
        reused.push({ cluster: p.cluster, userId: decision.userId, email: decision.email, priorExclude: decision.priorExclude, exclude: p.exclude_1099 });
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

    printPlan({ reviewDir, execute, checksum, created, reused, existing, toImport, toReconcile, clusterToUserId, inserted, attributionUpdated, unchanged });

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
      counts: { inserted, attributionUpdated, unchanged, reconcile: toReconcile.length },
    });
    console.log(`\n[import] COMMITTED. run log → ${runLogPath}`);
  } else {
    console.log('\n[import] ROLLBACK (dry run) — pass --execute to commit.');
  }
  return { ok: true, inserted, attributionUpdated, unchanged, created, reused, existing, toReconcile, runLogPath };
}

// ---- write plan + per-person/per-year ---------------------------------------
function printPlan({ reviewDir, execute, checksum, created, reused, existing, toImport, toReconcile, clusterToUserId, inserted, attributionUpdated, unchanged }) {
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
  reused.forEach((c) => console.log(`  REUSE(import)      ${c.cluster.padEnd(20)} ${c.email.padEnd(34)} id=${String(c.userId).padEnd(6)} ${excl(c)}`));
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
  const execute = argv.includes('--execute');
  const operator = getArg(argv, '--operator');
  // Admin ids approved to receive attached history — lives in the operator's
  // command, never in the editable sheet (tamper-resistant).
  const allowAdminIds = new Set((getArg(argv, '--allow-admin-ids') || '')
    .split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isInteger));
  runImport({ reviewDir: path.resolve(reviewDir), execute, operator, allowAdminIds })
    .then((res) => pool.end().then(() => process.exit(res.ok ? 0 : 1)))
    .catch((err) => { console.error('[import] FAILED:', err.message); pool.end().then(() => process.exit(1)); });
}

module.exports = { runImport, loadSheet, readCsvObjects, preflight };

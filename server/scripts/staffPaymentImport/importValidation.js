// Sheet validation (spec §4/§6/§7, plan C1). PURE — no DB, no I/O. The import
// (importFromSheet.js) runs ONLY when validateSheets(...).errors is empty.
//
// Excel-proofing (§7.3): the CANONICAL financial facts (date, amount_cents,
// platform, source_account, txn_id, payee, memo, source_file, post_boundary)
// are read from the `.manifest.json` keyed by fingerprint — NEVER from the CSV
// display columns, which Excel can mangle. Only human-judgment columns come off
// the CSVs: verdict, person_cluster, event_label, boundary_exception (txn) and
// proposed_name, email, phone, preferred_method/handle, account_decision,
// exclude_1099, current_or_ex (people).
//
// validateSheets({ manifest, people, transactions }) → { errors, toImport,
//   toReconcile, peopleActions } — see the shapes at the bottom of this file.
// Also exports the normalizers + deterministic placeholder-email planner shared
// with importFromSheet.js / verifyImport.js / reconcile.js.

const crypto = require('crypto'); // deterministic hashing only — no I/O, stays pure

const VERDICTS = new Set(['staff-pay', 'ignore', 'unsure']);
const EXCLUDE_VALUES = new Set(['yes', 'no', '']);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Trim + lowercase. Blank stays blank.
function normalizeEmail(raw) {
  return String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
}

// Strip display formatting but NEVER US-normalize: a leading "+" (country code,
// e.g. Zul's +63…) is preserved verbatim so the US-centric normalizePhone
// (strip-leading-1 / assume-10-digits) can never mangle a foreign number.
function normalizePhoneImport(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return '';
  if (s.startsWith('+')) return `+${s.slice(1).replace(/\D/g, '')}`;
  return s.replace(/\D/g, '');
}

// Name → placeholder-email slug: lowercase, alnum runs → single hyphen.
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'imported';
}

// (E1) INJECTIVE placeholder-email local part for a cluster key. slugify is lossy
// (non-ASCII collapses; 'josé'/'josè' → 'jos', all-non-Latin → 'imported'), so a
// readable slug alone would let a DIFFERENT person's cluster reuse-merge into an
// existing placeholder account. Append an 8-hex sha256 of the EXACT cluster string:
// the slug stays human-readable, the hash makes email identity ≡ cluster identity.
function placeholderEmailBase(cluster) {
  const hash = crypto.createHash('sha256').update(String(cluster)).digest('hex').slice(0, 8);
  return `${slugify(cluster)}-${hash}`;
}

// Deterministic placeholder-email plan for create-* people with NO real email.
// Same sheet + same order ⇒ same assignment on every run, so a re-run reclaims
// each person's existing @imported.invalid row by email (idempotency) instead
// of disambiguating into a fresh -2 duplicate. Real emails pass through
// unchanged. Returns Map(cluster → assigned email).
//   peopleActions: the array validateSheets returns (create-* + existing only).
function planPeopleEmails(peopleActions) {
  const assigned = new Map();
  const used = new Set();
  // Real emails first so placeholder disambiguation can avoid colliding with them.
  for (const p of peopleActions) {
    if ((p.action === 'create-current' || p.action === 'create-ex') && p.emailProvided) {
      assigned.set(p.cluster, p.email);
      used.add(p.email);
    }
  }
  // (E1) The placeholder is an INJECTIVE function of the CLUSTER KEY
  // (placeholderEmailBase = slug + sha256(cluster)), never slugify(proposed_name):
  // email identity ≡ cluster identity, so cross-run the same email means the same
  // cluster (the legit idempotent reuse) and a DIFFERENT person can never reuse-merge
  // into it. Disambiguation runs in DETERMINISTIC cluster order (plain code-point
  // compare for cross-machine stability), never sheet-row order — though with the
  // hash a real collision is only ever against a literal same-cluster row.
  const cmp = (a, b) => { const x = String(a.cluster); const y = String(b.cluster); return x < y ? -1 : x > y ? 1 : 0; };
  const noEmail = peopleActions
    .filter((p) => (p.action === 'create-current' || p.action === 'create-ex') && !p.emailProvided)
    .sort(cmp);
  for (const p of noEmail) {
    const base = placeholderEmailBase(p.cluster);
    let email = `${base}@imported.invalid`;
    let n = 2;
    while (used.has(email)) { email = `${base}-${n}@imported.invalid`; n += 1; }
    used.add(email);
    assigned.set(p.cluster, email);
  }
  return assigned;
}

function parseAccountDecision(raw) {
  const v = String(raw === null || raw === undefined ? '' : raw).trim();
  if (v === 'create-current' || v === 'create-ex' || v === 'skip') {
    return { ok: true, action: v, existingId: null };
  }
  const m = v.match(/^existing:(.+)$/);
  if (m) {
    // Plain digits only — reject 1e3 / 0x1 / 1.0 / +5, which Number() would
    // silently coerce into a valid-looking id and attach ledger rows to the
    // wrong user.
    const idStr = m[1].trim();
    if (!/^\d+$/.test(idStr)) return { ok: false, reason: `existing:<id> "${v}" is not a positive integer` };
    const id = Number(idStr);
    if (Number.isInteger(id) && id > 0) return { ok: true, action: 'existing', existingId: id };
    return { ok: false, reason: `existing:<id> "${v}" is not a positive integer` };
  }
  return { ok: false, reason: v === '' ? 'account_decision is blank' : `account_decision "${v}" is not a recognized value` };
}

// ---- shared payout-window + role helpers (pure) -----------------------------
// node-pg returns a DATE column as a JS Date at LOCAL midnight; read Y-M-D off
// the local components (TZ-safe) rather than toISOString (which can shift a day).
function ymd(v) {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}

// Add n days to a YYYY-MM-DD string (UTC math, TZ-safe).
function addDays(ymdStr, n) {
  const [y, m, d] = ymdStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Does a payment date fall in a payout's collection window? Payments land ON
// payday (Tuesday, AFTER the Sunday period end), and stragglers up to two weeks
// late still belong to that payout — so the window is [start_date, payday+14d],
// NOT [start_date, end_date]. Shared by reconcile matching and the boundary
// no-double-count assert. `payout` carries start_date + payday (DATE or string).
function inPayoutWindow(paidOn, payout) {
  const p = ymd(paidOn);
  return p >= ymd(payout.start_date) && p <= addDays(ymd(payout.payday), 14);
}

// Pure assert (fix 3; tested in importValidation.test.js + verifyImport.test.js).
// A boundary-exception row must match NO payout for the same contractor at
// |amount| ≤ 1¢ AND within that payout's collection window [start_date, payday+14d]
// — else it double-counts against a payout that could also be marked paid. Lives
// here (not verifyImport) so importFromSheet can run it INSIDE its transaction
// before COMMIT without a require cycle. Returns failure strings (empty ⇒ ok).
function checkBoundaryNoDoubleCount(exceptionRows, payouts) {
  const failures = [];
  for (const r of exceptionRows) {
    const clash = payouts.find((po) => po.contractor_id === r.contractor_id
      && Math.abs(po.total_cents - r.amount_cents) <= 1
      && inPayoutWindow(r.paid_on, po));
    if (clash) failures.push(`boundary_exception row ${r.row_fingerprint} (contractor ${r.contractor_id}, $${(r.amount_cents / 100).toFixed(2)}) matches payout ${clash.id} — would double-count`);
  }
  return failures;
}

// Pure role guard for existing:<id> attachment. staff/manager are payable workers
// → attach silently. admin needs an explicit --allow-admin-ids entry (which lives
// in the operator's command, NOT the editable sheet) because a real admin account
// can be a large payee (e.g. Zul). Returns { ok, error }.
function checkAttachRole(user, allowAdminIds) {
  const { id, role, email } = user;
  if (role === 'staff' || role === 'manager') return { ok: true, error: null };
  if (role === 'admin') {
    if (allowAdminIds && allowAdminIds.has(id)) return { ok: true, error: null };
    return { ok: false, error: `existing:${id} is an admin account (${email}) — re-run with --allow-admin-ids=${id} if intended` };
  }
  return { ok: false, error: `existing:${id} is a ${role} account (${email}) — refusing to attach staff-payment history` };
}

// (E1 belt, pure) When preflight REUSEs an import-created placeholder account, the
// account must still belong to the same person: slug(existing contractor profile
// name) must equal slug(sheet proposed_name). A mismatch means a different person's
// cluster is silently merging into this account (the lossy-slug cross-run case that
// the cluster-keyed email cannot catch alone). Returns { ok, error }.
function checkPlaceholderNameMatch({ email, profileName, proposedName }) {
  if (slugify(profileName) === slugify(proposedName)) return { ok: true, error: null };
  return { ok: false, error: `placeholder identity mismatch: account ${email} belongs to "${profileName || ''}", sheet says "${proposedName || ''}"` };
}

function validateSheets({ manifest = {}, people = [], transactions = [] } = {}) {
  const errors = [];

  // Index people by cluster; flag within-file people problems as we go.
  const peopleByCluster = new Map();
  for (const p of people) {
    const cluster = String(p.cluster || '').trim();
    if (!cluster) { errors.push('people row has a blank cluster'); continue; }
    if (peopleByCluster.has(cluster)) { errors.push(`duplicate people cluster "${cluster}"`); continue; }
    peopleByCluster.set(cluster, p);
  }

  // Which clusters are referenced by a staff-pay txn → the actionable set.
  const staffPayClusters = new Set();
  const fpSeen = new Set();
  let skippedUnsure = 0; // (fix 5) unsure rows are dropped — surface the count.
  for (const t of transactions) {
    const fp = String(t.fingerprint || '').trim();
    const verdict = String(t.verdict || '').trim();
    if (!VERDICTS.has(verdict)) {
      errors.push(`txn ${fp || '(no fingerprint)'} has invalid verdict "${verdict}"`);
    }
    if (fp) {
      if (fpSeen.has(fp)) errors.push(`duplicate fingerprint ${fp} in transactions`);
      fpSeen.add(fp);
    }
    if (verdict === 'unsure') skippedUnsure += 1;
    if (verdict === 'staff-pay') {
      const cluster = String(t.person_cluster || '').trim();
      if (cluster) staffPayClusters.add(cluster);
    }
  }

  // ---- people-action resolution (actionable clusters only) ------------------
  const peopleActions = [];
  const emailToClusters = new Map(); // normalized email → [cluster,...] within sheet
  for (const cluster of staffPayClusters) {
    const p = peopleByCluster.get(cluster);
    if (!p) continue; // reported per-txn below

    const dec = parseAccountDecision(p.account_decision);
    if (!dec.ok) {
      errors.push(`people cluster "${cluster}" account_decision invalid: ${dec.reason}`);
      continue;
    }
    if (dec.action === 'skip') {
      errors.push(`people cluster "${cluster}" is account_decision=skip but has staff-pay txns`);
      continue;
    }

    const email = normalizeEmail(p.email);
    const emailProvided = email !== '';
    if (emailProvided && !EMAIL_RE.test(email)) {
      errors.push(`people cluster "${cluster}" email "${p.email}" is invalid (must be a valid address or blank)`);
    }
    if (emailProvided) {
      if (!emailToClusters.has(email)) emailToClusters.set(email, []);
      emailToClusters.get(email).push(cluster);
    }

    const proposedName = String(p.proposed_name || '').trim();
    if ((dec.action === 'create-current' || dec.action === 'create-ex') && !proposedName) {
      errors.push(`create-* person "${cluster}" has empty proposed_name`);
    }

    const excludeRaw = String(p.exclude_1099 === null || p.exclude_1099 === undefined ? '' : p.exclude_1099).trim().toLowerCase();
    if (!EXCLUDE_VALUES.has(excludeRaw)) {
      errors.push(`people cluster "${cluster}" exclude_1099 "${p.exclude_1099}" invalid (yes|no|blank)`);
    }

    peopleActions.push({
      cluster,
      action: dec.action,
      existingId: dec.existingId,
      proposed_name: proposedName,
      email,
      emailProvided,
      phone: normalizePhoneImport(p.phone),
      preferred_method: String(p.preferred_method || '').trim(),
      preferred_handle: String(p.preferred_handle || '').trim(),
      exclude_1099: excludeRaw === 'yes',
      // (fix 4) blank cell = NO CHANGE; only explicit yes|no writes the flag, so a
      // blank must never silently strip an existing exclusion on existing/reuse.
      exclude_1099_provided: excludeRaw === 'yes' || excludeRaw === 'no',
      current_or_ex: String(p.current_or_ex || '').trim(),
    });
  }

  // Within-sheet duplicate emails.
  for (const [email, clusters] of emailToClusters.entries()) {
    if (clusters.length > 1) {
      errors.push(`duplicate email "${email}" within sheet (clusters ${clusters.join(', ')})`);
    }
  }

  // VECTOR 1 (b) / E1 belt: guard keyed on the FULL placeholder (slug + hash). With
  // the injective hash suffix two DISTINCT clusters can no longer collide, so this
  // now only catches a literal same-placeholder collision (already impossible via the
  // duplicate-cluster check) — kept as a cheap belt against a future scheme regression.
  const placeholderToClusters = new Map();
  for (const a of peopleActions) {
    if ((a.action === 'create-current' || a.action === 'create-ex') && !a.emailProvided) {
      const base = placeholderEmailBase(a.cluster);
      if (!placeholderToClusters.has(base)) placeholderToClusters.set(base, []);
      placeholderToClusters.get(base).push(a.cluster);
    }
  }
  for (const [base, clusters] of placeholderToClusters.entries()) {
    if (clusters.length > 1) {
      errors.push(`no-email create-* clusters ${clusters.map((c) => `"${c}"`).join(', ')} map to the same placeholder "${base}@imported.invalid" — give one a distinct cluster key or a real email`);
    }
  }

  // E3: two clusters that resolve to the SAME existing:<id> would attach two
  // different people's ledgers to one account — hard error, dedupe by target id.
  const existingIdToClusters = new Map();
  for (const a of peopleActions) {
    if (a.action === 'existing') {
      if (!existingIdToClusters.has(a.existingId)) existingIdToClusters.set(a.existingId, []);
      existingIdToClusters.get(a.existingId).push(a.cluster);
    }
  }
  for (const [id, clusters] of existingIdToClusters.entries()) {
    if (clusters.length > 1) {
      errors.push(`multiple clusters resolve to the same existing:${id} (clusters ${clusters.join(', ')}) — one target account per cluster`);
    }
  }

  const actionByCluster = new Map(peopleActions.map((a) => [a.cluster, a]));

  // ---- per-transaction resolution → toImport / toReconcile ------------------
  const toImport = [];
  const toReconcile = [];
  for (const t of transactions) {
    const fp = String(t.fingerprint || '').trim();
    const verdict = String(t.verdict || '').trim();
    if (verdict !== 'staff-pay') continue; // ignore/unsure never import

    const cluster = String(t.person_cluster || '').trim();
    if (!cluster) { errors.push(`staff-pay txn ${fp} has no person_cluster`); continue; }

    const fact = manifest[fp];
    if (!fact) { errors.push(`staff-pay txn ${fp} has no manifest entry (hand-added or mangled row)`); continue; }

    if (!peopleByCluster.has(cluster)) {
      errors.push(`staff-pay txn ${fp} person_cluster "${cluster}" matches no people row`);
      continue;
    }
    const action = actionByCluster.get(cluster); // absent only if that person already errored (skip/invalid)
    if (!action) continue;

    const amount = fact.amount_cents;
    if (!(Number.isInteger(amount) && amount > 0)) {
      errors.push(`staff-pay txn ${fp} has no positive integer amount_cents (unresolved currency?) — got ${JSON.stringify(amount)}`);
      continue;
    }

    const txnId = String(fact.txn_id === null || fact.txn_id === undefined ? '' : fact.txn_id).trim();
    if (fact.platform === 'cash_other' && !txnId) {
      errors.push(`cash_other staff-pay txn ${fp} has no txn_id (CC expense row id required)`);
      continue;
    }

    const boundaryException = String(t.boundary_exception || '').trim().toLowerCase() === 'yes';
    const row = {
      fingerprint: fp,
      cluster,
      paid_on: fact.date,
      amount_cents: amount,
      platform: fact.platform,
      source_account: fact.source_account,
      external_txn_id: txnId || null,
      payee_handle: fact.payee || null,
      memo: fact.memo || null,
      event_label: String(t.event_label || '').trim() || null,
      boundary_exception: boundaryException,
      source_file: fact.source_file,
    };

    if (!fact.post_boundary) {
      toImport.push(row);
    } else if (boundaryException) {
      toImport.push(row); // §4 escape hatch — flag carried to the INSERT
    } else {
      toReconcile.push({
        fingerprint: fp, cluster, paid_on: fact.date, amount_cents: amount,
        platform: fact.platform, event_label: row.event_label,
      });
    }
  }

  return { errors, toImport, toReconcile, peopleActions, skippedUnsure };
}

module.exports = {
  validateSheets,
  normalizeEmail,
  normalizePhoneImport,
  slugify,
  planPeopleEmails,
  parseAccountDecision,
  ymd,
  addDays,
  inPayoutWindow,
  checkBoundaryNoDoubleCount,
  checkAttachRole,
  checkPlaceholderNameMatch,
};

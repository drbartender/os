// Unit tests for the sheet-validation module (spec §4/§6/§7, plan C1). Pure, no
// DB: every case is an inline synthetic {manifest, people, transactions} triple.
// One test per rule + a fully-valid baseline. Facts come from the manifest;
// only human-judgment columns come from the CSV rows (Excel-proofing, §7.3).
// Run: node --test server/scripts/staffPaymentImport/importValidation.test.js
const test = require('node:test');
const assert = require('node:assert');
const {
  validateSheets, normalizePhoneImport, normalizeEmail, checkAttachRole,
  planPeopleEmails, checkBoundaryNoDoubleCount, checkPlaceholderNameMatch,
} = require('./importValidation');

// ---- a fully-valid baseline every rule-test mutates into one violation -------
function baseSet() {
  const manifest = {
    'fp-aaa': {
      date: '2025-04-12', amount_cents: 10500, platform: 'venmo', source_account: 'venmo_business',
      txn_id: '111', payee: 'Test Person', memo: 'Testman DrB 4/12', source_file: 'apr.csv', post_boundary: false,
    },
    'fp-bbb': {
      date: '2025-08-03', amount_cents: 20000, platform: 'zelle', source_account: 'chase_6835',
      txn_id: 'Jpm99', payee: 'Test Freyer', memo: null, source_file: 'aug.txt', post_boundary: false,
    },
    'fp-ccc': {
      date: '2025-05-01', amount_cents: 25000, platform: 'cash_other', source_account: 'cc_expense_log',
      txn_id: '101', payee: 'Test Buddy', memo: 'Staff Payment', source_file: 'cc-expenses.csv', post_boundary: false,
    },
  };
  const people = [
    {
      cluster: 'test person', proposed_name: 'Test Person', os_user_id: '', email: 'test.person@example.com',
      phone: '(555) 100-2000', current_or_ex: 'current', preferred_method: 'venmo', preferred_handle: '@testperson',
      account_decision: 'create-current', exclude_1099: 'no', txn_count: '1', total_usd: '105.00',
    },
    {
      cluster: 'test freyer', proposed_name: 'Test Freyer', os_user_id: '', email: '',
      phone: '', current_or_ex: 'ex', preferred_method: 'zelle', preferred_handle: '',
      account_decision: 'create-ex', exclude_1099: 'no', txn_count: '1', total_usd: '200.00',
    },
    {
      cluster: 'test buddy', proposed_name: 'Test Buddy', os_user_id: '', email: 'test.buddy@example.com',
      phone: '', current_or_ex: 'ex', preferred_method: 'cashapp', preferred_handle: '',
      account_decision: 'create-ex', exclude_1099: 'no', txn_count: '1', total_usd: '250.00',
    },
  ];
  const transactions = [
    { fingerprint: 'fp-aaa', person_cluster: 'test person', verdict: 'staff-pay', event_label: 'Smith Wedding', boundary_exception: 'no' },
    { fingerprint: 'fp-bbb', person_cluster: 'test freyer', verdict: 'staff-pay', event_label: '', boundary_exception: 'no' },
    { fingerprint: 'fp-ccc', person_cluster: 'test buddy', verdict: 'staff-pay', event_label: 'Doe Party', boundary_exception: 'no' },
  ];
  return { manifest, people, transactions };
}

// ---- the happy path ---------------------------------------------------------
test('fully-valid set: no errors, correct toImport/peopleActions', () => {
  const { errors, toImport, toReconcile, peopleActions } = validateSheets(baseSet());
  assert.deepStrictEqual(errors, [], `unexpected errors: ${errors.join(' | ')}`);
  assert.strictEqual(toImport.length, 3);
  assert.strictEqual(toReconcile.length, 0);
  assert.strictEqual(peopleActions.length, 3);

  const venmo = toImport.find((r) => r.fingerprint === 'fp-aaa');
  assert.strictEqual(venmo.amount_cents, 10500);        // fact from manifest
  assert.strictEqual(venmo.paid_on, '2025-04-12');
  assert.strictEqual(venmo.platform, 'venmo');
  assert.strictEqual(venmo.external_txn_id, '111');
  assert.strictEqual(venmo.payee_handle, 'Test Person');
  assert.strictEqual(venmo.event_label, 'Smith Wedding'); // human column
  assert.strictEqual(venmo.boundary_exception, false);
  assert.strictEqual(venmo.cluster, 'test person');

  const person = peopleActions.find((p) => p.cluster === 'test person');
  assert.strictEqual(person.action, 'create-current');
  assert.strictEqual(person.email, 'test.person@example.com');
  assert.strictEqual(person.emailProvided, true);
  assert.strictEqual(person.exclude_1099, false);
});

// ---- rule: every staff-pay txn resolves to a person -------------------------
test('staff-pay txn with blank person_cluster is an error', () => {
  const s = baseSet();
  s.transactions[0].person_cluster = '';
  const { errors } = validateSheets(s);
  assert.ok(errors.some((e) => /fp-aaa/.test(e) && /person_cluster/i.test(e)), errors.join(' | '));
});

test('staff-pay txn whose person_cluster matches no people row is an error', () => {
  const s = baseSet();
  s.transactions[0].person_cluster = 'ghost cluster';
  const { errors } = validateSheets(s);
  assert.ok(errors.some((e) => /fp-aaa/.test(e) && /matches no people row/i.test(e)), errors.join(' | '));
});

// ---- rule: staff-pay txn must have a manifest entry -------------------------
test('staff-pay txn with no manifest entry is an error (hand-added/mangled row)', () => {
  const s = baseSet();
  delete s.manifest['fp-aaa'];
  const { errors } = validateSheets(s);
  assert.ok(errors.some((e) => /fp-aaa/.test(e) && /manifest/i.test(e)), errors.join(' | '));
});

// ---- rule: skip person with staff-pay rows ----------------------------------
test('account_decision=skip on a person with staff-pay txns is an error', () => {
  const s = baseSet();
  s.people[0].account_decision = 'skip';
  const { errors } = validateSheets(s);
  assert.ok(errors.some((e) => /test person/.test(e) && /skip/i.test(e)), errors.join(' | '));
});

test('invalid account_decision value is an error', () => {
  const s = baseSet();
  s.people[0].account_decision = 'make-current';
  const { errors } = validateSheets(s);
  assert.ok(errors.some((e) => /test person/.test(e) && /account_decision/i.test(e)), errors.join(' | '));
});

// ---- rule: create-* needs a proposed_name -----------------------------------
test('create-* person with empty proposed_name is an error', () => {
  const s = baseSet();
  s.people[0].proposed_name = '';
  const { errors } = validateSheets(s);
  assert.ok(errors.some((e) => /test person/.test(e) && /proposed_name/i.test(e)), errors.join(' | '));
});

// ---- rule: email valid-or-blank; blank is allowed ---------------------------
test('create-* person with an invalid email is an error', () => {
  const s = baseSet();
  s.people[0].email = 'not-an-email';
  const { errors } = validateSheets(s);
  assert.ok(errors.some((e) => /test person/.test(e) && /email/i.test(e)), errors.join(' | '));
});

test('blank email on a create-* person is allowed (placeholder generated later)', () => {
  const s = baseSet();
  s.people[0].email = '';
  const { errors, peopleActions } = validateSheets(s);
  assert.deepStrictEqual(errors, []);
  const person = peopleActions.find((p) => p.cluster === 'test person');
  assert.strictEqual(person.emailProvided, false);
  assert.strictEqual(person.email, '');
});

// ---- rule: no duplicate emails within the sheet -----------------------------
test('duplicate email within the sheet is an error', () => {
  const s = baseSet();
  s.people[2].email = 'test.person@example.com'; // same as person[0]
  const { errors } = validateSheets(s);
  assert.ok(errors.some((e) => /duplicate email/i.test(e) && /test\.person@example\.com/.test(e)), errors.join(' | '));
});

// ---- rule: phone / email normalization --------------------------------------
test('a +63 phone is preserved verbatim (never US-normalized)', () => {
  assert.strictEqual(normalizePhoneImport('+63 917 555 1234'), '+639175551234');
  assert.strictEqual(normalizePhoneImport('  +63-917-555-1234 '), '+639175551234');
});

test('a US phone is stripped to digits (formatting removed)', () => {
  assert.strictEqual(normalizePhoneImport('(555) 100-2000'), '5551002000');
});

test('emails are trimmed + lowercased on read', () => {
  assert.strictEqual(normalizeEmail('  Test.Person@Example.COM '), 'test.person@example.com');
  const s = baseSet();
  s.people[0].email = '  Test.Person@Example.COM ';
  const { peopleActions } = validateSheets(s);
  assert.strictEqual(peopleActions.find((p) => p.cluster === 'test person').email, 'test.person@example.com');
});

// ---- rule: boundary routing -------------------------------------------------
test('post_boundary=false rows go to toImport', () => {
  const { toImport } = validateSheets(baseSet());
  assert.ok(toImport.every((r) => r.boundary_exception === false));
  assert.strictEqual(toImport.length, 3);
});

test('post_boundary=true + staff-pay + boundary_exception=yes goes to toImport with the flag', () => {
  const s = baseSet();
  s.manifest['fp-aaa'].post_boundary = true;
  s.transactions[0].boundary_exception = 'yes';
  const { errors, toImport, toReconcile } = validateSheets(s);
  assert.deepStrictEqual(errors, []);
  const row = toImport.find((r) => r.fingerprint === 'fp-aaa');
  assert.ok(row, 'exception row is imported');
  assert.strictEqual(row.boundary_exception, true);
  assert.ok(!toReconcile.some((r) => r.fingerprint === 'fp-aaa'));
});

test('post_boundary=true + staff-pay without the flag goes to toReconcile, not toImport', () => {
  const s = baseSet();
  s.manifest['fp-aaa'].post_boundary = true;
  s.transactions[0].boundary_exception = 'no';
  const { toImport, toReconcile } = validateSheets(s);
  assert.ok(!toImport.some((r) => r.fingerprint === 'fp-aaa'), 'not imported');
  assert.ok(toReconcile.some((r) => r.fingerprint === 'fp-aaa'), 'reconciled');
});

// ---- rule: amount_cents positive integer ------------------------------------
test('staff-pay txn with a null/blank amount_cents (unresolved PHP) is an error', () => {
  const s = baseSet();
  s.manifest['fp-aaa'].amount_cents = null;
  const { errors } = validateSheets(s);
  assert.ok(errors.some((e) => /fp-aaa/.test(e) && /amount/i.test(e)), errors.join(' | '));
});

test('staff-pay txn with a non-positive amount_cents is an error', () => {
  const s = baseSet();
  s.manifest['fp-aaa'].amount_cents = 0;
  const { errors } = validateSheets(s);
  assert.ok(errors.some((e) => /fp-aaa/.test(e) && /amount/i.test(e)), errors.join(' | '));
});

// ---- rule: no duplicate fingerprints ----------------------------------------
test('a duplicate fingerprint in transactions is an error', () => {
  const s = baseSet();
  s.transactions.push({ fingerprint: 'fp-aaa', person_cluster: 'test person', verdict: 'staff-pay', event_label: '', boundary_exception: 'no' });
  const { errors } = validateSheets(s);
  assert.ok(errors.some((e) => /duplicate fingerprint/i.test(e) && /fp-aaa/.test(e)), errors.join(' | '));
});

// ---- rule: verdict enum -----------------------------------------------------
test('an invalid verdict value is an error', () => {
  const s = baseSet();
  s.transactions[0].verdict = 'maybe-pay';
  const { errors } = validateSheets(s);
  assert.ok(errors.some((e) => /fp-aaa/.test(e) && /verdict/i.test(e)), errors.join(' | '));
});

// ---- rule: exclude_1099 enum ------------------------------------------------
test('an invalid exclude_1099 value is an error', () => {
  const s = baseSet();
  s.people[0].exclude_1099 = 'maybe';
  const { errors } = validateSheets(s);
  assert.ok(errors.some((e) => /test person/.test(e) && /exclude_1099/i.test(e)), errors.join(' | '));
});

test('exclude_1099=yes sets the person action flag true; blank is false', () => {
  const s = baseSet();
  s.people[0].exclude_1099 = 'yes';
  s.people[1].exclude_1099 = '';
  const { peopleActions } = validateSheets(s);
  assert.strictEqual(peopleActions.find((p) => p.cluster === 'test person').exclude_1099, true);
  assert.strictEqual(peopleActions.find((p) => p.cluster === 'test freyer').exclude_1099, false);
});

// ---- rule: cash_other must carry a txn id -----------------------------------
test('cash_other staff-pay row without a txn_id is an error', () => {
  const s = baseSet();
  s.manifest['fp-ccc'].txn_id = '';
  const { errors } = validateSheets(s);
  assert.ok(errors.some((e) => /fp-ccc/.test(e) && /cash_other/i.test(e) && /txn/i.test(e)), errors.join(' | '));
});

// ---- rule: existing:<id> resolution -----------------------------------------
test('existing:<id> resolves to an existingId int on the person action', () => {
  const s = baseSet();
  s.people[0].account_decision = 'existing:37';
  const { errors, peopleActions } = validateSheets(s);
  assert.deepStrictEqual(errors, []);
  const person = peopleActions.find((p) => p.cluster === 'test person');
  assert.strictEqual(person.action, 'existing');
  assert.strictEqual(person.existingId, 37);
});

test('a malformed existing:<id> (non-integer) is an error', () => {
  const s = baseSet();
  s.people[0].account_decision = 'existing:abc';
  const { errors } = validateSheets(s);
  assert.ok(errors.some((e) => /test person/.test(e) && /existing/i.test(e)), errors.join(' | '));
});

test('existing:<id> in scientific/hex/decimal notation is rejected (plain digits only)', () => {
  for (const bad of ['existing:1e3', 'existing:0x1', 'existing:1.0', 'existing:+5']) {
    const s = baseSet();
    s.people[0].account_decision = bad;
    const { errors } = validateSheets(s);
    assert.ok(errors.some((e) => /test person/.test(e) && /existing/i.test(e)), `${bad} should error: ${errors.join(' | ')}`);
  }
});

// ---- existing:<id> role guard (fix 3, pure) ---------------------------------
test('checkAttachRole: staff and manager attach silently', () => {
  assert.deepStrictEqual(checkAttachRole({ id: 3, role: 'staff', email: 's@x.com' }, new Set()), { ok: true, error: null });
  assert.deepStrictEqual(checkAttachRole({ id: 8, role: 'manager', email: 'm@x.com' }, new Set()), { ok: true, error: null });
});

test('checkAttachRole: admin is refused unless allowlisted, and the error names the flag', () => {
  const refused = checkAttachRole({ id: 57, role: 'admin', email: 'zul@drbartender.com' }, new Set());
  assert.strictEqual(refused.ok, false);
  assert.match(refused.error, /existing:57 is an admin account \(zul@drbartender\.com\)/);
  assert.match(refused.error, /--allow-admin-ids=57/);
});

test('checkAttachRole: an allowlisted admin id attaches', () => {
  assert.deepStrictEqual(checkAttachRole({ id: 57, role: 'admin', email: 'zul@drbartender.com' }, new Set([57])), { ok: true, error: null });
});

// ---- ignore / unsure rows never import --------------------------------------
test('ignore and unsure rows are neither imported nor reconciled', () => {
  const s = baseSet();
  s.transactions[0].verdict = 'ignore';
  s.transactions[1].verdict = 'unsure';
  const { errors, toImport } = validateSheets(s);
  assert.deepStrictEqual(errors, []);
  assert.ok(!toImport.some((r) => r.fingerprint === 'fp-aaa'));
  assert.ok(!toImport.some((r) => r.fingerprint === 'fp-bbb'));
  assert.strictEqual(toImport.length, 1); // only the cash_other staff-pay row
});

// ==== hardening: identity-swap vector + smaller fixes ========================

// VECTOR 1 (a) / E1: placeholder emails are keyed on the CLUSTER with an INJECTIVE
// sha256 suffix — slugify alone is lossy, so a readable slug + hash of the exact
// cluster key keeps the human-readable part while guaranteeing distinct clusters
// get distinct emails. Placeholders stay order-independent.
test('planPeopleEmails keys placeholders on the cluster with an injective hash suffix', () => {
  const a = { cluster: 'jo ann', action: 'create-current', emailProvided: false, email: '', proposed_name: 'Jo-Ann' };
  const b = { cluster: 'joann', action: 'create-ex', emailProvided: false, email: '', proposed_name: 'Jo Ann' };
  const fwd = planPeopleEmails([a, b]);
  const rev = planPeopleEmails([b, a]);
  assert.match(fwd.get('jo ann'), /^jo-ann-[0-9a-f]{8}@imported\.invalid$/);
  assert.match(fwd.get('joann'), /^joann-[0-9a-f]{8}@imported\.invalid$/);
  assert.notStrictEqual(fwd.get('jo ann'), fwd.get('joann'), 'distinct clusters get distinct placeholders');
  assert.strictEqual(fwd.get('jo ann'), rev.get('jo ann'), 'order-independent');
  assert.strictEqual(fwd.get('joann'), rev.get('joann'), 'order-independent');
});

// E1 residue: slugify is LOSSY (non-ASCII collapses). Assigned in isolation (as
// separate runs would), lossy/non-Latin cluster keys must still get DISTINCT
// emails — the hash of the exact cluster key makes identity truly injective.
test('planPeopleEmails is injective over lossy / non-ASCII cluster keys (cross-run)', () => {
  const emailFor = (cluster) => planPeopleEmails([{ cluster, action: 'create-current', emailProvided: false, email: '', proposed_name: 'x' }]).get(cluster);
  assert.notStrictEqual(emailFor('josé'), emailFor('josè'), "'josé' and 'josè' both slugify to 'jos'");
  assert.notStrictEqual(emailFor('李伟'), emailFor('王芳'), 'all-non-Latin clusters both slugify to "imported"');
});

// E1: with injective emails, two clusters that slugify identically are NO LONGER an
// error — they get distinct emails via the hash suffix. (The within-sheet guard now
// keys on the full placeholder, so it only catches literal cluster-key dupes.)
test('two no-email clusters that slugify identically now get distinct injective emails (no slug error)', () => {
  const s = baseSet();
  s.people[0].cluster = 'joe x'; s.people[0].email = ''; s.people[0].proposed_name = 'Joe X';
  s.people[1].cluster = 'joe-x'; s.people[1].email = ''; s.people[1].proposed_name = 'Joe Ex';
  s.transactions[0].person_cluster = 'joe x';
  s.transactions[1].person_cluster = 'joe-x';
  const { errors, peopleActions } = validateSheets(s);
  assert.deepStrictEqual(errors.filter((e) => /slugif/i.test(e)), [], `unexpected slug error: ${errors.join(' | ')}`);
  const m = planPeopleEmails(peopleActions);
  assert.notStrictEqual(m.get('joe x'), m.get('joe-x'));
});

// E1 (b) belt (now a WARN, not a hard error): the pure check still flags a mismatch
// between the existing profile name and the sheet name (used for a printed warning).
test('checkPlaceholderNameMatch: matching name slugs pass; a mismatch is flagged (naming both) for a WARN', () => {
  assert.deepStrictEqual(
    checkPlaceholderNameMatch({ email: 'jo-ann@imported.invalid', profileName: 'Jo Ann', proposedName: 'Jo-Ann' }),
    { ok: true, error: null },
  );
  const bad = checkPlaceholderNameMatch({ email: 'jo-ann@imported.invalid', profileName: 'Jo Ann', proposedName: 'Bob Smith' });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /placeholder identity mismatch/i);
  assert.match(bad.error, /jo-ann@imported\.invalid/);
  assert.match(bad.error, /Jo Ann/);
  assert.match(bad.error, /Bob Smith/);
});

// E3: two clusters resolving to the same existing:<id> would attach two people's
// ledgers to one account — hard error. Distinct ids are fine.
test('two clusters resolving to the same existing:<id> is an error; distinct ids are fine', () => {
  const dup = baseSet();
  dup.people[0].account_decision = 'existing:37';
  dup.people[1].account_decision = 'existing:37';
  const { errors: dupErrors } = validateSheets(dup);
  assert.ok(dupErrors.some((e) => /existing:37/.test(e) && /(same|multiple|resolve)/i.test(e)),
    `expected a duplicate-existing error, got: ${dupErrors.join(' | ')}`);

  const ok = baseSet();
  ok.people[0].account_decision = 'existing:37';
  ok.people[1].account_decision = 'existing:38';
  const { errors: okErrors } = validateSheets(ok);
  assert.ok(!okErrors.some((e) => /resolve to existing/i.test(e)),
    `distinct ids should not error, got: ${okErrors.join(' | ')}`);
});

// FIX 5: unsure-verdict rows are skipped, but the count must be surfaced.
test('validateSheets counts unsure-verdict rows as skippedUnsure', () => {
  const s = baseSet();
  s.transactions[0].verdict = 'unsure';
  s.transactions[1].verdict = 'unsure';
  const { skippedUnsure } = validateSheets(s);
  assert.strictEqual(skippedUnsure, 2);
});

// FIX 4: a blank exclude_1099 cell means NO CHANGE — only explicit yes/no write
// the flag. peopleActions must carry whether the flag was explicitly provided.
test('exclude_1099 blank is "no change" (exclude_1099_provided=false); explicit yes/no is provided', () => {
  const s = baseSet();
  s.people[0].exclude_1099 = 'yes'; // test person
  s.people[1].exclude_1099 = '';    // test freyer — blank = no change
  s.people[2].exclude_1099 = 'no';  // test buddy
  const { peopleActions } = validateSheets(s);
  const person = peopleActions.find((p) => p.cluster === 'test person');
  const freyer = peopleActions.find((p) => p.cluster === 'test freyer');
  const buddy = peopleActions.find((p) => p.cluster === 'test buddy');
  assert.strictEqual(person.exclude_1099_provided, true);
  assert.strictEqual(person.exclude_1099, true);
  assert.strictEqual(freyer.exclude_1099_provided, false); // blank → no change
  assert.strictEqual(buddy.exclude_1099_provided, true);
  assert.strictEqual(buddy.exclude_1099, false);
});

// FIX 3: the pure boundary no-double-count assert now lives in importValidation
// (so importFromSheet can run it INSIDE its transaction without a require cycle).
test('checkBoundaryNoDoubleCount is exported from importValidation and flags an in-window clash', () => {
  const payout = { id: 5, contractor_id: 99, total_cents: 20000, start_date: '2026-06-01', payday: '2026-06-09' };
  const row = { row_fingerprint: 'fp-x', contractor_id: 99, amount_cents: 20000, paid_on: '2026-06-09' };
  const f = checkBoundaryNoDoubleCount([row], [payout]);
  assert.strictEqual(f.length, 1);
  assert.match(f[0], /would double-count/);
});

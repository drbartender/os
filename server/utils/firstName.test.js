const test = require('node:test');
const assert = require('node:assert');
const { firstNameOf } = require('./firstName');

// ── One person ──────────────────────────────────────────────────────────

test('narrows a full name to the first name', () => {
  assert.strictEqual(firstNameOf('Monica Donnely'), 'Monica');
});

test('a single-word name is returned as-is', () => {
  assert.strictEqual(firstNameOf('Monica'), 'Monica');
});

test('skips a leading title', () => {
  assert.strictEqual(firstNameOf('Dr. Monica Donnely'), 'Monica');
  assert.strictEqual(firstNameOf('mr monica'), 'monica');
});

test('a name that is ONLY a title falls back rather than greeting the title', () => {
  assert.strictEqual(firstNameOf('Dr.'), 'there');
});

test('a multi-part surname does not leak into the greeting', () => {
  assert.strictEqual(firstNameOf('Maria de la Cruz'), 'Maria');
});

// ── Couples: the case this helper exists to protect ──────────────────────
// Nine client rows are stored "First & First". Dropping the partner would hit
// them on every proposal, signed, payment, past-due and event-eve email.

test('an ampersand couple keeps both people', () => {
  assert.strictEqual(firstNameOf('Aubrey & Dominic'), 'Aubrey & Dominic');
});

test('an "and" couple keeps both people, and keeps the word "and"', () => {
  assert.strictEqual(firstNameOf('Jennifer and David'), 'Jennifer and David');
});

test('a plus couple keeps both people', () => {
  assert.strictEqual(firstNameOf('Taylor + Noah'), 'Taylor + Noah');
});

test('each side of a couple is narrowed on its own', () => {
  assert.strictEqual(firstNameOf('Aubrey Smith & Dominic Jones'), 'Aubrey & Dominic');
});

test('a title on either side of a couple is skipped', () => {
  assert.strictEqual(firstNameOf('Dr. Aubrey Smith & Mr. Dominic Jones'), 'Aubrey & Dominic');
});

test('a three-way name keeps every joiner verbatim', () => {
  assert.strictEqual(firstNameOf('Ann & Bob and Cara'), 'Ann & Bob and Cara');
});

test('a half-empty couple degrades to the one real name', () => {
  assert.strictEqual(firstNameOf('Aubrey & '), 'Aubrey');
  assert.strictEqual(firstNameOf(' & Dominic'), 'Dominic');
});

test('a name merely CONTAINING the joiner letters is never split', () => {
  assert.strictEqual(firstNameOf('Alexander Hamilton'), 'Alexander');
  assert.strictEqual(firstNameOf('Andrea Rossi'), 'Andrea');
  assert.strictEqual(firstNameOf('Sandra Land'), 'Sandra');
});

// ── Idempotency ─────────────────────────────────────────────────────────
// Load-bearing: some callers pass an already-narrowed clientFirstName, most
// pass a full client_name, and the helper is applied at the greeting either way.

test('re-applying the helper changes nothing', () => {
  for (const input of ['Monica Donnely', 'Aubrey & Dominic', 'Jennifer and David', 'Dr.', '']) {
    const once = firstNameOf(input);
    assert.strictEqual(firstNameOf(once), once, `not idempotent for ${JSON.stringify(input)}`);
  }
});

// ── Empty and hostile input ─────────────────────────────────────────────

test('null, undefined, empty and whitespace all reach the fallback', () => {
  assert.strictEqual(firstNameOf(null), 'there');
  assert.strictEqual(firstNameOf(undefined), 'there');
  assert.strictEqual(firstNameOf(''), 'there');
  assert.strictEqual(firstNameOf('   '), 'there');
});

test('punctuation-only input never becomes the greeting', () => {
  assert.strictEqual(firstNameOf('&'), 'there');
  assert.strictEqual(firstNameOf('- -'), 'there');
});

test('surrounding whitespace is trimmed', () => {
  assert.strictEqual(firstNameOf('  Monica Donnely  '), 'Monica');
});

test('the fallback is overridable', () => {
  assert.strictEqual(firstNameOf(null, 'friend'), 'friend');
});

// ── Non-ASCII ───────────────────────────────────────────────────────────
// This helper deliberately does NOT inherit the ASCII-only NAME_CHARS rule
// from staffDisplayName.validate.js; a greeting must work for any script.

test('non-ASCII names are unaffected', () => {
  assert.strictEqual(firstNameOf('Zoë Baker'), 'Zoë');
  assert.strictEqual(firstNameOf('José Álvarez'), 'José');
  assert.strictEqual(firstNameOf('李 小龍'), '李');
  assert.strictEqual(firstNameOf('Zoë & José'), 'Zoë & José');
});

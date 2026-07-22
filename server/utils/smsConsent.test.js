const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SMS_CONSENT_VERSION, getConsentCopy } = require('../data/smsConsentCopy');

/**
 * Pull an exported string literal out of the client constants file and
 * concatenate its adjacent-literal pieces, so the test compares the resolved
 * sentence rather than the source formatting. The client file is ESM inside
 * CRA and cannot be required from node, so it is read as text.
 */
function readClientConstant(source, name) {
  const start = source.indexOf(`export const ${name} =`);
  assert.ok(start !== -1, `${name} not found in client constant file`);
  const end = source.indexOf(';', start);
  assert.ok(end !== -1, `${name} declaration is unterminated`);
  const body = source.slice(start, end);
  const pieces = body.match(/'((?:[^'\\]|\\.)*)'/g) || [];
  return pieces
    .map(p => p.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
    .join('');
}

const CLIENT_CONSTANT_PATH = path.join(
  __dirname, '..', '..', 'client', 'src', 'constants', 'smsConsent.js'
);

test('sms consent copy > client and server agree on the sentence', () => {
  const source = fs.readFileSync(CLIENT_CONSTANT_PATH, 'utf8');
  // The client splits the sentence into LEAD + TAIL so the checkbox can render
  // the tail as links; reconstructing it here is what proves the rendered
  // sentence still equals the text we store in sms_consent_log.
  const lead = readClientConstant(source, 'SMS_CONSENT_LEAD');
  const tail = readClientConstant(source, 'SMS_CONSENT_TAIL');
  assert.ok(lead.length > 100, 'LEAD extraction produced nothing usable');
  assert.ok(tail.length > 5, 'TAIL extraction produced nothing usable');
  assert.strictEqual(lead + tail, getConsentCopy(SMS_CONSENT_VERSION));
});

test('sms consent copy > SMS_CONSENT_CLIENT is composed, never retyped', () => {
  const source = fs.readFileSync(CLIENT_CONSTANT_PATH, 'utf8');
  // A retyped third copy is exactly the drift this module exists to prevent.
  assert.match(
    source,
    /export const SMS_CONSENT_CLIENT = SMS_CONSENT_LEAD \+ SMS_CONSENT_TAIL;/
  );
});

test('sms consent copy > client and server agree on the version', () => {
  const source = fs.readFileSync(CLIENT_CONSTANT_PATH, 'utf8');
  const match = source.match(/export const SMS_CONSENT_VERSION = '([^']+)'/);
  assert.ok(match, 'SMS_CONSENT_VERSION not found in client constant file');
  assert.strictEqual(match[1], SMS_CONSENT_VERSION);
});

test('sms consent copy > carries the required disclosures', () => {
  const copy = getConsentCopy(SMS_CONSENT_VERSION);
  assert.match(copy, /Dr\. Bartender/);
  assert.match(copy, /Message frequency varies/);
  assert.match(copy, /Msg & data rates may apply/);
  assert.match(copy, /Reply STOP to opt out, HELP for help/);
  assert.match(copy, /not a condition of purchase/);
  assert.doesNotMatch(copy, /—/, 'no em dashes in client-facing copy');
});

test('sms consent copy > an unknown version resolves to null', () => {
  assert.strictEqual(getConsentCopy('v99'), null);
});

test('sms consent copy > prototype keys are not versions', () => {
  // `version` comes off an unauthenticated request body. A bare MAP[version]
  // walks the prototype chain, and every one of these returns something truthy
  // that would sail past the caller's `if (!copyText)` guard and land a
  // function's source text in the compliance log.
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.strictEqual(getConsentCopy(key), null, `${key} must not resolve`);
  }
  for (const bad of [null, undefined, 1, {}, []]) {
    assert.strictEqual(getConsentCopy(bad), null);
  }
});

// ─── recordSmsConsent ────────────────────────────────────────────

const { pool } = require('../db');
const {
  recordSmsConsent, consentFieldsFromBody, requestMeta,
} = require('./smsConsent');

let fixtureSeq = 0;
async function makeClient(phone) {
  fixtureSeq += 1;
  const r = await pool.query(
    'INSERT INTO clients (name, email, phone) VALUES ($1, $2, $3) RETURNING id',
    ['Consent Fixture', `consent-${process.pid}-${fixtureSeq}@example.invalid`, phone]
  );
  return r.rows[0].id;
}

async function cleanupClient(clientId) {
  await pool.query('DELETE FROM sms_consent_log WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
}

test('recordSmsConsent > consent true sets sms_enabled and stamps sms_opt_in_at', async (t) => {
  const clientId = await makeClient('3125550101');
  t.after(() => cleanupClient(clientId));

  const result = await recordSmsConsent(pool, {
    clientId, subjectIsNew: true, phone: '3125550101', consented: true,
    version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard',
    ip: '203.0.113.9', userAgent: 'test-agent',
  });
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.logged, true);

  const row = await pool.query('SELECT communication_preferences AS p FROM clients WHERE id = $1', [clientId]);
  assert.strictEqual(row.rows[0].p.sms_enabled, true);
  assert.ok(row.rows[0].p.sms_opt_in_at, 'sms_opt_in_at stamped');

  const log = await pool.query('SELECT * FROM sms_consent_log WHERE client_id = $1', [clientId]);
  assert.strictEqual(log.rows.length, 1);
  assert.strictEqual(log.rows[0].consented, true);
  assert.strictEqual(log.rows[0].source_form, 'quote_wizard');
  assert.strictEqual(log.rows[0].copy_text, getConsentCopy(SMS_CONSENT_VERSION));
  assert.strictEqual(log.rows[0].ip, '203.0.113.9');
});

test('recordSmsConsent > consent false disables sms and stamps sms_opt_out_at', async (t) => {
  const clientId = await makeClient('3125550102');
  t.after(() => cleanupClient(clientId));

  await recordSmsConsent(pool, {
    clientId, subjectIsNew: true, phone: '3125550102', consented: false,
    version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard',
  });

  const row = await pool.query('SELECT communication_preferences AS p FROM clients WHERE id = $1', [clientId]);
  assert.strictEqual(row.rows[0].p.sms_enabled, false);
  assert.ok(row.rows[0].p.sms_opt_out_at, 'sms_opt_out_at stamped');

  const log = await pool.query('SELECT consented FROM sms_consent_log WHERE client_id = $1', [clientId]);
  assert.strictEqual(log.rows[0].consented, false);
});

test('recordSmsConsent > an unchanged repeat submit does not append a duplicate row', async (t) => {
  const clientId = await makeClient('3125550103');
  t.after(() => cleanupClient(clientId));

  const args = {
    clientId, subjectIsNew: true, phone: '3125550103', consented: true,
    version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard',
  };
  const first = await recordSmsConsent(pool, args);
  const second = await recordSmsConsent(pool, args);

  assert.strictEqual(first.logged, true);
  assert.strictEqual(second.logged, false, 'same value + same version appends nothing');

  const log = await pool.query('SELECT id FROM sms_consent_log WHERE client_id = $1', [clientId]);
  assert.strictEqual(log.rows.length, 1);
});

test('recordSmsConsent > a changed answer appends a second row', async (t) => {
  const clientId = await makeClient('3125550104');
  t.after(() => cleanupClient(clientId));

  const base = { clientId, subjectIsNew: true, phone: '3125550104', version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard' };
  await recordSmsConsent(pool, { ...base, consented: true });
  await recordSmsConsent(pool, { ...base, consented: false });

  const log = await pool.query(
    'SELECT consented FROM sms_consent_log WHERE client_id = $1 ORDER BY id ASC', [clientId]
  );
  assert.deepStrictEqual(log.rows.map(r => r.consented), [true, false]);
});

test('recordSmsConsent > an unknown version is refused, nothing is written', async (t) => {
  const clientId = await makeClient('3125550105');
  t.after(() => cleanupClient(clientId));

  const result = await recordSmsConsent(pool, {
    clientId, subjectIsNew: true, phone: '3125550105', consented: true,
    version: 'v99', sourceForm: 'quote_wizard',
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'unknown_version');

  const log = await pool.query('SELECT id FROM sms_consent_log WHERE client_id = $1', [clientId]);
  assert.strictEqual(log.rows.length, 0);

  const row = await pool.query('SELECT communication_preferences AS p FROM clients WHERE id = $1', [clientId]);
  assert.strictEqual(row.rows[0].p.sms_enabled, true, 'default untouched');
});

test('recordSmsConsent > a missing clientId is a no-op, never a throw', async () => {
  const r = await recordSmsConsent(pool, {
    clientId: null, subjectIsNew: true, phone: '3125550106', consented: true,
    version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard',
  });
  assert.strictEqual(r.applied, false);
  assert.strictEqual(r.reason, 'no_client');
});

test('recordSmsConsent > an EXISTING client is never touched by a public form', async (t) => {
  // THE TAKEOVER GUARD. findOrCreateClient resolves a row by email alone on an
  // unauthenticated endpoint, so anyone who knows a client's email is handed
  // their row. Writing to it would let a stranger flip a real client's SMS,
  // resurrect an opt-out, and forge a row in the log we hand a carrier.
  const clientId = await makeClient('3125550107');
  t.after(() => cleanupClient(clientId));

  const before = await pool.query('SELECT communication_preferences AS p FROM clients WHERE id = $1', [clientId]);

  const result = await recordSmsConsent(pool, {
    clientId, subjectIsNew: false, phone: '9995550000', consented: true,
    version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard',
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.logged, false);
  assert.strictEqual(result.reason, 'existing_client');

  const after = await pool.query('SELECT communication_preferences AS p FROM clients WHERE id = $1', [clientId]);
  assert.deepStrictEqual(after.rows[0].p, before.rows[0].p, 'preferences untouched');

  const log = await pool.query('SELECT id FROM sms_consent_log WHERE client_id = $1', [clientId]);
  assert.strictEqual(log.rows.length, 0, 'no forged audit row');
});

test('recordSmsConsent > a prior opt-out is never lifted by a form post', async (t) => {
  const clientId = await makeClient('3125550108');
  t.after(() => cleanupClient(clientId));

  // Simulate an inbound STOP, exactly as smsInbound.js writes it.
  await pool.query(
    `UPDATE clients SET communication_preferences = jsonb_set(
        jsonb_set(communication_preferences, '{sms_enabled}', 'false'::jsonb),
        '{sms_opt_out_at}', to_jsonb(NOW()::text))
      WHERE id = $1`, [clientId]);

  const result = await recordSmsConsent(pool, {
    clientId, subjectIsNew: true, phone: '3125550108', consented: true,
    version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard',
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'prior_opt_out');

  const row = await pool.query('SELECT communication_preferences AS p FROM clients WHERE id = $1', [clientId]);
  assert.strictEqual(row.rows[0].p.sms_enabled, false, 'STOP still holds');
});

test('recordSmsConsent > a STOP on ANOTHER row carrying the same number blocks the write', async (t) => {
  // subjectIsNew proves row ownership, not PHONE ownership. Pairing a throwaway
  // email with someone else's real number yields a brand-new row that passes
  // the gate, and would otherwise write consent evidence for a number that had
  // already texted STOP. Consent is keyed by phone, so the guard must be too.
  const victimId = await makeClient('3125550120');
  await pool.query(
    `UPDATE clients SET communication_preferences = jsonb_set(
        jsonb_set(communication_preferences, '{sms_enabled}', 'false'::jsonb),
        '{sms_opt_out_at}', to_jsonb(NOW()::text))
      WHERE id = $1`, [victimId]);

  // The attacker's freshly created row: different client, same number.
  const attackerRowId = await makeClient('3125550120');
  t.after(async () => { await cleanupClient(attackerRowId); await cleanupClient(victimId); });

  const result = await recordSmsConsent(pool, {
    clientId: attackerRowId, subjectIsNew: true, phone: '(312) 555-0120', consented: true,
    version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard',
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'prior_opt_out');

  const log = await pool.query('SELECT id FROM sms_consent_log WHERE client_id = $1', [attackerRowId]);
  assert.strictEqual(log.rows.length, 0, 'no forged consent evidence for an opted-out number');

  const victim = await pool.query('SELECT communication_preferences AS p FROM clients WHERE id = $1', [victimId]);
  assert.strictEqual(victim.rows[0].p.sms_enabled, false, "victim's STOP still holds");
});

test('recordSmsConsent > an unrelated number is unaffected by another client STOP', async (t) => {
  // The guard must be scoped to the submitted number, not a blanket block.
  const stoppedId = await makeClient('3125550121');
  await pool.query(
    `UPDATE clients SET communication_preferences =
        jsonb_set(communication_preferences, '{sms_opt_out_at}', to_jsonb(NOW()::text))
      WHERE id = $1`, [stoppedId]);
  const freshId = await makeClient('3125550122');
  t.after(async () => { await cleanupClient(freshId); await cleanupClient(stoppedId); });

  const result = await recordSmsConsent(pool, {
    clientId: freshId, subjectIsNew: true, phone: '3125550122', consented: true,
    version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard',
  });
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.logged, true);
});

test('recordSmsConsent > no usable phone means nothing is recorded', async (t) => {
  const clientId = await makeClient(null);
  t.after(() => cleanupClient(clientId));

  for (const bad of ['', null, '911', 'abc']) {
    const r = await recordSmsConsent(pool, {
      clientId, subjectIsNew: true, phone: bad, consented: true,
      version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard',
    });
    assert.strictEqual(r.applied, false, `${JSON.stringify(bad)} must not record`);
    assert.strictEqual(r.reason, 'no_phone');
  }
  const log = await pool.query('SELECT id FROM sms_consent_log WHERE client_id = $1', [clientId]);
  assert.strictEqual(log.rows.length, 0);
});

test('recordSmsConsent > the stored phone is normalized to 10 digits', async (t) => {
  const clientId = await makeClient('3125550109');
  t.after(() => cleanupClient(clientId));

  await recordSmsConsent(pool, {
    clientId, subjectIsNew: true, phone: '(312) 555-0109', consented: true,
    version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard',
  });
  const log = await pool.query('SELECT phone FROM sms_consent_log WHERE client_id = $1', [clientId]);
  assert.strictEqual(log.rows[0].phone, '3125550109', 'raw body formatting must not reach the audit row');
});

test('recordSmsConsent > a different number earns its own row', async (t) => {
  // Consent evidence is per number, not per person.
  const clientId = await makeClient('3125550110');
  t.after(() => cleanupClient(clientId));

  const base = { clientId, subjectIsNew: true, consented: true, version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard' };
  await recordSmsConsent(pool, { ...base, phone: '3125550110' });
  const second = await recordSmsConsent(pool, { ...base, phone: '3125550111' });

  assert.strictEqual(second.logged, true);
  const log = await pool.query('SELECT phone FROM sms_consent_log WHERE client_id = $1 ORDER BY id ASC', [clientId]);
  assert.deepStrictEqual(log.rows.map(r => r.phone), ['3125550110', '3125550111']);
});

test('consentFieldsFromBody > absent consent fields return null', () => {
  assert.strictEqual(consentFieldsFromBody({}), null);
  assert.strictEqual(consentFieldsFromBody({ sms_consent: undefined }), null);
});

test('consentFieldsFromBody > accepts the JSON boolean from the quote wizard', () => {
  assert.deepStrictEqual(
    consentFieldsFromBody({ sms_consent: true, sms_consent_version: 'v1' }),
    { consented: true, version: 'v1' }
  );
  assert.deepStrictEqual(
    consentFieldsFromBody({ sms_consent: false, sms_consent_version: 'v1' }),
    { consented: false, version: 'v1' }
  );
});

test("consentFieldsFromBody > accepts a multipart 'true' as well as the boolean", () => {
  // The quote wizard posts JSON, but any future multipart caller stringifies
  // every field. Both spellings are accepted so a strict === true check cannot
  // silently drop a real opt-in.
  assert.deepStrictEqual(
    consentFieldsFromBody({ sms_consent: 'true', sms_consent_version: 'v1' }),
    { consented: true, version: 'v1' }
  );
  assert.deepStrictEqual(
    consentFieldsFromBody({ sms_consent: 'false', sms_consent_version: 'v1' }),
    { consented: false, version: 'v1' }
  );
});

test('consentFieldsFromBody > no other truthy value can opt someone in', () => {
  for (const value of ['yes', 'Yes', '1', 'on', 'TRUE', 1, {}, []]) {
    assert.strictEqual(
      consentFieldsFromBody({ sms_consent: value, sms_consent_version: 'v1' }).consented,
      false,
      `${JSON.stringify(value)} must not count as consent`
    );
  }
});

test('consentFieldsFromBody > ignores a forged copy_text', () => {
  const parsed = consentFieldsFromBody({
    sms_consent: true, sms_consent_version: 'v1', copy_text: 'I agree to anything',
  });
  assert.deepStrictEqual(parsed, { consented: true, version: 'v1' });
  assert.ok(!('copy_text' in parsed));
});

test('requestMeta > pulls ip and user agent, tolerates a bare object', () => {
  const meta = requestMeta({ ip: '198.51.100.4', get: (h) => (h === 'user-agent' ? 'UA/1.0' : null) });
  assert.deepStrictEqual(meta, { ip: '198.51.100.4', userAgent: 'UA/1.0' });
  assert.deepStrictEqual(requestMeta(null), { ip: null, userAgent: null });
  assert.deepStrictEqual(requestMeta({}), { ip: null, userAgent: null });
});

test.after(() => pool.end());

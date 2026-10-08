'use strict';

// The staffing-driven gratuity disclosure (spec 2026-08-03 section 7), moved
// out of routes/proposals/crud.js for the file-size ratchet (Inbox spec
// 2026-10-06, lane send-attribution). The helper keeps the PATCH's exact
// gates: a missing or placeholder address, a hard bounce, or an archived
// proposal sends nothing, and a provider failure never reaches the committed
// PATCH. Runs ALONE against the shared dev DB:
//   node --test server/utils/gratuityDisclosureNotify.test.js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const notify = require('./gratuityDisclosureNotify');
const { sendGratuityStaffingDisclosure } = notify;

const TAG = 'lane-b-gdn';
const RUN = Date.now();
let n = 0;
let sends = [];

function stubSend({ fail = false } = {}) {
  sends = [];
  notify.__setDeps({
    sendEmail: (args) => {
      if (fail) return Promise.reject(new Error('provider down'));
      sends.push(args);
      return Promise.resolve({ id: 'stub' });
    },
  });
}

async function seed({ email, emailStatus = 'ok', status = 'deposit_paid' } = {}) {
  n += 1;
  const c = await pool.query(
    'INSERT INTO clients (name, email, email_status) VALUES ($1, $2, $3) RETURNING id',
    [`${TAG} client ${n}`, email === undefined ? `${TAG}-${RUN}-${n}@example.test` : email, emailStatus]
  );
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, archive_reason, total_price, amount_paid, pricing_snapshot)
     VALUES ($1, $2, $3, 1300, 100, $4::jsonb) RETURNING id`,
    [c.rows[0].id, status, status === 'archived' ? 'client_cancelled' : null,
      JSON.stringify({ gratuity: { total: 300, staff_noun: 'bartender' } })]
  );
  return { clientId: c.rows[0].id, proposalId: p.rows[0].id };
}

async function purge() {
  await pool.query(
    'DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE name LIKE $1)', [`${TAG} %`]);
  await pool.query('DELETE FROM clients WHERE name LIKE $1', [`${TAG} %`]);
}

before(purge);

after(async () => {
  notify.__setDeps({ sendEmail: require('./email').sendEmail });
  await purge();
  await pool.end();
});

test('sends the staffing-change email to the client with the new gratuity and total', async () => {
  const { proposalId } = await seed();
  stubSend();
  await sendGratuityStaffingDisclosure({ proposalId });
  assert.equal(sends.length, 1);
  assert.ok(sends[0].to.startsWith(`${TAG}-${RUN}-`), `unexpected recipient ${sends[0].to}`);
  assert.equal(sends[0].subject, 'An update to your event staffing and gratuity');
  assert.match(sends[0].text, /\$300\.00/);
  assert.match(sends[0].text, /\$1300\.00/);
});

test('a placeholder (.invalid) address sends nothing', async () => {
  const { proposalId } = await seed({ email: `${TAG}-${RUN}-ph@ccimport.invalid` });
  stubSend();
  await sendGratuityStaffingDisclosure({ proposalId });
  assert.equal(sends.length, 0);
});

test('a hard-bounced address or an archived proposal sends nothing', async () => {
  const bounced = await seed({ emailStatus: 'bad' });
  const archived = await seed({ status: 'archived' });
  stubSend();
  await sendGratuityStaffingDisclosure({ proposalId: bounced.proposalId });
  await sendGratuityStaffingDisclosure({ proposalId: archived.proposalId });
  assert.equal(sends.length, 0);
});

test('no email on file, or no such proposal, sends nothing and never throws', async () => {
  const { proposalId } = await seed({ email: null });
  stubSend();
  await assert.doesNotReject(() => sendGratuityStaffingDisclosure({ proposalId }));
  await assert.doesNotReject(() => sendGratuityStaffingDisclosure({ proposalId: 2147480000 }));
  await assert.doesNotReject(() => sendGratuityStaffingDisclosure());
  assert.equal(sends.length, 0);
});

test('a provider failure is swallowed: the committed PATCH never sees it', async () => {
  const { proposalId } = await seed();
  stubSend({ fail: true });
  await assert.doesNotReject(() => sendGratuityStaffingDisclosure({ proposalId }));
});

test('the disclosure ledgers its own type, its proposal, its client and the editing admin', async () => {
  const { clientId, proposalId } = await seed();
  stubSend();
  await sendGratuityStaffingDisclosure({ proposalId, sentBy: 4242 });
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].meta, { proposalId, clientId, messageType: 'gratuity_disclosure', sentBy: 4242 });
});

test('with no sentBy the disclosure still carries its type, and sent_by NULL', async () => {
  const { proposalId } = await seed();
  stubSend();
  await sendGratuityStaffingDisclosure({ proposalId });
  assert.equal(sends[0].meta.messageType, 'gratuity_disclosure');
  assert.equal(sends[0].meta.sentBy, null);
});

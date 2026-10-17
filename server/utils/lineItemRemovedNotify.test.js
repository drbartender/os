'use strict';

// The line-item removal notice renders only the descriptor applyLineItemCancel
// decided from the locked row (result.clientNotice; spec 2026-10-16 section
// 4.3): { kind: 'removed', label } names a shown line, { kind:
// 'package_adjusted', amountCents } describes a hidden one by the change in
// the total, wording approved by Dallas 2026-10-17. Anything else (no
// descriptor, an unknown kind, a bad amount, a blank label, or a bare label
// under an old parameter name) sends nothing rather than guess, so an admin
// label can never ride along by accident. The route-level proof that a hidden
// line's email carries no trace of its label is in
// server/routes/proposals/cancelLineItem.test.js. Runs ALONE against the
// shared dev DB:
//   node --test server/utils/lineItemRemovedNotify.test.js
require('dotenv').config();

// The failure path reports to Sentry when a DSN is set: never from a test.
const sentryModule = require('@sentry/node');
sentryModule.captureException = () => {};

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const notify = require('./lineItemRemovedNotify');

if (process.env.NODE_ENV === 'production') {
  throw new Error('lineItemRemovedNotify.test.js refuses to run against production');
}

const NONCE = `lirn-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let clientId;
let proposalId;
let sends = [];

before(async () => {
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`LIRN Fixture ${NONCE}`, `${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, event_date, total_price, amount_paid)
     VALUES ($1, 'deposit_paid', 'wedding', CURRENT_DATE + 60, 1500, 100) RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  notify.__setDeps({ sendEmail: (args) => { sends.push(args); return Promise.resolve({ id: 'stub' }); } });
});

after(async () => {
  notify.__setDeps({ sendEmail: require('./email').sendEmail });
  if (proposalId) await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('a removed shown line is named, with the total and balance as before', async () => {
  sends = [];
  const r = await notify.sendLineItemRemovedNotice({
    proposalId, clientNotice: { kind: 'removed', label: 'Bar Rental' }, newTotal: 1500, sentBy: null,
  });
  assert.equal(r.email, 'sent');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].subject, 'Your event total was updated');
  assert.match(sends[0].text,
    /We removed Bar Rental from your event at your request\. Your updated total is \$1,500\.00\. Your remaining balance is \$1,400\.00\./);
  assert.match(sends[0].html, /We removed Bar Rental from your event at your request\./);
});

test('a removed hidden line reads as a package price adjustment by the change, then the total and balance', async () => {
  sends = [];
  const r = await notify.sendLineItemRemovedNotice({
    proposalId, clientNotice: { kind: 'package_adjusted', amountCents: 4000 }, newTotal: 1500, sentBy: null,
  });
  assert.equal(r.email, 'sent');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].subject, 'Your event total was updated', 'the subject is unchanged');
  assert.match(sends[0].text,
    /We adjusted your package price by \$40\.00 at your request\. Your updated total is \$1,500\.00\. Your remaining balance is \$1,400\.00\./);
  assert.match(sends[0].html, /We adjusted your package price by \$40\.00 at your request\./);
  assert.ok(!/We removed/.test(sends[0].text));
});

test('anything but a well-formed descriptor sends nothing, so no label can ride along', async () => {
  sends = [];
  const refusals = [
    {},                                                         // no descriptor at all
    { clientLabel: 'Test secret line' },                        // the old parameter
    { removedLabel: 'Test secret line' },                       // the admin label by its old name
    { clientNotice: 'Test secret line' },                       // a bare label
    { clientNotice: { kind: 'removed', label: '   ' } },        // a blank name
    { clientNotice: { kind: 'removed' } },
    { clientNotice: { kind: 'package_adjusted', amountCents: -4000 } },
    { clientNotice: { kind: 'package_adjusted', amountCents: 40.5 } },
    { clientNotice: { kind: 'package_adjusted', amountCents: '4000' } },
    { clientNotice: { kind: 'package_adjusted' } },
    { clientNotice: { kind: 'unknown', label: 'Test secret line' } },
  ];
  for (const extra of refusals) {
    const r = await notify.sendLineItemRemovedNotice({ proposalId, newTotal: 1500, ...extra });
    assert.equal(r.email, 'failed', `refused: ${JSON.stringify(extra)}`);
    // The dialog toasts "Removed, but the client notice failed to send: <email_error>",
    // so the reason reads as plain words for the admin, never a code identifier.
    assert.equal(r.email_error, 'the notice for this line could not be written. Tell the client directly.');
  }
  assert.equal(sends.length, 0, 'nothing reached the client');
});

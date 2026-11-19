'use strict';

// GV sender outage tracking (spec 2026-10-17 section 6 "Sweep", plan Task 6):
// one admin email per outage episode, three streaks that open one, and a
// success that closes it. DB suite on the shared dev database: run ALONE,
//   node --test server/utils/gvPost/outage.test.js
// notifyAdminCategory is stubbed through outage.__setDeps, so nothing is
// emailed. gv_sender_state is the one shared row (id 1): each test resets it
// with UPDATE, never DELETE (a missing row reads as already alerted), and
// after() restores the values it held before the suite.
require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('outage.test.js refuses to run against production');
}
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { notifyAdminCategory } = require('../adminNotifications');
const outage = require('./outage');

const SUBJECT = 'Google Voice sender is down: Thumbtack customers are getting the toll-free text';
const SUBJECT_CHECK = 'Google Voice sender needs a look: some Thumbtack posts may not have gone through';
// The two reasons whose posts get no toll-free text: their email must never
// say nothing is lost.
const NO_FALLBACK = new Set(['unknown_streak', 'verify_unconfirmed']);
const textFor = (reason) => `The box's Google Voice sender stopped posting proposal links (reason: ${reason}). Thumbtack customers are getting today's toll-free text instead, so nothing is lost. To fix it, sign GV back in on the box (gv-agent/README.md); the sender picks up on its next poll.`;
const STATE_COLUMNS = [
  'outage_since', 'outage_reason', 'outage_alerted_at', 'last_lease_at', 'last_success_at',
  'consecutive_preclick_failures', 'consecutive_unknown', 'consecutive_unverified',
];
let snapshot = null;
let mails = [];

const state = async () => (await pool.query('SELECT * FROM gv_sender_state WHERE id = 1')).rows[0];
// The suite's admin-email stub: one admin reached.
const mailOne = (args) => { mails.push(args); return Promise.resolve({ emailed: 1, texted: 0, pushQueued: 0 }); };

before(async () => {
  snapshot = await state();
  assert.ok(snapshot, 'precondition: the gv_sender_state seed row (id 1) exists; run initDb');
  outage.__setDeps({ notifyAdminCategory: mailOne });
});

beforeEach(async () => {
  mails = [];
  await pool.query(
    `UPDATE gv_sender_state
        SET outage_since = NULL, outage_reason = NULL, outage_alerted_at = NULL,
            consecutive_preclick_failures = 0, consecutive_unknown = 0, consecutive_unverified = 0,
            updated_at = now()
      WHERE id = 1`
  );
});

after(async () => {
  try {
    if (snapshot) {
      await pool.query(
        `UPDATE gv_sender_state
            SET outage_since = $1, outage_reason = $2, outage_alerted_at = $3, last_lease_at = $4,
                last_success_at = $5, consecutive_preclick_failures = $6, consecutive_unknown = $7,
                consecutive_unverified = $8, updated_at = now()
          WHERE id = 1`,
        STATE_COLUMNS.map((c) => snapshot[c]) // eslint-disable-line security/detect-object-injection
      );
    }
  } finally {
    if (typeof outage.__setDeps === 'function') outage.__setDeps({ notifyAdminCategory, Sentry });
    await pool.end();
  }
});

function assertOutageMail(mail, reason) {
  assert.equal(mail.category, 'routine_thumbtack');
  if (NO_FALLBACK.has(reason)) {
    assert.equal(mail.subject, SUBJECT_CHECK);
    assert.ok(!/nothing is lost|getting today's toll-free text/.test(mail.emailText), 'no false reassurance');
    assert.match(mail.emailText, /check the thread, and paste the link if it is not there/);
    assert.match(mail.emailText, reason === 'unknown_streak' ? /were not sent the toll-free text/ : /no toll-free text was sent/);
    assert.ok(!mail.emailText.includes('\u2014'), 'no em dash in staff copy');
  } else {
    assert.equal(mail.subject, SUBJECT);
    assert.equal(mail.emailText, textFor(reason));
  }
  assert.ok(mail.emailHtml.includes(`(reason: ${reason})`));
  assert.equal(mail.smsBody, undefined, 'email only, never a text');
  assert.equal(mail.push, undefined);
}

test('noteOutage emails once per episode with no smsBody', async () => {
  assert.equal(await outage.noteOutage('session_expired'), true);
  assert.equal(await outage.noteOutage('challenge'), false, 'the episode is already alerted');
  assert.equal(mails.length, 1);
  assertOutageMail(mails[0], 'session_expired');
  const s = await state();
  assert.ok(s.outage_since);
  assert.ok(s.outage_alerted_at);
  assert.equal(s.outage_reason, 'session_expired', 'the episode keeps the reason that opened it');

  // Two signals at once (the status endpoint and the sweep) still mail once.
  await pool.query('UPDATE gv_sender_state SET outage_since = NULL, outage_reason = NULL, outage_alerted_at = NULL WHERE id = 1');
  mails = [];
  const raced = await Promise.all([outage.noteOutage('no_lease'), outage.noteOutage('session_expired')]);
  assert.deepEqual(raced.sort(), [false, true]);
  assert.equal(mails.length, 1);
});

test('noteSuccess reopens the episode for a later alert', async () => {
  await outage.noteOutage('no_lease');
  assert.equal(mails.length, 1);
  await pool.query('UPDATE gv_sender_state SET consecutive_unknown = 2, consecutive_unverified = 1 WHERE id = 1');
  await outage.noteSuccess();
  const s = await state();
  assert.equal(s.outage_since, null);
  assert.equal(s.outage_reason, null);
  assert.equal(s.outage_alerted_at, null);
  assert.ok(s.last_success_at);
  assert.equal(s.consecutive_preclick_failures, 0);
  assert.equal(s.consecutive_unknown, 0);
  assert.equal(s.consecutive_unverified, 0);
  assert.equal(await outage.noteOutage('session_expired'), true);
  assert.equal(mails.length, 2, 'a new episode alerts again');
  assertOutageMail(mails[1], 'session_expired');
});

test('three non-exempt pre-click failures email once and cap failures never count', async () => {
  for (const reason of ['cap', 'cap', 'cap', 'spacing', 'no_thread']) {
    await outage.notePreclickFailure(reason);
  }
  assert.equal((await state()).consecutive_preclick_failures, 0, 'exempt reasons never count');
  assert.equal(mails.length, 0);
  await outage.notePreclickFailure('session_expired');
  await outage.notePreclickFailure('timeout');
  assert.equal(mails.length, 0);
  await outage.notePreclickFailure('ui_error_before_send');
  assert.equal(mails.length, 1);
  assertOutageMail(mails[0], 'preclick_failures');
  await outage.notePreclickFailure('wrong_thread');
  await outage.notePreclickFailure('cap');
  assert.equal(mails.length, 1, 'one email per episode');
  assert.equal((await state()).consecutive_preclick_failures, 4);
});

test('three unknowns in a row email once and a success resets the streak', async () => {
  await outage.noteUnknown();
  await outage.noteUnknown();
  await outage.noteSuccess();
  assert.equal((await state()).consecutive_unknown, 0);
  await outage.noteUnknown();
  await outage.noteUnknown();
  assert.equal(mails.length, 0, 'the success broke the streak');
  await outage.noteUnknown();
  assert.equal(mails.length, 1);
  assertOutageMail(mails[0], 'unknown_streak');
  await outage.noteUnknown();
  assert.equal(mails.length, 1);
});

test('three unverified in a row email once', async () => {
  await outage.noteUnverified();
  await outage.noteUnverified();
  assert.equal(mails.length, 0);
  await outage.noteUnverified();
  assert.equal(mails.length, 1);
  assertOutageMail(mails[0], 'verify_unconfirmed');
  await outage.noteUnverified();
  assert.equal(mails.length, 1);
  assert.equal((await state()).consecutive_unverified, 4);
});

test('an outage email that reaches nobody warns Sentry once', async () => {
  // Nobody subscribed to routine_thumbtack, or the recipient lookup failed
  // (notifyAdminCategory then answers emailed 0): the outage would pass
  // unseen, so Sentry carries it, once. The alerted stamp holds, so a later
  // signal in the episode never re-sends: no storm.
  const warnings = [];
  outage.__setDeps({
    notifyAdminCategory: (args) => { mails.push(args); return Promise.resolve({ emailed: 0, texted: 0, pushQueued: 0 }); },
    Sentry: { captureMessage: (message, ctx) => { warnings.push({ message, ctx }); } },
  });
  try {
    assert.equal(await outage.noteOutage('session_expired'), true);
    assert.equal(mails.length, 1);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].ctx.level, 'warning');
    assert.deepEqual(warnings[0].ctx.tags, { feature: 'gv_post', event: 'outage_email_unsent' });
    assert.deepEqual(warnings[0].ctx.extra, { reason: 'session_expired' }, 'the reason only: no address, no number');
    assert.ok((await state()).outage_alerted_at, 'the episode stays alerted');

    assert.equal(await outage.noteOutage('no_lease'), false);
    await outage.notePreclickFailure('timeout');
    await outage.notePreclickFailure('timeout');
    await outage.notePreclickFailure('timeout');
    assert.equal(mails.length, 1, 'never re-sent inside the episode');
    assert.equal(warnings.length, 1, 'one warning per episode');

    // A send that throws reached nobody either: the next episode warns once.
    await outage.noteSuccess();
    outage.__setDeps({ notifyAdminCategory: () => Promise.reject(new Error('mail provider down')) });
    assert.equal(await outage.noteOutage('challenge'), true);
    assert.equal(warnings.length, 2);
    assert.deepEqual(warnings[1].ctx.extra, { reason: 'challenge' });

    // An email that reached an admin warns nothing.
    await outage.noteSuccess();
    outage.__setDeps({ notifyAdminCategory: mailOne });
    assert.equal(await outage.noteOutage('no_lease'), true);
    assert.equal(mails.length, 2);
    assert.equal(warnings.length, 2);
  } finally {
    outage.__setDeps({ notifyAdminCategory: mailOne, Sentry });
  }
});

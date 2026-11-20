'use strict';

// The connector's two owner emails (spec 2026-11-19 sections 7.2 and 8),
// through an injected sender: what each says, that it carries no em dash, and
// that no credential or link is ever put in it.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const mail = require('./mail');

const sent = [];
mail.__setSender(async (m) => { sent.push(m); return { id: 'stub' }; });
after(() => mail.__setSender(null));

test('the new-connection email names when and from where, and says how to undo it', async () => {
  sent.length = 0;
  await mail.sendGrantCreatedEmail({
    to: 'owner@example.com',
    connectedAt: new Date('2026-11-19T18:01:00Z'),
    approvedAt: new Date('2026-11-19T18:00:00Z'),
    requestedAt: new Date('2026-11-19T17:58:00Z'),
    callerAddress: '203.0.113.7',
    userAgent: 'Mozilla/5.0 <script>',
    replaced: true,
  });
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.to, 'owner@example.com');
  assert.equal(m.subject, 'Claude was connected to the OS');
  assert.match(m.text, /203\.0\.113\.7/);
  assert.match(m.text, /replaced the connection/);
  assert.match(m.text, /Disconnect/);
  assert.match(m.text, /Forgot your password\?/, 'the real way to sign every session out');
  assert.doesNotMatch(m.text, /sign out everywhere/i, 'no action the OS does not have');
  assert.match(m.text, /You approved it/);
  assert.doesNotMatch(m.html, /<script>/, 'the browser string is escaped');
  for (const body of [m.text, m.html, m.subject]) {
    assert.doesNotMatch(body, /—/, 'no em dash');
    assert.doesNotMatch(body, /drbc_|https?:\/\//, 'no credential and no link');
  }
});

test('the replay email says the connection was cut off and how to reconnect', async () => {
  sent.length = 0;
  await mail.sendReplayRevokedEmail({ to: 'owner@example.com', kind: 'refresh_replay', revokedAt: new Date() });
  await mail.sendReplayRevokedEmail({ to: 'owner@example.com', kind: 'code_replay', revokedAt: new Date() });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].subject, 'The Claude connection was cut off');
  assert.match(sent[0].text, /A refresh token that had already been used/);
  assert.match(sent[1].text, /A sign-in code that had already been used/);
  for (const m of sent) {
    assert.doesNotMatch(m.text + m.html, /—|drbc_|https?:\/\//);
  }
});

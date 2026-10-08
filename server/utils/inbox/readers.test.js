require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../../db');

if (process.env.NODE_ENV === 'production') throw new Error('readers.test.js refuses to run against production');

const { INBOX_HISTORY_START, RELAY_NOTICE_WORDS, TT_MISSED_TEXT } = require('./constants');
const { loadPeopleIndex } = require('./people');
const { SMS_HEADERS_SQL, mapSmsHeader, relayQuotedWords } = require('./readSms');
const { TT_HEADERS_SQL, mapThumbtackHeader } = require('./readThumbtack');
const { ML_HEADERS_SQL, mapMessageLogHeader } = require('./readMessageLog');
const { PAL_HEADERS_SQL, mapProposalSendHeader } = require('./readProposalSends');
const { CALL_HEADERS_SQL, mapCallHeader } = require('./readCalls');
const { loadDetails, mergeDetails } = require('./details');
const { lineE164 } = require('../smsLines');
const { countsAsReply } = require('./classify');

// Fixed identifiers, not per run, so before() also clears whatever a crashed
// earlier run left behind. Invented numbers in the 555-01xx range.
const TAG = 'inbox-readers-test';
const SID = 'SMinboxreaderstest0001';
const phone = (i) => `+1872555${String(100 + i).padStart(4, '0')}`;
const P = { pre: phone(0), staff: phone(1), unknown: phone(2), proxy: phone(3), own: phone(4), other: phone(5) };
const PHONES = Object.values(P).map((p) => p.slice(-10));
// Thumbtack's notice in the shape prod sends (Task 18 F1): the name line, the
// link line, the opt-out line, a line of dashes, then the customer's words.
// Every word of it is invented.
const QUOTED_BODY = 'Pat Q. replied to you on Thumbtack.\n\nView the full conversation here: https://www.thumbtack.com/pro-inbox/messages/neg-10\n\nReply STOP to opt out, or HELP for help.\n\n---\n\nGot it, we will review and get back to you.';

const ids = { sms: {}, users: [], clients: [], proposals: [], leads: [], consults: [] };
const byRef = new Map();
let savedAdminPhone;

async function sms(key, cols) {
  const r = await pool.query(
    `INSERT INTO sms_messages (direction, client_id, sender_id, recipient_id, recipient_phone, body, status,
                               twilio_sid, error_message, metadata, group_id, created_at, processed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, COALESCE($11::uuid, gen_random_uuid()), NOW() - $12::interval, $13)
     RETURNING id`,
    [cols.direction || 'inbound', cols.clientId || null, cols.senderId || null, cols.recipientId || null, cols.phone,
      cols.body, cols.status || 'received', cols.sid || null, cols.error || null, JSON.stringify(cols.metadata || {}),
      cols.groupId || null, cols.ago || '1 hour', cols.processed === undefined ? true : cols.processed]
  );
  // eslint-disable-next-line security/detect-object-injection -- key is one of this suite's own literal fixture names
  ids.sms[key] = r.rows[0].id;
}

// Everything this suite seeds, found by its tag, its client names and its phone block.
async function clean() {
  const users = (await pool.query('SELECT id FROM users WHERE email LIKE $1', [`${TAG}-%`])).rows.map((r) => r.id);
  const clients = (await pool.query('SELECT id FROM clients WHERE name LIKE $1', [`%${TAG}`])).rows.map((r) => r.id);
  await pool.query('DELETE FROM consults WHERE client_id = ANY($1::int[])', [clients]); // cascades the attempt
  await pool.query('DELETE FROM thumbtack_messages WHERE negotiation_id = $1', [`${TAG}-neg`]);
  await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id = $1', [`${TAG}-neg`]); // cascades the lead call
  await pool.query('DELETE FROM email_webhook_events WHERE resend_id = $1', [`re_${TAG}`]);
  await pool.query('DELETE FROM sms_status_orphans WHERE twilio_sid LIKE $1', [`${SID}%`]);
  await pool.query('DELETE FROM proposals WHERE client_id = ANY($1::int[])', [clients]); // cascades the ledger and activity
  await pool.query(
    `DELETE FROM sms_messages
      WHERE RIGHT(REGEXP_REPLACE(recipient_phone, '\\D', '', 'g'), 10) = ANY($1::text[])
         OR client_id = ANY($2::int[]) OR sender_id = ANY($3::int[]) OR recipient_id = ANY($3::int[])`,
    [PHONES, clients, users]
  );
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clients]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [users]); // cascades profile and agreement
}

before(async () => {
  savedAdminPhone = process.env.ADMIN_PHONE;
  process.env.ADMIN_PHONE = P.own; // an own number for this run
  await clean();
  const user = async (role) => {
    const r = await pool.query(
      "INSERT INTO users (email, password_hash, role, onboarding_status, token_version) VALUES ($1, 'x', $2, 'approved', 0) RETURNING id",
      [`${TAG}-${role}@example.com`, role]
    );
    ids.users.push(r.rows[0].id);
    return r.rows[0].id;
  };
  ids.admin = await user('admin');
  ids.staff = await user('staff');
  await pool.query('INSERT INTO contractor_profiles (user_id, preferred_name, phone) VALUES ($1, $2, $3)', [ids.staff, 'Kai', P.staff]);
  await pool.query('INSERT INTO agreements (user_id, full_name, sms_consent) VALUES ($1, $2, true)', [ids.staff, 'Kai Example']);

  // A text from a number that only LATER becomes a client: read-time resolution must join them.
  await sms('pre', { phone: P.pre, body: 'Is the 14th open?', metadata: { from: P.pre, to: lineE164('1922') }, ago: '3 hours' });
  await sms('picture', { phone: P.pre, body: '', metadata: { from: P.pre, media: [{ url: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEtest', content_type: 'image/jpeg' }] }, ago: '170 minutes' });
  const pre = await pool.query('INSERT INTO clients (name, phone) VALUES ($1, $2) RETURNING id', [`Robin Example ${TAG}`, P.pre]);
  ids.pre = pre.rows[0].id;
  ids.clients.push(ids.pre);
  const tt = await pool.query('INSERT INTO clients (name, phone) VALUES ($1, $2) RETURNING id', [`Pat Example ${TAG}`, P.proxy]);
  ids.ttClient = tt.rows[0].id;
  ids.clients.push(ids.ttClient);

  await sms('staffCant', { phone: P.staff, body: "can't", metadata: { from: P.staff } });
  await sms('staffTalk', { phone: P.staff, body: 'Can I swap Saturday?', metadata: { from: P.staff, to: lineE164('1922'), outcome: 'conversation' } });
  // Still being handled (processed false) and no outcome yet: it counts (amendment 27).
  await sms('staffUnsettled', { phone: P.staff, body: 'Confirm', metadata: { from: P.staff }, processed: false });
  // A shift command from a phone that is also a client's: the outcome skips it on c- too.
  await sms('clientConfirm', { phone: P.pre, clientId: ids.pre, body: 'confirm', metadata: { from: P.pre, outcome: 'staff_confirm' } });
  // Twilio reported this one undelivered before its row was written (amendment 19).
  await sms('orphaned', { direction: 'outbound', status: 'sent', senderId: ids.admin, clientId: ids.pre, phone: P.pre, body: 'See you then', sid: `${SID}orphan` });
  await pool.query("INSERT INTO sms_status_orphans (twilio_sid, status, error_message) VALUES ($1, 'failed', 'Twilio 30005 (undelivered)')", [`${SID}orphan`]);
  await sms('unknownStop', { phone: P.unknown, body: 'STOP', metadata: { from: P.unknown, opt_keyword: 'stop' } });
  await sms('own', { phone: P.own, body: 'Testing the line', metadata: { from: P.own } });

  const lead = await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_name, customer_phone, status, raw_payload, created_at,
                                  first_reply_status, first_reply_sent_at)
     VALUES ($1, $2, 'Pat Example', $3, 'new', '{}'::jsonb, NOW() - INTERVAL '1 day', 'sent', NOW() - INTERVAL '50 minutes')
     RETURNING id`,
    [`${TAG}-neg`, ids.ttClient, P.proxy]
  );
  ids.lead = lead.rows[0].id;
  ids.leads.push(ids.lead);
  await sms('notice', { phone: P.proxy, clientId: ids.ttClient, body: 'Pat replied to you on Thumbtack.\n\nView the full conversation here: https://example.com/x', metadata: { from: P.proxy, thumbtack_relay: true } });
  await sms('relayText', { phone: P.proxy, clientId: ids.ttClient, body: 'Can we do 5pm instead?', metadata: { from: P.proxy, thumbtack_relay: true } });
  await sms('quoted', { phone: P.proxy, clientId: ids.ttClient, body: QUOTED_BODY, metadata: { from: P.proxy, thumbtack_relay: true }, ago: '5 hours' });
  // A dash line with nothing after it quotes nothing.
  await sms('dashOnly', { phone: P.proxy, clientId: ids.ttClient, body: 'Pat Q. replied to you on Thumbtack.\n\n---\n\n   ', metadata: { from: P.proxy, thumbtack_relay: true }, ago: '6 hours' });
  // The same words from a phone that is not a Thumbtack relay: their own text, never cut.
  await sms('dashText', { phone: P.pre, clientId: ids.pre, body: QUOTED_BODY, metadata: { from: P.pre }, ago: '7 hours' });

  const groupId = crypto.randomUUID();
  await sms('groupStaff', { direction: 'outbound', status: 'sent', senderId: ids.admin, recipientId: ids.staff, phone: P.staff, body: 'Uniforms are black', groupId });
  await sms('groupOther', { direction: 'outbound', status: 'sent', senderId: ids.admin, phone: P.other, body: 'Uniforms are black', groupId });
  await sms('failedReply', { direction: 'outbound', status: 'failed', senderId: ids.admin, clientId: ids.pre, phone: P.pre, body: 'Yes, the 14th is open', error: 'Twilio 30007 (undelivered)', metadata: { line: '1922' }, ago: '2 hours' });

  await pool.query(
    `INSERT INTO thumbtack_messages (message_id, negotiation_id, from_type, sender_name, text, sent_at, raw_payload) VALUES
       ($1, $3, 'Customer', 'Pat E.', 'Looking for a bartender', NOW() - INTERVAL '60 minutes', '{}'::jsonb),
       ($2, $3, 'Business', 'Dr. Bartender', 'Hi there, we are reviewing your request', NOW() - INTERVAL '50 minutes' + INTERVAL '20 seconds', '{}'::jsonb)`,
    [`${TAG}-c`, `${TAG}-b`, `${TAG}-neg`]
  );

  const prop = await pool.query("INSERT INTO proposals (client_id, status, event_date) VALUES ($1, 'sent', CURRENT_DATE + 30) RETURNING id", [ids.ttClient]);
  ids.proposal = prop.rows[0].id;
  ids.proposals.push(ids.proposal);
  const ml = await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, subject, status, provider_id, sent_by) VALUES
       ($1, $2, 'email', 'proposal_sent', 'pat@example.com', 'Your proposal', 'sent', $3, $4),
       ($1, $2, 'sms', 'initial_proposal', $5, 'Your proposal is ready', 'sent', $6, $4)
     RETURNING id, channel`,
    [ids.proposal, ids.ttClient, `re_${TAG}`, ids.admin, P.proxy, SID]
  );
  ids.mlEmail = ml.rows.find((r) => r.channel === 'email').id;
  ids.mlSms = ml.rows.find((r) => r.channel === 'sms').id;
  await pool.query("INSERT INTO email_webhook_events (resend_id, event_type, payload) VALUES ($1, 'email.bounced', '{}'::jsonb)", [`re_${TAG}`]);
  const pal = await pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES
       ($1, 'status_changed', 'admin', $2, '{"to":"sent"}'::jsonb),
       ($1, 'status_changed', 'admin', NULL, '{"to":"sent"}'::jsonb),
       ($1, 'viewed', 'client', NULL, '{}'::jsonb)
     RETURNING id, actor_id, action`,
    [ids.proposal, ids.admin]
  );
  ids.palAdmin = pal.rows.find((r) => r.actor_id === ids.admin).id;
  ids.palAuto = pal.rows.find((r) => r.actor_id === null && r.action === 'status_changed').id;
  ids.palViewed = pal.rows.find((r) => r.action === 'viewed').id;

  const lc = await pool.query(
    `INSERT INTO lead_call_attempts (lead_id, status, answered_by, bridge_started_at, bridge_duration_sec)
     VALUES ($1, 'connected', 'admin', NOW() - INTERVAL '30 minutes', 185) RETURNING id`,
    [ids.lead]
  );
  ids.lc = lc.rows[0].id;
  const consult = await pool.query("INSERT INTO consults (client_id, scheduled_at, status) VALUES ($1, NOW() - INTERVAL '2 hours', 'completed') RETURNING id", [ids.ttClient]);
  ids.consults.push(consult.rows[0].id);
  const cc = await pool.query(
    `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, answered_by, bridge_started_at, bridge_duration_sec, client_no_answer_at)
     VALUES ($1, NOW() - INTERVAL '2 hours', 'connected', 'va', NOW() - INTERVAL '65 minutes', 300, NOW() - INTERVAL '1 hour') RETURNING id`,
    [consult.rows[0].id]
  );
  ids.cc = cc.rows[0].id;

  const index = await loadPeopleIndex(pool);
  const readers = [
    [SMS_HEADERS_SQL, (r) => mapSmsHeader(r, index)],
    [TT_HEADERS_SQL, (r) => mapThumbtackHeader(r, index)],
    [ML_HEADERS_SQL, (r) => mapMessageLogHeader(r)],
    [PAL_HEADERS_SQL, (r) => mapProposalSendHeader(r)],
    [CALL_HEADERS_SQL, (r) => mapCallHeader(r, index)],
  ];
  for (const [sql, map] of readers) {
    const { rows } = await pool.query(sql, [INBOX_HISTORY_START]);
    for (const row of rows) {
      const e = map(row);
      if (e) byRef.set(e.ref, e);
    }
  }
});

after(async () => {
  try {
    await clean();
  } finally {
    if (savedAdminPhone === undefined) delete process.env.ADMIN_PHONE;
    else process.env.ADMIN_PHONE = savedAdminPhone;
    await pool.end();
  }
});

const ev = (ref) => byRef.get(ref);

test('sms: a text sent before its sender became a client joins that client, with its line; a picture is media', () => {
  const pre = ev(`sms:${ids.sms.pre}`);
  assert.deepEqual([pre.personKey, pre.direction, pre.kind, pre.line], [`c-${ids.pre}`, 'in', 'message', '1922']);
  const pic = ev(`sms:${ids.sms.picture}`);
  assert.deepEqual([pic.personKey, pic.kind, pic.meta.empty], [`c-${ids.pre}`, 'media', false]);
});

test('sms: a staffer is s- on the staff channel; an old CANT is a shift command; conversation counts', () => {
  const cant = ev(`sms:${ids.sms.staffCant}`);
  assert.deepEqual([cant.personKey, cant.channel, cant.meta.skip], [`s-${ids.staff}`, 'staff_text', 'shift_command']);
  const talk = ev(`sms:${ids.sms.staffTalk}`);
  assert.deepEqual([talk.meta.skip || null, talk.line], [null, '1922']);
});

test('sms: an unsettled row with no outcome counts; an outcome skips whatever the key', () => {
  const unsettled = ev(`sms:${ids.sms.staffUnsettled}`);
  assert.deepEqual([unsettled.personKey, unsettled.meta.skip || null], [`s-${ids.staff}`, null]);
  const asClient = ev(`sms:${ids.sms.clientConfirm}`);
  assert.deepEqual([asClient.personKey, asClient.meta.skip], [`c-${ids.pre}`, 'shift_command']);
});

test('sms: a "sent" text whose failure beat its row (sms_status_orphans) reads as failed, is no reply, and keeps the reason', async () => {
  const orphaned = ev(`sms:${ids.sms.orphaned}`);
  assert.deepEqual([orphaned.direction, orphaned.meta.smsSenderId, orphaned.meta.failed], ['out', ids.admin, true]);
  assert.equal(countsAsReply(orphaned), false, 'a human text that never arrived answers nobody');
  const [full] = mergeDetails([orphaned], await loadDetails([orphaned], pool));
  assert.equal(full.meta.failureReason, 'Unknown or inactive number (Twilio 30005)');
});

test('sms: our own number never shows; a bare STOP is a marked opt-out line', () => {
  assert.equal(ev(`sms:${ids.sms.own}`), undefined);
  const stop = ev(`sms:${ids.sms.unknownStop}`);
  assert.deepEqual([stop.personKey, stop.direction, stop.kind, stop.meta.optWord], [`p-${P.unknown.slice(-10)}`, 'system', 'opt_out', true]);
});

test('sms: a relay notice is flagged, a real relay text names its lead, a group text carries its size', () => {
  const notice = ev(`sms:${ids.sms.notice}`);
  assert.deepEqual([notice.personKey, notice.meta.relayNotice, notice.meta.relayNegotiationId], [`c-${ids.ttClient}`, true, `${TAG}-neg`]);
  const relay = ev(`sms:${ids.sms.relayText}`);
  assert.deepEqual([relay.meta.relayNotice, relay.meta.relayLeadName, relay.kind], [false, 'Pat Example', 'message']);
  const group = ev(`sms:${ids.sms.groupStaff}`);
  assert.deepEqual([group.personKey, group.meta.groupSize, group.meta.smsSenderId], [`s-${ids.staff}`, 2, ids.admin]);
  // eslint-disable-next-line security/detect-non-literal-regexp -- RELAY_NOTICE_WORDS is a constant from constants.js, never input
  assert.ok(new RegExp(RELAY_NOTICE_WORDS, 'i').test("Pat replied to you on Thumbtack."));
  assert.ok(SMS_HEADERS_SQL.includes(RELAY_NOTICE_WORDS), 'the SQL notice test spells the constant');
});

test('sms: a relay notice that quotes their words reads relay_quoted in the header pass; pass 2 hands over the words alone (Task 18 F1)', async () => {
  const header = async (id) => (await pool.query(`${SMS_HEADERS_SQL} AND m.id = $2`, [INBOX_HISTORY_START, id])).rows[0].relay_quoted;
  assert.deepEqual(
    [await header(ids.sms.quoted), await header(ids.sms.notice), await header(ids.sms.dashOnly), await header(ids.sms.dashText)],
    [true, false, false, false],
    'quoted; no dash line; a dash line with nothing after it; not a relay'
  );
  const quoted = ev(`sms:${ids.sms.quoted}`);
  assert.deepEqual([quoted.meta.relayNotice, quoted.meta.relayQuoted], [true, true]);
  assert.equal(ev(`sms:${ids.sms.notice}`).meta.relayQuoted, false);
  const wanted = [quoted, ev(`sms:${ids.sms.dashText}`)];
  const [words, own] = mergeDetails(wanted, await loadDetails(wanted, pool));
  assert.equal(words.text, 'Got it, we will review and get back to you.');
  assert.equal(own.text, QUOTED_BODY, 'a text that is not a Thumbtack relay is never cut');
});

test('pass 2: the words after the first dash line, trimmed; a quoted notice whose words come out empty stays tt_missed', () => {
  const notice = 'Pat replied to you on Thumbtack.';
  assert.equal(relayQuotedWords(`${notice}\r\n\r\n  ---  \r\n\r\n  First line\n\n---\nsecond part  `), 'First line\n\n---\nsecond part');
  assert.equal(relayQuotedWords(`${notice} --- not a line\n\nHello`), '', 'dashes inside a line are not the rule line');
  assert.equal(relayQuotedWords(`${notice}\n---\n \n`), '', 'only a no-break space after it');
  const event = {
    ref: 'sms:1', personKey: 'c-1', channel: 'thumbtack', line: null, direction: 'in', at: new Date(), author: null,
    kind: 'message', text: undefined, meta: { source: 'sms', id: 1, inbound: true, relayQuoted: true, normalized: true },
  };
  const [empty] = mergeDetails([event], new Map([['sms:1', { text: '', media: [], failureReason: null }]]));
  assert.deepEqual([empty.kind, empty.channel, empty.text], ['tt_missed', 'thumbtack', TT_MISSED_TEXT]);
  const [said] = mergeDetails([event], new Map([['sms:1', { text: 'Thanks!', media: [], failureReason: null }]]));
  assert.deepEqual([said.kind, said.text], ['message', 'Thanks!']);
});

test('thumbtack: both sides land on the lead client, with first_reply_sent_at', () => {
  const customer = ev(`tt:${TAG}-c`);
  const business = ev(`tt:${TAG}-b`);
  assert.deepEqual([customer.personKey, customer.direction, business.direction], [`c-${ids.ttClient}`, 'in', 'out']);
  assert.ok(business.meta.firstReplySentAt instanceof Date);
});

test('message_log: the bounce join fails the email; sent_by is the author; proposal sends carry the actor role', () => {
  const email = ev(`ml:${ids.mlEmail}`);
  assert.deepEqual([email.personKey, email.meta.bounced, email.meta.failed, email.author], [`c-${ids.ttClient}`, true, true, ids.admin]);
  assert.deepEqual([ev(`ml:${ids.mlSms}`).channel, ev(`ml:${ids.mlSms}`).meta.providerId], ['text', SID]);
  const admin = ev(`pal:${ids.palAdmin}`);
  assert.deepEqual([admin.kind, admin.author, admin.meta.actorRole], ['proposal_sent', ids.admin, 'admin']);
  assert.equal(ev(`pal:${ids.palAuto}`).author, 'auto');
  assert.equal(ev(`pal:${ids.palViewed}`), undefined, 'a view is not a send');
});

test('calls: answered_by maps to the user who took it; the consult no-answer rides along', () => {
  const lc = ev(`lc:${ids.lc}`);
  assert.deepEqual([lc.personKey, lc.author, lc.meta.durationSec], [`c-${ids.ttClient}`, 1, 185]);
  const cc = ev(`cc:${ids.cc}`);
  assert.deepEqual([cc.personKey, cc.author, cc.meta.clientNoAnswer], [`c-${ids.ttClient}`, 2, true]);
});

test('pass 2: bodies, media, subjects and the failure reason, by ref', async () => {
  const wanted = [ev(`sms:${ids.sms.pre}`), ev(`sms:${ids.sms.picture}`), ev(`sms:${ids.sms.failedReply}`), ev(`tt:${TAG}-c`), ev(`ml:${ids.mlEmail}`)];
  const full = mergeDetails(wanted, await loadDetails(wanted, pool));
  const [pre, pic, failed, tt, email] = full;
  assert.equal(pre.text, 'Is the 14th open?');
  assert.equal(pic.meta.media[0].content_type, 'image/jpeg');
  assert.deepEqual([failed.meta.failed, failed.line, failed.meta.failureReason], [true, '1922', 'Filtered by the carrier (Twilio 30007)']);
  assert.equal(tt.text, 'Looking for a bartender');
  assert.deepEqual([email.text, email.meta.subject], [null, 'Your proposal']);
});

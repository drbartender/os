require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool, initDb } = require('../../db');

if (process.env.NODE_ENV === 'production') throw new Error('readers.test.js refuses to run against production');

const {
  INBOX_HISTORY_START, RELAY_NOTICE_WORDS, TT_MISSED_TEXT, ZOLA_UNREAD_TEXT, ZOLA_RELAY_DOMAIN, PERSONAL_ALIAS,
} = require('./constants');
const { loadPeopleIndex, emailHash, personalEmailKey } = require('./people');
const { MAIL_HEADERS_SQL, mapGmailHeaders, isGmRow } = require('./readGmail');
const { mapZolaHeaders, mapMailHeaders, isZolaRow } = require('./readZola');
const { GMAIL_MAILBOX } = require('../gmailClient');
const { SMS_HEADERS_SQL, mapSmsHeader, relayQuotedWords } = require('./readSms');
const { TT_HEADERS_SQL, mapThumbtackHeader } = require('./readThumbtack');
const { ML_HEADERS_SQL, mapMessageLogHeader } = require('./readMessageLog');
const { PAL_HEADERS_SQL, mapProposalSendHeader } = require('./readProposalSends');
const { CALL_HEADERS_SQL, mapCallHeader } = require('./readCalls');
const { loadDetails, mergeDetails } = require('./details');
const { lineE164 } = require('../smsLines');
const { countsAsReply } = require('./classify');
const { loadFeeds } = require('./feeds');

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

const ids = { sms: {}, users: [], clients: [], proposals: [], leads: [], consults: [], gm: {}, zola: {} };
const byRef = new Map();
let savedAdminPhone;

// The email rows (spec 2026-10-14 section 5.1). Every gmail id, address and
// Zola label starts with GM, so clean() finds exactly this suite's rows.
const GM = 'zz-test-readers';
const mailOf = (who) => `${GM}-${who}@example.com`;
const RELAY = (who) => `${GM}-${who}@${ZOLA_RELAY_DOMAIN}`;
const gmByRef = new Map();
const zolaByRef = new Map();
// The one shared scan, this suite's rows only, and both readers over it.
let mailRows = [];
let mailEvents = [];

async function gmRow(key, cols) {
  const gmailId = `${GM}-${key}`;
  const r = await pool.query(
    `INSERT INTO gmail_messages (gmail_id, thread_id, direction, kind, from_address, from_name, to_addresses, subject, text,
                                 attachments, message_id_header, in_reply_to, failed, zola_lead_id, at, bounced_to, personal, personal_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11, $12, $13, $14, NOW() - $15::interval, $16::text[], $17, $18::text[])
     RETURNING id`,
    [gmailId, `${GM}-${cols.thread || key}`, cols.direction || 'in', cols.kind || 'message', cols.from || GMAIL_MAILBOX,
      cols.fromName || null, cols.to || [GMAIL_MAILBOX], cols.subject || null, cols.text === undefined ? 'Hello there' : cols.text,
      cols.attachments || 0, cols.messageId || `<${gmailId}@mail.example.com>`, cols.inReplyTo || null, Boolean(cols.failed),
      cols.lead || null, cols.ago || '1 hour', cols.bouncedTo || null, Boolean(cols.personal), cols.personalTo || null]
  );
  // eslint-disable-next-line security/detect-object-injection -- key is one of this suite's own literal fixture names
  ids.gm[key] = { id: r.rows[0].id, gmailId, ref: `gm:${gmailId}`, messageId: cols.messageId || `<${gmailId}@mail.example.com>` };
}

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
  // A message row holds its Zola lead (ON DELETE RESTRICT): messages first.
  await pool.query('DELETE FROM gmail_messages WHERE gmail_id LIKE $1', [`${GM}-%`]);
  await pool.query('DELETE FROM zola_leads WHERE couple_label LIKE $1', [`${GM} %`]);
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
  // The schema as this lane declares it (gmail_messages.bounced_to), applied
  // the way the other inbox DB suites apply it.
  await initDb();
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

  await seedMail();
  const index = await loadPeopleIndex(pool);
  mailRows = (await pool.query(MAIL_HEADERS_SQL, [INBOX_HISTORY_START])).rows.filter((r) => r.gmail_id.startsWith(`${GM}-`));
  for (const e of mapGmailHeaders(mailRows, index)) gmByRef.set(e.ref, e);
  for (const e of mapZolaHeaders(mailRows, index)) zolaByRef.set(e.ref, e);
  mailEvents = mapMailHeaders(mailRows, index);
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

// Clients with addresses, a second staffer, two Zola leads (one linked to a
// client), and the mail. Invented people at example.com only.
async function seedMail() {
  const client = async (name, email) => {
    const r = await pool.query('INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id', [`${name} ${TAG}`, email]);
    ids.clients.push(r.rows[0].id);
    return r.rows[0].id;
  };
  ids.pat = await client('Pat Mail', mailOf('pat'));
  ids.lee = await client('Lee Planner', mailOf('lee'));
  ids.zolaClient = await client('Alex B and Sam C', null);
  const staff2 = await pool.query(
    "INSERT INTO users (email, password_hash, role, onboarding_status, token_version) VALUES ($1, 'x', 'staff', 'approved', 0) RETURNING id",
    [`${TAG}-staff2@example.com`]
  );
  ids.staff2 = staff2.rows[0].id;
  ids.users.push(ids.staff2);
  await pool.query('INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)', [ids.staff2, 'Rae']);
  await pool.query('INSERT INTO agreements (user_id, full_name, sms_consent) VALUES ($1, $2, true)', [ids.staff2, 'Rae Example']);
  const lead = async (label, clientId, uuid = null) => (await pool.query(
    'INSERT INTO zola_leads (couple_label, couple_label_key, client_id, lead_uuid) VALUES ($1, lower($1), $2, $3) RETURNING id',
    [`${GM} ${label}`, clientId, uuid]
  )).rows[0].id;
  ids.zola.linked = await lead('Alex B & Sam C', ids.zolaClient);
  ids.zola.open = await lead('Lee D & Max E', null, '0b6f2c1e-3d4a-4b5c-8d9e-0f1a2b3c4d5e');
  ids.zola.later = await lead('Kim F & Ray G', null);
  const staffMail = `${TAG}-staff@example.com`;
  const ownMail = `${TAG}-admin@example.com`;

  await gmRow('inClient', { from: mailOf('pat'), fromName: 'Pat Mail', thread: 't1', subject: 'Mocktails', text: 'Can we add a mocktail station?', ago: '5 hours' });
  await gmRow('inStaff', { from: staffMail, thread: 't2', text: 'Can I swap Saturday?', ago: '5 hours' });
  await gmRow('inUnknown', { from: mailOf('unknown'), fromName: 'Jamie Q', thread: 't3', text: 'Do you travel?', ago: '5 hours' });
  await gmRow('inOwn', { from: ownMail, thread: 't4', text: 'Testing the mailbox', ago: '5 hours' });
  await gmRow('inPhoto', { from: mailOf('pat'), thread: 't1', text: null, attachments: 2, ago: '290 minutes' });
  await gmRow('outClient', {
    direction: 'out', to: [mailOf('pat')], thread: 't1', inReplyTo: ids.gm.inClient.messageId, text: 'Yes, we can.', ago: '4 hours',
  });
  await gmRow('outTwo', { direction: 'out', to: [mailOf('pat'), mailOf('lee')], thread: 't5', subject: 'The plan', text: 'Here is the plan', ago: '4 hours' });
  // Review Focus 1: Pat wrote from her own address; the reply went to a
  // Reply-To address nobody knows, and still answers her.
  await gmRow('inAsk', { from: mailOf('pat'), thread: 't7', text: 'Reply to my work address please', ago: '3 hours' });
  await gmRow('outReplyTo', {
    direction: 'out', to: [`${GM}-pat.work@example.net`], thread: 't7', inReplyTo: ids.gm.inAsk.messageId, text: 'Will do', ago: '2 hours',
  });
  // To ourselves, Bcc the client: the stored recipients hold the Bcc.
  await gmRow('outBcc', { direction: 'out', to: [GMAIL_MAILBOX, mailOf('lee')], thread: 't8', text: 'Copying you', ago: '2 hours' });
  await gmRow('outFailed', { direction: 'out', to: [mailOf('lee')], thread: 't9', text: 'See you then', failed: true, ago: '2 hours' });
  await gmRow('bounce', {
    kind: 'bounce', from: 'mailer-daemon@googlemail.com', thread: 't9', inReplyTo: ids.gm.outFailed.messageId, text: null, ago: '100 minutes',
  });
  await gmRow('autoIn', { kind: 'auto_reply', from: mailOf('pat'), thread: 't1', subject: 'Out of office', text: 'Away until Monday', ago: '230 minutes' });
  await gmRow('outStaff', { direction: 'out', to: [staffMail, `${TAG}-staff2@example.com`], thread: 't10', text: 'Uniforms are black', ago: '1 hour' });
  await gmRow('outEmpty', { direction: 'out', to: [mailOf('unknown')], thread: 't3', text: null, attachments: 1, ago: '1 hour' });

  const zola = { from: 'weddingvendors@zola.com', to: [GMAIL_MAILBOX] };
  await gmRow('zInquiry', { ...zola, kind: 'zola_inquiry', thread: 'tz0', text: 'We love your menu', lead: ids.zola.linked, ago: '6 hours' });
  // Review Focus 2, order one: the notice is stored first, the reply after.
  await gmRow('zMessage', { ...zola, kind: 'zola_message', thread: 'tz1', text: 'Is June open?', lead: ids.zola.open, ago: '5 hours' });
  await gmRow('zReplyAfter', {
    direction: 'out', to: [RELAY('abc')], thread: 'tz1', inReplyTo: ids.gm.zMessage.messageId, text: 'June is open', ago: '4 hours',
  });
  // Order two: the backfill stored the reply BEFORE the notice it answers.
  await gmRow('zReplyBefore', { direction: 'out', to: [RELAY('def')], thread: 'tz2', text: 'We can do that', ago: '3 hours' });
  await gmRow('zMessageLate', { ...zola, kind: 'zola_message', thread: 'tz2', text: 'Can you bring a bar?', lead: ids.zola.later, ago: '4 hours' });
  await gmRow('zUnparsed', { ...zola, kind: 'zola_unparsed', thread: 'tz3', text: null, lead: ids.zola.open, ago: '2 hours' });
  await gmRow('zClosed', { ...zola, kind: 'zola_closed', thread: 'tz4', text: 'We found another vendor', lead: ids.zola.linked, ago: '1 hour' });

  // The review round (2026-10-15). A forward keeps the thread it forwards
  // (Gmail does), here a client's question and a Zola notice, both sent on
  // to a bartender.
  await gmRow('outForward', {
    direction: 'out', to: [staffMail], thread: 't1', inReplyTo: ids.gm.inClient.messageId, subject: 'Fwd: Mocktails', text: 'Can you cover this?', ago: '150 minutes',
  });
  await gmRow('zForward', {
    direction: 'out', to: [staffMail], thread: 'tz1', inReplyTo: ids.gm.zMessage.messageId, subject: 'Fwd: New message', text: 'Are you free in June?', ago: '150 minutes',
  });
  // Subjects only, to ourselves (so they form no event): which ones read as a forward.
  await gmRow('fwUpper', { direction: 'out', thread: 'tfw1', subject: '  FW: The plan', ago: '2 hours' });
  await gmRow('fwTight', { direction: 'out', thread: 'tfw2', subject: 'fwd:the plan', ago: '2 hours' });
  await gmRow('reFwd', { direction: 'out', thread: 'tfw3', subject: 'Re: Fwd: The plan', ago: '2 hours' });
  await gmRow('fwInside', { direction: 'out', thread: 'tfw4', subject: 'Plan fwd: later', ago: '2 hours' });
  // Per-recipient bounces: one bad Cc; the client's own address; a reply to a
  // Reply-To address whose report names that address.
  await gmRow('outCc', {
    direction: 'out', to: [mailOf('pat'), mailOf('badcc')], thread: 't12', text: 'Menu attached', failed: true, bouncedTo: [mailOf('badcc')], ago: '2 hours',
  });
  await gmRow('bounceCc', {
    kind: 'bounce', from: 'mailer-daemon@googlemail.com', thread: 't12', inReplyTo: ids.gm.outCc.messageId, text: null,
    bouncedTo: [mailOf('badcc')], ago: '110 minutes',
  });
  await gmRow('outNamed', {
    direction: 'out', to: [mailOf('lee'), mailOf('vendor')], thread: 't13', text: 'Timeline below', failed: true, bouncedTo: [mailOf('lee')], ago: '2 hours',
  });
  // A report naming only an address the mail never went to (where an alias
  // forwarded it): it cannot be placed, so the whole mail reads as failed.
  await gmRow('outElsewhere', {
    direction: 'out', to: [mailOf('lee'), mailOf('vendor2')], thread: 't14', text: 'Updated menu', failed: true,
    bouncedTo: [`${GM}-lee.forwarded@example.net`], ago: '2 hours',
  });
  await gmRow('inAsk3', { from: mailOf('pat'), thread: 't15', text: 'Use my other address', ago: '3 hours' });
  await gmRow('outReplyTo3', {
    direction: 'out', to: [`${GM}-pat.alt@example.net`, mailOf('cc4')], thread: 't15', inReplyTo: ids.gm.inAsk3.messageId, text: 'Sent there',
    failed: true, bouncedTo: [`${GM}-pat.alt@example.net`], ago: '2 hours',
  });
  // Our own vacation responder answering the client.
  await gmRow('autoOut', { direction: 'out', kind: 'auto_reply', to: [mailOf('pat')], thread: 't16', subject: 'Automatic reply', ago: '100 minutes' });
  // One Sent mail to Zola's relay and a client: a Zola reply and an email reply, two refs.
  await gmRow('zReplyCc', {
    direction: 'out', to: [RELAY('ghi'), mailOf('lee')], thread: 'tz1', text: 'Copying our planner', ago: '140 minutes',
  });
  // A linked couple whose own address got the reply as well: one reply, not two.
  ids.casey = await client('Casey Twin', mailOf('casey'));
  ids.zola.twin = await lead('Casey T & Jo U', ids.casey);
  await gmRow('zTwinMsg', { ...zola, kind: 'zola_message', thread: 'tz6', text: 'Do you do sparklers?', lead: ids.zola.twin, ago: '3 hours' });
  await gmRow('zTwinReply', {
    direction: 'out', to: [RELAY('jkl'), mailOf('casey')], thread: 'tz6', inReplyTo: ids.gm.zTwinMsg.messageId, text: 'We do', ago: '2 hours',
  });

  // Personal mail (spec 2026-10-14 decision 6, as decided 2026-10-15), as
  // the sync stored it: personal and personal_to set once at storage.
  await gmRow('pIn', { from: mailOf('friend'), to: [PERSONAL_ALIAS], thread: 'tp1', text: 'Dinner on Sunday?', personal: true, ago: '5 hours' });
  await gmRow('pBiz', { from: mailOf('friend'), to: [GMAIL_MAILBOX], thread: 'tp2', text: 'Also, a quote for a party?', ago: '4 hours' });
  // Stored personal while Pat was nobody we knew; Pat is a client now.
  await gmRow('pNowClient', { from: mailOf('pat'), to: [PERSONAL_ALIAS], thread: 'tp3', text: 'Old friend here', personal: true, ago: '5 hours' });
  await gmRow('pReplyAlias', {
    direction: 'out', from: PERSONAL_ALIAS, to: [mailOf('friend'), mailOf('lee')], thread: 'tp1', inReplyTo: ids.gm.pIn.messageId,
    text: 'Sunday works', personal: true, personalTo: [mailOf('friend')], ago: '4 hours',
  });
  await gmRow('pBizReply', { direction: 'out', to: [mailOf('friend')], thread: 'tp2', inReplyTo: ids.gm.pBiz.messageId, text: 'Quote attached', ago: '3 hours' });
  // The first sync stores Sent mail before the inbound it answers, so the
  // sync never saw this reply's personal inbound: its row says business.
  await gmRow('pIn2', { from: mailOf('friend2'), to: [PERSONAL_ALIAS], thread: 'tp4', text: 'Lunch?', personal: true, ago: '5 hours' });
  await gmRow('pReplyBackfill', {
    direction: 'out', to: [mailOf('friend2')], thread: 'tp4', inReplyTo: ids.gm.pIn2.messageId, text: 'Yes, lunch', ago: '4 hours',
  });
  await gmRow('pSentFailed', {
    direction: 'out', from: PERSONAL_ALIAS, to: [mailOf('friend3')], thread: 'tp5', text: 'Are you around?', personal: true,
    personalTo: [mailOf('friend3')], failed: true, bouncedTo: [mailOf('friend3')], ago: '3 hours',
  });
  await gmRow('pBounce', {
    kind: 'bounce', from: 'mailer-daemon@googlemail.com', thread: 'tp5', inReplyTo: ids.gm.pSentFailed.messageId, text: null,
    bouncedTo: [mailOf('friend3')], ago: '170 minutes',
  });
  // Answering decides first (the coordinator's correction, 2026-10-15): a
  // reply from the owner alias to a business mail is business, as the sync
  // stores it, and also when the first sync stored it as a fresh send from
  // the alias (personal_to set) before the inbound it answers was stored.
  await gmRow('pBiz6', { from: mailOf('friend6'), to: [GMAIL_MAILBOX], thread: 'tp6', text: 'Do you do weddings?', ago: '5 hours' });
  await gmRow('pAliasBizReply', {
    direction: 'out', from: PERSONAL_ALIAS, to: [mailOf('friend6')], thread: 'tp6', inReplyTo: ids.gm.pBiz6.messageId, text: 'We do', ago: '4 hours',
  });
  await gmRow('pBiz7', { from: mailOf('friend7'), to: [GMAIL_MAILBOX], thread: 'tp7', text: 'Are you free in May?', ago: '5 hours' });
  await gmRow('pAliasBizReplyFirstSync', {
    direction: 'out', from: PERSONAL_ALIAS, to: [mailOf('friend7')], thread: 'tp7', inReplyTo: ids.gm.pBiz7.messageId, text: 'We are',
    personal: true, personalTo: [mailOf('friend7')], ago: '4 hours',
  });
  // The first sync stored this reply from the mailbox BEFORE the personal
  // mail it answers, so its row says business; it went to the friend, their
  // spouse (nobody we know) and a client.
  await gmRow('pReply9', {
    direction: 'out', to: [mailOf('friend9'), mailOf('spouse9'), mailOf('lee')], thread: 'tp9', inReplyTo: `<${GM}-pIn9@mail.example.com>`,
    text: 'Sunday is great for us both', ago: '4 hours',
  });
  await gmRow('pIn9', { from: mailOf('friend9'), to: [PERSONAL_ALIAS], thread: 'tp9', text: 'Dinner with the family?', personal: true, ago: '5 hours' });
  // A later mail (stored first, dated after the reply) reusing the
  // Message-ID of the personal mail the reply answers.
  await gmRow('pReuse', { from: mailOf('pat'), to: [GMAIL_MAILBOX], thread: 'tpx', messageId: `<${GM}-shared@mail.example.com>`, ago: '1 hour' });
  await gmRow('pIn10', {
    from: mailOf('friend10'), to: [PERSONAL_ALIAS], thread: 'tp10', messageId: `<${GM}-shared@mail.example.com>`, text: 'Coffee?', personal: true, ago: '5 hours',
  });
  await gmRow('pReply10', { direction: 'out', to: [mailOf('friend10')], thread: 'tp10', inReplyTo: `<${GM}-shared@mail.example.com>`, text: 'Yes', ago: '3 hours' });
  // A fresh send from the alias (it answers nothing), stored personal.
  await gmRow('pFresh', {
    direction: 'out', from: PERSONAL_ALIAS, to: [mailOf('friend4')], thread: 'tp8', text: 'Long time no see', personal: true,
    personalTo: [mailOf('friend4')], ago: '2 hours',
  });
}

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

test('a text written without a group_id reads as a group of one (the column default; the reader guards a NULL)', async () => {
  const { rows: cols } = await pool.query(
    `SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sms_messages' AND column_name = 'group_id'`
  );
  assert.equal(cols.length, 1);
  assert.equal(cols[0].is_nullable, 'NO', 'group_id can be NULL now: the CASE in readSms.js is what keeps those texts groups of one');
  assert.match(cols[0].column_default || '', /gen_random_uuid/, 'group_id lost its fresh-uuid default');
  // Two texts from the admin to the staffer, neither naming group_id, so each
  // takes the column default. On the staff channel a user's text is a reply
  // only in a group of one (classify.js).
  const mine = (await pool.query(
    `INSERT INTO sms_messages (direction, sender_id, recipient_id, recipient_phone, body, status) VALUES
       ('outbound', $1, $2, $3, 'Call time is 5pm', 'sent'),
       ('outbound', $1, $2, $3, 'Parking is behind the hall', 'sent')
     RETURNING id`,
    [ids.admin, ids.staff, P.staff]
  )).rows.map((r) => r.id);
  try {
    // The whole window, as the engine reads it: the window count runs after
    // WHERE, so a read narrowed to these ids would count only them.
    const index = await loadPeopleIndex(pool);
    const { rows } = await pool.query(SMS_HEADERS_SQL, [INBOX_HISTORY_START]);
    const read = rows.filter((r) => mine.includes(r.id)).map((r) => mapSmsHeader(r, index));
    assert.deepEqual(read.map((e) => [e.personKey, e.channel, e.meta.groupSize]), [[`s-${ids.staff}`, 'staff_text', 1], [`s-${ids.staff}`, 'staff_text', 1]]);
  } finally {
    await pool.query('DELETE FROM sms_messages WHERE id = ANY($1::int[])', [mine]);
  }
});

// ─── Email and Zola (spec 2026-10-14 section 5.1) ───

const gmEv = (key) => gmByRef.get(ids.gm[key].ref); // eslint-disable-line security/detect-object-injection -- a literal fixture name
const gmAll = (key) => [...gmByRef.values()].filter((e) => e.meta.readRef === ids.gm[key].ref); // eslint-disable-line security/detect-object-injection -- a literal fixture name
const zEv = (key) => zolaByRef.get(ids.gm[key].ref); // eslint-disable-line security/detect-object-injection -- a literal fixture name
// Our Gmail reply through Zola's relay: gm:<id>:z, never the email side's ref.
const zReply = (key) => zolaByRef.get(`${ids.gm[key].ref}:z`); // eslint-disable-line security/detect-object-injection -- a literal fixture name

test('email inbound: a client address is c-, a staffer s-, an unknown sender e- (a hash, never the address), our own nothing', () => {
  assert.deepEqual([gmEv('inClient').personKey, gmEv('inClient').direction, gmEv('inClient').kind, gmEv('inClient').channel],
    [`c-${ids.pat}`, 'in', 'message', 'email']);
  assert.equal(gmEv('inStaff').personKey, `s-${ids.staff}`);
  const unknown = gmEv('inUnknown');
  assert.equal(unknown.personKey, `e-${emailHash(mailOf('unknown'))}`);
  assert.ok(!unknown.personKey.includes('example'), 'the key carries no address');
  assert.deepEqual([unknown.meta.address, unknown.meta.fromName], [mailOf('unknown'), 'Jamie Q']);
  assert.equal(gmByRef.get(ids.gm.inOwn.ref), undefined, 'an operator address is ours');
  assert.equal(gmEv('inClient').text, undefined, 'pass 1 carries no words');
});

test('email inbound: an attachment-only mail is media, never empty; the header meta is spec 5.1 plus personal', () => {
  const photo = gmEv('inPhoto');
  assert.deepEqual([photo.kind, photo.meta.attachments, photo.meta.empty], ['media', 2, false]);
  const m = gmEv('inClient').meta;
  assert.deepEqual(Object.keys(m).sort(), ['address', 'attachments', 'empty', 'failed', 'fromName', 'gmailId', 'id', 'legalHold',
    'personal', 'readRef', 'source', 'textBearing', 'threadId'].sort(), 'no recipient list rides on the event any more');
  assert.deepEqual([m.source, m.readRef, m.personal, m.threadId], ['gm', ids.gm.inClient.ref, false, `${GM}-t1`]);
});

test('email outbound: a Sent mail to a client is one reply, no author, text-bearing; to two people, two events sharing readRef', () => {
  const out = gmAll('outClient');
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].ref, out[0].personKey, out[0].direction, out[0].author, out[0].meta.textBearing],
    [ids.gm.outClient.ref, `c-${ids.pat}`, 'out', null, true]);
  assert.equal(countsAsReply(out[0]), true);
  const two = gmAll('outTwo').sort((a, b) => (a.ref < b.ref ? -1 : 1));
  assert.deepEqual(two.map((e) => [e.ref, e.personKey, e.meta.readRef]), [
    [`${ids.gm.outTwo.ref}:1`, `c-${ids.pat}`, ids.gm.outTwo.ref],
    [`${ids.gm.outTwo.ref}:2`, `c-${ids.lee}`, ids.gm.outTwo.ref],
  ]);
});

test('outbound resolves by the inbound it answers before recipients (Review Focus 1)', () => {
  const [first, second] = gmAll('outReplyTo').sort((a, b) => (a.ref < b.ref ? -1 : 1));
  assert.deepEqual([first.ref, first.personKey, first.meta.address], [`${ids.gm.outReplyTo.ref}:1`, `c-${ids.pat}`, mailOf('pat')]);
  assert.equal(second.personKey, `e-${emailHash(`${GM}-pat.work@example.net`)}`);
  assert.equal(countsAsReply(first), true, 'the client who wrote is answered');
});

test('email outbound: Bcc counts, our own address never does; a bounced reply is failed and no reply', () => {
  const bcc = gmAll('outBcc');
  assert.deepEqual(bcc.map((e) => [e.ref, e.personKey, e.meta.address]), [[ids.gm.outBcc.ref, `c-${ids.lee}`, mailOf('lee')]]);
  const failed = gmEv('outFailed');
  assert.deepEqual([failed.meta.failed, countsAsReply(failed)], [true, false]);
});

test('email system lines: an auto-reply is theirs, a bounce is the person of the Sent mail it names', () => {
  const auto = gmEv('autoIn');
  assert.deepEqual([auto.personKey, auto.direction, auto.kind], [`c-${ids.pat}`, 'system', 'auto_reply']);
  const bounce = gmEv('bounce');
  assert.deepEqual([bounce.personKey, bounce.direction, bounce.kind], [`c-${ids.lee}`, 'system', 'bounce']);
});

test('email outbound: a mail to two staffers marks both events a group; an attachment-only reply carries no words', () => {
  const staff = gmAll('outStaff');
  assert.deepEqual(staff.map((e) => [e.personKey, e.meta.staffGroup]).sort(), [[`s-${ids.staff2}`, true], [`s-${ids.staff}`, true]].sort());
  assert.deepEqual(staff.map(countsAsReply), [false, false], 'a mail to two staffers answers neither');
  const empty = gmEv('outEmpty');
  assert.deepEqual([empty.kind, empty.meta.textBearing, empty.meta.attachments], ['message', false, 1]);
});

test('zola: a notice is its lead, z- unlinked or the client linked; inquiry carries its template; unparsed reads the fixed line', () => {
  const inquiry = zEv('zInquiry');
  assert.deepEqual([inquiry.personKey, inquiry.channel, inquiry.direction, inquiry.kind, inquiry.meta.template, inquiry.meta.zolaLeadId],
    [`c-${ids.zolaClient}`, 'zola', 'in', 'message', 'inquiry', ids.zola.linked]);
  const message = zEv('zMessage');
  assert.deepEqual([message.personKey, message.meta.template, message.meta.leadUuid],
    [`z-${ids.zola.open}`, 'message', '0b6f2c1e-3d4a-4b5c-8d9e-0f1a2b3c4d5e']);
  const unparsed = zEv('zUnparsed');
  assert.deepEqual([unparsed.kind, unparsed.direction, unparsed.text, unparsed.meta.template], ['zola_unread', 'in', ZOLA_UNREAD_TEXT, 'unparsed']);
  const closed = zEv('zClosed');
  assert.deepEqual([closed.kind, closed.direction, closed.personKey], ['zola_closed', 'system', `c-${ids.zolaClient}`]);
  assert.equal(gmByRef.get(ids.gm.zInquiry.ref), undefined, 'a Zola notice is never an email row');
});

test('zola join works in both storage orders (Review Focus 2), and the relay reply is never an email person', () => {
  const after = zReply('zReplyAfter');
  assert.ok(ids.gm.zReplyAfter.id > ids.gm.zMessage.id, 'stored after its notice');
  assert.deepEqual([after.personKey, after.direction, after.channel, after.author, after.meta.textBearing, countsAsReply(after)],
    [`z-${ids.zola.open}`, 'out', 'zola', null, true, true]);
  const before = zReply('zReplyBefore');
  assert.ok(ids.gm.zReplyBefore.id < ids.gm.zMessageLate.id, 'stored before its notice');
  assert.deepEqual([before.personKey, before.direction, countsAsReply(before)], [`z-${ids.zola.later}`, 'out', true]);
  assert.deepEqual([...gmAll('zReplyAfter'), ...gmAll('zReplyBefore')], [], 'no e- person for a relay address');
  assert.equal(zolaByRef.get(ids.gm.outClient.ref), undefined, 'a Sent mail that answers no notice is not Zola');
  assert.equal(zReply('outClient'), undefined);
});

test('pass 2: subject and words by readRef, so every sibling of one Sent mail gets them; an unread notice keeps its line', async () => {
  const wanted = [gmEv('inClient'), ...gmAll('outTwo'), zEv('zUnparsed'), zEv('zClosed')];
  const full = mergeDetails(wanted, await loadDetails(wanted, pool));
  const byRef = new Map(full.map((e) => [e.ref, e]));
  assert.deepEqual([byRef.get(ids.gm.inClient.ref).text, byRef.get(ids.gm.inClient.ref).meta.subject], ['Can we add a mocktail station?', 'Mocktails']);
  for (const n of [1, 2]) {
    const e = byRef.get(`${ids.gm.outTwo.ref}:${n}`);
    assert.deepEqual([e.text, e.meta.subject], ['Here is the plan', 'The plan'], `sibling ${n}`);
  }
  assert.equal(byRef.get(ids.gm.zUnparsed.ref).text, ZOLA_UNREAD_TEXT);
  assert.equal(byRef.get(ids.gm.zClosed.ref).text, 'We found another vendor');
});

// ─── the review round (2026-10-15) ───

test('a forward answers its recipients only: a client question sent on to a bartender answers no client, and no Zola couple', () => {
  assert.deepEqual(gmAll('outForward').map((e) => e.personKey), [`s-${ids.staff}`]);
  assert.equal(gmAll('outForward').some((e) => e.personKey === `c-${ids.pat}`), false, 'the client still waits');
  assert.equal(countsAsReply(gmAll('outClient')[0]), true, 'a real reply in the same thread still answers');
  assert.equal(zReply('zForward'), undefined, 'a forwarded notice is no reply to the couple');
  assert.deepEqual(gmAll('zForward').map((e) => e.personKey), [`s-${ids.staff}`]);
  const forward = new Map(mailRows.map((r) => [r.gmail_id, r.forward]));
  assert.deepEqual(['outForward', 'fwUpper', 'fwTight', 'reFwd', 'fwInside', 'outClient', 'outTwo'].map((k) => forward.get(ids.gm[k].gmailId)), // eslint-disable-line security/detect-object-injection -- literal fixture names
    [true, true, true, false, false, false, false], 'Fwd: or Fw: at the start, any case; a reply to a forward is a reply');
});

test('a per-recipient bounce: one bad Cc fails only its own event; a report naming the client fails theirs', () => {
  const cc = new Map(gmAll('outCc').map((e) => [e.personKey, e]));
  const bad = `e-${emailHash(mailOf('badcc'))}`;
  assert.deepEqual([cc.get(`c-${ids.pat}`).meta.failed, cc.get(bad).meta.failed], [false, true]);
  assert.equal(countsAsReply(cc.get(`c-${ids.pat}`)), true, 'the client got the mail: it answers them');
  assert.deepEqual(gmAll('bounceCc').map((e) => e.personKey), [bad], 'the bounce line sits with the address that failed');
  const named = new Map(gmAll('outNamed').map((e) => [e.personKey, e.meta.failed]));
  assert.deepEqual([named.get(`c-${ids.lee}`), named.get(`e-${emailHash(mailOf('vendor'))}`)], [true, false]);
  assert.equal(countsAsReply(gmAll('outNamed').find((e) => e.personKey === `c-${ids.lee}`)), false);
  const viaReplyTo = new Map(gmAll('outReplyTo3').map((e) => [e.personKey, e.meta.failed]));
  assert.deepEqual([viaReplyTo.get(`c-${ids.pat}`), viaReplyTo.get(`e-${emailHash(`${GM}-pat.alt@example.net`)}`), viaReplyTo.get(`e-${emailHash(mailOf('cc4'))}`)],
    [true, true, false], 'the person answered through a Reply-To address shares that address\'s fate');
  assert.deepEqual([gmEv('outFailed').meta.failed, gmEv('bounce').personKey], [true, `c-${ids.lee}`], 'a report naming nobody still fails the whole mail');
  assert.deepEqual(gmAll('outElsewhere').map((e) => e.meta.failed), [true, true], 'a report naming no recipient of the mail fails it whole');
});

test('our own auto-reply is a system line marked sent; theirs is not', () => {
  const ours = gmEv('autoOut');
  assert.deepEqual([ours.personKey, ours.direction, ours.kind, ours.meta.sent], [`c-${ids.pat}`, 'system', 'auto_reply', true]);
  assert.equal(gmEv('autoIn').meta.sent, undefined);
});

test('one Sent mail on both sides: a Zola reply gm:<id>:z and an email reply gm:<id>, one readRef; a twin on one person is one reply', () => {
  const z = zReply('zReplyCc');
  const email = gmAll('zReplyCc');
  assert.deepEqual([z.personKey, z.meta.readRef], [`z-${ids.zola.open}`, ids.gm.zReplyCc.ref]);
  assert.deepEqual(email.map((e) => [e.ref, e.personKey, e.meta.readRef]), [[ids.gm.zReplyCc.ref, `c-${ids.lee}`, ids.gm.zReplyCc.ref]]);
  const refs = mailEvents.map((e) => e.ref);
  assert.equal(new Set(refs).size, refs.length, 'no ref twice across both readers');
  assert.ok(zReply('zTwinReply'), 'the Zola reader alone sees the couple reply');
  const twin = mailEvents.filter((e) => e.meta.readRef === ids.gm.zTwinReply.ref);
  assert.deepEqual(twin.map((e) => [e.personKey, e.channel]), [[`c-${ids.casey}`, 'email']], 'one reply for the one person');
});

// ─── personal mail (spec 2026-10-14 decision 6, as decided 2026-10-15) ───

test('personal mail: a row the sync stored personal is its sender\'s personal person, never the business key, whoever the sender is now', () => {
  const friendPersonal = personalEmailKey(mailOf('friend'));
  const friendBusiness = `e-${emailHash(mailOf('friend'))}`;
  assert.match(friendPersonal, /^e-[0-9a-f]{16}$/);
  assert.notEqual(friendPersonal, friendBusiness);
  assert.deepEqual([gmEv('pIn').personKey, gmEv('pIn').meta.personal], [friendPersonal, true]);
  assert.deepEqual([gmEv('pBiz').personKey, gmEv('pBiz').meta.personal], [friendBusiness, false], 'the same friend\'s business mail');
  assert.deepEqual([gmEv('pNowClient').personKey, gmEv('pNowClient').meta.personal], [personalEmailKey(mailOf('pat')), true],
    'not c-: the sender became a client after the sync judged it');
});

test('personal Sent mail: the reply from the alias joins the personal person it answers; the client it copies keeps a business event', () => {
  const reply = new Map(gmAll('pReplyAlias').map((e) => [e.personKey, e]));
  assert.deepEqual([...reply.keys()].sort(), [personalEmailKey(mailOf('friend')), `c-${ids.lee}`].sort());
  assert.deepEqual([reply.get(personalEmailKey(mailOf('friend'))).meta.personal, reply.get(`c-${ids.lee}`).meta.personal], [true, false]);
  assert.equal(countsAsReply(reply.get(personalEmailKey(mailOf('friend')))), true, 'a reply on the personal person');
  assert.deepEqual(gmAll('pBizReply').map((e) => [e.personKey, e.meta.personal]), [[`e-${emailHash(mailOf('friend'))}`, false]],
    'the business reply lands on the business person');
});

test('a reply stored before the personal mail it answers (the first sync) still lands on the personal person, never a business one', () => {
  assert.deepEqual(gmAll('pReplyBackfill').map((e) => [e.personKey, e.meta.personal]), [[personalEmailKey(mailOf('friend2')), true]]);
  assert.equal(mailEvents.some((e) => e.personKey === `e-${emailHash(mailOf('friend2'))}`), false, 'no business person for friend2 at all');
});

test('a bounce of a personal Sent mail sits with the personal person and fails its event there', () => {
  const key = personalEmailKey(mailOf('friend3'));
  assert.deepEqual(gmAll('pSentFailed').map((e) => [e.personKey, e.meta.personal, e.meta.failed]), [[key, true, true]]);
  assert.deepEqual(gmAll('pBounce').map((e) => [e.personKey, e.kind, e.meta.personal]), [[key, 'bounce', true]]);
});

test('answering decides first: the owner alias answering a business mail is business and answers it, even as the first sync stored it', () => {
  for (const [reply, friend] of [['pAliasBizReply', 'friend6'], ['pAliasBizReplyFirstSync', 'friend7']]) {
    const events = gmAll(reply);
    assert.deepEqual(events.map((e) => [e.personKey, e.meta.personal]), [[`e-${emailHash(mailOf(friend))}`, false]], reply);
    assert.equal(countsAsReply(events[0]), true, `${reply} answers the business item`);
    assert.equal(mailEvents.some((e) => e.personKey === personalEmailKey(mailOf(friend))), false, `${reply}: no personal person`);
  }
});

test('a reply to a personal mail, stored before it: each recipient nobody knows is a personal person, a copied client stays business', () => {
  assert.ok(ids.gm.pReply9.id < ids.gm.pIn9.id, 'stored before the mail it answers');
  assert.deepEqual(gmAll('pReply9').map((e) => [e.personKey, e.meta.personal]).sort(), [
    [personalEmailKey(mailOf('friend9')), true], [personalEmailKey(mailOf('spouse9')), true], [`c-${ids.lee}`, false],
  ].sort());
  assert.equal(mailEvents.some((e) => e.personKey === `e-${emailHash(mailOf('spouse9'))}`), false, 'no business person for the spouse');
});

test('a reply answers only an inbound dated at or before it: a later mail reusing the Message-ID never takes it over', () => {
  assert.ok(ids.gm.pReuse.id < ids.gm.pIn10.id, 'the later mail was stored first');
  assert.deepEqual(gmAll('pReply10').map((e) => [e.personKey, e.meta.personal]), [[personalEmailKey(mailOf('friend10')), true]]);
});

test('a fresh send from the owner alias (it answers nothing) is the personal person of each recipient it is personal for', () => {
  assert.deepEqual(gmAll('pFresh').map((e) => [e.personKey, e.meta.personal]), [[personalEmailKey(mailOf('friend4')), true]]);
});

test('the one scan splits into exactly the rows the two old queries read', async () => {
  const old = async (where) => (await pool.query(`SELECT gmail_id FROM gmail_messages WHERE at >= $1 AND gmail_id LIKE $2 AND ${where}`,
    [INBOX_HISTORY_START, `${GM}-%`])).rows.map((r) => r.gmail_id).sort();
  assert.deepEqual(mailRows.filter(isGmRow).map((r) => r.gmail_id).sort(),
    await old("zola_lead_id IS NULL AND kind IN ('message', 'auto_reply', 'bounce')"));
  assert.deepEqual(mailRows.filter(isZolaRow).map((r) => r.gmail_id).sort(),
    await old("(kind IN ('zola_inquiry', 'zola_message', 'zola_closed', 'zola_unparsed') OR (direction = 'out' AND kind = 'message'))"));
  assert.equal(mailRows.find((r) => r.gmail_id === ids.gm.inPhoto.gmailId).empty_body, true);
  assert.equal(mailRows.find((r) => r.gmail_id === ids.gm.inClient.gmailId).empty_body, false);
});

test('the Zola feed time is the newest lead-linked row: a Zola notice counts, a newer Sent mail does not', async () => {
  const insert = (key, cols) => pool.query(
    `INSERT INTO gmail_messages (gmail_id, thread_id, direction, kind, from_address, to_addresses, zola_lead_id, at)
     VALUES ($1, $1, $2, $3, $4, $5::text[], $6, NOW() + $7::interval) RETURNING at`,
    [`${GM}-${key}`, cols.direction, cols.kind, cols.from, cols.to, cols.lead || null, cols.ahead]
  );
  try {
    const notice = (await insert('feedZola', {
      direction: 'in', kind: 'zola_message', from: 'weddingvendors@zola.com', to: [GMAIL_MAILBOX], lead: ids.zola.open, ahead: '1 minute',
    })).rows[0].at;
    await insert('feedSent', { direction: 'out', kind: 'message', from: GMAIL_MAILBOX, to: [mailOf('pat')], ahead: '2 minutes' });
    const zola = (await loadFeeds({ now: new Date() }, pool)).find((f) => f.source === 'zola');
    assert.equal(zola.last_at, notice.toISOString());
  } finally {
    await pool.query('DELETE FROM gmail_messages WHERE gmail_id = ANY($1::text[])', [[`${GM}-feedZola`, `${GM}-feedSent`]]);
  }
});

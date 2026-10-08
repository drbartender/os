'use strict';

// The reply area of an opened item and the target of an Inbox text (spec 4.3,
// 5.8, 8 and decision 29). One resolver serves both, so the box the admin sees
// and the route that sends can never disagree about who, which number, or
// which lines.

const { pool } = require('../../db');
const { last10 } = require('../phone');
const { normalizePhone } = require('../sms');
const smsLines = require('../smsLines');
const smsOptOut = require('../smsOptOut');
const staffText = require('../staffText');
const { thumbtackInboxUrl } = require('./constants');
const { parsePersonKey } = require('./personKey');
const { phoneDisplay } = require('./contextFormat');
const { firstTextPrefixFor } = require('./firstText');
const { lastHumanRowsForClient } = require('./lastHumanRows');
const { pickRecipient, smsRowsOf, theirLineOf, latestConversationChannel } = require('./replyRules');

const CLIENT_SQL = 'SELECT id, name, phone, communication_preferences, phone_status FROM clients WHERE id = $1';

const realDeps = () => ({
  textability: (args, db) => smsOptOut.textability(args, db),
  loadEligibleStaffRecipients: (ids, db) => staffText.loadEligibleStaffRecipients(ids, db),
});
let _deps = realDeps();
function __setReplyDeps(d) { _deps = { ..._deps, ...d }; }
function __resetReplyDeps() { _deps = realDeps(); }

function withLines(target, index) {
  const isProxy = Boolean(target.recipient && index.isProxyPhone(last10(target.recipient)));
  return { ...target, isProxy, lines: smsLines.allowedLines({ isStaff: target.isStaff, isProxy }) };
}

// Who can be texted (spec 8): c- with a phone, s- in the send-eligible set,
// p- and t- only as a reply to a text they sent a DRB line. Never a cold text.
async function resolveTextTarget(personKey, { events, index }, db = pool) {
  const key = parsePersonKey(personKey);
  const base = {
    personKey, type: key ? key.type : null, isStaff: Boolean(key && key.type === 's'),
    clientId: null, client: null, staffRecipient: null, recipient: null, textable: false, why: null, isProxy: false, lines: [],
  };
  if (!key) return { ...base, why: 'That is not an inbox person.' };
  if (key.type === 'c') {
    const { rows } = await db.query(CLIENT_SQL, [Number(key.id)]);
    const client = rows[0];
    if (!client) return { ...base, why: 'This client no longer exists.' };
    const recipient = pickRecipient({ events, fallbackE164: normalizePhone(client.phone || '') });
    return withLines({
      ...base, clientId: client.id, client, recipient, textable: Boolean(recipient),
      why: recipient ? null : 'This client has no phone number on file.',
    }, index);
  }
  if (key.type === 's') {
    const userId = Number(key.id);
    const found = index.staffEligible.has(userId) ? await _deps.loadEligibleStaffRecipients([userId], db) : [];
    const row = (found || [])[0];
    // Zero recipients is an error, never a silent success (spec 8).
    if (!row) return { ...base, why: 'This staffer cannot be texted from Inbox.' };
    const recipient = pickRecipient({ events, fallbackE164: normalizePhone(row.phone || '') });
    return withLines({
      ...base, staffRecipient: row, recipient, textable: Boolean(recipient),
      why: recipient ? null : 'This staffer has no phone number on file.',
    }, index);
  }
  const recipient = pickRecipient({ events });
  if (!recipient) return { ...base, why: 'Inbox only texts a number that has texted us first.' };
  return withLines({ ...base, recipient, textable: true }, index);
}

// One opt-out rule for every line (5.8), lane sms-lines' textability.
function textabilityFor(target, db = pool) {
  if (target.type === 'c') return _deps.textability({ kind: 'client', client: target.client, phone: target.recipient }, db);
  if (target.type === 's') {
    const r = target.staffRecipient;
    return _deps.textability({
      kind: 'staff',
      user: { id: r.id, communication_preferences: r.communication_preferences || {} },
      agreement: { sms_consent: r.sms_consent },
      phone: target.recipient,
    }, db);
  }
  return _deps.textability({ kind: 'unknown', phone: target.recipient }, db);
}

function appLinkFor(personKey, index) {
  const key = parsePersonKey(personKey);
  let negotiationId = null;
  if (key && key.type === 't') negotiationId = key.id;
  if (key && key.type === 'c') {
    const lead = index.latestLeadByClient.get(Number(key.id));
    negotiationId = lead ? String(lead.negotiation_id) : null;
  }
  return negotiationId ? { name: 'Thumbtack', url: thumbtackInboxUrl(negotiationId) } : null;
}

// Only the lines whose next text gets the prefix: { "1922": "Dr. Bartender: " },
// or {} (spec amendment 7). A missing line means no prefix.
async function firstTextPrefixes(target, db) {
  const pairs = await Promise.all(target.lines.map(async (line) => [line, await firstTextPrefixFor({ line, to: target.recipient }, db)]));
  return Object.fromEntries(pairs.filter(([, prefix]) => Boolean(prefix)));
}

async function buildReplyBlock({ personKey, events, index, viewerId }, db = pool) {
  const target = await resolveTextTarget(personKey, { events, index }, db);
  const app = appLinkFor(personKey, index);
  const theirLine = theirLineOf(events);
  const closed = {
    lines: [], default_line: null, last_line: null, their_line: theirLine, recipient_display: null, opted_out: null,
    bad_number: false, proxy: false, staff: target.isStaff, first_text_prefix: {}, app,
  };
  if (!target.textable) return { mode: app ? 'open' : 'none', ...closed };
  const check = await textabilityFor(target, db);
  if (!check.ok && check.reason === 'no_phone') return { mode: app ? 'open' : 'none', ...closed };
  // One "last human-involved line" rule with the Messages reply (amendment
  // 20), over the same rows: a client's whole history as the Messages reply
  // reads it (lastHumanRows.js) beside their events since the floor, and the
  // newest row wins. A p-, s- or t- key has only its events.
  const history = target.type === 'c' ? await lastHumanRowsForClient(target.clientId, db) : [];
  const lastLine = smsLines.lastHumanLineFromRows([...smsRowsOf(events), ...history]);
  return {
    mode: latestConversationChannel(events) === 'thumbtack' && app ? 'open' : 'text',
    lines: target.lines,
    default_line: smsLines.defaultLine({ lastHumanLine: lastLine, senderUserId: viewerId, isStaff: target.isStaff, isProxy: target.isProxy }),
    last_line: lastLine,
    their_line: theirLine,
    recipient_display: phoneDisplay(target.recipient),
    opted_out: !check.ok && check.reason === 'opted_out' ? { since: check.since ? new Date(check.since).toISOString() : null } : null,
    bad_number: !check.ok && check.reason === 'bad_number',
    proxy: target.isProxy,
    staff: target.isStaff,
    first_text_prefix: await firstTextPrefixes(target, db),
    app,
  };
}

module.exports = { resolveTextTarget, textabilityFor, buildReplyBlock, appLinkFor, __setReplyDeps, __resetReplyDeps };

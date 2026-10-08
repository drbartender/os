'use strict';

// The answering allowlist (Inbox spec 2026-10-06, decision 26, section 5.4 and
// section 14 "Attribution"). Pure: no DB. The writer scan reads server/ source
// and pins every allowlisted type's write sites, file and count, so renaming
// the type at any one site, removing a writer or adding a new one fails here
// until EXPECTED_WRITE_SITES is updated on purpose, instead of silently
// changing which sends close an Inbox item. Synthetic sources prove each
// call-site shape counts, and that the export line and a file with no send
// call count nothing.
//   node --test server/utils/answeringMessageTypes.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ANSWERING_MESSAGE_TYPES, PROPOSAL_SEND_MESSAGE_TYPES } = require('./answeringMessageTypes');

const SERVER_DIR = path.resolve(__dirname, '..');
const SELF = path.join(__dirname, 'answeringMessageTypes.js');

// A writer is a non-test server source file that hands the type to a send or
// ledger primitive. The call-site shapes in use today:
//   messageType: 'x'          a literal in a send's meta or sendAndLogSms args
//   const messageType = 'x'   a comms action: its email entry reads
//                             `messageType, sentBy:` and its SMS entry
//                             derives `${messageType}_sms`. The export line
//                             (`key, messageType, defaultChannels,`) also
//                             holds a bare `messageType,`, so the scan keys
//                             on the entry shape, never on the bare word.
const SEND_CALL_RE = /\b(?:sendEmail|sendSMS|sendAndLogSms|logClientMessage)\s*\(/;

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') && p !== SELF) out.push(p);
  }
  return out;
}

// The write sites in ONE source string, as type -> count. A source with no
// send or ledger call writes nothing. Each literal counts one site. A comms
// action counts one site for its base type when it holds the email entry
// shape, and one for <base>_sms when it holds the SMS entry shape.
function writeSitesIn(src) {
  const sites = new Map();
  const count = (type) => sites.set(type, (sites.get(type) || 0) + 1);
  if (!SEND_CALL_RE.test(src)) return sites;
  for (const m of src.matchAll(/messageType:\s*'([a-z0-9_]+)'/g)) count(m[1]);
  const base = src.match(/const messageType = '([a-z0-9_]+)';/);
  if (base) {
    if (/\bmessageType,\s*sentBy:/.test(src)) count(base[1]);
    if (src.includes('`${messageType}_sms`')) count(`${base[1]}_sms`);
  }
  return sites;
}

// type -> (file relative to server/ -> count), over the same walk.
function writtenTypes() {
  const found = new Map();
  for (const file of sourceFiles(SERVER_DIR)) {
    const rel = path.relative(SERVER_DIR, file).split(path.sep).join('/');
    for (const [type, n] of writeSitesIn(fs.readFileSync(file, 'utf8'))) {
      if (!found.has(type)) found.set(type, new Map());
      found.get(type).set(rel, n);
    }
  }
  return found;
}

const WRITTEN = writtenTypes();

// Every allowlisted type's write sites, file (relative to server/) -> count,
// as the scan finds them. A rename at one of two sites, a removed writer or a
// new one changes this map, so what closes an Inbox item changes only on
// purpose: update it in the same commit as the send.
const EXPECTED_WRITE_SITES = {
  change_request_decision: { 'utils/changeRequestNotifications.js': 1 },
  consult_recap: { 'utils/comms/actions/consultRecap.js': 1 },
  initial_proposal: { 'utils/sendProposalSentEmail.js': 1 },
  invoice_sent: { 'utils/comms/actions/invoiceSend.js': 1 },
  proposal_options_sent: { 'utils/comms/actions/proposalSendGroup.js': 1 },
  proposal_sent: {
    'utils/comms/actions/proposalResend.js': 1,
    'utils/sendProposalSentEmail.js': 1,
  },
  proposal_sent_sms: { 'utils/comms/actions/proposalResend.js': 1 },
  reschedule: { 'utils/rescheduleProposal.js': 2 }, // the email meta and the SMS args
  shopping_list_ready: { 'utils/comms/actions/shoppingListApprove.js': 1 },
  shopping_list_ready_sms: { 'utils/comms/actions/shoppingListApprove.js': 1 },
};

test('the allowlist is exactly the answering sends of decision 26', () => {
  assert.deepEqual([...ANSWERING_MESSAGE_TYPES].sort(), [
    'change_request_decision',
    'consult_recap',
    'initial_proposal',
    'invoice_sent',
    'proposal_options_sent',
    'proposal_sent',
    'proposal_sent_sms',
    'reschedule',
    'shopping_list_ready',
    'shopping_list_ready_sms',
  ]);
});

test("'other' and every attributed-but-not-answering type stay off the list", () => {
  for (const t of [
    'other',
    'payment_reminder', 'payment_reminder_sms',
    'portal_invite', 'portal_invite_sms',
    'drink_plan_nudge', 'drink_plan_nudge_sms',
    'payment_received', 'refund_notice', 'line_item_removed_notice',
    'cancel_confirmation', 'gratuity_disclosure',
  ]) {
    assert.equal(ANSWERING_MESSAGE_TYPES.has(t), false, `${t} must never close an Inbox item`);
  }
});

test('the write sites of every allowlisted type are pinned, file and count', () => {
  const found = Object.fromEntries([...ANSWERING_MESSAGE_TYPES].sort()
    .map((t) => [t, Object.fromEntries(WRITTEN.get(t) || [])]));
  assert.deepEqual(found, EXPECTED_WRITE_SITES,
    'the write sites of an answering type changed: a rename, a removal or a new writer of an answering type changes what closes an Inbox item, so update EXPECTED_WRITE_SITES deliberately');
});

test('the three notices this lane typed each have a writer', () => {
  assert.ok(WRITTEN.get('cancel_confirmation')?.has('routes/proposals/cancel.js'),
    'cancel_confirmation has no write site in routes/proposals/cancel.js');
  assert.ok(WRITTEN.get('gratuity_disclosure')?.has('utils/gratuityDisclosureNotify.js'),
    'gratuity_disclosure has no write site in utils/gratuityDisclosureNotify.js');
  assert.ok(WRITTEN.get('change_request_decision')?.has('utils/changeRequestNotifications.js'),
    'change_request_decision has no write site in utils/changeRequestNotifications.js');
});

test('the scan is not vacuous: it finds each call-site shape in a real writer', () => {
  assert.ok(WRITTEN.get('refund_notice')?.has('utils/refundClientNotify.js'), 'literal meta shape');
  assert.ok(WRITTEN.get('invoice_sent')?.has('utils/comms/actions/invoiceSend.js'), 'comms-action email entry shape (messageType, sentBy:)');
  assert.ok(WRITTEN.get('shopping_list_ready_sms')?.has('utils/comms/actions/shoppingListApprove.js'), 'comms-action _sms shape');
});

test('each shape counts once in a synthetic source, and nothing without a send call or from the export line', () => {
  const sites = (src) => Object.fromEntries(writeSitesIn(src));
  // A comms action around one body line, closed by the real export line.
  const action = (body) => `const messageType = 'probe_base';\n${body}\nmodule.exports = { key, messageType, defaultChannels, dispatch };`;
  assert.deepEqual(sites("await sendEmail({ to, meta: { messageType: 'probe_literal', sentBy } });"),
    { probe_literal: 1 }, 'a literal meta beside a send call counts one site');
  assert.deepEqual(sites("const meta = { messageType: 'probe_literal', sentBy };"),
    {}, 'the same literal with no send or ledger call counts nothing');
  assert.deepEqual(sites(action('await logClientMessage(entry);')),
    {}, 'a comms action whose only other messageType is the export line counts nothing');
  assert.deepEqual(sites(action('const entry = { messageType, sentBy: null }; await logClientMessage(entry);')),
    { probe_base: 1 }, 'the email entry shape counts the base type once');
  assert.deepEqual(sites(action("const entry = { messageType: `${messageType}_sms`, sentBy: null }; await logClientMessage(entry);")),
    { probe_base_sms: 1 }, 'the SMS entry shape counts <base>_sms once');
});

test('the proposal-send types are the answering subset a proposal send absorbs', () => {
  assert.deepEqual([...PROPOSAL_SEND_MESSAGE_TYPES].sort(),
    ['initial_proposal', 'proposal_options_sent', 'proposal_sent', 'proposal_sent_sms']);
  for (const t of PROPOSAL_SEND_MESSAGE_TYPES) assert.ok(ANSWERING_MESSAGE_TYPES.has(t), t);
});

test('both lists are read-only Sets', () => {
  assert.ok(ANSWERING_MESSAGE_TYPES instanceof Set);
  assert.throws(() => ANSWERING_MESSAGE_TYPES.add('other'), TypeError);
  assert.throws(() => ANSWERING_MESSAGE_TYPES.delete('reschedule'), TypeError);
  assert.throws(() => PROPOSAL_SEND_MESSAGE_TYPES.clear(), TypeError);
  assert.equal(ANSWERING_MESSAGE_TYPES.has('reschedule'), true);
  assert.equal(ANSWERING_MESSAGE_TYPES.has('other'), false);
});

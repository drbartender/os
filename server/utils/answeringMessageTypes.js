'use strict';

// Which client sends count as a REPLY in Inbox (spec 2026-10-06, decision 26
// and section 5.4). A message_log row closes a waiting item only when sent_by
// is set (a person clicked) AND its message_type is in ANSWERING_MESSAGE_TYPES.
//
// Deliberately absent, so they are attributed but never close an item: the
// nudges (payment_reminder, portal_invite, drink_plan_nudge, each with its
// _sms twin; the re-enroll action writes drink_plan_nudge too), the receipt
// (payment_received), refund_notice, cancel_confirmation, gratuity_disclosure
// and line_item_removed_notice. 'other', messageLog.js's default for an
// untyped send, is never here: an untyped send proves nothing about what it
// answered. The spec states the trade: a deliverable sent from elsewhere
// closes the item even when the person also asked something it did not
// answer, and Recently handled shows it with Reopen.
//
// Each allowlisted type's write sites (file and count) are pinned in
// answeringMessageTypes.test.js, so renaming, removing or adding a writer fails
// the suite until the pin is updated on purpose. SQL callers pass
// [...ANSWERING_MESSAGE_TYPES] as a text[] parameter.

// A Set whose mutators throw. The lists are shared process-wide; a caller that
// add()ed to one would quietly change what closes an item for everyone.
class ReadonlyStringSet extends Set {
  constructor(values) {
    super();
    for (const v of values) Set.prototype.add.call(this, v);
    Object.freeze(this);
  }

  add() { throw new TypeError('message type lists are read-only'); }

  delete() { throw new TypeError('message type lists are read-only'); }

  clear() { throw new TypeError('message type lists are read-only'); }
}

// The deliveries one proposal send makes. A proposal_activity_log send row (a
// status_changed or status_force_changed row to 'sent', or a 'resent' or
// 'group_sent' row) absorbs these message_log rows for its proposal written
// within 5 minutes of it (spec 5.4, one event per real-world send). The POST
// /api/proposals send_now create writes no such row, only 'created', so its
// send is visible through these message_log rows alone.
const PROPOSAL_SEND_MESSAGE_TYPES = new ReadonlyStringSet([
  'proposal_sent',         // Send to client email (sendProposalSentEmail.js); proposal_send and proposal_resend comms actions
  'initial_proposal',      // Send to client SMS (sendProposalSentEmail.js through sendAndLogSms)
  'proposal_sent_sms',     // proposal_send and proposal_resend comms action SMS
  'proposal_options_sent', // proposal_send_group comms action, the options compare email
]);

const ANSWERING_MESSAGE_TYPES = new ReadonlyStringSet([
  ...PROPOSAL_SEND_MESSAGE_TYPES,
  'invoice_sent',            // invoice_send comms action
  'shopping_list_ready',     // shopping_list_approve comms action, email
  'shopping_list_ready_sms', // shopping_list_approve comms action, SMS
  'consult_recap',           // consult_recap comms action
  'change_request_decision', // changeRequestNotifications.notifyClientOfDecision, approve and decline
  'reschedule',              // the event-details notice, both halves (rescheduleProposal.sendRescheduleEmail)
]);

module.exports = { ANSWERING_MESSAGE_TYPES, PROPOSAL_SEND_MESSAGE_TYPES };

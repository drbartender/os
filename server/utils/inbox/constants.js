'use strict';

// Inbox constants (spec docs/superpowers/specs/2026-10-06-inbox-design.md,
// sections 4, 5.7 and 8). Code, not env vars: moving a window changes what the
// rules decide, so it goes through review like any other rules change.

// Read-only collections. Object.freeze() does not stop a Set's add() or a
// Map's set(), and these lists are shared process-wide: a caller that add()ed
// to OPT_WORDS would quietly change what every AI slice leaves out. The
// mutators throw instead. The twin of ReadonlyStringSet in
// server/utils/answeringMessageTypes.js (not exported there, and outside this
// folder), keep the two alike.
class ReadonlySet extends Set {
  constructor(values) {
    super();
    for (const v of values) Set.prototype.add.call(this, v);
    Object.freeze(this);
  }

  add() { throw new TypeError('Inbox constants are read-only'); }

  delete() { throw new TypeError('Inbox constants are read-only'); }

  clear() { throw new TypeError('Inbox constants are read-only'); }
}

class ReadonlyMap extends Map {
  constructor(entries) {
    super();
    for (const [key, value] of entries) Map.prototype.set.call(this, key, value);
    Object.freeze(this);
  }

  set() { throw new TypeError('Inbox constants are read-only'); }

  delete() { throw new TypeError('Inbox constants are read-only'); }

  clear() { throw new TypeError('Inbox constants are read-only'); }
}

// THE HISTORY FLOOR (decision 18). A FIXED instant: midnight Chicago, 30 days
// before the day lane inbox-engine was built. Nothing older ever opens an item,
// and nothing newer ever ages out. Never move it forward: anyone still waiting
// behind a newer floor would silently disappear from the list.
const INBOX_HISTORY_START = '2026-09-08T05:00:00.000Z';

const CLAIM_HOURS = 4;
const HOT_HOURS = 24;
const HANDLED_DAYS = 7;
const THREAD_DAYS = 30;
const QUIET_HOURS = 48;
const TT_MISSED_MINUTES = 15;
const CALL_MIN_SECONDS = 60;
const UNDO_SECONDS = 60;
const CACHE_MS = 30000;
const BADGE_TIMEOUT_MS = 2000;
// The badge may read a snapshot up to two badge polls old (writes still clear
// it), so one open tab polling every 60 seconds does not recompute the whole
// inbox on every poll. Task 16's getWaitingCount uses it.
const BADGE_MAX_AGE_MS = 120000;

// Spec 5.4: a proposal send's activity row absorbs the message_log rows for
// that proposal's send types written within this many minutes of it, before
// or after (the resend route writes its activity row AFTER the dispatch).
const PROPOSAL_ABSORB_MINUTES = 5;
// Spec 5.4: the Thumbtack auto first reply is the Business message within this
// many minutes of thumbtack_leads.first_reply_sent_at.
const AUTO_FIRST_REPLY_MINUTES = 2;
// A comparison send writes one group_sent row per member proposal in a single
// statement; rows for one person this close together are one send.
const GROUP_SEND_COLLAPSE_SECONDS = 5;

// The message_log types a proposal send writes are NOT restated here: they are
// PROPOSAL_SEND_MESSAGE_TYPES in server/utils/answeringMessageTypes.js (lane
// send-attribution), next to the answering allowlist they belong to.

// Spec 5.3: whole-body words that never count as the person writing; they show
// as thread system lines. The AMBIGUOUS words (cancel, end, quit, yes, help,
// info) are left out on purpose and count, because "Cancel" about an event and
// "yes" to a question are exactly the messages Inbox must not lose.
const UNAMBIGUOUS_STOP_WORDS = new ReadonlySet(['stop', 'stopall', 'unsubscribe', 'optout', 'revoke']);
const UNAMBIGUOUS_START_WORDS = new ReadonlySet(['start', 'unstop']);
// The seven together: the only keyword rows the AI slice leaves out (spec 6.2,
// amendment 5), and the SMS reader turns them into system events. Lane
// inbox-ai imports OPT_WORDS; personKey.test.js ties it to lane sms-lines'
// STOP and START sets less the four ambiguous words.
const OPT_WORDS = new ReadonlySet([...UNAMBIGUOUS_STOP_WORDS, ...UNAMBIGUOUS_START_WORDS]);

// Thumbtack's own notice texted from a proxy number ("Name replied to you on
// Thumbtack."). readSms.js tests the body against the same words in SQL.
const RELAY_NOTICE_WORDS = 'replied to you on thumbtack';
const TT_MISSED_TEXT = 'Thumbtack message the OS never received. Open Thumbtack.';

// The instant THUMBTACK_PROXY_ROLLOUT holds in server/utils/smsInbound.js:
// leads created on or after it carry a Thumbtack proxy number as
// customer_phone. personKey.test.js reads that file and fails if they drift.
const THUMBTACK_PROXY_ROLLOUT = '2026-06-08T00:00:00Z';

// The box agent's pinned Thumbtack inbox URL (spec 4.3).
function thumbtackInboxUrl(negotiationId) {
  return `https://www.thumbtack.com/pro-inbox/messages/${encodeURIComponent(String(negotiationId))}`;
}

// Calls (spec 5.1): answered_by 'admin' is Dallas and 'va' is Zul, users 1 and
// 2, the same ids smsLines.ownLineForUser keys on.
const CALL_ANSWERED_BY_USER = Object.freeze({ admin: 1, va: 2 });

// Recently handled wording for an answering OS send (spec 4.5), keyed by the
// strings in ANSWERING_MESSAGE_TYPES (answeringMessageTypes.js). A type with no
// entry reads "a message".
const SEND_LABELS = new ReadonlyMap([
  ['proposal_sent', 'the proposal'],
  ['proposal_sent_sms', 'the proposal'],
  ['initial_proposal', 'the proposal'],
  ['proposal_options_sent', 'the proposal options'],
  ['invoice_sent', 'the invoice'],
  ['shopping_list_ready', 'the shopping list'],
  ['shopping_list_ready_sms', 'the shopping list'],
  ['consult_recap', 'the consult recap'],
  ['change_request_decision', 'the change request decision'],
  ['reschedule', 'the event details'],
]);

// Spec 4.3: the first text ever sent from a 224 line to a number starts with
// this, added by the server and shown in the box before sending.
const FIRST_TEXT_PREFIX = 'Dr. Bartender: ';
const TEXT_BODY_MAX = 1600;
const SNOOZE_MIN_SECONDS = 60;
const SNOOZE_MAX_DAYS = 8;
// The message_log type an Inbox text writes through sendSMS's ledger hook.
const INBOX_TEXT_MESSAGE_TYPE = 'inbox_text';
// Amendment 23: a send that threw leaves a failed sms_messages row with no
// Twilio SID and, for a client with a proposal, a failed message_log row with
// no provider id. Within this many seconds, for one person, they are one send.
const FAILED_TWIN_SECONDS = 10;
// Amendment 18: pass 1 reads every header since the floor; past this many
// pass-1 rows (the headers, the AI reads and the taps) the engine logs a
// warning, the signal to move pass 1 to SQL aggregates. At
// today's rate (about 1,900 header rows a month) that is about five months of
// history, and each recompute re-reads everything since the fixed floor, so
// the warning fires before the data moved per recompute gets expensive
// (performance review, 2026-10-08).
const HEADER_WARN_ROWS = 10000;
// Amendment 3: a send reservation with no answer after this long answers
// INBOX_SEND_UNRECORDED, so a crashed request never blocks a draft for good.
const SEND_STALE_SECONDS = 120;

module.exports = {
  INBOX_HISTORY_START, CLAIM_HOURS, HOT_HOURS, HANDLED_DAYS, THREAD_DAYS, QUIET_HOURS,
  TT_MISSED_MINUTES, CALL_MIN_SECONDS, UNDO_SECONDS, CACHE_MS, BADGE_TIMEOUT_MS, BADGE_MAX_AGE_MS,
  PROPOSAL_ABSORB_MINUTES, AUTO_FIRST_REPLY_MINUTES, GROUP_SEND_COLLAPSE_SECONDS,
  UNAMBIGUOUS_STOP_WORDS, UNAMBIGUOUS_START_WORDS, OPT_WORDS,
  RELAY_NOTICE_WORDS, TT_MISSED_TEXT, THUMBTACK_PROXY_ROLLOUT, thumbtackInboxUrl,
  CALL_ANSWERED_BY_USER, SEND_LABELS, FIRST_TEXT_PREFIX, TEXT_BODY_MAX,
  SNOOZE_MIN_SECONDS, SNOOZE_MAX_DAYS, INBOX_TEXT_MESSAGE_TYPE,
  FAILED_TWIN_SECONDS, HEADER_WARN_ROWS, SEND_STALE_SECONDS,
};

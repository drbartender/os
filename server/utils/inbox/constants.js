'use strict';

// Inbox constants (spec docs/superpowers/specs/2026-10-06-inbox-design.md,
// sections 4, 5.7 and 8). Code, not env vars: moving a window changes what the
// rules decide, so it goes through review like any other rules change.

const { GMAIL_MAILBOX } = require('../gmailClient');

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

// ─── Email and Zola (spec docs/superpowers/specs/2026-10-14-inbox-email-zola-design.md) ───

// Decision 6: mail addressed only to this alias, from a sender nobody knows,
// is personal: tagged, never read by the AI, and shown only to its owner's
// account (users.id 1, Dallas).
const PERSONAL_ALIAS = 'dallas@drbartender.com';
const PERSONAL_MAILBOX_OWNER_USER_ID = 1;

// Zola's system sender and the relay domain its per-message Reply-To uses
// (spec section 2). Mail from the vendor address goes to the Zola branch
// before any own-address rule (5.2 rule 2).
const ZOLA_VENDOR_ADDRESS = 'weddingvendors@zola.com';
const ZOLA_RELAY_DOMAIN = 'vmkt-message.zola.com';
// Decision 14: a notice from Zola that matches no template.
const ZOLA_UNREAD_TEXT = "Zola sent something the OS couldn't read. Open Zola.";

// Spec 6: an email line is pre-clipped at 8,000 characters before redaction
// and capped at 4,000 after (texts keep 3,000 and 1,500).
const EMAIL_LINE_MAX = 4000;
const EMAIL_PRECLIP_MAX = 8000;

// Spec 5.5: one tick handles at most this many messages and this much wall
// time, inside a lease of GMAIL_LEASE_SECONDS on the state row; a message
// that fails GMAIL_SKIP_ATTEMPTS times is skipped for good. The lease is
// 180 s, not the spec's 120: a tick can run about 100 s at worst (a fetch
// and a list call, 20 s timeouts each, started just inside the 40 s bound,
// on a cold Neon), and a lease that lapses mid-tick lets a second instance in.
const GMAIL_SYNC_MAX_PER_TICK = 50;
const GMAIL_SYNC_TICK_MS = 40000;
const GMAIL_LEASE_SECONDS = 180;
const GMAIL_SKIP_ATTEMPTS = 3;
// Spec 4.6: the feed line reads "Gmail failing" from this many failed ticks
// in a row, the count at which gmailSync.js starts its hourly Sentry warning.
const GMAIL_FAILING_TICKS = 3;

// Spec 5.6: lead-driven clients per rolling 24 hours.
const ZOLA_CLIENT_DAILY_CAP = 20;

// Spec 5.2 rules 3 and 5: senders the OS already hears from another way
// (Thumbtack's webhook) or that only ever notify. Code, not env, so a change
// goes through review.
const DROPPED_SENDER_DOMAINS = new ReadonlySet([
  'thumbtack.com', 'cal.com', 'stripe.com', 'twilio.com', 'sentry.io',
  'render.com', 'vercel.com', 'google.com', 'accounts.google.com',
]);

// Spec 5.2 rule 10: a sender's local part that is a machine, with or without
// dashes and dots, case-insensitive, the whole local part.
const NO_REPLY_LOCAL_RE = /^(no[-.]?reply|do[-.]?not[-.]?reply|notifications?|mailer[-.]?daemon|postmaster|alerts|newsletter)$/i;
// Spec 5.2 rule 7: an auto-reply subject, at the start or after "Re:".
// "Automatic reply", "auto-reply" and "auto response" open nothing else, so
// whatever follows them counts. "Out of office" opens client subjects too
// ("Out of Office party - final headcount", "Out of Office - team offsite bar
// quote", "Out of office/holiday party"), and a false positive drops a
// client's mail for good while a false negative only opens an item (code
// review 2026-10-15). So it counts only as a responder writes it: before ":"
// or "(", alone (a closing "." or "!" allowed), before "until", "reply",
// "autoreply" or "notice", or before a hyphen, a dash, ",", "|" or "/" and
// then "back", "returning", "until" or "away" ("Out of office - back
// Monday"). A real responder nearly always carries Auto-Submitted or
// X-Autoreply, which isAutoReply reads before the subject. Anchored, one
// optional character between the two spaces runs, no nested repeats: linear
// on the 1000-character subject.
const AUTO_REPLY_SUBJECT_RE = /^(?:re:\s*)?(?:(?:automatic reply|auto[- ]?reply|auto[- ]?response)\b|out of (?:the )?office(?:\s*[:(]|\s*(?:[.!]\s*)?$|\s+(?:until|reply|auto[- ]?reply|notice)\b|\s*[-\u2013\u2014,|/]\s*(?:back|returning|until|away)\b))/i;

// Spec 4.4: the Zola lead page when the lead's UUID is known, else the vendor
// dashboard. Anything but a strict lowercase UUID opens the dashboard, so a
// bad value can never shape the path. zolaMail.js re-exports the pattern as
// UUID_RE, the one check a lead UUID passes before it reaches a row (5.6).
const ZOLA_DASHBOARD_URL = 'https://www.zola.com/inspire/vendors/dashboard';
const ZOLA_LEAD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function zolaLeadUrl(uuid) {
  if (typeof uuid !== 'string' || !ZOLA_LEAD_UUID_RE.test(uuid)) return ZOLA_DASHBOARD_URL;
  return `https://www.zola.com/inspire/vendors/leads/ready/${uuid}`;
}

// Spec 4.4: the Gmail thread in the business account. The mailbox is the
// client's code constant, never restated here.
function gmailThreadUrl(threadId) {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(GMAIL_MAILBOX)}#all/${encodeURIComponent(String(threadId))}`;
}

module.exports = {
  INBOX_HISTORY_START, CLAIM_HOURS, HOT_HOURS, HANDLED_DAYS, THREAD_DAYS, QUIET_HOURS,
  TT_MISSED_MINUTES, CALL_MIN_SECONDS, UNDO_SECONDS, CACHE_MS, BADGE_TIMEOUT_MS, BADGE_MAX_AGE_MS,
  PROPOSAL_ABSORB_MINUTES, AUTO_FIRST_REPLY_MINUTES, GROUP_SEND_COLLAPSE_SECONDS,
  UNAMBIGUOUS_STOP_WORDS, UNAMBIGUOUS_START_WORDS, OPT_WORDS,
  RELAY_NOTICE_WORDS, TT_MISSED_TEXT, THUMBTACK_PROXY_ROLLOUT, thumbtackInboxUrl,
  CALL_ANSWERED_BY_USER, SEND_LABELS, FIRST_TEXT_PREFIX, TEXT_BODY_MAX,
  SNOOZE_MIN_SECONDS, SNOOZE_MAX_DAYS, INBOX_TEXT_MESSAGE_TYPE,
  FAILED_TWIN_SECONDS, HEADER_WARN_ROWS, SEND_STALE_SECONDS,
  PERSONAL_ALIAS, PERSONAL_MAILBOX_OWNER_USER_ID, ZOLA_VENDOR_ADDRESS, ZOLA_RELAY_DOMAIN, ZOLA_UNREAD_TEXT,
  EMAIL_LINE_MAX, EMAIL_PRECLIP_MAX, GMAIL_SYNC_MAX_PER_TICK, GMAIL_SYNC_TICK_MS, GMAIL_LEASE_SECONDS,
  GMAIL_SKIP_ATTEMPTS, GMAIL_FAILING_TICKS, ZOLA_CLIENT_DAILY_CAP, DROPPED_SENDER_DOMAINS, NO_REPLY_LOCAL_RE, AUTO_REPLY_SUBJECT_RE,
  ZOLA_DASHBOARD_URL, ZOLA_LEAD_UUID_RE, zolaLeadUrl, gmailThreadUrl,
};

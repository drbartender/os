// Consult call bridge, the admin detail vocabulary (spec 2026-08-25 section 5.3).
// One line on ProposalDetail, one line per consult on ClientDetail, both fed by
// server/utils/consultCallLookups.js. Rows arrive snake_case, exactly as that
// module selects them.
//
// This is NOT the same vocabulary as the needs-attention feed
// (pages/admin/overview/queueItems.js). That feed shows FAULTS only and speaks
// in headlines: "Consult call with X call failed". A detail line has to describe
// every outcome a chain can end in, including the happy one, so the two maps
// deliberately differ and neither should be collapsed into the other.
//
// THE CLIENT-NO-ANSWER LATCH IS A COLUMN. voiceConsultCall.js sets
// client_no_answer_at on a row whose status stays 'connected': we bridged, the
// client's phone did not pick up. It is a column rather than a detail string
// because placeLeg's catch may already have written a Twilio error code into
// detail, and a detail-based latch would then match nothing (ruling R14).
// `detail === 'client_no_answer'` is a value the writers NEVER produce, so a
// branch testing for it would never fire, and a label that never fires looks
// exactly like a condition that never occurs.
//
// detail is DIAGNOSTIC FREE TEXT, never an enum: a failed calls.create writes a
// raw Twilio error code into it. Only the cap, cancelled and unconfirmed-bridge
// branches read it, and only by equality against the values their writers
// actually produce. The cap and cancelled branches therefore need a fallback,
// and what a fallback is allowed to SAY differs between them: see the note
// above consultCancelledLabel. The bridge branch needs none: any other failed
// row keeps the plain 'failed' label.

// The closed set the DB CHECK allows, minus the three statuses that need more
// than a lookup: 'connected' carries a name and a duration, 'skipped_cap'
// carries three different meanings in one status, and 'skipped_cancelled'
// carries four, two of which are not a cancellation at all.
const CONSULT_CALL_LABELS = {
  missed: 'missed',
  failed: 'failed',
  skipped_invalid_phone: 'skipped, bad number',
  skipped_missed_window: 'missed window',
  skipped_unconfigured: 'misconfigured',
  skipped_disabled: 'disabled',
  pending: 'in progress',
  calling_admin: 'in progress',
  calling_va: 'in progress',
};

// The one phrase for a press-1 the reaper flipped because Twilio never reported
// the client leg (spec 2026-09-30 section 4.3). SHARED, like consultCapLabel:
// the needs-attention feed (queueItems.js) imports it, so the detail line and
// the feed headline can never say different things about the same row.
export const BRIDGE_UNCONFIRMED_LABEL = 'pressed 1, bridge unconfirmed';

// skipped_cap is THREE operator events wearing one status:
//   cap_tripped        openChain's chain-open daily cap, and the DOMINANT one.
//                      The Cal.com booking page is PUBLIC, so this is what a
//                      stranger hammering it trips first and most often.
//   dial_cap_tripped   the ceiling on rings to Dallas.
//   va_leg_cap_tripped the ceiling on international legs to Zul, a spend signal
//                      rather than an abuse signal.
//
// cap_tripped is listed EXPLICITLY even though the fallback says the same
// words. Leaving the dominant detail to the fallback would make correct output
// depend on the fallback's wording, and the next person to reword the fallback
// would silently relabel the most common cap trip in the system. The fallback
// stays because detail can hold anything at all.
//
// EXPORTED because the needs-attention feed labels the same three events with
// the same three strings (pages/admin/overview/queueItems.js). That half of the
// vocabulary was a verbatim copy in two files: each copy was test-pinned, so a
// single edit failed a suite, but the two surfaces could be edited APART and
// nothing would have noticed them drift. The STATUS vocabularies around it stay
// separate on purpose, because a fault feed and a detail line say different
// things about the same row.
export function consultCapLabel(detail) {
  if (detail === 'cap_tripped') return 'daily cap tripped';
  if (detail === 'dial_cap_tripped') return 'dial cap tripped';
  if (detail === 'va_leg_cap_tripped') return 'international leg cap tripped';
  return 'daily cap tripped';
}

// skipped_cancelled is FOUR operator events wearing one status, and half of
// them are not a cancellation at all. It read as a flat 'cancelled' until
// 2026-08-26, which meant a client whose booking is LIVE was rendered on the
// client and proposal detail pages as having cancelled it.
//
//   rescheduled_unresolved  consultCallChain's sibling INSERT. Its SELECT
//                           filters on c.status = 'scheduled' AND
//                           c.scheduled_at > NOW(), so the row it marks is a
//                           LIVE, FUTURE consult. That INSERT is the only path
//                           in the feature that turns a consult which would
//                           have rung into one that will not: the client is
//                           still expecting a call and nothing will ring. The
//                           chain emails when it stops a row (spec 2026-09-30,
//                           once per booker per day), but the row has no
//                           needs-attention item, so this line is its only
//                           browsing surface, which is why it is the one that
//                           carries an instruction rather than just a fact.
//   rescheduled             guardStillScheduled saw scheduled_at move. The
//                           consult is live at a NEW slot, which opens its own
//                           chain and rings on its own. Nothing to do.
//   <a consult status>      guardStillScheduled returns String(consult_status)
//                           whenever the consult is no longer 'scheduled'. The
//                           consults CHECK allows cancelled, completed and
//                           no_show. The server goes out of its way to preserve
//                           which one (ruling R17, whose comment says filing a
//                           'completed' consult as a cancel "sends a future
//                           reader chasing a cancellation that never happened")
//                           so collapsing them back here would throw that away.
//   missing                 gets NO branch, deliberately. guardStillScheduled
//                           returns it when its JOIN finds nothing, but
//                           consult_call_attempts.consult_id is NOT NULL
//                           REFERENCES consults(id) ON DELETE CASCADE, so the
//                           only way that JOIN comes back empty is the ATTEMPT
//                           row being gone, and the claim that would write the
//                           detail is UPDATE ... WHERE id = $1, which then
//                           matches nothing. The value cannot reach this
//                           column. Branching on it would break the same law
//                           the client_no_answer note at the top of this file
//                           states: a label that never fires looks exactly
//                           like a condition that never occurs. It falls to
//                           the fallback, which is safe for it anyway.
//
// THE FALLBACK ABSTAINS, and that is the one real difference from
// consultCapLabel above. The cap fallback repeats the DOMINANT label because
// all three cap details are the same class of event, so guessing the common one
// is honest. These are not one class: two of them mean the consult is LIVE and
// the rest mean it is gone, so there is no dominant to fall back to and a guess
// would be a coin flip on the exact fact the operator is reading the line for.
// What every
// writer of this status does share is that no call was placed, so that is all an
// unrecognised detail is allowed to say. detail is diagnostic free text and can
// hold anything at all, null included.
//
// NOT exported, unlike consultCapLabel. The needs-attention feed deliberately
// omits skipped_cancelled from both of its status lists
// (server/routes/admin/leadCalls.js), so there is no second surface to keep in
// step and nothing here can drift out of sync with one.
function consultCancelledLabel(detail) {
  if (detail === 'rescheduled_unresolved') return 'stopped, consult still on, call by hand';
  if (detail === 'rescheduled') return 'not called, slot moved';
  if (detail === 'cancelled') return 'not called, consult cancelled';
  if (detail === 'completed') return 'not called, consult completed';
  if (detail === 'no_show') return 'not called, consult no-show';
  return 'not called, reason unknown';
}

/**
 * What happened on this consult call chain, in one short phrase.
 *
 * @param {object|null} cc a row from consultCallLookups.js, or null
 * @returns {string} '' when there is no row; call sites already guard on
 *   presence, so this only keeps a missing row from throwing on an admin page.
 */
export function consultCallOutcomeLabel(cc) {
  if (!cc) return '';

  if (cc.status === 'connected') {
    // Checked FIRST: the bridge really did connect, so answered_by and a
    // duration can both be sitting on this row, and printing them would say
    // the call happened when nobody picked up.
    if (cc.client_no_answer_at) return 'connected, no answer';
    // Safe as a two-way choice: the single UPDATE that writes 'connected' sets
    // answered_by in the same statement (voiceConsultCall.js), so a connected
    // row always has one of the two legs recorded.
    const who = cc.answered_by === 'admin' ? 'Dallas' : 'Zul';
    const secs = cc.bridge_duration_sec;
    // Integer only. The column is INTEGER and fills from the client leg's
    // status callback, so a chain that never got one leaves it NULL, and the
    // line then says who answered without inventing a length. Minutes are not
    // rolled into hours: an hour-long consult reads 60:00.
    const dur = Number.isInteger(secs)
      ? `, ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
      : '';
    return `connected (${who}${dur})`;
  }

  if (cc.status === 'skipped_cap') return consultCapLabel(cc.detail);
  if (cc.status === 'skipped_cancelled') return consultCancelledLabel(cc.detail);
  // A press-1 the reaper flipped because Twilio never reported the client leg
  // (spec 2026-09-30 section 4.3). Its own words, not the generic 'failed':
  // somebody DID answer and press 1, and the line should say so.
  if (cc.status === 'failed' && cc.detail === 'bridge_unconfirmed') return BRIDGE_UNCONFIRMED_LABEL;

  // typeof rather than truthiness: CONSULT_CALL_LABELS is an object literal, so
  // an inherited key would otherwise hand a function back to JSX. An unknown
  // status shows itself, because a thirteenth status added later should read as
  // a word nobody recognizes rather than as a confident wrong outcome.
  const label = CONSULT_CALL_LABELS[cc.status];
  return typeof label === 'string' ? label : (cc.status || '');
}

/**
 * The booked slot, short and in Chicago time: 'Aug 14, 10:00 AM'.
 *
 * @param {object|null} cc a row from consultCallLookups.js, or null
 * @returns {string} '' when the slot is missing or unparseable. scheduled_at is
 *   NOT NULL and part of the (consult_id, scheduled_at) UNIQUE, so that is a
 *   dropped-column guard, not an expected case: new Date(null) is the epoch,
 *   and printing 'Dec 31, 6:00 PM' for a missing slot would be exactly the
 *   silently-wrong-fact failure this surface exists to prevent.
 */
export function consultCallSlotLabel(cc) {
  if (!cc || !cc.scheduled_at) return '';
  const at = new Date(cc.scheduled_at);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: 'America/Chicago',
  });
}

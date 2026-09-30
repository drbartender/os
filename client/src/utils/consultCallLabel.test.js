import { consultCallOutcomeLabel, consultCallSlotLabel } from './consultCallLabel';

// Rows are shaped exactly as server/utils/consultCallLookups.js returns them:
// snake_case, six shared columns, plus consult_id on the client list. The
// statuses below are the twelve the DB CHECK allows, so this file walks the
// whole closed set once.

const row = (over) => ({
  status: 'connected', answered_by: 'admin', bridge_duration_sec: null,
  scheduled_at: '2026-08-14T15:00:00.000Z', detail: null, client_no_answer_at: null,
  ...over,
});

// ---------------------------------------------------------------- connected

test('connected names who answered and formats the bridge as m:ss', () => {
  expect(consultCallOutcomeLabel(row({ answered_by: 'admin', bridge_duration_sec: 252 })))
    .toBe('connected (Dallas, 4:12)');
  expect(consultCallOutcomeLabel(row({ answered_by: 'va', bridge_duration_sec: 252 })))
    .toBe('connected (Zul, 4:12)');
});

test('seconds are zero padded and a sub-minute call still reads as m:ss', () => {
  expect(consultCallOutcomeLabel(row({ bridge_duration_sec: 5 }))).toBe('connected (Dallas, 0:05)');
  expect(consultCallOutcomeLabel(row({ bridge_duration_sec: 60 }))).toBe('connected (Dallas, 1:00)');
  expect(consultCallOutcomeLabel(row({ bridge_duration_sec: 0 }))).toBe('connected (Dallas, 0:00)');
});

// Minutes are never rolled into hours: an hour-long consult reads 60:00. Stated
// as a test so the format is a decision on the record, not an accident.
test('a long bridge keeps counting minutes rather than growing an hours field', () => {
  expect(consultCallOutcomeLabel(row({ bridge_duration_sec: 3600 }))).toBe('connected (Dallas, 60:00)');
});

test('the duration is dropped unless it is an integer', () => {
  // null is the ordinary case: the client-leg status callback carries
  // CallDuration, and a chain that never got one leaves the column NULL.
  expect(consultCallOutcomeLabel(row({ bridge_duration_sec: null }))).toBe('connected (Dallas)');
  expect(consultCallOutcomeLabel(row({ bridge_duration_sec: undefined }))).toBe('connected (Dallas)');
  expect(consultCallOutcomeLabel(row({ bridge_duration_sec: '252' }))).toBe('connected (Dallas)');
  expect(consultCallOutcomeLabel(row({ bridge_duration_sec: 4.5 }))).toBe('connected (Dallas)');
  expect(consultCallOutcomeLabel(row({ bridge_duration_sec: NaN }))).toBe('connected (Dallas)');
});

// ------------------------------------------------- the no-answer COLUMN latch

test('a connected row with client_no_answer_at set reads as no answer', () => {
  expect(consultCallOutcomeLabel(row({ client_no_answer_at: '2026-08-14T15:01:00.000Z' })))
    .toBe('connected, no answer');
});

test('the latch outranks the duration and the name it would otherwise print', () => {
  // The bridge really did connect on our side, so answered_by and a duration
  // can both be present. Whoever we bridged TO never picked up, and that is
  // the fact the line has to carry.
  expect(consultCallOutcomeLabel(row({
    answered_by: 'va', bridge_duration_sec: 252, client_no_answer_at: '2026-08-14T15:01:00.000Z',
  }))).toBe('connected, no answer');
});

// Ruling R14. `detail === 'client_no_answer'` is a string the writers NEVER
// produce: voiceConsultCall.js latches the COLUMN because placeLeg's catch may
// already have written a Twilio error code into detail. If this ever passes as
// 'connected, no answer', the helper has grown a branch that fires on a value
// nothing writes, and the real latch has probably stopped being read.
test('a detail of client_no_answer is not the latch and must not fire it', () => {
  expect(consultCallOutcomeLabel(row({ detail: 'client_no_answer', client_no_answer_at: null })))
    .toBe('connected (Dallas)');
});

// -------------------------------------------------------- the plain statuses

test('the terminal non-cap statuses each get their own words', () => {
  expect(consultCallOutcomeLabel(row({ status: 'missed' }))).toBe('missed');
  expect(consultCallOutcomeLabel(row({ status: 'failed' }))).toBe('failed');
  expect(consultCallOutcomeLabel(row({ status: 'skipped_invalid_phone' }))).toBe('skipped, bad number');
  expect(consultCallOutcomeLabel(row({ status: 'skipped_missed_window' }))).toBe('missed window');
  expect(consultCallOutcomeLabel(row({ status: 'skipped_unconfigured' }))).toBe('misconfigured');
  expect(consultCallOutcomeLabel(row({ status: 'skipped_disabled' }))).toBe('disabled');
});

test('the three in-flight statuses all read as in progress', () => {
  expect(consultCallOutcomeLabel(row({ status: 'pending' }))).toBe('in progress');
  expect(consultCallOutcomeLabel(row({ status: 'calling_admin' }))).toBe('in progress');
  expect(consultCallOutcomeLabel(row({ status: 'calling_va' }))).toBe('in progress');
});

// detail is diagnostic free text on every status, not just the two that read
// it: a failed calls.create writes a raw Twilio error code there. It must not
// leak into, or alter, any label outside the cap and cancelled branches.
test('detail never changes a label outside the cap and cancelled branches', () => {
  expect(consultCallOutcomeLabel(row({ status: 'failed', detail: '13224' }))).toBe('failed');
  expect(consultCallOutcomeLabel(row({ status: 'failed', detail: 'too_late' }))).toBe('failed');
  expect(consultCallOutcomeLabel(row({ status: 'missed', detail: 'dial_cap_tripped' }))).toBe('missed');
  // The two detail-reading branches must not read each OTHER's vocabulary.
  expect(consultCallOutcomeLabel(row({ status: 'missed', detail: 'rescheduled_unresolved' }))).toBe('missed');
  expect(consultCallOutcomeLabel(row({ status: 'skipped_cap', detail: 'rescheduled' })))
    .toBe('daily cap tripped');
  expect(consultCallOutcomeLabel(row({ status: 'skipped_cancelled', detail: 'cap_tripped' })))
    .toBe('not called, reason unknown');
});

// ---------------------------------------------------- skipped_cap, all THREE

// cap_tripped is openChain's chain-open daily cap and the DOMINANT one, because
// the Cal.com booking page is public. It is asserted here in its own right, so
// re-wording the unknown-detail fallback below cannot silently relabel the most
// common cap trip in the system.
test('the chain-open daily cap is the dominant cap and says so', () => {
  expect(consultCallOutcomeLabel(row({ status: 'skipped_cap', detail: 'cap_tripped' })))
    .toBe('daily cap tripped');
});

test('the dial cap and the international leg cap are distinct operator events', () => {
  expect(consultCallOutcomeLabel(row({ status: 'skipped_cap', detail: 'dial_cap_tripped' })))
    .toBe('dial cap tripped');
  expect(consultCallOutcomeLabel(row({ status: 'skipped_cap', detail: 'va_leg_cap_tripped' })))
    .toBe('international leg cap tripped');
});

test('an unrecognized cap detail still renders the honest generic', () => {
  expect(consultCallOutcomeLabel(row({ status: 'skipped_cap', detail: '13224' })))
    .toBe('daily cap tripped');
  expect(consultCallOutcomeLabel(row({ status: 'skipped_cap', detail: null })))
    .toBe('daily cap tripped');
  expect(consultCallOutcomeLabel(row({ status: 'skipped_cap' })))
    .toBe('daily cap tripped');
});

// --------------------------------------------- skipped_cancelled, all FOUR

// The finding this section exists for: skipped_cancelled read as a flat
// 'cancelled', and two of its four details describe a consult that is LIVE.
// A surface that affirms something false is worse than the blank space it
// replaced, so every branch below is pinned by name.

// The one that matters most. consultCallChain's sibling INSERT selects on
// c.status = 'scheduled' AND c.scheduled_at > NOW(), so this row is a live,
// future consult whose ring was stopped: the client is still expecting a call
// and nothing will ring. It is also the quietest failure in the feature (no
// email at one row, no text, not on the needs-attention feed), so this line is
// its only surface and it has to carry the instruction, not just the fact.
test('a stopped-but-live consult tells the operator to call by hand', () => {
  expect(consultCallOutcomeLabel(row({ status: 'skipped_cancelled', detail: 'rescheduled_unresolved' })))
    .toBe('stopped, consult still on, call by hand');
});

// Guards the whole point of the finding from the outside: no detail that means
// the consult is LIVE may ever produce the word cancelled.
test('neither live-consult detail ever says cancelled', () => {
  for (const detail of ['rescheduled_unresolved', 'rescheduled']) {
    expect(consultCallOutcomeLabel(row({ status: 'skipped_cancelled', detail })))
      .not.toMatch(/cancel/i);
  }
});

test('a moved slot reads as moved, not as a cancellation', () => {
  // The new slot opens its own chain and rings on its own, so this is a fact
  // rather than an action item.
  expect(consultCallOutcomeLabel(row({ status: 'skipped_cancelled', detail: 'rescheduled' })))
    .toBe('not called, slot moved');
});

// guardStillScheduled returns String(consult_status) whenever the consult left
// 'scheduled'. Ruling R17 preserves WHICH status on purpose, its own comment
// warning that filing a completed consult as a cancel "sends a future reader
// chasing a cancellation that never happened" - so the client must not collapse
// them back together. These are the three the consults CHECK allows.
test('a consult that left scheduled reports the status it actually holds', () => {
  expect(consultCallOutcomeLabel(row({ status: 'skipped_cancelled', detail: 'cancelled' })))
    .toBe('not called, consult cancelled');
  expect(consultCallOutcomeLabel(row({ status: 'skipped_cancelled', detail: 'completed' })))
    .toBe('not called, consult completed');
  expect(consultCallOutcomeLabel(row({ status: 'skipped_cancelled', detail: 'no_show' })))
    .toBe('not called, consult no-show');
});

// The sibling of the client_no_answer guard above, and the reason this helper
// has no 'missing' branch. guardStillScheduled returns detail 'missing' when
// its JOIN finds nothing, but consult_id is NOT NULL REFERENCES consults(id)
// ON DELETE CASCADE, so an empty JOIN means the ATTEMPT row is gone, and the
// claim that would persist the detail is UPDATE ... WHERE id = $1, matching
// nothing. The value cannot reach the column. Branching on it would add a
// label that never fires, which reads exactly like a condition that never
// occurs. If someone adds that branch, this test tells them why not.
test('missing gets no branch of its own, because it cannot reach the column', () => {
  expect(consultCallOutcomeLabel(row({ status: 'skipped_cancelled', detail: 'missing' })))
    .toBe('not called, reason unknown');
});

// THE branch the finding turns on, and the one place this helper differs in
// KIND from consultCapLabel. The cap fallback repeats its dominant label
// because all three cap details are the same class of event. These four are
// not: two mean live and two mean gone, so there is no dominant and a guess
// would be a coin flip on the exact fact being read. The only thing every
// writer of this status shares is that no call went out, so that is all an
// unrecognised detail may say. If this ever asserts an outcome again, the
// original bug is back.
test('an unrecognised detail abstains and never asserts an outcome', () => {
  for (const detail of ['13224', 'at_old_slot', '', null, undefined]) {
    expect(consultCallOutcomeLabel(row({ status: 'skipped_cancelled', detail })))
      .toBe('not called, reason unknown');
  }
  expect(consultCallOutcomeLabel(row({ status: 'skipped_cancelled' })))
    .toBe('not called, reason unknown');
});

test('the abstaining fallback claims neither a cancellation nor a live consult', () => {
  const label = consultCallOutcomeLabel(row({ status: 'skipped_cancelled', detail: 'something new' }));
  expect(label).not.toMatch(/cancel/i);
  expect(label).not.toMatch(/still on|moved|completed|no-show/i);
});

// ------------------------------------------------------------- the edge cases

// The CHECK constraint makes this unreachable today. If a thirteenth status is
// ever added, showing it raw beats asserting a wrong outcome: an operator sees
// a word they do not recognize and asks, instead of reading a confident lie.
test('an unknown status shows itself rather than a confident wrong label', () => {
  expect(consultCallOutcomeLabel(row({ status: 'skipped_blacklisted' }))).toBe('skipped_blacklisted');
});

test('a missing row is blank, never a throw on an admin page', () => {
  expect(consultCallOutcomeLabel(null)).toBe('');
  expect(consultCallOutcomeLabel(undefined)).toBe('');
  expect(consultCallSlotLabel(null)).toBe('');
});

// ---------------------------------------------------------------- slot label

// The separator before AM is a CLDR detail: Node prints U+0020 here and some
// Chrome builds print U+202F, and both render as a space. Normalize it so the
// assertion pins the words and the numbers, which is what an operator reads.
const slot = (cc) => consultCallSlotLabel(cc).replace(/[\u202f\u00a0]/g, ' ');

test('the slot reads as a short Chicago date and time', () => {
  expect(slot({ scheduled_at: '2026-08-14T15:00:00.000Z' })).toBe('Aug 14, 10:00 AM');
});

test('the slot is Chicago local, not UTC, even when the two disagree on the day', () => {
  // 02:00Z on the 15th is 9pm on the 14th in Chicago. Reading this as UTC would
  // print the wrong DAY, which is exactly the mistake a booker would catch.
  expect(slot({ scheduled_at: '2026-08-15T02:00:00.000Z' })).toBe('Aug 14, 9:00 PM');
});

test('the slot accepts a Date as readily as the ISO string the API sends', () => {
  expect(slot({ scheduled_at: new Date('2026-08-14T15:00:00.000Z') })).toBe('Aug 14, 10:00 AM');
});

// A dropped column arrives as undefined, and new Date(undefined/null) is either
// Invalid Date or the epoch. Printing "Dec 31, 6:00 PM" for a missing slot is
// the silent-wrong-fact failure this whole surface was built to avoid.
test('a missing slot is blank, never the epoch and never Invalid Date', () => {
  expect(consultCallSlotLabel({ scheduled_at: null })).toBe('');
  expect(consultCallSlotLabel({})).toBe('');
  expect(consultCallSlotLabel({ scheduled_at: 'not a timestamp' })).toBe('');
});

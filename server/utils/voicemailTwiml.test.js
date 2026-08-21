require('dotenv').config();
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const twiml = require('./voicemailTwiml');

const SAVED = { ...process.env };
beforeEach(() => {
  delete process.env.VM_GREETING_URL;
  delete process.env.VM_GREETING_URL_PRIMARY;
  delete process.env.VM_ESCALATION_ENABLED;
  delete process.env.VM_ESCALATION_PROMPT;
  process.env.VM_MAX_LENGTH_SEC = '120';
});
after(() => { process.env = { ...SAVED }; });

test('zul greeting default is her 2026-08-19 bundled recording', () => {
  const out = twiml.messageVerb('greeting_day', 'zul');
  assert.match(out, /^<Play>[^<]*\/api\/voice\/audio\/zul-greeting-day\.mp3<\/Play>$/);
  assert.doesNotMatch(out, /<Say/);
});

test('zul greeting honors the existing VM_GREETING_URL override and say kill switch', () => {
  process.env.VM_GREETING_URL = 'https://cdn.example.com/z.mp3';
  assert.match(twiml.messageVerb('greeting_day', 'zul'), /<Play>https:\/\/cdn\.example\.com\/z\.mp3<\/Play>/);
  process.env.VM_GREETING_URL = 'say';
  const said = twiml.messageVerb('greeting_day', 'zul');
  assert.match(said, /<Say voice="Polly\.Joanna-Neural">/);
  assert.match(said, /this is Zul/i);
  assert.match(said, /press one/i, 'her synthetic text mirrors her new recording');
});

test('primary greeting defaults to DALLAS\'S RECORDING, never to Zul\'s', () => {
  // Was "defaults to synthetic until a recording exists". He recorded on
  // 2026-08-19, so the recording is now the default and needs no env var anyone
  // could forget. The load-bearing half is unchanged: Zul's recording says "This
  // is Zul" and must never play on his line.
  const out = twiml.messageVerb('greeting_day', 'primary');
  assert.match(out, /<Play>.*primary-greeting-day\.mp3<\/Play>/);
  assert.doesNotMatch(out, /\/api\/voice\/greeting\.mp3/, "Zul's recording must never play on Dallas's line");
});

test('"say" forces the synthetic text, the kill switch for a bad recording', () => {
  // The kill switch for a bad recording. The synthetic text is what callers
  // hear when it is thrown, so it has to say the same words as the mp3.
  process.env.VM_GREETING_URL_PRIMARY = 'say';
  const out = twiml.messageVerb('greeting_day', 'primary');
  assert.match(out, /<Say voice="Polly\.Joanna-Neural">/);
  assert.match(out, /Dallas/);
  assert.match(out, /press one/i, 'the synthetic day text carries the offer too');
  assert.doesNotMatch(out, /This is Zul/);
  delete process.env.VM_GREETING_URL_PRIMARY;
});

test('primary greeting switches to Play when VM_GREETING_URL_PRIMARY is a url', () => {
  process.env.VM_GREETING_URL_PRIMARY = 'https://cdn.example.com/d.mp3';
  assert.match(twiml.messageVerb('greeting_day', 'primary'), /<Play>https:\/\/cdn\.example\.com\/d\.mp3<\/Play>/);
  assert.doesNotMatch(twiml.messageVerb('greeting_day', 'primary'), /<Say/);
});

test('the two lines never share a greeting', () => {
  assert.notEqual(twiml.messageVerb('greeting_day', 'primary'), twiml.messageVerb('greeting_day', 'zul'));
});

test('recordVerb carries the clamped maxLength, the status callback, and no action', () => {
  const out = twiml.recordVerb();
  assert.match(out, /<Record[^>]*maxLength="120"/);
  assert.match(out, /recordingStatusCallback="[^"]*\/api\/voice\/inbound\/voicemail"/);
  assert.match(out, /recordingStatusCallbackEvent="completed"/);
  // No action attribute: Twilio skips it when the caller hangs up, which is the
  // normal way a voicemail ends. Delivery hangs off recordingStatusCallback.
  assert.doesNotMatch(out, /\saction=/);
});

test('vmMaxLengthSec clamps to 30..300 and defaults to 120', () => {
  process.env.VM_MAX_LENGTH_SEC = '5';
  assert.equal(twiml.vmMaxLengthSec(), 30);
  process.env.VM_MAX_LENGTH_SEC = '9000';
  assert.equal(twiml.vmMaxLengthSec(), 300);
  delete process.env.VM_MAX_LENGTH_SEC;
  assert.equal(twiml.vmMaxLengthSec(), 120);
});

test('escalationEnabled defaults OFF and only true enables it', () => {
  assert.equal(twiml.escalationEnabled(), false);
  process.env.VM_ESCALATION_ENABLED = 'yes';
  assert.equal(twiml.escalationEnabled(), false);
  process.env.VM_ESCALATION_ENABLED = 'true';
  assert.equal(twiml.escalationEnabled(), true);
});

test('dayGreetingOffersPress1 is true for both lines on their 2026-08-19 defaults', () => {
  assert.equal(twiml.dayGreetingOffersPress1('zul'), true);
  assert.equal(twiml.dayGreetingOffersPress1('primary'), true);
  // NOT the inverse of needsAppendedOffer, which is the whole reason it exists:
  // both greetings already say the offer, so nothing is appended AND a digit is
  // still expected. voice.js needs the second fact to know whether to listen.
  assert.equal(twiml.needsAppendedOffer('zul'), false);
  assert.equal(twiml.needsAppendedOffer('primary'), false);
});

test("dayGreetingOffersPress1 follows the default through the 'say' kill switch", () => {
  // The case .env.example's three-variable "revert" got wrong: it prescribed
  // VM_GREETING_URL_PRIMARY=say to undo the offer, and the synthetic text says
  // the offer too, so that revert only changed whose voice said it.
  process.env.VM_GREETING_URL_PRIMARY = 'say';
  assert.match(twiml.messageVerb('greeting_day', 'primary'), /press one/i);
  assert.equal(twiml.dayGreetingOffersPress1('primary'), true);
  // A malformed value degrades to that same synthetic text, so same answer.
  process.env.VM_GREETING_URL_PRIMARY = 'yes';
  assert.equal(twiml.dayGreetingOffersPress1('primary'), true);
});

test('dayGreetingOffersPress1 assumes an unknown override recording DOES offer', () => {
  // Fail-safe direction: listening for a digit that never comes costs a
  // 4-second timeout, not listening for one that does costs the caller a key
  // press into silence.
  process.env.VM_GREETING_URL = 'https://cdn.example.com/z.mp3';
  assert.equal(twiml.dayGreetingOffersPress1('zul'), true);
});

test('dayGreetingOffersPress1 ignores VM_ESCALATION_PROMPT, which cannot edit an mp3', () => {
  // That override suppresses the APPENDED prompt only. If it silenced this too,
  // it would re-create the exact trap this helper exists to close: a recording
  // that says "press one" with no Gather behind it.
  process.env.VM_ESCALATION_PROMPT = 'none';
  assert.equal(twiml.needsAppendedOffer('zul'), false);
  assert.equal(twiml.dayGreetingOffersPress1('zul'), true);
});

test('dayGreetingOffersPress1 reads the SLOTS flag, so a no-offer recording turns the Gather off', () => {
  // Without this the function could be a constant true and every test above
  // would still pass. It also pins the migration path: record a greeting
  // without the sentence, flip defaultSaysOffer, and voice.js stops emitting
  // the Gather with no code change at all.
  // MUST STAY SEQUENTIAL. Object.freeze(SLOTS) is shallow, so this write lands
  // on shared module state and the finally is what puts it back. node --test
  // runs top-level tests in a file in order, so the false window is invisible
  // today; enabling concurrency for this file would make it observable to the
  // needsAppendedOffer tests below.
  const slot = twiml.SLOTS.greeting_day.zul;
  const saved = slot.defaultSaysOffer;
  try {
    slot.defaultSaysOffer = false;
    assert.equal(twiml.dayGreetingOffersPress1('zul'), false);
    assert.equal(twiml.needsAppendedOffer('zul'), true, 'and the prompt would be owed again');
  } finally {
    slot.defaultSaysOffer = saved;
  }
});

test('escalationPromptVerb speaks the option by default and is suppressible', () => {
  // The verb itself is unconditional; WHETHER it is emitted is decided by
  // needsAppendedOffer. Since 2026-08-19 both day recordings say the offer, so
  // in practice nothing is appended and this exists for an override URL whose
  // script we do not know. (The comment here used to say the production
  // greetings do not mention press 1; that stopped being true on 2026-08-19.)
  assert.match(twiml.escalationPromptVerb(), /<Say[^>]*>[^<]*press 1[^<]*<\/Say>/);
  process.env.VM_ESCALATION_PROMPT = 'none';
  assert.equal(twiml.escalationPromptVerb(), '', 'none means the recording already says it');
});

test('the zul greeting copy is pinned byte-for-byte to what she recorded 2026-08-19', () => {
  // Unchanged contract, new recording: the synthetic fallback must match her mp3
  // word for word, because it is what callers hear if the recording is killed.
  // Re-recorded 2026-08-19 to include the press-1 offer, which is what lets
  // defaultSaysOffer be true on her line and stops the appended prompt.
  assert.strictEqual(
    twiml.GREETING_TEXT_ZUL,
    "Thanks for calling Dr. Bartender, this is Zul. Sorry I missed your call. Leave me a message and we'll get back to you as soon as we can. If you need to talk to somebody now, press one and I'll see if someone's available."
  );
  assert.match(twiml.GREETING_TEXT_ZUL, /press one/i, 'and it must still contain the offer');
});

test('no greeting or prompt copy contains an em dash', () => {
  const all = [
    twiml.GREETING_TEXT_ZUL, twiml.GREETING_TEXT_PRIMARY, twiml.ESCALATION_PROMPT_TEXT,
    twiml.GREETING_TEXT_PRIMARY_NIGHT, twiml.GREETING_TEXT_ZUL_NIGHT,
    twiml.ESCALATE_ACK_TEXT_PRIMARY, twiml.ESCALATE_ACK_TEXT_ZUL,
    twiml.ESCALATE_FAILED_TEXT_PRIMARY, twiml.ESCALATE_FAILED_TEXT_ZUL,
  ].join(' ');
  assert.doesNotMatch(all, /—/);
});

// --- message slots (spec 2026-08-19) -----------------------------------------

const SLOT_ENV = [
  'VM_GREETING_URL', 'VM_GREETING_URL_PRIMARY',
  'VM_NIGHT_GREETING_URL', 'VM_NIGHT_GREETING_URL_PRIMARY',
  'VM_ESCALATE_ACK_URL', 'VM_ESCALATE_ACK_URL_PRIMARY',
  'VM_ESCALATE_FAILED_URL', 'VM_ESCALATE_FAILED_URL_PRIMARY',
  'VM_ESCALATION_PROMPT',
];
const clearSlots = () => SLOT_ENV.forEach((k) => delete process.env[k]);

test('every slot resolves to something playable with nothing configured', () => {
  // Nothing may resolve to an empty verb: an empty verb is a TwiML document that
  // silently says nothing, which is the failure this feature exists to remove.
  // Since 2026-08-19 BOTH lines are all bundled recordings; the synthetic texts
  // are the kill switch, not the normal path.
  clearSlots();
  for (const slot of ['greeting_day', 'greeting_night', 'escalate_ack', 'escalate_failed']) {
    const prim = twiml.messageVerb(slot, 'primary');
    assert.match(prim, /^<Play>.*\.mp3<\/Play>$/, `primary/${slot} should be a bundled recording`);
    const zul = twiml.messageVerb(slot, 'zul');
    assert.match(zul, /^<Play>.*\.mp3<\/Play>$/, `zul/${slot} should be a bundled recording`);
    assert.ok(zul.length > 0 && prim.length > 0);
  }
});

test('a url makes a slot Play it; the literal "say" forces synthetic', () => {
  clearSlots();
  process.env.VM_ESCALATE_ACK_URL_PRIMARY = 'https://cdn.example.com/ack.mp3';
  assert.equal(twiml.messageVerb('escalate_ack', 'primary'), '<Play>https://cdn.example.com/ack.mp3</Play>');
  process.env.VM_ESCALATE_ACK_URL_PRIMARY = 'say';
  assert.match(twiml.messageVerb('escalate_ack', 'primary'), /^<Say /);
  clearSlots();
});

test('the primary DAY greeting contains the press-1 offer; NIGHT must not', () => {
  assert.match(twiml.GREETING_TEXT_PRIMARY, /press one/i);
  assert.doesNotMatch(twiml.GREETING_TEXT_PRIMARY_NIGHT, /press one/i,
    'the night greeting must never offer a human');
  assert.match(twiml.GREETING_TEXT_PRIMARY_NIGHT, /in the morning/i);
  assert.doesNotMatch(twiml.GREETING_TEXT_ZUL_NIGHT, /press one/i);
  assert.match(twiml.GREETING_TEXT_ZUL_NIGHT, /in the morning/i);
});

test('needsAppendedOffer trusts only the KNOWN defaults, never an override', () => {
  clearSlots();
  // Known defaults: the table says whether each one already contains the offer.
  assert.equal(twiml.needsAppendedOffer('zul'), false, 'her 2026-08-19 recording says the offer itself');
  assert.equal(twiml.needsAppendedOffer('primary'), false, 'his recording says the offer itself');
  process.env.VM_GREETING_URL = 'say';
  assert.equal(twiml.needsAppendedOffer('zul'), false, 'her synthetic text mirrors that recording');
  process.env.VM_GREETING_URL_PRIMARY = 'say';
  assert.equal(twiml.needsAppendedOffer('primary'), false, 'his synthetic text carries the offer');

  // An override URL has UNKNOWN content, and the two failures are not
  // symmetric: a doubled offer is an obvious stutter, a missing one loses the
  // feature invisibly behind a silent 4-second Gather. So append on unknown.
  clearSlots();
  process.env.VM_GREETING_URL = 'https://cdn.example.com/zul-seasonal.mp3';
  assert.equal(twiml.needsAppendedOffer('zul'), true, 'unknown recording: append');
  process.env.VM_GREETING_URL_PRIMARY = 'https://cdn.example.com/dallas-holiday.mp3';
  assert.equal(twiml.needsAppendedOffer('primary'), true,
    'an override on the MAIN business line must not silently drop the offer');
  clearSlots();
});

test('VM_ESCALATION_PROMPT=none still suppresses the append everywhere', () => {
  clearSlots();
  process.env.VM_ESCALATION_PROMPT = 'none';
  assert.equal(twiml.needsAppendedOffer('zul'), false);
  clearSlots();
});


test('an unknown slot SPEAKS rather than throwing on a live call', () => {
  // The shape invariant is enforced at module load. At request time messageVerb
  // must be total: /inbound/missed is a bare async handler with no asyncHandler
  // wrapper, so a throw would write NO response, and the caller would wait ~15s
  // for Twilio to give up and play an application error, after the ledger row
  // was already claimed. Saying the wrong thing beats saying nothing.
  const out = twiml.messageVerb('nope', 'primary');
  assert.match(out, /^<Say /);
  assert.ok(out.length > 20);
});

test('a malformed override URL degrades to the synthetic voice, not to silence', () => {
  // Twilio SKIPS a <Play> whose fetch fails, so a typo'd env value would make
  // the caller hear nothing at all, with no server-side trace.
  clearSlots();
  process.env.VM_ESCALATE_ACK_URL_PRIMARY = 'yes';
  assert.match(twiml.messageVerb('escalate_ack', 'primary'), /^<Say /);
  process.env.VM_ESCALATE_ACK_URL_PRIMARY = 'ftp://x/a.mp3';
  assert.match(twiml.messageVerb('escalate_ack', 'primary'), /^<Say /);
  process.env.VM_ESCALATE_ACK_URL_PRIMARY = 'https://cdn.example.com/a.mp3';
  assert.match(twiml.messageVerb('escalate_ack', 'primary'), /^<Play>/);
  clearSlots();
});

test('every bundled default names a real key in the assets allowlist', () => {
  // SLOTS.bundled is a URL fragment whose tail must be a key in a map in
  // ANOTHER file. A slot added with a bundled name nobody registered would 404
  // at Twilio, which skips the <Play> and gives the caller a beep with no
  // greeting: the exact bug this feature exists to kill, delivered through the
  // feature's own extension point.
  const { ASSETS } = require('../routes/voiceAssets');
  for (const [slot, byLine] of Object.entries(twiml.SLOTS)) {
    for (const [ln, cfg] of Object.entries(byLine)) {
      if (!cfg.bundled) continue;
      const key = cfg.bundled.replace(/^audio\//, '');
      assert.ok(Object.prototype.hasOwnProperty.call(ASSETS, key),
        `${slot}/${ln} bundles "${key}", which is not in voiceAssets ASSETS`);
    }
  }
});

test('the approved primary copy is pinned exactly (it must match the RECORDING)', () => {
  // These four strings are what Dallas recorded on 2026-08-19. The synthetic
  // fallback and the mp3 have to say the same words, or the kill switch
  // (VM_GREETING_URL_PRIMARY=say) silently changes what callers hear. A silent
  // copy edit here is exactly the drift this pin exists to catch.
  assert.strictEqual(
    twiml.GREETING_TEXT_PRIMARY,
    "Thanks for calling Dr. Bartender, this is Dallas. Sorry I missed your call. Leave me a message and I'll get back to you as soon as I can. If you need to talk to somebody now, press one and I'll see if someone's available."
  );
  assert.strictEqual(
    twiml.GREETING_TEXT_PRIMARY_NIGHT,
    "Thanks for calling Dr. Bartender, this is Dallas. Sorry I missed your call. Leave me a message and I'll get back to you in the morning."
  );
  assert.strictEqual(twiml.ESCALATE_ACK_TEXT_PRIMARY, "Hold on, let me see who's available.");
  assert.strictEqual(
    twiml.ESCALATE_FAILED_TEXT_PRIMARY,
    "Sorry, nobody's available right now. Leave me a message and I'll get back to you as soon as I can."
  );
});

test('the unknown-slot fallback is honest in EVERY position it can fire from', () => {
  // It can play on either line, in day or night, and immediately before a
  // <Dial> as well as before a <Record>. So it must name nobody, promise no
  // callback time, and not invite a message. Anything richer is wrong somewhere.
  for (const ln of ['primary', 'zul']) {
    const out = twiml.messageVerb('no_such_slot', ln);
    assert.match(out, /^<Say /);
    assert.doesNotMatch(out, /Dallas|Zul/i, 'names nobody: it may play on either line');
    assert.doesNotMatch(out, /morning|as soon as/i, 'promises nothing: it may play day or night');
    assert.doesNotMatch(out, /leave me a message|leave a message/i,
      'invites nothing: it may play before a <Dial>, not a <Record>');
  }
  assert.equal(twiml.messageVerb('no_such_slot', 'primary'), twiml.messageVerb('no_such_slot', 'zul'));
});

test('a malformed override cannot produce a DOUBLED offer', () => {
  // messageVerb and needsAppendedOffer both have to agree on what counts as a
  // recording. When they disagreed, VM_GREETING_URL_PRIMARY=yes fell back to the
  // synthetic text (which SAYS the offer) while the append fired anyway.
  clearSlots();
  for (const bad of ['yes', 'ftp://x/a.mp3', 'primary-greeting-day.mp3']) {
    process.env.VM_GREETING_URL_PRIMARY = bad;
    assert.match(twiml.messageVerb('greeting_day', 'primary'), /^<Say /, `${bad} should speak`);
    assert.equal(twiml.needsAppendedOffer('primary'), false,
      `${bad} falls back to text that already says the offer, so do NOT append`);
  }
  // Whitespace-only trims to empty, so it is effectively UNSET: the bundled
  // recording plays, and it says the offer too.
  process.env.VM_GREETING_URL_PRIMARY = '   ';
  assert.match(twiml.messageVerb('greeting_day', 'primary'), /^<Play>/);
  assert.equal(twiml.needsAppendedOffer('primary'), false);
  clearSlots();
});

test('the fallback copy is pinned, so a reword cannot slip past the property test', () => {
  // The property assertions are phrase-specific ("morning", "leave a message"),
  // so a reword like "I'll ring you back tomorrow" would pass them all.
  assert.strictEqual(twiml.FALLBACK_TEXT, 'Thanks for calling Dr. Bartender.');
});

test('a renamed or deleted required slot cannot get past boot', () => {
  // The boot loop used to validate only slots that were PRESENT, so deleting
  // greeting_day passed boot and then threw inside /inbound/missed, which has no
  // asyncHandler: no response written, ~15s of dead air, ledger row already burned.
  assert.ok(twiml.SLOTS.greeting_day && twiml.SLOTS.greeting_night);
  assert.ok(twiml.SLOTS.escalate_ack && twiml.SLOTS.escalate_failed);
  // And the runtime guard holds even if one vanished at runtime.
  assert.equal(typeof twiml.needsAppendedOffer('primary'), 'boolean');
});

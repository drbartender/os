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

test('zul greeting default is the bundled recording, unchanged from production', () => {
  const out = twiml.greetingVerbForLine('zul');
  assert.match(out, /^<Play>[^<]*\/api\/voice\/greeting\.mp3<\/Play>$/);
  assert.doesNotMatch(out, /<Say/);
});

test('zul greeting honors the existing VM_GREETING_URL override and say kill switch', () => {
  process.env.VM_GREETING_URL = 'https://cdn.example.com/z.mp3';
  assert.match(twiml.greetingVerbForLine('zul'), /<Play>https:\/\/cdn\.example\.com\/z\.mp3<\/Play>/);
  process.env.VM_GREETING_URL = 'say';
  const said = twiml.greetingVerbForLine('zul');
  assert.match(said, /<Say voice="Polly\.Joanna-Neural">/);
  assert.match(said, /This is Zul/);
});

test('primary greeting defaults to the synthetic Dallas text until a recording exists', () => {
  // Dallas has not recorded his greeting yet, and Zul's recording says "This is
  // Zul", so the primary line must NOT fall back to it.
  const out = twiml.greetingVerbForLine('primary');
  assert.match(out, /<Say voice="Polly\.Joanna-Neural">/);
  assert.match(out, /Dallas/);
  assert.doesNotMatch(out, /This is Zul/);
});

test('primary greeting switches to Play when VM_GREETING_URL_PRIMARY is a url', () => {
  process.env.VM_GREETING_URL_PRIMARY = 'https://cdn.example.com/d.mp3';
  assert.match(twiml.greetingVerbForLine('primary'), /<Play>https:\/\/cdn\.example\.com\/d\.mp3<\/Play>/);
  assert.doesNotMatch(twiml.greetingVerbForLine('primary'), /<Say/);
});

test('the two lines never share a greeting', () => {
  assert.notEqual(twiml.greetingVerbForLine('primary'), twiml.greetingVerbForLine('zul'));
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

test('escalationPromptVerb speaks the option by default and is suppressible', () => {
  // The greetings currently in production do NOT mention press 1, so the option
  // has to be announced or no caller will ever know it exists.
  assert.match(twiml.escalationPromptVerb(), /<Say[^>]*>[^<]*press 1[^<]*<\/Say>/);
  process.env.VM_ESCALATION_PROMPT = 'none';
  assert.equal(twiml.escalationPromptVerb(), '', 'none means the recording already says it');
});

test('the zul greeting copy is pinned byte-for-byte to what shipped 2026-07-24', () => {
  // This string's whole contract is byte-identity: the synthetic fallback must
  // match Zul's recorded mp3 word for word. A substring match would let the
  // copy drift while the suite stays green.
  assert.strictEqual(
    twiml.GREETING_TEXT_ZUL,
    "Thanks for calling Dr. Bartender. This is Zul. I'm not available right now. Please leave your name, your number, and the date of your event, and I'll call you right back."
  );
});

test('no greeting or prompt copy contains an em dash', () => {
  const all = [
    twiml.GREETING_TEXT_ZUL, twiml.GREETING_TEXT_PRIMARY, twiml.ESCALATION_PROMPT_TEXT,
  ].join(' ');
  assert.doesNotMatch(all, /—/);
});

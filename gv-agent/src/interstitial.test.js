// Google interstitial classification (spec section 6, Box). Pure.
// Run: `node --test src/interstitial.test.js`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyPage, challengeFrameVisible } = require('./interstitial');

const BFRAME = 'https://www.google.com/recaptcha/api2/bframe?hl=en&v=abc&k=key';

test('accounts.google.com is session_expired', () => {
  assert.equal(classifyPage({ host: 'accounts.google.com', texts: [] }), 'session_expired');
  assert.equal(classifyPage({ host: 'accounts.google.com', texts: ['Sign in - Google Accounts', 'Sign in'] }), 'session_expired');
  // The chooser or a Sign in control on GV's own host means the same.
  assert.equal(classifyPage({ host: 'voice.google.com', texts: ['Choose an account'] }), 'session_expired');
  assert.equal(classifyPage({ host: 'voice.google.com', texts: ['Google Voice', 'For personal use', 'Sign in'] }), 'session_expired');
  // The signed-in messages page (shapes from the 2026-10-17 probe) is ok.
  assert.equal(classifyPage({ host: 'voice.google.com',
    texts: ['Voice - (2) Messages', 'Send new message', 'Messages: 2 unread', 'Settings'] }), 'ok');
  assert.equal(classifyPage({ host: 'voice.google.com', texts: ['Signing out soon is not a thing'] }), 'ok');
});

test("Verify it's you is challenge", () => {
  // Google renders a curly apostrophe; a straight one must match too.
  assert.equal(classifyPage({ host: 'accounts.google.com', texts: ['Verify it\u{2019}s you'] }), 'challenge');
  assert.equal(classifyPage({ host: 'accounts.google.com', texts: ["Verify it's you"] }), 'challenge');
  assert.equal(classifyPage({ host: 'voice.google.com', texts: ['Unusual activity detected'] }), 'challenge');
  // A reCAPTCHA challenge frame that has opened up.
  assert.equal(classifyPage({ host: 'voice.google.com', texts: ['Send new message'],
    frames: [{ src: BFRAME, w: 400, h: 580 }] }), 'challenge');
});

test('a collapsed challenge frame or the reCAPTCHA anchor is not a challenge', () => {
  // GV loads invisible reCAPTCHA on every page (the probe saw g-recaptcha-response).
  const frames = [{ src: BFRAME, w: 0, h: 0 }, { src: 'https://www.google.com/recaptcha/api2/anchor?k=key', w: 256, h: 60 }];
  assert.equal(challengeFrameVisible(frames), false);
  assert.equal(classifyPage({ host: 'voice.google.com', texts: ['Send new message'], frames }), 'ok');
  for (const junk of [null, undefined, 'x', [null]]) assert.equal(challengeFrameVisible(junk), false);
});

// Every judgment the GV glue makes about the page, kept pure (spec sections 5
// and 10). Shapes come from the 2026-10-17 spike: the formatted number sits
// between bidi marks, and screen-reader twins spell the digits out.
// Run: `node --test src/pageLogic.test.js`. Numbers are invented 555-01xx.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseBidId, digitsEqual, oneSendToEntry, oneRecipientChip, verifyDecision,
  threadItemMatches, threadBids, hasToken, fillCheck, pasteInThread,
} = require('./pageLogic');

const PHONE = '+13125550123';
const SHOWN = '\u{202A}(312) 555-0123\u{202C}';
const SPELLED = '3 1 2 5 5 5 0 1 2 3';
const TOKEN = '0f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f';
const entry = (ownText, w, h, containsOther = []) => ({ ownText, w, h, containsOther });

test('parseBidId reads the bids id from a notice link', () => {
  assert.equal(parseBidId('https://www.thumbtack.com/request/400000000000000123/bids/500000000000000123/messages'),
    '500000000000000123');
  assert.equal(parseBidId('/request/4/bids/500000000000000123/messages?utm_source=sms'), '500000000000000123');
  // A redirect-wrapped link still yields the id.
  assert.equal(parseBidId('https://www.google.com/url?q=https%3A%2F%2Fwww.thumbtack.com%2Frequest%2F4%2Fbids%2F500000000000000123%2Fmessages&sa=D'),
    '500000000000000123');
  for (const bad of [null, undefined, '', 'https://www.thumbtack.com/pro-leads', `https://drbartender.com/proposal/${TOKEN}`]) {
    assert.equal(parseBidId(bad), null, `href=${bad}`);
  }
});

test('digitsEqual matches the shown or spelled number and nothing longer', () => {
  assert.equal(digitsEqual(`Send to ${SHOWN}`, PHONE), true);
  assert.equal(digitsEqual(`Remove ${SPELLED}?`, PHONE), true);
  assert.equal(digitsEqual('+1 (312) 555-0123', PHONE), true);
  assert.equal(digitsEqual('(312) 555-0199', PHONE), false);
  // Dialed with the 00 prefix, so the fixture's only phone-shaped run is the 555 one.
  assert.equal(digitsEqual('0044 312 555 0123', PHONE), false, 'an international number ending in the same 10 digits');
  assert.equal(digitsEqual('', PHONE), false);
  assert.equal(digitsEqual(SHOWN, 'not a phone'), false);
});

test('oneSendToEntry ignores the 1px screen-reader twin', () => {
  assert.equal(oneSendToEntry([entry(`Send to ${SPELLED}`, 1, 1), entry(`Send to ${SHOWN}`, 296, 20)], PHONE), 1);
  // A wrapper with no own text is not an entry, and a hit nested inside another hit counts once (the outermost).
  assert.equal(oneSendToEntry([
    entry('', 320, 48, [1, 2]),
    entry(`Send to ${SHOWN}`, 296, 40, [2]),
    entry(`Send to ${SHOWN}`, 280, 20),
  ], PHONE), 1);
  // Another number, a missing Send to, or nothing rendered never matches.
  assert.equal(oneSendToEntry([entry('Send to (312) 555-0199', 296, 20)], PHONE), -1);
  assert.equal(oneSendToEntry([entry(SHOWN, 296, 20)], PHONE), -1);
  assert.equal(oneSendToEntry([], PHONE), -1);
  assert.equal(oneSendToEntry(null, PHONE), -1);
});

test('two visible Send-to entries is -1', () => {
  assert.equal(oneSendToEntry([entry(`Send to ${SHOWN}`, 296, 20), entry(`Send to ${SHOWN}`, 296, 20)], PHONE), -1);
});

test('oneRecipientChip needs exactly one matching chip', () => {
  // Live shape: the chip's Remove label spells the digits and ends with a question mark.
  assert.equal(oneRecipientChip([`Remove ${SPELLED}?`], PHONE, ''), true);
  assert.equal(oneRecipientChip([`Remove ${SPELLED}?`], PHONE), true, 'no recipient input found');
  assert.equal(oneRecipientChip([], PHONE, ''), false);
  assert.equal(oneRecipientChip(['Remove 3 1 2 5 5 5 0 1 9 9?'], PHONE, ''), false);
  // A second recipient makes it a group text, even when one chip is ours.
  assert.equal(oneRecipientChip([`Remove ${SPELLED}?`, 'Remove 3 1 2 5 5 5 0 1 9 9?'], PHONE, ''), false);
  assert.equal(oneRecipientChip([`Remove ${SPELLED}?`, `Remove ${SPELLED}?`], PHONE, ''), false);
  // Text left in the recipient field means the pick did not complete.
  assert.equal(oneRecipientChip([`Remove ${SPELLED}?`], PHONE, '312'), false);
});

test('verifyDecision needs a message more than before the click and the empty box', () => {
  assert.equal(verifyDecision({ before: 0, after: 1, boxEmpty: true }), 'sent');
  assert.equal(verifyDecision({ before: 1, after: 2, boxEmpty: true }), 'sent', 'a resend beside its earlier post');
  // The earlier post alone still shows the token: nothing proves this click.
  assert.equal(verifyDecision({ before: 1, after: 1, boxEmpty: true }), 'clicked_unverified');
  assert.equal(verifyDecision({ before: 2, after: 1, boxEmpty: true }), 'clicked_unverified');
  assert.equal(verifyDecision({ before: 0, after: 1, boxEmpty: false }), 'clicked_unverified');
  assert.equal(verifyDecision({ before: 0, after: 1, boxEmpty: null }), 'clicked_unverified', 'box unreadable');
  // A count that is missing or not a whole number is no proof.
  assert.equal(verifyDecision({ after: 1, boxEmpty: true }), 'clicked_unverified');
  assert.equal(verifyDecision({ before: 0, boxEmpty: true }), 'clicked_unverified');
  assert.equal(verifyDecision({ before: '0', after: '1', boxEmpty: true }), 'clicked_unverified');
  assert.equal(verifyDecision({ before: 0, after: NaN, boxEmpty: true }), 'clicked_unverified');
  assert.equal(verifyDecision({ tokenInBubble: true, boxEmpty: true }), 'clicked_unverified', 'the old shape proves nothing');
  assert.equal(verifyDecision({}), 'clicked_unverified');
  assert.equal(verifyDecision(null), 'clicked_unverified');
});

test('pasteInThread lets through only what prior_bodies accounts for', () => {
  const body = `Your proposal: https://drbartender.com/proposal/${TOKEN}.`;
  const other = `Here it is again https://drbartender.com/proposal/${TOKEN}`;
  // An empty list: any token-holding message is a paste (the rule before resends).
  assert.equal(pasteInThread([body], []), true);
  assert.equal(pasteInThread([], []), false, 'nothing in the thread holds the token');
  // One earlier copy, accounted for.
  assert.equal(pasteInThread([body], [body]), false);
  // The list is an upper bound: fewer copies in the thread is fine.
  assert.equal(pasteInThread([body], [body, body]), false);
  assert.equal(pasteInThread([], [body]), false);
  // Two copies in the thread against one in the list: the second is a paste.
  assert.equal(pasteInThread([body, body], [body]), true);
  // A paste in other words beside an accounted copy.
  assert.equal(pasteInThread([body, other], [body]), true);
  assert.equal(pasteInThread([body, other], [body, other]), false, 'both were the box\'s own posts');
  // Whitespace differences are the same text.
  assert.equal(pasteInThread([`  Your proposal:\n https://drbartender.com/proposal/${TOKEN}.\t`], [body]), false);
  assert.equal(pasteInThread([body.replace(' ', '\u00a0\u00a0')], [body]), false);
  // Anything else is a different text.
  assert.equal(pasteInThread([body.toUpperCase()], [body]), true);
  // A list that is not one is empty.
  assert.equal(pasteInThread([body], 'not a list'), true);
  assert.equal(pasteInThread([body], null), true);
  assert.equal(pasteInThread(null, [body]), false, 'no thread read is no message');
});

test('threadItemMatches needs a line that is only this number', () => {
  assert.equal(threadItemMatches(['person', SHOWN, SPELLED], PHONE), true);
  assert.equal(threadItemMatches(['person', SHOWN], PHONE), true, 'the shown number alone, bidi marks and all');
  // A preview that mentions the number is not the conversation with it.
  assert.equal(threadItemMatches(['N', 'Saved Contact', 'call me at (312) 555-0123'], PHONE), false);
  // A group conversation is never the one-to-one thread.
  assert.equal(threadItemMatches(['person', '(312) 555-0123, (312) 555-0199'], PHONE), false);
  assert.equal(threadItemMatches(['person', '(312) 555-0199'], PHONE), false);
  assert.equal(threadItemMatches([], PHONE), false);
});

const noticeHref = (id) => `https://www.thumbtack.com/request/4/bids/${id}/messages`;
const BID = '500000000000000123';

test('a thread holding the expected bid among others passes', () => {
  // A repeat customer's conversation holds a notice per bid; the job's may sit anywhere among them.
  assert.deepEqual(threadBids([noticeHref('500000000000000111'), noticeHref(BID), noticeHref('500000000000000999')], BID),
    { bidIds: ['500000000000000111', BID, '500000000000000999'], wrongThread: false });
  assert.equal(threadBids([noticeHref(BID), noticeHref('500000000000000999')], BID).wrongThread, false,
    'an older lead\'s bid, behind a newer notice');
  // Several notices for one bid are one bid; a link that names no bid is no notice.
  assert.deepEqual(threadBids([noticeHref(BID), noticeHref(BID), 'https://www.thumbtack.com/help', null], BID),
    { bidIds: [BID], wrongThread: false });
  // A redirect-wrapped, percent-encoded notice still counts.
  const wrapped = `https://www.google.com/url?q=${encodeURIComponent(noticeHref(BID))}&sa=D`;
  assert.equal(threadBids([wrapped, noticeHref('500000000000000999')], BID).wrongThread, false);
});

test('a thread whose notices all name other bids is wrong_thread', () => {
  assert.deepEqual(threadBids([noticeHref('500000000000000111'), noticeHref('500000000000000999')], BID),
    { bidIds: ['500000000000000111', '500000000000000999'], wrongThread: true });
  assert.equal(threadBids([noticeHref('500000000000000999')], BID).wrongThread, true);
  // A bid id that merely contains the expected one, or sits inside it, is another bid.
  assert.equal(threadBids([noticeHref(`${BID}0`)], BID).wrongThread, true);
  assert.equal(threadBids([noticeHref(BID.slice(1))], BID).wrongThread, true);
});

test('a thread with no notice passes', () => {
  // One we started: nothing to check.
  assert.deepEqual(threadBids([], BID), { bidIds: [], wrongThread: false });
  assert.deepEqual(threadBids(['https://www.thumbtack.com/help', '', null], BID), { bidIds: [], wrongThread: false });
  assert.deepEqual(threadBids(undefined, BID), { bidIds: [], wrongThread: false });
});

test('with no expected bid (the dry run) a thread is only read', () => {
  assert.deepEqual(threadBids([noticeHref('500000000000000999'), noticeHref('500000000000000111')], null),
    { bidIds: ['500000000000000999', '500000000000000111'], wrongThread: false });
  assert.deepEqual(threadBids([noticeHref('500000000000000999')], ''), { bidIds: ['500000000000000999'], wrongThread: false });
});

test('hasToken matches the proposal token and never an empty one', () => {
  assert.equal(hasToken(['Hi', `https://drbartender.com/proposal/${TOKEN}`], TOKEN), true);
  assert.equal(hasToken([`see www.drbartender.com/proposal/${TOKEN.toUpperCase()}/`], TOKEN), true);
  assert.equal(hasToken(['Hi', null, 'nothing here'], TOKEN), false);
  assert.equal(hasToken(['anything'], ''), false);
  assert.equal(hasToken(['anything'], null), false);
  assert.equal(hasToken(['anything'], 'abc'), false, 'only a uuid-shaped token is ever matched');
});

test('fillCheck passes only an exact body, an empty Call panel and one enabled Send', () => {
  const body = `Your proposal: https://drbartender.com/proposal/${TOKEN}.`;
  const good = { value: body, body, callPanelValues: [''], frames: [], sendCount: 1, sendEnabled: true };
  assert.deepEqual(fillCheck(good), { ok: true });
  assert.deepEqual(fillCheck({ ...good, callPanelValues: [] }), { ok: true }, 'no dialer input found');
  const bad = { ok: false, reason: 'ui_error_before_send' };
  assert.deepEqual(fillCheck({ ...good, value: body.slice(0, -1) }), bad);
  assert.deepEqual(fillCheck({ ...good, callPanelValues: ['3125550123'] }), bad, 'the call-dialer trap');
  assert.deepEqual(fillCheck({ ...good, sendEnabled: false }), bad);
  assert.deepEqual(fillCheck({ ...good, sendCount: 2 }), bad);
  assert.deepEqual(fillCheck({ ...good, sendCount: 0 }), bad);
  assert.deepEqual(fillCheck({ ...good, frames: [{ src: 'https://www.google.com/recaptcha/api2/bframe?k=x', w: 400, h: 580 }] }),
    { ok: false, reason: 'challenge' });
});

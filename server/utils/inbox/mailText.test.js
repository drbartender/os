const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractText, stripQuotes, stripSignature, htmlToText, MAIL_TEXT_MAX } = require('./mailText');
const b64 = (s) => Buffer.from(s).toString('base64url');
const plain = (s) => ({ mimeType: 'text/plain', body: { data: b64(s) } });

test('plain part wins over html', () => {
  const r = extractText({ mimeType: 'multipart/alternative', parts: [plain('Hi, can we add a mocktail station?'), { mimeType: 'text/html', body: { data: b64('<p>Hi</p>') } }] });
  assert.equal(r.text, 'Hi, can we add a mocktail station?');
});
test('html only is converted, blockquote dropped', () => {
  const r = extractText({ mimeType: 'text/html', body: { data: b64('<div>Yes please<br>thanks</div><blockquote>old stuff</blockquote>') } });
  assert.equal(r.text, 'Yes please\nthanks');
});
test('gmail, apple and outlook quote headers are cut', () => {
  assert.equal(stripQuotes('Sounds good.\n\nOn Mon, Oct 5, 2026 at 3:12 PM Someone <a@example.com> wrote:\n> old'), 'Sounds good.');
  assert.equal(stripQuotes('Yes\n\nFrom: Someone\nSent: Monday\nTo: us\nSubject: Re: x\n\nold'), 'Yes');
  assert.equal(stripQuotes('Ok\n-----Original Message-----\nold'), 'Ok');
  assert.equal(stripQuotes('Ok\n> quoted\n> lines'), 'Ok');
});
test('signatures are cut: -- line, device line, trailing contact block', () => {
  assert.equal(stripSignature('See you then\n-- \nPat\n555-0100'), 'See you then');
  assert.equal(stripSignature('See you then\n\nSent from my phone'), 'See you then');
  assert.equal(stripSignature('See you then\n\nPat Example\nEvents Lead\npat@example.com\nwww.example.com'), 'See you then');
});
test('an empty strip falls back to the original minus quotes', () => {
  const r = extractText({ mimeType: 'text/plain', body: { data: b64('-- \nPat\n555-0100\n\nOn Mon Someone wrote:\n> q') } });
  assert.equal(r.text, '-- \nPat\n555-0100');
});
test('cap, attachments, calendar-only', () => {
  const long = 'x'.repeat(MAIL_TEXT_MAX + 5);
  assert.equal(extractText({ mimeType: 'text/plain', body: { data: b64(long) } }).text.length, MAIL_TEXT_MAX);
  const r = extractText({ mimeType: 'multipart/mixed', parts: [plain('see attached'), { mimeType: 'application/pdf', filename: 'doc.pdf', body: {} }, { mimeType: 'image/png', filename: 'a.png', headers: [{ name: 'Content-Disposition', value: 'inline' }], body: {} }] });
  assert.equal(r.attachments, 2);
  const c = extractText({ mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/calendar', filename: 'invite.ics', body: { data: b64('BEGIN:VCALENDAR') } }] });
  assert.equal(c.hasCalendarOnly, true); assert.equal(c.text, null);
});

// ─── hostile input (security and performance review, 2026-10-15) ───
// Every pass is linear: a megabyte of any of these shapes, the decoded-source
// bound, must not stall the Express process. Before the fix '<' x 100k took
// about 10 s; a megabyte extrapolated to minutes.
const MB = 1000000;
const hostile = (unit) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
const msOf = (fn) => {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
};
test('a megabyte of hostile markup finishes in well under 250 ms, through htmlToText and through extractText', () => {
  for (const unit of ['<', '<!--', '<style>', '<hr', '<blockquote ', '<blockquote>', '</blockquote>', '<head>', '<title>',
    '<script>', '<p', '<!-', '&a', '&#', '-- \n', '--\n', 'On x wrote:\n', 'On x\n', '> \n', 'From: x\n', '____________\n', '1-', 'a@',
    '--\n\n', 'Pat\n--\n', '<head><body>', '<head><bodyx']) {
    const s = hostile(unit);
    const html = { mimeType: 'text/html', body: { data: b64(s) } };
    const text = { mimeType: 'text/plain', body: { data: b64(s) } };
    for (const [what, fn] of [['htmlToText', () => htmlToText(s)], ['extractText html', () => extractText(html)], ['extractText plain', () => extractText(text)]]) {
      const ms = msOf(fn);
      assert.ok(ms < 250, `${what} on ${JSON.stringify(unit)} x ${MB / unit.length} took ${ms.toFixed(0)} ms`);
    }
  }
});

test('htmlToText: comments, hidden elements and quotes go, nested or not; a stray "<" stays', () => {
  assert.equal(htmlToText('<html><head><title>T</title><style>p{color:red}</style></head><body><!-- note --><p>Hi there</p>'
    + '<script>x()</script><p>a &lt; b, and 3 < 4</p></body></html>'), 'Hi there\n\na < b, and 3 < 4');
  assert.equal(htmlToText('<P>Keep</P><!-- an unclosed comment <p>hidden</p>'), 'Keep', 'an unclosed comment runs to the end');
  assert.equal(htmlToText('<p>Keep</p><STYLE type="text/css">p{} <p>hidden</p>'), 'Keep', 'so does an unclosed style');
  assert.equal(htmlToText('<head><meta charset="utf-8"><body><p>Hello</p></body>'), 'Hello', 'a head with no end tag ends at the body');
  assert.equal(htmlToText('<div>Yes</div><blockquote type="cite">q1<BLOCKQUOTE>q2</blockquote>q3</blockquote><div>Sure</div>'), 'Yes\nSure');
  assert.equal(htmlToText('<div>Yes</div><blockquote>open<blockquote>inner</blockquote> tail'), 'Yes\nopen tail', 'an unclosed outer quote keeps its words');
  assert.equal(htmlToText('Yes</blockquote> still'), 'Yes still', 'a stray closer is only a tag');
  assert.equal(htmlToText('Line one<hr class="rule">Line two'), 'Line one\nLine two');
  assert.equal(htmlToText('<div>Caf&eacute; &amp; bar &#x1F942;</div>'), 'Caf&eacute; & bar \u{1F942}');
  const long = htmlToText(`<p>${'word '.repeat(52427)}<span class="${'a'.repeat(40)}">after the bound</span></p>`);
  assert.ok(long.startsWith('word word'), 'the start is kept');
  assert.ok(!long.includes('<') && !long.includes('span') && !long.includes('after the bound'),
    'only the first 256 KB of HTML is read, and the tag the bound cut in half is no text');
});

// ─── their own words (code review, 2026-10-15) ───
test('a detail block at the end of an inquiry is kept: a dashed date is no phone', () => {
  const inquiry = "Hi, we'd like a quote for our wedding.\n\nDate: 2026-12-12\nGuests: 120\nVenue: The Loft";
  assert.equal(extractText(plain(inquiry)).text, inquiry);
  for (const date of ['2026-12-12', '12-12-2026', '12.12.2026']) {
    const s = `See you then.\nThanks!\n\nDate: ${date}\nGuests: 120`;
    assert.equal(stripSignature(s), s, date);
  }
  assert.equal(stripSignature('See you then.\n\nThanks,\nPat\n555-0100'), 'See you then.', 'a real phone after a sign-off still goes');
});

test('a last block with an address or a number is a signature only after a sign-off or the sender\'s own name', () => {
  const moved = 'Can you send the invoice here instead?\n\nbilling@corp.example.com';
  assert.equal(extractText(plain(moved)).text, moved);
  assert.equal(extractText(plain('See you then.\n\nPat\npat@example.com'), { senderName: 'Pat Example' }).text, 'See you then.');
  assert.equal(extractText(plain('See you then.\n\n- pat\npat@example.com | 555-0100'), { senderName: 'Example, Pat' }).text, 'See you then.');
  const planner = 'Please loop in my planner.\n\nLee D\nlee@example.com';
  assert.equal(extractText(plain(planner), { senderName: 'Jamie Q' }).text, planner, 'someone else\'s card is their words');
  assert.equal(extractText(plain('See you then.\nBest,\n\nJamie Q\njamie.q@example.com'), { senderName: 'Jamie Q' }).text, 'See you then.\nBest,',
    'a sign-off above the block');
  assert.equal(stripSignature('Sounds good.\n\nThanks so much!\nPat\n555-0100'), 'Sounds good.', 'a sign-off that ends in "!" opens the block');
  assert.equal(stripSignature('Sounds good.\n\nCheers - The Example Team\n555-0100'), 'Sounds good.', 'a sign-off with a name after it');
  const intro = 'Our details changed, here they are:\n\nJamie Q\n12 Example Ave\n555-0123';
  assert.equal(extractText(plain(intro), { senderName: 'Jamie Q' }).text, intro, 'a block the line above introduces with ":" is content');
  const sentence = 'Hi.\n\nThanks, we will see you then\nPat\n555-0100';
  assert.equal(stripSignature(sentence), sentence, 'a sentence that starts with "Thanks," is no sign-off');
});

test('a bare "--" separates only in HTML; plain text needs the standard "-- "', () => {
  const menu = 'Menu ideas:\n--\nMargarita\nPaloma\n\nCan you do both?';
  assert.equal(extractText(plain(menu)).text, menu);
  const html = { mimeType: 'text/html', body: { data: b64('<div>See you then</div><div>-- </div><div>Pat</div><div>555-0100</div>') } };
  assert.equal(extractText(html).text, 'See you then');
  assert.equal(stripSignature('See you then\n-- \nPat'), 'See you then');
});

// Re-review 2026-10-15: a bare "--" over a signature leaked the whole card.
test('in plain text a bare "--" cuts when what follows is a signature, and keeps a separator\'s words', () => {
  const card = 'Sounds good, see you Saturday.\n\n--\nPat Example\nExample Events\npat@example.com\n555-0142';
  assert.equal(extractText(plain(card), { senderName: 'Pat Example' }).text, 'Sounds good, see you Saturday.');
  assert.equal(extractText(plain(card)).text, 'Sounds good, see you Saturday.', 'with no display name, a short line of capitalized words opens a card');
  assert.equal(extractText(plain('See you then\n--\nPat'), { senderName: 'Pat Example' }).text, 'See you then', 'the sender\'s own name');
  assert.equal(extractText(plain('See you then\n--\nThanks,\nPat\n555-0142')).text, 'See you then', 'a sign-off under it');
  assert.equal(extractText(plain('See you then\n--\nPat\n555-0142\nSent from my phone')).text, 'See you then', 'and the device line');
  const keep = [
    'Menu ideas:\n--\nMargarita\nPaloma\n\nCan you do both?',
    'Menu ideas:\n--\nMargarita\nPaloma',
    'Our hours:\n--\nFriday 5-11pm\nSaturday 4-10pm',
    'Two questions\n--\nDo you bring ice?\n--\nWhat about glassware?',
    'Quick update\n--\nwe moved the start to six and the guest count is now about ninety people in total\npat@example.com',
    'Times\n--\nOne\nTwo\nThree\nFour\nFive\nSix\nSeven\n555-0142',
  ];
  for (const s of keep) assert.equal(extractText(plain(s), { senderName: 'Jamie Q' }).text, s, JSON.stringify(s));
  assert.equal(stripSignature('Menu:\n--\nA\nB\nCan you do both?\n--\nPat\n555-0142'), 'Menu:\n--\nA\nB\nCan you do both?',
    'a later "--" over a card still cuts');
});

// Code review 2026-10-15: a contact line alone is never a signature. A bare
// "--" cuts only when what follows opens with a sign-off or the sender's own
// name line, as cutContactBlock requires; otherwise an address, a phone, a
// link or a code under it is what they sent.
test('in plain text a bare "--" over contact lines that open with no sign-off and no sender name keeps them', () => {
  const keep = [
    'Please send the invoice to our accounts team instead\n--\naccounts@example.com',
    'Day-of contact below\n--\nJamie Q\n555-0142',
    'Venue details\n--\nThe Barn\n12 Main Street\nwww.example.com/map',
    'Here is the parking info\n--\nLot B\nGate code 4417 2290',
  ];
  for (const s of keep) assert.equal(extractText(plain(s), { senderName: 'Pat Example' }).text, s, JSON.stringify(s));
  const card = 'Sounds good, see you Saturday.\n\n--\nPat Example\nExample Events\npat@example.com\n555-0142';
  assert.equal(extractText(plain(card), { senderName: 'Pat Example' }).text, 'Sounds good, see you Saturday.', 'the sender\'s own card still cuts');
  assert.equal(extractText(plain('Menu ideas:\n--\nMargarita\nPaloma\n\nCan you do both?'), { senderName: 'Pat Example' }).text,
    'Menu ideas:\n--\nMargarita\nPaloma\n\nCan you do both?', 'the menu is kept');
});

test('a head with neither an end tag nor a body drops only its tag, and the words after it stay', () => {
  assert.equal(htmlToText('<html><head><meta charset=utf-8><div>Hi there, the 12th works.</div></html>'), 'Hi there, the 12th works.');
  assert.equal(htmlToText('<head><title>T</title><style>p{}</style><div>Yes</div>'), 'Yes', 'what the head holds that hides still hides');
  assert.equal(htmlToText('<head><meta charset="utf-8"><body><p>Hello</p></body>'), 'Hello', 'a body still ends it');
  const html = { mimeType: 'text/html', body: { data: b64('<html><head><meta charset=utf-8><div>Hi there, the 12th works.</div></html>') } };
  assert.equal(extractText(html).text, 'Hi there, the 12th works.');
});

test('a bottom-posted or inline reply keeps their words, without the quoted lines or the header', () => {
  const bottom = 'On Mon, Oct 5, 2026 at 3:12 PM Someone <a@example.com> wrote:\n> Is the 14th open?\nYes, the 14th works';
  assert.equal(extractText(plain(bottom)).text, 'Yes, the 14th works');
  const inline = 'On Mon, Oct 5, 2026 at 3:12 PM Someone <a@example.com>\nwrote:\n> Is the 14th open?\nYes.\n\n> And a mocktail bar?\n>> On Sun, Someone wrote:\nSure, add it.';
  assert.equal(stripQuotes(inline), 'Yes.\n\nSure, add it.');
  assert.equal(stripQuotes('On Mon, Oct 5, 2026, Someone wrote:\n> q\n\n-----Original Message-----\nold'), '', 'a forwarded block below is still cut');
  assert.equal(extractText(plain('On Mon, Someone wrote:\n> q')).text, null);
});

test('Outlook\'s plain-text rule above its From:/Sent: block is the quote boundary', () => {
  const outlook = 'Sounds good.\n\n________________________________\nFrom: Pat Example <pat@example.com>\nSent: Monday, October 12, 2026 3:00 PM\nTo: Desk\nSubject: Re: x\n\nold';
  assert.equal(stripQuotes(outlook), 'Sounds good.');
  assert.equal(extractText(plain(outlook)).text, 'Sounds good.');
  assert.equal(stripQuotes('Totals:\n________________________________\nTwo bars'), 'Totals:\n________________________________\nTwo bars', 'a rule alone is no header');
});

test('the bottom-post fallback runs only on a quote marked with ">", and stops at the next header of either kind', () => {
  const unmarked = '\nOn Mon, Oct 5, 2026 at 3:12 PM Desk <desk@example.com> wrote:\n\nHi Pat, your quote is $1,200 for 120 guests.\n';
  assert.equal(stripQuotes(unmarked), '', 'history a client did not mark with ">" is still history');
  assert.equal(extractText(plain(unmarked)).text, null);
  const older = 'On Mon, A wrote:\n> q\nYes\n\nOn Sun, Oct 4, 2026, B <b@example.com> wrote:\nolder unprefixed history';
  assert.equal(stripQuotes(older), 'Yes');
});

test('the common sign-offs open a signature block', () => {
  for (const signOff of ['Warm wishes,', 'Yours truly,', 'Love,', 'All best,', 'With thanks,']) {
    assert.equal(stripSignature(`See you then.\n\n${signOff}\nPat\n555-0100`), 'See you then.', signOff);
  }
});

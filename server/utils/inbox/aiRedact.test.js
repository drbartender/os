// Pure suite (no DB, no network). Every name, number and address below is
// invented; the 555 numbers are the reserved fiction range.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SLICE_SKIP_WORDS, isKeywordRow, nameParts, redact } = require('./aiRedact');

test('phone numbers in every common format become [number]', () => {
  const formats = [
    '+13125550100', '(312) 555-0100', '312.555.0100', '312-555-0100', '312 555 0100',
    '1-312-555-0100', '3125550100', '+1 (312) 555-0100', '555-0100', '(312)555-0100',
  ];
  for (const phone of formats) {
    assert.equal(redact(`Call me at ${phone} after 5`), 'Call me at [number] after 5', phone);
  }
});

test('card, bank, routing and SSN runs become [number]', () => {
  assert.equal(redact('Card 4242 4242 4242 4242 exp 12/29'), 'Card [number] exp 12/29');
  assert.equal(redact('Card 4242-4242-4242-4242'), 'Card [number]');
  assert.equal(redact('Routing 123456789, acct 000123456789'), 'Routing [number], acct [number]');
  assert.equal(redact('SSN 123-45-6789'), 'SSN [number]');
  assert.equal(redact('Order #1234567 shipped'), 'Order #[number] shipped');
});

test('short numbers, money, times and slashed dates stay', () => {
  for (const kept of [
    '150 guests', 'Deposit was $1,250.00', 'ZIP 60601', 'Start at 5:30 PM', 'Oct 20 works',
    'Can you do 10/20/2026?', 'Code 55-0100', 'ext 22', 'Room 1205, floor 12', '2 bars, 3 bartenders',
  ]) {
    assert.equal(redact(kept), kept);
  }
});

test('two numbers in one message, a dashed date, and a number in parentheses', () => {
  assert.equal(redact('Text 312.555.0100 or 312-555-0101.'), 'Text [number] or [number].');
  assert.equal(redact('Can you do 10-20-2026?'), 'Can you do [number]?');
  assert.equal(redact('(call 312-555-0100)'), '(call [number])');
});

test('a sentence-ending period stops the run; Unicode dashes join it', () => {
  assert.equal(redact('My number is 312-555-0100. 2 kids'), 'My number is [number]. 2 kids');
  assert.equal(redact('Text 312\u2010555\u20100100 please'), 'Text [number] please');
  assert.equal(redact('Text 312\u2013555\u20130100 please'), 'Text [number] please');
  assert.equal(redact('Text 312\u2212555\u22120100 please'), 'Text [number] please');
});

test('email addresses become [email]', () => {
  assert.equal(redact('jordan.testerton@example.com'), '[email]');
  assert.equal(redact('Reach me: JO+events@Mail.Example.org.'), 'Reach me: [email].');
  assert.equal(redact('email test_user99@example.co.uk today'), 'email [email] today');
  assert.equal(redact('Meet @ the venue at 6'), 'Meet @ the venue at 6');
});

test('links become [link], with token paths and trailing punctuation handled', () => {
  assert.equal(redact('https://drbartender.com/proposal/0f3c2a1e-1234-4abc-9def-0123456789ab'), '[link]');
  assert.equal(redact('see http://example.com/a?b=c.'), 'see [link].');
  assert.equal(redact('go to www.example.com/plan/abc123 now'), 'go to [link] now');
  assert.equal(redact('drbartender.com/plan/ab12cd34'), '[link]');
  assert.equal(redact('(https://example.com/x)'), '([link])');
  assert.equal(redact('https://example.com/i/31255501001'), '[link]');
  assert.equal(redact('Is your site drbartender.com?'), 'Is your site drbartender.com?');
  assert.equal(redact('e.g. 3.5/hr and/or a.m./p.m.'), 'e.g. 3.5/hr and/or a.m./p.m.');
});

test('the surname is dropped and the first name kept', () => {
  const p = { personName: 'Jordan Testerton' };
  assert.equal(redact('Hi, this is Jordan Testerton from the wedding', p), 'Hi, this is Jordan from the wedding');
  assert.equal(redact('jordan testerton here', p), 'jordan here');
  assert.equal(redact('Testerton party of 8', p), 'party of 8');
  assert.equal(redact("Jordan Testerton's order", p), "Jordan's order");
  assert.equal(redact('Thanks, Jordan', p), 'Thanks, Jordan');
});

test('hyphenated names, couples, titles, accents and initials', () => {
  assert.equal(redact('Vale and Testerton-Vale both', { personName: 'Jordan Testerton-Vale' }), 'and both');
  assert.equal(redact('Casey Testerton says hi', { personName: 'Jordan & Casey Testerton' }), 'Casey says hi');
  const titled = nameParts('Dr. Jordan Testerton Jr.');
  assert.deepEqual([...titled.firstNames], ['jordan']);
  assert.deepEqual([...titled.surnames], ['testerton']);
  assert.equal(redact('Hola, soy Tomás Núñez', { personName: 'Tomás Núñez' }), 'Hola, soy Tomás');
  assert.equal(redact('Jordan T. here', { personName: 'Jordan T.' }), 'Jordan T. here');
});

test('a surname that is an everyday word goes only after the first name', () => {
  const p = { personName: 'Pat White' };
  assert.equal(
    redact('Pat White here. Do you have White wine and white wine?', p),
    'Pat here. Do you have White wine and white wine?',
  );
  assert.equal(redact('the lighting looked great', { personName: 'Acme Lighting' }), 'the lighting looked great');
  assert.equal(redact('Acme Lighting called', { personName: 'Acme Lighting' }), 'Acme called');
});

test('no name, a one-word name, and non-string input change nothing they should not', () => {
  assert.equal(redact('Jordan Testerton here'), 'Jordan Testerton here');
  assert.equal(redact('Jordan Testerton here', { personName: 'Jordan' }), 'Jordan Testerton here');
  assert.equal(redact(null), '');
  assert.equal(redact(undefined), '');
  assert.equal(redact(42), '');
});

test('everything at once', () => {
  assert.equal(
    redact('Jordan Testerton here, call 312-555-0100 or email jordan.t@example.com, link https://drbartender.com/plan/abc', { personName: 'Jordan Testerton' }),
    'Jordan here, call [number] or email [email], link [link]',
  );
});

test("keyword rows are lane inbox-engine's OPT_WORDS: exactly spec 5.3's seven unambiguous opt words", () => {
  assert.deepEqual([...SLICE_SKIP_WORDS].sort(), ['optout', 'revoke', 'start', 'stop', 'stopall', 'unstop', 'unsubscribe']);
  for (const w of ['STOP', ' stop ', 'StopAll', 'unsubscribe', 'OPTOUT', 'revoke', 'Start', 'unstop']) {
    assert.equal(isKeywordRow(w), true, w);
  }
  for (const w of ['Cancel', 'yes', 'help', 'info', 'end', 'quit', 'stop by later', '', null]) {
    assert.equal(isKeywordRow(w), false, String(w));
  }
});

test('a crafted 3000-character host run with no slash redacts in well under a second, with the same result', () => {
  // Every hyphen boundary in the prefix starts a host that reaches the same
  // long letter run, and the run never ends in a slash: the old BARE_URL form
  // backtracked cubically on it (several seconds on this line). The run is
  // never a link, so it stays; the bare link after it still becomes [link].
  const link = ' drbartender.com/plan/ab12cd34';
  const run = `${'a-'.repeat(500)}.${'a'.repeat(3000 - 1001 - link.length)}`;
  const line = `${run}${link}`;
  assert.equal(line.length, 3000);
  const started = process.hrtime.bigint();
  const out = redact(line);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(out, `${run} [link]`);
  assert.ok(ms < 500, `redact took ${Math.round(ms)} ms on the crafted line (bound 500 ms)`);
});

// The two tests below pin quadratic patterns. At the 3000-character line bound
// the old forms took about 0.1 s, too close to any bound a slow box can trust,
// so the same shapes run at 20,000 characters: seconds before, milliseconds now.
test('the surname pass scans a long run of spaces before a non-letter once', () => {
  const line = `Jordan Testerton${' '.repeat(20000 - 17)}\u2019`;
  const started = process.hrtime.bigint();
  const out = redact(line, { personName: 'Jordan Testerton' });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(out, 'Jordan \u2019');
  assert.ok(ms < 500, `redact took ${Math.round(ms)} ms on the crafted line (bound 500 ms)`);
});

test('a name token with a long run of non-letters inside is trimmed in one pass', () => {
  const inner = `T${'\u2010'.repeat(20000 - 12)}n`;
  const started = process.hrtime.bigint();
  const parts = nameParts(`Jordan (${inner}).`);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual([...parts.firstNames], ['jordan']);
  assert.deepEqual([...parts.surnames], [inner.toLowerCase()]);
  assert.deepEqual([...parts.commonSurnames], []);
  assert.ok(ms < 500, `nameParts took ${Math.round(ms)} ms on the crafted name (bound 500 ms)`);
});

// The merge review, 2026-10-13: \d is ASCII-only, and www. hosts ran before
// addresses, so an address at a www. host kept its local part.
test('a phone typed in fullwidth digits is still [number] (NFKC runs first)', () => {
  const wide = (s) => s.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));
  assert.equal(redact(`Call me at ${wide('312-555-0100')} after 5`), 'Call me at [number] after 5');
  assert.equal(redact(`Card ${wide('4242 4242 4242 4242')}`), 'Card [number]');
});

test('an address at a www. host is [email], so its local part never rides out inside a link', () => {
  assert.equal(redact('Email me at jordan.testerton@www.example.com please'), 'Email me at [email] please');
  assert.equal(redact('Site www.example.com/book and mail a@b.co'), 'Site [link] and mail [email]');
});

test('a display name stored with a decomposed accent still matches the normalized text', () => {
  const nfd = `Jordan Mu${String.fromCharCode(0x0308)}ller`; // u + combining diaeresis
  const nfc = `Jordan M${String.fromCharCode(0x00fc)}ller`; // precomposed u-umlaut
  assert.equal(redact(`Hi, ${nfc} here about the 20th`, { personName: nfd }), 'Hi, Jordan here about the 20th');
  assert.equal(redact(`Hi, ${nfd} here about the 20th`, { personName: nfc }), 'Hi, Jordan here about the 20th');
});

// Email fixtures (spec 2026-10-14 section 6): the redactor needs no new rule
// for mail, and these pin it on the two shapes mail adds.
test('an email signature block: every phone, the address and every link go, and the surname with them', () => {
  const signature = [
    'Thanks so much!',
    '--',
    'Jordan Testerton',
    'Event Planner, Example Events LLC',
    'Mobile: (312) 555-0100 | Office: 312.555.0101 ext 22',
    'jordan.testerton@example.com',
    'www.example.com/events | https://example.com/book?ref=abc123',
  ].join('\n');
  const out = redact(signature, { personName: 'Jordan Testerton' });
  assert.equal(out, [
    'Thanks so much!',
    '--',
    'Jordan',
    'Event Planner, Example Events LLC',
    'Mobile: [number] | Office: [number] ext 22',
    '[email]',
    '[link] | [link]',
  ].join('\n'));
  assert.doesNotMatch(out, /555|0100|0101|@|example\.com|abc123|Testerton/);
});

test('a quoted-address line: the attribution line and a quoted header block keep no address and no surname', () => {
  const attribution = 'On Mon, Oct 5, 2026 at 9:00 AM Jordan Testerton <jordan.testerton@example.com> wrote:';
  assert.equal(redact(attribution, { personName: 'Jordan Testerton' }), 'On Mon, Oct 5, 2026 at 9:00 AM Jordan <[email]> wrote:');
  const header = [
    '> From: Jordan Testerton [mailto:jordan.testerton@example.com]',
    '> Sent: Monday, October 5, 2026 9:00 AM',
    '> To: events@example.com; <planner.p@example.org>',
  ].join('\n');
  const out = redact(header, { personName: 'Jordan Testerton' });
  assert.equal(out, [
    '> From: Jordan [mailto:[email]]',
    '> Sent: Monday, October 5, 2026 9:00 AM',
    '> To: [email]; <[email]>',
  ].join('\n'));
  assert.doesNotMatch(out, /@|example\.(com|org)|Testerton/);
});

// The fleet, 2026-10-16: the address and bare-host scans are linear (each
// consumes a run it judged rather than restarting inside it), and redact no
// less than before.
test('a 70-character local part, a long link and a long host are redacted whole', () => {
  const local = `${'j'.repeat(70)}.testerton`;
  assert.equal(redact(`write to ${local}@example.com today`), 'write to [email] today');
  assert.equal(redact(`see example.com/plan/${'a1'.repeat(1500)} now`), 'see [link] now');
  assert.equal(redact(`at ${'sub.'.repeat(500)}example.com/p/${'z'.repeat(200)}.`), 'at [link].');
  const out = redact(`${local}@example.com ${'sub-'.repeat(300)}example.co.uk/x`);
  assert.equal(out, '[email] [link]');
  assert.doesNotMatch(out, /j{2}|testerton|sub|example/);
});

test('addresses and hosts that start where a run already began still go: back to back, after a dot, after a hyphen', () => {
  assert.equal(redact('a@b.com.x@c.org'), '[email][email]');
  assert.equal(redact('a@b.com1x@c.org'), '[email][email]');
  assert.equal(redact('_jo@example.com'), '[email]');
  assert.equal(redact('.example.com/path'), '.[link]');
  assert.equal(redact('-example.com/path'), '-[link]');
  assert.equal(redact('.-.-.a.com/p'), '.-.-.[link]');
  assert.equal(redact('see a.b.example.co.uk/plan/abc123.'), 'see [link].');
  for (const kept of ['3.5/5 stars', 'v1.2/3', 'a.b/c', 'jo@ex.c', 'x@y']) assert.equal(redact(kept), kept);
});

test('an 8,000-character unbroken run that walks both scans redacts in a few milliseconds', () => {
  const runs = [
    'ab.cd-ef_gh+ij%k'.repeat(500),
    'a.'.repeat(4000),
    'a-'.repeat(4000),
    'x'.repeat(8000),
    `${'q'.repeat(7980)}@example.c`,
  ];
  for (const run of runs) {
    assert.equal(run.length >= 7990, true);
    const started = process.hrtime.bigint();
    redact(run, { personName: 'Jordan Testerton' });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 50, `${run.slice(0, 12)}... took ${ms.toFixed(1)} ms`);
  }
});

// The fleet's second round (2026-10-16): the sentence punctuation kept after
// [link] is found by walking back from the end of the link; a $-anchored
// pattern retried from every position of a long run of it.
test('a link followed by 8,000 characters of sentence punctuation and a letter redacts in a few milliseconds, its tail kept', () => {
  const tail = ".,)'".repeat(2000);
  const started = process.hrtime.bigint();
  const out = redact(`https://a${tail}b`);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 25, `took ${ms.toFixed(1)} ms`);
  assert.equal(out, '[link]');
  assert.equal(redact(`see https://example.com/x${tail}`), `see [link]${tail}`);
  assert.equal(redact('(see https://example.com/plan/abc).'), '(see [link]).');
});

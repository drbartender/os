const { test } = require('node:test');
const assert = require('node:assert/strict');
const { zolaAuthPasses, zolaTemplateOf, labelKey, fallbackLabel, boundLabel } = require('./zolaMail');

// Invented Authentication-Results values in the shape mx.google.com writes:
// folded across lines, comments in parentheses, a second DKIM signature from a
// relay. Selectors, signatures, the bounce address and the IP are made up
// (192.0.2.0/24 is the documentation range).
function authResults({ dkim = 'pass', dkimDomain = 'zola.com', dmarc = 'pass', fromDomain = 'zola.com', server = 'mx.google.com' } = {}) {
  return [
    `${server};`,
    `       dkim=${dkim} header.i=@${dkimDomain} header.s=sel1 header.b=AbCd1234;`,
    '       dkim=pass header.i=@relay.example.net header.s=relay header.b=EfGh5678;',
    '       spf=pass (google.com: domain of bounce@mail.example.net designates 192.0.2.10 as permitted sender) smtp.mailfrom=bounce@mail.example.net;',
    `       dmarc=${dmarc} (p=REJECT sp=REJECT dis=NONE) header.from=${fromDomain}`,
  ].join('\r\n');
}
const headers = (value) => new Map([['authentication-results', value]]);

test('gate passes on a pass line', () => {
  assert.equal(zolaAuthPasses(headers(authResults())), true);
  assert.equal(zolaAuthPasses(headers('mx.google.com; dkim=pass header.i=@zola.com; dmarc=pass header.from=zola.com')), true);
  assert.equal(zolaAuthPasses(headers('MX.Google.com; DKIM=Pass header.i=@Zola.com; DMARC=PASS header.from=ZOLA.COM')), true, 'case-insensitive');
  assert.equal(zolaAuthPasses(headers([authResults(), authResults({ dkim: 'fail' })])), true, 'only the topmost header, the one Google wrote, is read');
});

test('gate refuses dkim fail', () => {
  for (const dkim of ['fail', 'neutral', 'none', 'temperror', 'permerror', 'policy']) {
    assert.equal(zolaAuthPasses(headers(authResults({ dkim }))), false, dkim);
  }
  assert.equal(zolaAuthPasses(headers('mx.google.com; dmarc=pass header.from=zola.com')), false, 'no DKIM result at all');
});

test('gate refuses a dmarc fail', () => {
  for (const dmarc of ['fail', 'none', 'bestguesspass', 'temperror']) {
    assert.equal(zolaAuthPasses(headers(authResults({ dmarc }))), false, dmarc);
  }
  assert.equal(zolaAuthPasses(headers('mx.google.com; dkim=pass header.i=@zola.com')), false, 'no DMARC result at all');
});

test('gate refuses a pass line for a different domain, a line Google did not write, and a forged line under Google\'s', () => {
  assert.equal(zolaAuthPasses(headers(authResults({ dkimDomain: 'example.net', fromDomain: 'example.net' }))), false);
  assert.equal(zolaAuthPasses(headers(authResults({ dkimDomain: 'zola.com.example.net' }))), false);
  assert.equal(zolaAuthPasses(headers(authResults({ dkimDomain: 'notzola.com' }))), false);
  assert.equal(zolaAuthPasses(headers(authResults({ fromDomain: 'example.net' }))), false, 'DMARC passed for some other From domain');
  assert.equal(zolaAuthPasses(headers(authResults({ server: 'mx.example.net' }))), false);
  assert.equal(zolaAuthPasses(headers([authResults({ dkim: 'fail' }), authResults()])), false, 'a forged pass below Google\'s own fail');
  assert.equal(zolaAuthPasses(headers('mx.google.com; dkim=fail (bad sig; dkim=pass header.i=@zola.com); dmarc=pass header.from=zola.com')), false, 'a pass inside a comment');
  assert.equal(zolaAuthPasses(headers('mx.google.com; dkim=fail header.i=@zola.com; spf=pass smtp.mailfrom="x;dkim=pass header.i=@zola.com;"@example.net; dmarc=pass header.from=zola.com')), false, 'a pass inside a quoted string');
  assert.equal(zolaAuthPasses(new Map()), false);
  assert.equal(zolaAuthPasses(null), false);
  assert.equal(zolaAuthPasses(headers('')), false);
});

// The review's probes: identities and results an attacker can shape through
// a DKIM i= tag or an envelope sender Google copies into its own line.
const SPF_INJECT = 'spf=pass (google.com: domain of "a);dkim=pass header.i=@zola.com;dmarc=pass header.from=zola.com;(b"@evil.example designates 192.0.2.7 as permitted sender) smtp.mailfrom=b@evil.example';
const SPF_SWALLOW = 'spf=pass (google.com: domain of "a);dkim=pass header.i=@zola.com;dmarc=pass header.from=zola.com;((b"@evil.example designates 192.0.2.7 as permitted sender) smtp.mailfrom=b@evil.example';

test('gate probes: a quoted identity, a repeated property, a result smuggled out of a comment, a swallowed dmarc', () => {
  const gate = (v) => zolaAuthPasses(headers(v));
  assert.equal(gate('mx.google.com; dkim=pass header.i="x header.i=@zola.com"@evil.example header.s=s1; dmarc=pass header.from=zola.com'), false, 'quoted identity with a space');
  assert.equal(gate('mx.google.com; dkim=pass header.i="x@zola.com"@evil.example header.s=s1; dmarc=pass header.from=zola.com'), false, 'quoted identity');
  assert.equal(gate('mx.google.com; dkim=pass header.i=a@b@zola.com header.s=s1; dmarc=pass header.from=zola.com'), false, 'two @');
  assert.equal(gate('mx.google.com; dkim=pass header.i=@evil.example header.i=@zola.com header.s=s1; dmarc=pass header.from=zola.com'), false, 'the first header.i is the one Google wrote');
  assert.equal(gate('mx.google.com; dkim=pass header.i=@zola.com header.s=s1; dmarc=pass header.from=evil.example header.from=zola.com'), false, 'the first header.from');
  assert.equal(gate(`mx.google.com; dkim=pass header.i=@evil.example header.s=s1; ${SPF_INJECT}; dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=zola.com`), false,
    'a ")" in a quoted local part closes the comment early: two dmarc results, refused');
  assert.equal(gate(`mx.google.com; dkim=pass header.i=@evil.example header.s=s1; ${SPF_SWALLOW}; dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=zola.com`), false,
    'an unclosed "(" swallows Google\'s own dmarc: the line ends inside a comment, refused');
  assert.equal(gate('mx.google.com; dkim=pass header.i=@zola.com; spf=pass smtp.mailfrom="x@zola.com; dmarc=pass header.from=zola.com'), false, 'ends inside a quoted string');
  assert.equal(gate('mx.google.com; dkim=pass header.i=@zola.com; dmarc=pass header.from=zola.com; dmarc=pass header.from=zola.com'), false, 'exactly one dmarc result');
  assert.equal(gate('mx.google.com; arc=pass (i=1 spf=pass spfdomain=mail.zola.com dkim=pass dkdomain=zola.com dmarc=pass fromdomain=zola.com); '
    + 'dkim=pass header.i=@zola.com header.s=s1 header.b=Ab1; spf=pass (google.com: domain of bounce@mail.zola.com designates 192.0.2.10 as permitted sender) '
    + 'smtp.mailfrom=bounce@mail.zola.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=zola.com'), true, 'a real line with an ARC comment still passes');
});

test('boundLabel trims and cuts at 120 code points, null when empty', () => {
  assert.equal(boundLabel('  Alex B & Sam C '), 'Alex B & Sam C');
  assert.equal(boundLabel('🥂'.repeat(130)), '🥂'.repeat(120));
  assert.equal(boundLabel('   '), null);
  assert.equal(boundLabel(null), null);
});

test('the four subjects map to their templates, with the label where the subject carries one', () => {
  assert.deepEqual(zolaTemplateOf('New Zola inquiry for Dr. Bartender'), { template: 'inquiry', label: null });
  assert.deepEqual(zolaTemplateOf('New message from Alex B & Sam C for Dr. Bartender'), { template: 'message', label: 'Alex B & Sam C' });
  assert.deepEqual(zolaTemplateOf('Alex B & Sam C closed their inquiry'), { template: 'closed', label: 'Alex B & Sam C' });
  assert.deepEqual(zolaTemplateOf('Booked! A couple booked you on Zola'), { template: 'booked', label: null });
  assert.deepEqual(zolaTemplateOf('  New message from  Lee D & Max E  for Dr. Bartender '), { template: 'message', label: 'Lee D & Max E' });
});

test('a marketing subject, or none, maps to null', () => {
  for (const subject of ['Grow your bookings with Zola this season', 'Re: New message from Alex B & Sam C for Dr. Bartender', '', null, undefined]) {
    assert.deepEqual(zolaTemplateOf(subject), { template: null, label: null }, String(subject));
  }
});

test('a 200-character label is cut to 120', () => {
  const long = 'A'.repeat(200);
  assert.equal(zolaTemplateOf(`New message from ${long} for Dr. Bartender`).label.length, 120);
  assert.equal(zolaTemplateOf(`${long} closed their inquiry`).label, 'A'.repeat(120));
});

test('labelKey trims, collapses inner whitespace and case-folds', () => {
  assert.equal(labelKey('  Alex  B &  Sam C '), labelKey('alex b & sam c'));
  assert.equal(labelKey('  Alex\tB &\n Sam C '), 'alex b & sam c');
});

test('fallbackLabel names the notice by its Chicago date', () => {
  assert.equal(fallbackLabel('2026-10-14'), 'Zola notice 2026-10-14');
});

// Security review, 2026-10-15: the DKIM half was forgeable two ways. Both
// passed the gate before the fix.
test('gate probes: a dkim=pass smuggled in through a quoted envelope local part, and an unquoted identity cut at a quote', () => {
  const gate = (v) => zolaAuthPasses(headers(v));
  const smuggled = 'mx.google.com; dkim=pass header.i=@evil.example header.s=s1; '
    + 'spf=pass (google.com: domain of "a);dkim=pass header.i=@zola.com;(b"@evil.example designates 192.0.2.7 as permitted sender) '
    + 'smtp.mailfrom=b@evil.example; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=zola.com';
  assert.equal(gate(smuggled), false, 'a quote anywhere in Google\'s line is refused');
  assert.equal(gate('mx.google.com; dkim=pass header.i=@zola.com"x"@evil.example header.s=s1; dmarc=pass (p=REJECT) header.from=zola.com'), false,
    'the identity runs to the next space or ";", so the quote reaches the domain check');
  assert.equal(gate(authResults()), true, 'a line with no quote still passes');
});

// Security re-review 2026-10-15: the property pattern rescanned a long run of
// name characters from every position in it (50,000 took 4 s, 200,000 68 s).
test('the auth-line reader is linear on a long run of name characters, and a line past 4096 characters is refused', () => {
  const ms = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  const real = authResults();
  // A real line, its selector padded to a total length.
  const padded = (total) => real.replace('header.s=sel1', `header.s=${'s'.repeat(total - real.length + 4)}`);
  assert.equal(padded(4096).length, 4096);
  assert.equal(zolaAuthPasses(headers(padded(4096))), true, 'a 4096-character line is read');
  assert.equal(zolaAuthPasses(headers(padded(4097))), false, 'one character more is refused');
  const run = `mx.google.com; dkim=pass ${'a'.repeat(4000)}; dmarc=pass header.from=zola.com`;
  assert.ok(run.length <= 4096);
  let took = 0;
  for (let i = 0; i < 200; i += 1) took += ms(() => zolaAuthPasses(headers(run)));
  assert.ok(took < 250, `a 4000-character run under the bound, 200 times, took ${took.toFixed(0)} ms`);
  for (const line of [`mx.google.com; dkim=pass ${'a'.repeat(50000)}`, `mx.google.com; dkim=pass ${'a'.repeat(200000)}; dmarc=pass header.from=zola.com`,
    `mx.google.com; dkim=pass header.i=${'-'.repeat(200000)}`]) {
    const t = ms(() => assert.equal(zolaAuthPasses(headers(line)), false));
    assert.ok(t < 50, `${line.length} characters took ${t.toFixed(0)} ms`);
  }
});

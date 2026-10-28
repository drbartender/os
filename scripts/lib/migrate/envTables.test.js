'use strict';

// Suite for the env tables' port helpers (scripts/lib/migrate/envTables.js):
// both table shapes, the Required phrase, the tokens a row carries, the
// convention, the draft and the row-by-row check.

const test = require('node:test');
const assert = require('node:assert/strict');
const envt = require('./envTables');
const { parse } = require('../genDocs/env');

const EM = '\u2014';
// A phone-shaped run built from parts (the 555 fixture exchange), never a literal.
const PHONE = ['+1', '312', '555', '0142'].join('');
const MAIL = ['team', 'example.com'].join('@');

const README = [
  '# Project',
  '',
  '## Environment Variables',
  '',
  'Copy `.env.example`.',
  '',
  '| Variable | Required | Description |',
  '|---|---|---|',
  '| `PORT` | No | Server port (default: 5000) |',
  '| `DATABASE_URL` | Yes | Connection string |',
  '| `UPLOAD_KEY` | For uploads | Storage key for the `uploads/` bucket |',
  '| `HOOK_LINE` | Yes* | The line in strict E.164 (`' + PHONE + '`). *Required once the hook is live. |',
  '| `FLAG_A` / `FLAG_B` | No | Set to `false` to stop that job. Default on. |',
  '| `MODE_NAME` | Optional | Pick `a \\| b`; keeps a || bare pipe |',
  '| `BOOT_ID` | Bootstrap | Leave unset on first deploy |',
  '| `NOT_IN_FILE` | No | Missing from the template |',
  '',
  'Trailing prose.',
].join('\n');

const CLAUDE = [
  '## Environment Variables',
  '',
  '| Variable | Purpose |',
  '|---|---|',
  '| `DATABASE_URL` | Postgres connection string, read at boot |',
  '| `R2_*` | Cloudflare R2 credentials |',
  '| `SENDER_ADDRESS` | Defaults to `' + MAIL + '`. Changed 2026-10-14. |',
  '| `ZZ_*` | No such prefix |',
].join('\n');

const rows = () => [...envt.parseTable(README, 'README'), ...envt.parseTable(CLAUDE, 'CLAUDE.md')];

test('parseTable: README rows, several names in a row, escaped and bare pipes', () => {
  const r = envt.parseTable(README, 'README');
  assert.equal(r.length, 8);
  assert.deepEqual(r[4].names, ['FLAG_A', 'FLAG_B']);
  assert.equal(r[2].required, 'For uploads');
  assert.equal(r[5].description, 'Pick `a | b`; keeps a || bare pipe');
  assert.equal(r[0].line, 9);
});

test('parseTable: CLAUDE.md rows (Purpose), globs, and the missing-table errors', () => {
  const c = envt.parseTable(CLAUDE, 'CLAUDE.md');
  assert.deepEqual(c[1].globs, ['R2_*']);
  assert.equal(c[1].required, null);
  assert.equal(c[0].description, 'Postgres connection string, read at boot');
  assert.throws(() => envt.parseTable('# none', 'README'), /Environment Variables/);
  assert.throws(() => envt.parseTable('## Environment Variables\n\ntext\n\n## Next', 'README'), /no table/);
});

test('requiredPhrase and requiredWords', () => {
  assert.equal(envt.requiredPhrase('Yes'), 'Required.');
  assert.equal(envt.requiredPhrase('Yes*'), 'Required*.');
  assert.equal(envt.requiredPhrase('For uploads'), 'Required for uploads.');
  assert.equal(envt.requiredPhrase('For the Inbox read'), 'Required for the Inbox read.');
  assert.equal(envt.requiredPhrase('Bootstrap'), 'Required (bootstrap).');
  assert.equal(envt.requiredPhrase('No'), null);
  assert.equal(envt.requiredPhrase('Optional'), null);
  assert.deepEqual(envt.requiredWords('Yes*'), ['required']);
  assert.deepEqual(envt.requiredWords('For uploads'), ['required', 'for', 'uploads']);
  assert.deepEqual(envt.requiredWords('Optional'), ['optional']);
  assert.deepEqual(envt.requiredWords('No'), []);
});

test('rowTokens: code spans, numbers outside them, a date as one number', () => {
  const t = envt.rowTokens({ description: 'Default `6 hours`; cap 25 per 24h, 1.5x, at 21:00, since 2026-10-14 (`x`)' });
  assert.deepEqual(t.spans, ['6 hours', 'x']);
  assert.deepEqual(t.numbers, ['25', '24', '1.5', '21:00', '2026-10-14']);
});

const lines = (...l) => l.join('\n');
const ENV = lines(
  '# Server',
  'PORT=5000',
  'DATABASE_URL=postgres://localhost/x',
  '',
  `# Storage ${EM} uploads`,
  '# Storage key for the `uploads/` bucket',
  'UPLOAD_KEY=',
  '',
  '# ─── Jobs ───',
  '# Set to false to stop that job. Default on.',
  '# FLAG_A=true',
  '# FLAG_B=true',
  '',
  '# A long block sentence that is not a title at all, spanning the line.',
  'HOOK_LINE=',
  'MODE_NAME=a',
  'BOOT_ID=',
  'R2_ONE=',
  'R2_TWO=',
  `SENDER_ADDRESS=${MAIL}`,
  '',
);

test('toConvention: a short title over two or more variables and a rule-decorated line become headings', () => {
  const { lines: ls, eol } = require('./archRows').splitText(ENV);
  const out = envt.toConvention(ls, eol).map((l) => l.c);
  assert.deepEqual(out.slice(0, 4), ['# Server', '', 'PORT=5000', 'DATABASE_URL=postgres://localhost/x']);
  assert.deepEqual(out.slice(9, 12), ['# ─── Jobs ───', '', '# Set to false to stop that job. Default on.']);
  assert.equal(out[5], `# Storage ${EM} uploads`);
  assert.equal(out[15], '# A long block sentence that is not a title at all, spanning the line.');
});

test('draft: the existing block, the Required line, then each row labelled; nothing for No; no duplicate', () => {
  const { text, missing } = envt.draft(ENV, rows());
  assert.ok(!text.includes(EM));
  const ls = text.split('\n');
  const at = (name) => ls.findIndex((l) => l.startsWith(`${name}=`) || l.startsWith(`# ${name}=`));
  assert.deepEqual(ls.slice(at('PORT') - 5, at('DATABASE_URL') + 1), [
    '',
    '# [README] Server port (default: 5000)',
    '# Required (DATABASE_URL).',
    '# [README] Connection string',
    '# [CLAUDE.md] Postgres connection string, read at boot',
    'PORT=5000',
    'DATABASE_URL=postgres://localhost/x',
  ]);
  assert.deepEqual(ls.slice(at('UPLOAD_KEY') - 3, at('UPLOAD_KEY') + 1), ['# Storage - uploads', '# Storage key for the `uploads/` bucket', '# Required for uploads.', 'UPLOAD_KEY=']);
  assert.ok(!text.includes('[README] Storage key'), 'a row already in the block verbatim is not added');
  assert.ok(!text.includes('[README] Set to `false`'), 'the backticks aside, the row is in the shared block');
  assert.equal(ls[at('FLAG_B') - 1], '# FLAG_A=true');
  const chainAt = ls.indexOf('# A long block sentence that is not a title at all, spanning the line.');
  assert.deepEqual(ls.slice(chainAt, at('SENDER_ADDRESS') + 1), [
    '# A long block sentence that is not a title at all, spanning the line.',
    '# Required* (HOOK_LINE).',
    `# [README] The line in strict E.164 (\`${PHONE}\`). *Required once the hook is live.`,
    '# Optional (MODE_NAME).',
    '# [README] Pick `a | b`; keeps a || bare pipe',
    '# Required (bootstrap) (BOOT_ID).',
    '# [README] Leave unset on first deploy',
    '# [CLAUDE.md] Cloudflare R2 credentials',
    `# [CLAUDE.md] Defaults to \`${MAIL}\`. Changed 2026-10-14.`,
    'HOOK_LINE=',
    'MODE_NAME=a',
    'BOOT_ID=',
    'R2_ONE=',
    'R2_TWO=',
    `SENDER_ADDRESS=${MAIL}`,
  ], 'every member of a chain has its lines above the chain, the declarations adjacent');
  assert.deepEqual(missing.map((m) => m.name), ['NOT_IN_FILE', 'ZZ_*']);
  const before = ENV.split('\n').filter((l) => /^#?\s?[A-Z][A-Z0-9_]*=/.test(l));
  const after = ls.filter((l) => /^#?\s?[A-Z][A-Z0-9_]*=/.test(l));
  assert.deepEqual(after, before, 'every variable line byte-identical and in order');
});

test('draft: a long row wraps with the label on the first line only; CRLF and a BOM survive', () => {
  const long = `| \`PORT\` | No | ${'words that run on '.repeat(12)}|`;
  const readme = README.replace('| `PORT` | No | Server port (default: 5000) |', long);
  const crlf = `\ufeff${ENV.replace(/\n/g, '\r\n')}`;
  const { text } = envt.draft(crlf, [...envt.parseTable(readme, 'README'), ...envt.parseTable(CLAUDE, 'CLAUDE.md')]);
  assert.ok(text.startsWith('\ufeff# Server\r\n\r\n# [README] words'));
  assert.ok(!/[^\r]\n/.test(text.slice(1)), 'every line ends CRLF');
  const block = text.split('\r\n').filter((l) => l.startsWith('# ') && l.includes('words'));
  assert.ok(block.length > 1);
  assert.ok(block.every((l) => l.length <= 100));
  assert.equal(block.filter((l) => l.startsWith('# [README]')).length, 1);
});

test('check: a ported file passes; a missing token names the variable and the token', () => {
  const good = lines(
    '# Server port (default: 5000)',
    'PORT=5000',
    '# Required. Connection string, Postgres connection string, read at boot',
    'DATABASE_URL=x',
    '# Required for uploads. Storage key for the uploads/ bucket. Cloudflare R2.',
    'UPLOAD_KEY=',
    '# Set to false to stop that job. Default on.',
    'FLAG_A=',
    'FLAG_B=',
    '# Required once the hook is live: the 0142 line in strict E.164.',
    'HOOK_LINE=',
    '# Optional. Pick a | b; keeps a || bare pipe',
    'MODE_NAME=',
    '# Required in bootstrap mode only: leave unset on first deploy.',
    'BOOT_ID=',
    '# Cloudflare R2 credentials',
    'R2_ONE=',
    '# Defaults to the contact address. Changed 2026-10-14.',
    `SENDER_ADDRESS=${MAIL}`,
    '',
  );
  const r = rows().filter((x) => !x.names.includes('NOT_IN_FILE') && !x.globs.includes('ZZ_*'));
  assert.deepEqual(envt.check(good, r), []);
  const bad = good.replace('(default: 5000)', '(default unset)').replace('Set to false', 'Set it off').replace('# Optional. ', '# ').replace('the 0142 line', 'the line');
  assert.deepEqual(envt.check(bad, r), [
    { name: 'PORT', token: '5000' },
    { name: 'HOOK_LINE', token: PHONE },
    { name: 'FLAG_A', token: 'false' },
    { name: 'FLAG_B', token: 'false' },
    { name: 'MODE_NAME', token: 'optional' },
  ]);
});

test('check: Required words, an email only on the value line, a variable or glob the file lacks', () => {
  const env = lines('# Connection string, Postgres connection string, read at boot', 'DATABASE_URL=x', '# Changed 2026-10-14.', 'SENDER_ADDRESS=other', '');
  const r = [...envt.parseTable(README, 'README'), ...envt.parseTable(CLAUDE, 'CLAUDE.md')]
    .filter((x) => x.names.includes('DATABASE_URL') || x.names.includes('SENDER_ADDRESS') || x.globs.includes('ZZ_*'));
  assert.deepEqual(envt.check(env, r), [
    { name: 'DATABASE_URL', token: 'required' },
    { name: 'SENDER_ADDRESS', token: MAIL },
    { name: 'ZZ_*', token: 'not in .env.example' },
  ]);
});

test('check reads the block by the env generator: a heading is not a block', () => {
  const env = lines('# Server port (default: 5000)', '', 'PORT=5000', '');
  assert.equal(parse(env).sections[0].heading, 'Server port (default: 5000)');
  assert.equal(parse(env).sections[0].variables[0].description, '');
  assert.deepEqual(envt.check(env, envt.parseTable(README, 'README').filter((x) => x.names.includes('PORT'))), [{ name: 'PORT', token: '5000' }]);
});

// ---- a chain keeps its block shared (fix round 1, item 3) --------------------

const CHAIN_README = [
  '## Environment Variables',
  '',
  '| Variable | Required | Description |',
  '|---|---|---|',
  '| `KEY_ONE` | For uploads | First key |',
  '| `KEY_TWO` | Yes | Second key, rotated every 30 days |',
  '| `SOLO_TWO` | For uploads | The second of the pair |',
  '',
].join('\n');
const CHAIN_CLAUDE = ['## Environment Variables', '', '| Variable | Purpose |', '|---|---|', '| `KEY_*` | Storage keys, see `docs/keys.md` |', ''].join('\n');
const CHAIN_ENV = lines(
  '# The storage keys the uploader reads.',
  'KEY_ONE=',
  'KEY_TWO=',
  '',
  '# The pair, only the second documented.',
  'SOLO_ONE=',
  'SOLO_TWO=',
  '',
);
const chainRows = () => [...envt.parseTable(CHAIN_README, 'README'), ...envt.parseTable(CHAIN_CLAUDE, 'CLAUDE.md')];

test('draft: a chain where only the second has a row keeps both declarations adjacent, the lines above the first', () => {
  const ls = envt.draft(CHAIN_ENV, chainRows()).text.split('\n');
  const at = ls.indexOf('# The pair, only the second documented.');
  assert.deepEqual(ls.slice(at, at + 5), [
    '# The pair, only the second documented.',
    '# Required for uploads (SOLO_TWO).',
    '# [README] The second of the pair',
    'SOLO_ONE=',
    'SOLO_TWO=',
  ]);
  const keys = ls.indexOf('# The storage keys the uploader reads.');
  assert.deepEqual(ls.slice(keys, keys + 8), [
    '# The storage keys the uploader reads.',
    '# Required for uploads (KEY_ONE).',
    '# [README] First key',
    '# [CLAUDE.md] Storage keys, see `docs/keys.md`',
    '# Required (KEY_TWO).',
    '# [README] Second key, rotated every 30 days',
    'KEY_ONE=',
    'KEY_TWO=',
  ]);
});

test('check over the draft\'s own output finds no miss', () => {
  assert.deepEqual(envt.check(envt.draft(CHAIN_ENV, chainRows()).text, chainRows()), []);
  const present = rows().filter((r) => !r.names.includes('NOT_IN_FILE') && !r.globs.includes('ZZ_*'));
  assert.deepEqual(envt.check(envt.draft(ENV, rows()).text, present), []);
});

// ---- the block side reads numbers by the row side's rules (fix round 2, item 1)

const numberRows = (desc) => envt.parseTable(['## Environment Variables', '', '| Variable | Required | Description |', '|---|---|---|', `| \`RING_CAP\` | No | ${desc} |`, ''].join('\n'), 'README');

test('check: a number whose only copy sits inside a date in the block is a miss; standing alone it is found', () => {
  const r = numberRows('Max rings per day (default 30).');
  assert.deepEqual(envt.check(lines('# Max rings per day, spec 2026-09-30.', 'RING_CAP=', ''), r), [{ name: 'RING_CAP', token: '30' }]);
  assert.deepEqual(envt.check(lines('# Max rings per day (default 30), spec 2026-09-30.', 'RING_CAP=', ''), r), []);
  assert.deepEqual(envt.check(lines('# Max rings per day: 30-day window, default 30.', 'RING_CAP=', ''), r), []);
});

test('check: a decimal and a clock time in a row are found whole and never by a part', () => {
  const r = numberRows('Scale 1.5 at 21:00, then 5 more.');
  assert.deepEqual(envt.check(lines('# Scale 1.5 at 21:00, then 5 more.', 'RING_CAP=', ''), r), []);
  assert.deepEqual(envt.check(lines('# Scale 1.5.2 at 21:00:30, then 1.5 more.', 'RING_CAP=', ''), r), [
    { name: 'RING_CAP', token: '21:00' },
    { name: 'RING_CAP', token: '5' },
  ]);
  assert.deepEqual(envt.check(lines('# A range of 0-5 and 1.5 at 21:00.', 'RING_CAP=', ''), r), []);
});

// ---- a shared block's Required line names its members (fix round 2, item 2) --

const MIXED_README = [
  '## Environment Variables',
  '',
  '| Variable | Required | Description |',
  '|---|---|---|',
  '| `KEY_A` | For uploads | Account key |',
  '| `KEY_B` | For uploads | Access key |',
  '| `KEY_C` | No | Default 10000 |',
  '| `KEY_D` | Optional | Region name |',
  '| `SAME_A` | For uploads | First of the same |',
  '| `SAME_B` | For uploads | Second of the same |',
  '| `ALONE` | Yes | On its own |',
  '',
].join('\n');
const MIXED_ENV = lines(
  '# The storage keys, in one chain.',
  'KEY_A=',
  'KEY_B=',
  'KEY_C=10000',
  'KEY_D=',
  '',
  '# Two keys that share one cell.',
  'SAME_A=',
  'SAME_B=',
  '',
  '# A variable on its own.',
  'ALONE=',
  '',
);
const mixedRows = () => envt.parseTable(MIXED_README, 'README');

test('draft: a chain whose cells differ names the members each Required and Optional line covers', () => {
  const ls = envt.draft(MIXED_ENV, mixedRows()).text.split('\n');
  const at = ls.indexOf('# The storage keys, in one chain.');
  assert.deepEqual(ls.slice(at, ls.indexOf('KEY_D=') + 1), [
    '# The storage keys, in one chain.',
    '# Required for uploads (KEY_A, KEY_B).',
    '# [README] Account key',
    '# [README] Access key',
    '# [README] Default 10000',
    '# Optional (KEY_D).',
    '# [README] Region name',
    'KEY_A=',
    'KEY_B=',
    'KEY_C=10000',
    'KEY_D=',
  ]);
});

test('draft: a chain whose members share one phrase, and a single variable, get the bare line', () => {
  const text = envt.draft(MIXED_ENV, mixedRows()).text;
  assert.ok(text.includes('# Two keys that share one cell.\n# Required for uploads.\n# [README] First of the same\n# [README] Second of the same\nSAME_A=\nSAME_B='), text);
  assert.ok(text.includes('# A variable on its own.\n# Required.\n# [README] On its own\nALONE='), text);
  assert.deepEqual(envt.check(text, mixedRows()), []);
});

// ---- a backticked number is checked as a number (lane migrate-headers-split) -

test('check: a backticked 0 is a miss where the only zeros sit inside 300 and a date; standing alone it is found', () => {
  const r = numberRows('Max rings per day. `0` is treated as unset.');
  assert.deepEqual(envt.rowTokens(r[0]), { spans: ['0'], numbers: [] });
  assert.deepEqual(envt.check(lines('# Max rings per day (default 300, spec 2026-08-25); unset means the default.', 'RING_CAP=', ''), r), [{ name: 'RING_CAP', token: '0' }]);
  assert.deepEqual(envt.check(lines('# Max rings per day (default 300, spec 2026-08-25); 0 is treated as unset.', 'RING_CAP=', ''), r), []);
  assert.deepEqual(envt.check(lines('# Max rings per day (default 300); `0` is treated as unset.', 'RING_CAP=', ''), r), []);
});

test('check: a backticked 60 is a miss inside 600 and found standing alone; a backticked date is found as one token', () => {
  const r = numberRows('Gap in ms, `60` in tests, since `2026-08-25`.');
  assert.deepEqual(envt.check(lines('# Gap in ms, default 600, since 2026-08-25.', 'RING_CAP=', ''), r), [{ name: 'RING_CAP', token: '60' }]);
  assert.deepEqual(envt.check(lines('# Gap in ms, 60 in tests (spec 2026-08-25).', 'RING_CAP=', ''), r), []);
  assert.deepEqual(envt.check(lines('# Gap in ms, 60 in tests, since 08-25.', 'RING_CAP=', ''), r), [{ name: 'RING_CAP', token: '2026-08-25' }]);
});

test('check: a span holding letters and digits is still found by substring', () => {
  const r = numberRows('Size `2560x3200`, words model `gpt-5.4-mini`.');
  assert.deepEqual(envt.rowTokens(r[0]).numbers, []);
  assert.deepEqual(envt.check(lines('# Size (2560x3200; fallback 1664x2080), words model gpt-5.4-mini.', 'RING_CAP=', ''), r), []);
  assert.deepEqual(envt.check(lines('# Size 2560 by 3200, words model gpt 5.4 mini.', 'RING_CAP=', ''), r), [
    { name: 'RING_CAP', token: '2560x3200' },
    { name: 'RING_CAP', token: 'gpt-5.4-mini' },
  ]);
});

test('check over the draft of a row with backticked numbers finds no miss', () => {
  const r = numberRows('Max rings per day (default 300). `0` is treated as unset; `60` in tests; size `2560x3200`.');
  const env = lines('# Max rings per day (default 300), spec 2026-08-25.', 'RING_CAP=300', '');
  assert.deepEqual(envt.check(env, r).map((m) => m.token), ['0', '60', '2560x3200']);
  assert.deepEqual(envt.check(envt.draft(env, r).text, r), []);
});

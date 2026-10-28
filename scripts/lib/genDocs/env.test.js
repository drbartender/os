'use strict';

// Suite for the env table (scripts/lib/genDocs/env.js): the .env.example
// convention of decision 6 and the rendered tables.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, render } = require('./env');

const FILE = [
  'EARLY=1',
  '',
  '# Server',
  '',
  '# The port the app listens on.',
  'PORT=5000',
  '# Three switches that share',
  '# one block | with a pipe.',
  'ALPHA_ON=true',
  'BETA_ON=',
  '# GAMMA_ON=false',
  '',
  '# ─── Mail ───',
  '# The provider notes,',
  '# on two lines.',
  '',
  'BARE_VAR=x',
  '# Optional. A commented-out one.',
  '# LATE_VAR=42',
  '',
].join('\n');

test('parse: headings open sections; blocks sit directly above their variables', () => {
  const { sections } = parse(FILE);
  assert.deepEqual(sections.map((s) => [s.heading, s.note, s.variables.map((v) => v.name)]), [
    [null, '', ['EARLY']],
    ['Server', '', ['PORT', 'ALPHA_ON', 'BETA_ON', 'GAMMA_ON']],
    ['Mail', 'The provider notes, on two lines.', ['BARE_VAR', 'LATE_VAR']],
  ]);
  const v = Object.fromEntries(sections.flatMap((s) => s.variables).map((x) => [x.name, x]));
  assert.deepEqual(v.PORT, { name: 'PORT', default: '5000', active: true, description: 'The port the app listens on.', line: 6 });
  for (const n of ['ALPHA_ON', 'BETA_ON', 'GAMMA_ON']) assert.equal(v[n].description, 'Three switches that share one block | with a pipe.', n);
  assert.equal(v.GAMMA_ON.active, false);
  assert.equal(v.GAMMA_ON.default, null);
  assert.equal(v.BETA_ON.default, '');
  assert.equal(v.BARE_VAR.description, '');
  assert.equal(v.EARLY.description, '');
  assert.equal(v.LATE_VAR.description, 'Optional. A commented-out one.');
});

const NOTE = 'Each value is the sample .env.example carries, never the default the code uses when the variable is unset.';

test('render: a ### heading, its note, then the table; unset for a commented-out line', () => {
  assert.equal(render(parse(FILE)), [
    NOTE,
    '',
    '| Variable | Value in .env.example | Description |',
    '|---|---|---|',
    '| `EARLY` | `1` |  |',
    '',
    '### Server',
    '',
    '| Variable | Value in .env.example | Description |',
    '|---|---|---|',
    '| `PORT` | `5000` | The port the app listens on. |',
    '| `ALPHA_ON` | `true` | Three switches that share one block \\| with a pipe. |',
    '| `BETA_ON` |  | Three switches that share one block \\| with a pipe. |',
    '| `GAMMA_ON` | unset | Three switches that share one block \\| with a pipe. |',
    '',
    '### Mail',
    '',
    'The provider notes, on two lines.',
    '',
    '| Variable | Value in .env.example | Description |',
    '|---|---|---|',
    '| `BARE_VAR` | `x` |  |',
    '| `LATE_VAR` | unset | Optional. A commented-out one. |',
  ].join('\n'));
});

test('a variable with no block never fails, an empty file renders nothing, CRLF reads like LF', () => {
  assert.equal(render(parse('ONLY=1\n')), `${NOTE}\n\n| Variable | Value in .env.example | Description |\n|---|---|---|\n| \`ONLY\` | \`1\` |  |`);
  assert.equal(render(parse('')), '');
  assert.deepEqual(parse('# Heading\r\n\r\n# Block.\r\nA=1\r\n').sections.map((s) => [s.heading, s.variables[0].description]), [['Heading', 'Block.']]);
});

test('a heading with no variables still renders its heading; an em dash never survives', () => {
  const out = render(parse('# Lonely \u2014 heading\n\n'));
  assert.equal(out, '### Lonely - heading');
});

// The seven prose lines of today's .env.example that read like commented-out
// variables (lines 207, 208, 212, 218, 219, 225 and 435), in their blocks.
const PROSE = [
  '# Schedulers fire only in production.',
  '#   RUN_SCHEDULERS=true   force-on locally (testing a handler against a scratch row)',
  '#   RUN_SCHEDULERS=false  force-off on a secondary prod instance to prevent duplicate runs',
  'RUN_SCHEDULERS=',
  '',
  '# Real outbound notifications fire only when',
  '# NODE_ENV=production by default \u2014 same philosophy as RUN_SCHEDULERS \u2014 so the',
  '# dev server never burns allotments.',
  '#   SEND_NOTIFICATIONS=true   force real sends locally (e.g. a real send to a scratch row)',
  '#   SEND_NOTIFICATIONS=false  force off everywhere (e.g. a secondary prod instance)',
  'SEND_NOTIFICATIONS=',
  '',
  '# Per-scheduler disable, honored only when schedulers are running (on prod, or locally with',
  '# RUN_SCHEDULERS=true). When schedulers are globally disabled, these are ignored.',
  '# RUN_AUTOPAY_SCHEDULER=true',
  '# RUN_SEQUENCE_SCHEDULER=true',
  '',
  '# (a) The note prescribed VM_ESCALATION_ENABLED=false +',
  '#     VM_NIGHT_WINDOW=none + VM_GREETING_URL_PRIMARY=say as "the real',
  '#     three-variable revert".',
  'VM_ESCALATION_ENABLED=false',
  '# A quoted sample.',
  "# FIRST_REPLY_COOLDOWN_INTERVAL='10 minutes'",
  '',
].join('\n');

test('a commented-out variable is `#NAME=value` or `# NAME=value` and nothing after; indented or trailing prose is description', () => {
  const vars = parse(PROSE).sections.flatMap((x) => x.variables);
  assert.deepEqual(vars.map((v) => [v.name, v.active]), [
    ['RUN_SCHEDULERS', true],
    ['SEND_NOTIFICATIONS', true],
    ['RUN_AUTOPAY_SCHEDULER', false],
    ['RUN_SEQUENCE_SCHEDULER', false],
    ['VM_ESCALATION_ENABLED', true],
    ['FIRST_REPLY_COOLDOWN_INTERVAL', false],
  ]);
  assert.equal(new Set(vars.map((v) => v.name)).size, vars.length);
  const d = Object.fromEntries(vars.map((v) => [v.name, v.description]));
  assert.match(d.RUN_SCHEDULERS, /RUN_SCHEDULERS=true force-on locally .* RUN_SCHEDULERS=false force-off on a secondary/);
  assert.match(d.SEND_NOTIFICATIONS, /NODE_ENV=production by default - same philosophy .* SEND_NOTIFICATIONS=false force off everywhere/);
  assert.match(d.RUN_AUTOPAY_SCHEDULER, /RUN_SCHEDULERS=true\)\. When schedulers are globally disabled/);
  assert.match(d.VM_ESCALATION_ENABLED, /VM_NIGHT_WINDOW=none \+ VM_GREETING_URL_PRIMARY=say/);
  assert.equal(vars[5].default, null);
});

test('a name declared twice as an active line is one row, its last declaration, that says so', () => {
  const text = ['# First block.', 'DOUBLE=1', 'OTHER=2', '', '# Second block.', 'DOUBLE=3', '', '# Third.', 'TRIPLE=a', 'TRIPLE=b', 'TRIPLE=c', ''].join('\n');
  const parsed = parse(text);
  const vars = parsed.sections.flatMap((x) => x.variables);
  assert.deepEqual(vars.map((v) => v.name), ['OTHER', 'DOUBLE', 'TRIPLE']);
  const rows = render(parsed).split('\n').filter((l) => l.startsWith('| `'));
  assert.deepEqual(rows, [
    '| `OTHER` | `2` | First block. |',
    '| `DOUBLE` | `3` | Second block. (declared twice, lines 2 and 6; dotenv keeps the last) |',
    '| `TRIPLE` | `c` | Third. (declared three times, lines 9, 10 and 11; dotenv keeps the last) |',
  ]);
});

test('A=1 then A=3 renders 3, as dotenv reads it', () => {
  const rows = render(parse('# The A.\nA=1\n\n# The A again.\nA=3\n')).split('\n').filter((l) => l.startsWith('| `'));
  assert.deepEqual(rows, ['| `A` | `3` | The A again. (declared twice, lines 2 and 5; dotenv keeps the last) |']);
});

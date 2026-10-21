'use strict';

// Tests for scripts/lib/receiptVerdicts.js (instruction rewrite step 2, lane
// receipt-lib): the verdict table of a lens report, read through
// scripts/lib/receipt.js's re-export as steps 3 and 5 read it. Pure: no git,
// no disk.

const { test } = require('node:test');
const assert = require('node:assert');

const { parseVerdictTable, mergeVerdicts, coverage } = require('./receipt');

const FILES5 = ['server/a.js', 'server/b.js', 'server/c.js', 'client/src/d.js', 'scripts/e.js'];

function report(rows, { findings = [], header = '| file | verdict | note |', separator = '|---|---|---|', tail = '' } = {}) {
  const lines = ['Read the brief and the diff.', ''];
  for (const f of findings) lines.push(f);
  lines.push('', header);
  if (separator) lines.push(separator);
  for (const [file, verdict, note = ''] of rows) lines.push(`| ${file} | ${verdict} | ${note} |`);
  if (tail) lines.push(tail);
  return lines.join('\n') + '\n';
}

test('a report with no table is malformed and yields no rows', () => {
  const r = parseVerdictTable('I looked at everything and it is fine.\n- H1 `server/a.js:3` A defect. Failure path: x. Check: MON-1.\n');
  assert.strictEqual(r.malformed, true);
  assert.deepStrictEqual(r.rows, []);
  assert.strictEqual(r.findings.length, 1);
  const cov = coverage(FILES5, mergeVerdicts([r]));
  assert.deepStrictEqual(cov.not_reached, FILES5);
});

test('the separator row is skipped and every row is read', () => {
  const r = parseVerdictTable(report(FILES5.map((f) => [f, 'pass'])));
  assert.strictEqual(r.malformed, false);
  assert.deepStrictEqual(r.rows.map((x) => x.file), FILES5);
  assert.ok(r.rows.every((x) => x.verdict === 'pass' && x.note === ''));
});

test('a table without a separator row (the spec 3.5 example) still parses', () => {
  const findings = ['- H1 `server/b.js:1` One. Check: SEAM-1.', '- M2 `server/b.js:2` Two. Check: SEAM-2.'];
  const r = parseVerdictTable(report([['server/a.js', 'pass'], ['server/b.js', 'finding', 'H1, M2']], { separator: '', findings }));
  assert.strictEqual(r.malformed, false);
  assert.deepStrictEqual(r.rows.map((x) => [x.file, x.verdict, x.note]), [['server/a.js', 'pass', ''], ['server/b.js', 'finding', 'H1, M2']]);
});

test('a table missing one file yields that file as not reached', () => {
  const r = parseVerdictTable(report(FILES5.slice(0, 4).map((f) => [f, 'pass'])));
  assert.strictEqual(r.malformed, false);
  const cov = coverage(FILES5, mergeVerdicts([r]));
  assert.deepStrictEqual(cov.not_reached, ['scripts/e.js']);
  assert.deepStrictEqual(cov.files_with_verdicts, FILES5.slice(0, 4));
  assert.deepStrictEqual(cov.files_in_diff, FILES5);
});

test('a not reached row counts as not reached', () => {
  const r = parseVerdictTable(report([['server/a.js', 'pass'], ['server/b.js', 'not reached', 'budget']]));
  assert.deepStrictEqual(coverage(['server/a.js', 'server/b.js'], mergeVerdicts([r])).not_reached, ['server/b.js']);
});

test('an unknown verdict word marks the report malformed, naming the row and not the word', () => {
  const r = parseVerdictTable(report([['server/a.js', 'pass'], ['server/b.js', 'looks fine']]));
  assert.strictEqual(r.malformed, true);
  assert.deepStrictEqual(r.rows, []);
  assert.ok(r.problems.some((p) => /unknown verdict/.test(p) && /line \d+/.test(p)));
  assert.ok(r.problems.every((p) => !/looks fine/.test(p)));
});

test('a bad header is malformed', () => {
  const r = parseVerdictTable(report([['server/a.js', 'pass']], { header: '| file | result | note |' }));
  assert.strictEqual(r.malformed, true);
  assert.deepStrictEqual(r.rows, []);
});

test('a row with the wrong cell count, an empty file or a file listed twice is malformed', () => {
  assert.strictEqual(parseVerdictTable(report([['server/a.js', 'pass']]).replace('| server/a.js | pass |  |', '| server/a.js | pass |')).malformed, true);
  assert.strictEqual(parseVerdictTable(report([['', 'pass']])).malformed, true);
  assert.strictEqual(parseVerdictTable(report([['server/a.js', 'pass'], ['server/a.js', 'finding', 'H1']])).malformed, true);
});

test('the last table is the verdict table; verdict case, backticked files and CRLF are read', () => {
  const md = ['| a | b |', '|---|---|', '| x | y |', '', 'Findings above.', '', '| File | Verdict | Note |', '|:---|:---:|---:|',
    '| `server/a.js` | Pass | |', '| server/b.js | Not  Reached | budget |', '| server/c.js | ESCALATE | writes payout rows |'].join('\r\n');
  const r = parseVerdictTable(md);
  assert.strictEqual(r.malformed, false);
  assert.deepStrictEqual(r.rows.map((x) => [x.file, x.verdict]), [['server/a.js', 'pass'], ['server/b.js', 'not reached'], ['server/c.js', 'escalate']]);
});

test('a table inside a code fence is not the verdict table', () => {
  const md = report([['server/a.js', 'pass']]) + '\n```\n| file | verdict | note |\n|---|---|---|\n| server/z.js | pass | |\n```\n';
  const r = parseVerdictTable(md);
  assert.deepStrictEqual(r.rows.map((x) => x.file), ['server/a.js']);
});

test('a fence closes only on a fence of its own character at least as long as the opener', () => {
  const fake = ['| file | verdict | note |', '|---|---|---|', '| server/z.js | pass | |'];
  const wrapped = (open, inner, close) => `${report([['server/a.js', 'pass']])}\n${[open, inner, ...fake, close, ''].join('\n')}`;
  for (const [open, inner, close] of [['````md', '```', '````'], ['```', '~~~', '```'], ['~~~~', '~~~', '~~~~~']]) {
    const r = parseVerdictTable(wrapped(open, inner, close));
    assert.deepStrictEqual(r.rows.map((x) => x.file), ['server/a.js'], `${open} ${inner} ${close}`);
  }
  // A closing fence longer than the opener closes it; the table after it is read.
  const after = ['```', 'code', '`````', '', ...fake, ''].join('\n');
  assert.deepStrictEqual(parseVerdictTable(after).rows.map((x) => x.file), ['server/z.js']);
});

test('findings H1 and M2 are read with their file and line, severity, text and check', () => {
  const md = report([['server/a.js', 'finding', 'H1'], ['server/b.js', 'finding', 'M2']], {
    findings: [
      '- H1 `server/a.js:120` The total is written twice. Failure path: a retry posts again. Check: MON-3.',
      '- M2 `server/b.js:7-9` The badge reads status. Failure path: a refund leaves it paid. Check: SEAM-12.',
      '- L1 `docs/x.md` No line given. Check: DATA-1.',
    ],
  });
  const r = parseVerdictTable(md);
  assert.strictEqual(r.malformed, false);
  assert.deepStrictEqual(r.findings.map((f) => [f.id, f.severity, f.file, f.line, f.check]), [
    ['H1', 'H', 'server/a.js', 120, 'MON-3'],
    ['M2', 'M', 'server/b.js', 7, 'SEAM-12'],
    ['L1', 'L', 'docs/x.md', null, 'DATA-1'],
  ]);
  assert.match(r.findings[0].text, /^The total is written twice\. Failure path: a retry posts again\. Check: MON-3\.$/);
});

test('verify findings use Against: and need no table', () => {
  const r = parseVerdictTable('- H1 `server/a.js:5` The fix misses the second entrance. Failure path: the sweep. Against: the fix for H2, or money math.\n');
  assert.strictEqual(r.findings.length, 1);
  assert.strictEqual(r.findings[0].check, 'the fix for H2, or money math');
  assert.strictEqual(r.malformed, true);
});

test('a duplicate finding id keeps the first and is named as a problem', () => {
  const r = parseVerdictTable(report([['server/a.js', 'finding', 'H1']], { findings: ['- H1 `server/a.js:1` One. Check: MON-1.', '- H1 `server/a.js:2` Two. Check: MON-2.'] }));
  assert.strictEqual(r.findings.length, 1);
  assert.strictEqual(r.findings[0].line, 1);
  assert.ok(r.problems.some((p) => /H1/.test(p) && /twice/.test(p)));
});

test('a finding or escalate row whose note names an id no finding line carries makes the report malformed', () => {
  for (const shape of ['### H1 server/a.js:3 A defect.', '1. H1 `server/a.js:3` A defect.', '- **H1** A defect at server/a.js:3.']) {
    const r = parseVerdictTable(report([['server/a.js', 'finding', 'H1'], ['server/b.js', 'pass']], { findings: [shape] }));
    assert.strictEqual(r.malformed, true, shape);
    assert.deepStrictEqual(r.rows, [], shape);
    assert.strictEqual(r.findings.length, 0, shape);
    assert.ok(r.problems.some((p) => /line \d+: the note names H1, which no finding line carries/.test(p)), `${shape}: ${r.problems.join('; ')}`);
  }
  const esc = parseVerdictTable(report([['server/a.js', 'escalate', 'see M2']], { findings: ['- M1 `server/a.js:1` x. Check: MON-1.'] }));
  assert.strictEqual(esc.malformed, true);
  assert.ok(esc.problems.some((p) => /names M2/.test(p)));
});

test('a finding or escalate row with an empty note, or a finding row naming no id, is malformed', () => {
  const finding = ['- H1 `server/a.js:1` x. Check: MON-1.'];
  for (const rows of [[['server/a.js', 'finding', '']], [['server/a.js', 'escalate', '']], [['server/a.js', 'finding', 'see above']]]) {
    const r = parseVerdictTable(report(rows, { findings: finding }));
    assert.strictEqual(r.malformed, true, JSON.stringify(rows));
    assert.ok(r.problems.some((p) => /^line \d+: a (finding|escalate) row (with no note|whose note names no finding id)$/.test(p)), r.problems.join('; '));
  }
  const ok = parseVerdictTable(report([['server/a.js', 'finding', '**H1**'], ['server/b.js', 'escalate', 'writes payout rows']], { findings: finding }));
  assert.strictEqual(ok.malformed, false, ok.problems.join('; '));
});

test('a finding line is a bullet with the id and the backticked location right after it; anything else is prose', () => {
  const r = parseVerdictTable(report([['server/a.js', 'pass', 'fixed'], ['server/b.js', 'finding', 'M2']], {
    findings: ['- H1 from the first pass is fixed.', '- The H1 fix is now covered by `server/a.js:9`.', '* **M2** `server/b.js:4` The badge reads status. Check: SEAM-1.'],
  }));
  assert.strictEqual(r.malformed, false, r.problems.join('; '));
  assert.deepStrictEqual(r.findings.map((f) => [f.id, f.file, f.line]), [['M2', 'server/b.js', 4]]);
});

test('ids are uppercase whole-word tokens: lowercase and run-on words are prose, an id opening a line beside a backticked path is malformed', () => {
  const finding = ['- H1 `server/a.js:1` x. Check: MON-1.'];
  // Notes: "the h1 heading" and "M2's" are not ids; an uppercase token is, and must exist.
  for (const note of ['see the h1 heading', "after M2's rejection", 'H1, fixed', '(H1)', '**H1**', 'H1: fixed']) {
    const r = parseVerdictTable(report([['server/a.js', 'pass', note]], { findings: finding }));
    assert.strictEqual(r.malformed, false, `${note}: ${r.problems.join('; ')}`);
  }
  for (const [note, id] of [['H1, M2', 'M2'], ['see M3.', 'M3'], ['the H2 driver', 'H2'], ['[L4]', 'L4']]) {
    const r = parseVerdictTable(report([['server/a.js', 'pass', note]], { findings: finding }));
    assert.ok(r.malformed && r.problems.some((p) => p.endsWith(`the note names ${id}, which no finding line carries`)), `${note}: ${r.problems.join('; ')}`);
  }
  // Prose: an id that does not open the line is never a finding and never malformed.
  for (const line of ['- the H2 driver writes `server/a.js`.', '- the h1 heading in `client/src/x.js` is missing.', 'Read `server/a.js:3`; H1 holds.', '- h1 heading tag in `client/src/x.js`.']) {
    const v = parseVerdictTable(`No findings.\n\n${line}\n`, { findingsOnly: true });
    assert.deepStrictEqual([v.malformed, v.findings.length], [false, 0], `${line}: ${v.problems.join('; ')}`);
  }
  // An id opening the line after a bullet, number, heading mark, quote or bold, beside a backticked path: malformed.
  for (const line of ['- H1 is now covered by `server/a.js:9`.', '> H1 was fixed in `server/a.js`.', '**H1** was fixed in `server/a.js`.', '1. H1 fixed `server/a.js`.', '### H1 fixed in `server/a.js`.', '- [M2] holds; see `server/b.js`.']) {
    const v = parseVerdictTable(`Verified.\n\n${line}\n`, { findingsOnly: true });
    assert.strictEqual(v.malformed, true, line);
    assert.ok(v.problems.includes('line 3: a finding not in bullet form'), `${line}: ${v.problems.join('; ')}`);
  }
  // A lowercase id in a finding's own shape is no id, and no finding escapes through it: malformed.
  for (const line of ['- h1 `server/a.js:3` A defect.', 'm2 `server/a.js:3` A defect.', '| l1 | `server/a.js:3` | x |']) {
    const v = parseVerdictTable(`Verified.\n\n${line}\n`, { findingsOnly: true });
    assert.deepStrictEqual([v.malformed, v.findings.length], [true, 0], line);
    assert.ok(v.problems.includes('line 3: a finding id in lowercase (ids are uppercase: H1, M2, L3)'), `${line}: ${v.problems.join('; ')}`);
  }
  // A closing ATX sequence on a lens heading is still the heading.
  const closed = parseVerdictTable(COLLAPSED.replace('## Lens: seams', '## Lens: seams ##'), { lens: 'seams' });
  assert.strictEqual(closed.malformed, false, closed.problems.join('; '));
});

test("verify's no-findings record is the line No findings alone; the checked list after it is neither a finding nor malformed", () => {
  for (const md of ['No findings.\n', 'No findings\n', '  No findings.  \n', 'No findings.\nChecked the fixes: H1 in `server/a.js`, M2 in `server/b.js`.\n',
    'Verified the fixes.\n\nNo findings.\n\n- Checked H1 at `server/a.js:12`: the refund label survives.\n- Re-read M2 in `server/b.js`; it holds.\n']) {
    const v = parseVerdictTable(md, { findingsOnly: true });
    assert.deepStrictEqual([v.malformed, v.findings.length, v.problems], [false, 0, []], JSON.stringify(md));
  }
});

// The reviewer forms review 5 found storing as 0 findings (M2): a record
// sentence that goes on to name a finding with its location, and a record
// followed by a line that opens with Finding and an id.
test('a record that goes on, or a Finding <id> line after it, is a finding or malformed, never 0 findings (review 5, M2)', () => {
  const sentence = parseVerdictTable('No findings on the fixes, but M1 `server/a.js:1` drops the refund label.\n', { findingsOnly: true });
  assert.deepStrictEqual([sentence.malformed, sentence.findings.length], [true, 0]);
  assert.ok(sentence.problems.includes(NO_EVIDENCE), sentence.problems.join('; '));
  for (const line of ['Finding H1 at `server/a.js:3`: drops a cent.', 'Finding H1 at server/a.js line 3: drops a cent.', '- Finding: H1 drops a cent.', '### Finding H1', '**Finding H1** drops a cent in `server/a.js`.', 'finding H1 drops a cent.', 'Findings: H1 drops a cent.']) {
    for (const md of [`No findings.\n\n${line}\n`, `No findings.\n${line}\n`, `- M9 \`server/b.js:1\` Another defect. Against: money math.\n${line}\n`]) {
      const v = parseVerdictTable(md, { findingsOnly: true });
      assert.strictEqual(v.malformed, true, JSON.stringify(md));
      assert.ok(v.problems.some((p) => /^line \d+: a line that opens with Finding and an id, which no finding form reads$/.test(p)), `${JSON.stringify(md)}: ${v.problems.join('; ')}`);
    }
  }
  // A checked line names the id mid-line, the word finding included.
  assert.strictEqual(parseVerdictTable('No findings.\nRe-checked finding H1 at `server/a.js:3`: the fix holds.\n', { findingsOnly: true }).malformed, false);
});

test('an id parsed twice makes the report malformed', () => {
  const r = parseVerdictTable(report([['server/a.js', 'finding', 'H1']], { findings: ['- H1 `server/a.js:1` One. Check: MON-1.', '- H1 `server/a.js:2` Two. Check: MON-2.'] }));
  assert.strictEqual(r.malformed, true);
  assert.deepStrictEqual(r.rows, []);
});

test('a findings-only report (verify) needs no table; an id parsed twice makes it malformed', () => {
  const one = parseVerdictTable('- H1 `server/a.js:5` The fix misses a path. Against: H2.\n', { findingsOnly: true });
  assert.strictEqual(one.malformed, false, one.problems.join('; '));
  assert.strictEqual(one.findings.length, 1);
  const twice = parseVerdictTable('- H1 `server/a.js:5` One. Against: x.\n- H1 `server/a.js:6` Two. Against: y.\n', { findingsOnly: true });
  assert.strictEqual(twice.malformed, true);
  assert.ok(twice.problems.some((p) => /H1 listed twice/.test(p)));
});

test('a re-pass report that covers two of five files flips only those two', () => {
  const raised = ['- H1 `server/a.js:1` One. Check: MON-1.', '- H2 `server/b.js:1` Two. Check: MON-2.'];
  const first = { name: 'money.md', ...parseVerdictTable(report(FILES5.map((f, i) => [f, i < 2 ? 'finding' : 'pass', i < 2 ? `H${i + 1}` : '']), { findings: raised })) };
  assert.strictEqual(first.malformed, false);
  const repass = { name: 'money.pass-1.md', ...parseVerdictTable(report([[FILES5[0], 'pass'], [FILES5[1], 'pass']])) };
  const before = mergeVerdicts([first]);
  const after = mergeVerdicts([first, repass]);
  for (const f of FILES5) {
    if (f === FILES5[0] || f === FILES5[1]) {
      assert.strictEqual(before[f].verdict, 'finding');
      assert.strictEqual(after[f].verdict, 'pass');
      assert.strictEqual(after[f].report, 'money.pass-1.md');
    } else {
      assert.deepStrictEqual(after[f], before[f]);
    }
  }
});

test('a malformed re-pass changes nothing it did not read', () => {
  const first = { name: 'seams.md', ...parseVerdictTable(report(FILES5.map((f) => [f, 'pass']))) };
  const broken = { name: 'seams.pass-1.md', ...parseVerdictTable('no table here\n') };
  assert.deepStrictEqual(mergeVerdicts([first, broken]), mergeVerdicts([first]));
});

test('receipt.js re-exports this module, so steps 3 and 5 read the parser the skill wrote with', () => {
  const R = require('./receipt');
  const V = require('./receiptVerdicts');
  for (const k of ['parseVerdictTable', 'lensHeadings', 'mergeVerdicts', 'coverage', 'VERDICTS']) assert.strictEqual(R[k], V[k], k);
  // lensSections served only the tests (review 3, L7): lensHeadings carries the sections.
  assert.deepStrictEqual([R.lensSections, V.lensSections], [undefined, undefined]);
});

// A collapsed one-agent report (spec 3.3's collapse rule): one section per
// lens, each with that lens's findings and table.
const COLLAPSED = [
  'Read the brief and both checklists.',
  '',
  '## Lens: money',
  '',
  '- H1 `server/a.js:3` The total is written twice. Failure path: a retry posts again. Check: MON-3.',
  '',
  '| file | verdict | note |',
  '|---|---|---|',
  '| server/a.js | finding | H1 |',
  '| server/b.js | pass | |',
  '',
  '## Lens: seams',
  '',
  '| file | verdict | note |',
  '|---|---|---|',
  '| server/a.js | pass | |',
  '| server/b.js | not reached | budget |',
  '',
].join('\n');

test('a collapsed report is read one lens section at a time', () => {
  const { lensHeadings } = require('./receipt');
  assert.deepStrictEqual(lensHeadings(COLLAPSED).sections, [{ name: 'money', line: 3 }, { name: 'seams', line: 12 }]);
  const money = parseVerdictTable(COLLAPSED, { lens: 'money' });
  assert.strictEqual(money.malformed, false, money.problems.join('; '));
  assert.deepStrictEqual(money.rows.map((r) => [r.file, r.verdict]), [['server/a.js', 'finding'], ['server/b.js', 'pass']]);
  assert.deepStrictEqual(money.findings.map((f) => [f.id, f.line]), [['H1', 3]]);
  const seams = parseVerdictTable(COLLAPSED, { lens: 'seams' });
  assert.strictEqual(seams.malformed, false, seams.problems.join('; '));
  assert.deepStrictEqual(seams.rows.map((r) => [r.file, r.verdict]), [['server/a.js', 'pass'], ['server/b.js', 'not reached']]);
  assert.deepStrictEqual(seams.findings, []);
  // A report without sections ignores the lens option.
  assert.strictEqual(parseVerdictTable(report([['server/a.js', 'pass']]), { lens: 'money' }).malformed, false);
});

test('a collapsed report is malformed read without a lens, for a lens it has no section for, with a section twice, or with a finding outside every section', () => {
  const bad = (md, opts, re) => {
    const r = parseVerdictTable(md, opts);
    assert.strictEqual(r.malformed, true, re.source);
    assert.deepStrictEqual(r.rows, []);
    assert.ok(r.problems.some((p) => re.test(p)), `${re}: ${r.problems.join('; ')}`);
  };
  bad(COLLAPSED, {}, /read one lens at a time/);
  bad(COLLAPSED, { lens: 'client' }, /no ## Lens: client section/);
  bad(`${COLLAPSED}\n## Lens: money\n\n| file | verdict | note |\n| server/a.js | pass | |\n`, { lens: 'money' }, /line 19: a second ## Lens: section for one lens/);
  bad(`- M1 \`server/b.js:1\` Loose. Check: SEAM-1.\n\n${COLLAPSED}`, { lens: 'seams' }, /line 1: a finding outside any ## Lens: section/);
  // A heading inside a fence is not a section.
  const fenced = `${report([['server/a.js', 'pass']])}\n\`\`\`\n## Lens: money\n\`\`\`\n`;
  assert.strictEqual(parseVerdictTable(fenced).malformed, false);
});

test('in a collapsed report any heading ends a section: a trailing table is never read for a lens', () => {
  // seams's own table says not reached; a trailing table says pass.
  const trailing = `${COLLAPSED}\n## Overall\n\n| file | verdict | note |\n|---|---|---|\n| server/a.js | pass | |\n| server/b.js | pass | |\n`;
  const seams = parseVerdictTable(trailing, { lens: 'seams' });
  assert.strictEqual(seams.malformed, false, seams.problems.join('; '));
  assert.deepStrictEqual(seams.rows.map((r) => [r.file, r.verdict]), [['server/a.js', 'pass'], ['server/b.js', 'not reached']]);
  // A finding under a heading that is no lens's is outside every section.
  const notes = `${COLLAPSED}\n## Notes\n\n- M4 \`server/b.js:2\` x. Check: SEAM-1.\n`;
  const r = parseVerdictTable(notes, { lens: 'money' });
  assert.strictEqual(r.malformed, true);
  assert.ok(r.problems.some((p) => /^line 21: a finding outside any ## Lens: section$/.test(p)), r.problems.join('; '));
  // A sub-heading ends the section too, so the table under it is outside.
  const sub = parseVerdictTable(COLLAPSED.replace('## Lens: seams\n', '## Lens: seams\n\n### Verdicts\n'), { lens: 'seams' });
  assert.strictEqual(sub.malformed, true);
  assert.ok(sub.problems.some((p) => /no verdict table/.test(p)), sub.problems.join('; '));
});

test('a heading that names a lens but is not ## Lens: <known lens>, or a section with two tables, makes a collapsed report malformed', () => {
  for (const h of ['## Lens access-egress', '### Lens: money', '## Lens: seams (re-pass)', '## Lens: seems', '## lens notes', '# LENS: seams', '## Lens: money money', '## Lenses: seams']) {
    for (const lens of ['money', 'seams']) {
      const r = parseVerdictTable(COLLAPSED.replace('## Lens: seams', h), { lens });
      assert.strictEqual(r.malformed, true, `${h} (${lens})`);
      assert.deepStrictEqual(r.rows, []);
      assert.ok(r.problems.some((p) => p === 'line 12: a heading names a lens but is not ## Lens: <one of the nine lenses>'), `${h}: ${r.problems.join('; ')}`);
    }
  }
  const { lensHeadings } = require('./receipt');
  assert.deepStrictEqual(lensHeadings(COLLAPSED.replace('## Lens: seams', '## Lens seams')), {
    sectioned: true, sections: [{ name: 'money', line: 3 }], problems: ['line 12: a heading names a lens but is not ## Lens: <one of the nine lenses>'],
  });
  const two = COLLAPSED.replace('## Lens: seams\n', '## Lens: seams\n\n| file | verdict | note |\n|---|---|---|\n| server/a.js | pass | |\n\n');
  const r = parseVerdictTable(two, { lens: 'seams' });
  assert.strictEqual(r.malformed, true);
  assert.ok(r.problems.some((p) => /^line 19: a second table in the ## Lens: seams section$/.test(p)), r.problems.join('; '));
  // A verify report is read whole, findings only, whatever headings it carries.
  const v = parseVerdictTable(COLLAPSED, { findingsOnly: true });
  assert.deepStrictEqual([v.malformed, v.findings.map((f) => f.id)], [false, ['H1']]);
});

test('any row whose note names an id no finding line carries is malformed, a pass row too', () => {
  for (const [verdict, note] of [['pass', 'H1 fixed'], ['pass', 'see M3'], ['not reached', 'budget; L2 unchecked']]) {
    const r = parseVerdictTable(report([['server/a.js', verdict, note]], { findings: ['### H1 `server/a.js:3` A defect in heading form.'] }));
    assert.strictEqual(r.malformed, true, `${verdict} ${note}`);
    assert.deepStrictEqual(r.rows, []);
    assert.ok(r.problems.some((p) => /^line \d+: the note names [HML]\d+, which no finding line carries$/.test(p)), r.problems.join('; '));
  }
});

test('a finding row whose note names its id only in lowercase names no id', () => {
  const lower = parseVerdictTable(report([['server/a.js', 'finding', 'h1']], { findings: ['- H1 `server/a.js:1` x. Check: MON-1.'] }));
  assert.ok(lower.malformed && lower.problems.some((p) => /a finding row whose note names no finding id/.test(p)), lower.problems.join('; '));
  const missing = parseVerdictTable(report([['server/a.js', 'escalate', 'see M2']], { findings: ['- H1 `server/a.js:1` x. Check: MON-1.'] }));
  assert.ok(missing.malformed && missing.problems.some((p) => /names M2, which no finding line carries/.test(p)), missing.problems.join('; '));
});

// Every form a finding comes back in (review 3, M4), the em dash written as an
// escape; each is read as a finding, so it needs triage.
const FORMS = [
  '- **H1:** `server/a.js:3` A defect. Check: MON-1.',
  '- **H1**: `server/a.js:3` A defect.',
  '- [H1] `server/a.js:3` A defect.',
  '+ H1 `server/a.js:3` A defect.',
  '> - H1 `server/a.js:3` A defect.',
  '- H1 (high) `server/a.js:3` A defect.',
  '- H1 \u2014 `server/a.js:3` A defect.',
  '- H1: `server/a.js:3` A defect.',
  'H1 `server/a.js:3` A defect.',
  '**H1** `server/a.js:3` A defect.',
  '- `server/a.js:3` H1 A defect.',
  '| H1 | `server/a.js:3` | A defect |',
];

test('every finding form is read as a finding, in a lens report and in verify', () => {
  for (const line of FORMS) {
    const v = parseVerdictTable(`Verified the fixes.\n\n${line}\n`, { findingsOnly: true });
    assert.strictEqual(v.malformed, false, `${line}: ${v.problems.join('; ')}`);
    assert.deepStrictEqual(v.findings.map((f) => [f.id, f.file, f.line]), [['H1', 'server/a.js', 3]], line);
    const lens = parseVerdictTable(report([['server/a.js', 'finding', 'H1']], { findings: [line, ''] }));
    assert.strictEqual(lens.malformed, false, `lens report: ${line}: ${lens.problems.join('; ')}`);
    assert.deepStrictEqual(lens.findings.map((f) => f.id), ['H1'], line);
  }
  // A findings table row with an id and no backticked location does not parse: malformed.
  const noLoc = parseVerdictTable('| id | severity | text |\n|---|---|---|\n| H1 | high | A defect |\n', { findingsOnly: true });
  assert.strictEqual(noLoc.malformed, true);
  assert.ok(noLoc.problems.some((p) => p === 'line 3: a finding not in bullet form'), noLoc.problems.join('; '));
});

test('a line that starts with a heading mark, a number or bold and holds an id and a backticked location is a finding not in bullet form', () => {
  for (const line of ['### H1 `server/a.js:3` A defect.', '1. H1 `server/a.js:3` A defect.', '12) M4 `server/a.js:3` A defect.', '#H2 `server/a.js:3` A defect.']) {
    const v = parseVerdictTable(`Verified the fix.\n\n${line}\n`, { findingsOnly: true });
    assert.strictEqual(v.malformed, true, line);
    assert.ok(v.problems.some((p) => p === 'line 3: a finding not in bullet form'), `${line}: ${v.problems.join('; ')}`);
    const lens = parseVerdictTable(report([['server/a.js', 'pass']], { findings: [line] }));
    assert.strictEqual(lens.malformed, true, `lens report: ${line}`);
  }
  // In a collapsed report a heading-form finding is itself a heading; it is caught too, after a table or outside every section.
  for (const [md, n] of [[`${COLLAPSED}\n### H3 \`server/a.js:9\` x.\n`, 19], [`${COLLAPSED}\n## Notes\n\n1. M4 \`server/b.js:2\` y.\n`, 21]]) {
    const r = parseVerdictTable(md, { lens: 'money' });
    assert.strictEqual(r.malformed, true);
    assert.ok(r.problems.some((p) => p === `line ${n}: a finding not in bullet form`), r.problems.join('; '));
  }
  for (const line of ['### H1 was fixed in the second pass.', '1. Read `server/a.js:3` first.', '**Note** `server/a.js` is long.', '## Lens: money']) {
    assert.strictEqual(parseVerdictTable(`No findings.\n\n${line}\n`, { findingsOnly: true }).malformed, false, line);
  }
});

// Verify's findings-only reading needs positive evidence (review 4, M3): a
// parsed finding, or a line that opens with No findings, outside every fence.
const NO_EVIDENCE = 'verify must raise a finding or record No findings (the line No findings alone, outside any fence)';

test('a verify report with no finding and no No findings record outside a fence is malformed', () => {
  for (const md of ['', 'Verified the fixes; all hold.\n', '- No findings.\n', '> No findings.\n', 'I report no findings.\n', '| No findings |\n', 'No findings. Checked the fixes.\n', 'No findings; all hold.\n', '**No findings.**\n']) {
    const v = parseVerdictTable(md, { findingsOnly: true });
    assert.deepStrictEqual([v.malformed, v.findings.length], [true, 0], JSON.stringify(md));
    assert.ok(v.problems.includes(NO_EVIDENCE), `${JSON.stringify(md)}: ${v.problems.join('; ')}`);
  }
  // A finding inside a fence of any kind, closed or not, is outside the report.
  const f = '- H1 `server/a.js:3` The fix misses a path. Against: H2.';
  for (const md of [`\`\`\`\n${f}\n\`\`\`\n`, `~~~\n${f}\n~~~\n`, `\`\`\`\`md\n${f}\n\`\`\`\`\n`, `\`\`\`\n${f}\n`, `~~~~\n${f}\n~~~\n`, `Verified.\n~~~\n${f}\nNo findings.\n`]) {
    const v = parseVerdictTable(md, { findingsOnly: true });
    assert.deepStrictEqual([v.malformed, v.findings.length], [true, 0], JSON.stringify(md));
    assert.ok(v.problems.includes(NO_EVIDENCE), `${JSON.stringify(md)}: ${v.problems.join('; ')}`);
  }
  // The record, or a finding, outside the fences stands.
  const record = 'No findings.\nChecked the fixes: H1 in `server/a.js`, M2 in `server/b.js`.';
  for (const md of [`${record}\n`, `Verified.\n\n${record}\n`, `\`\`\`\nquoted\n\`\`\`\n${record}\n`, `${f}\n`]) {
    assert.strictEqual(parseVerdictTable(md, { findingsOnly: true }).malformed, false, JSON.stringify(md));
  }
  // A lens report is not read this way: its table is the evidence.
  assert.strictEqual(parseVerdictTable(report([['server/a.js', 'pass']])).malformed, false);
});

// The forms review 4 found storing as 0 findings (M3), as verify writes them,
// with Against:; each beside the record line, which does not excuse it.
const ESCAPED = [
  ['| H1, H2 | `server/a.js:3` | The fix misses a path. Against: H2. |', 'line 3: a findings table row whose first cell is not exactly one id'],
  ['| Finding H1 | `server/a.js:3` | The fix misses a path. |', 'line 3: a findings table row whose first cell is not exactly one id'],
  ['- **H1** server/a.js:3 The fix misses a path. Against: H2.', 'line 3: Against: beside an id or a backticked location on a line that is no finding'],
  ['- (H1) `server/a.js:3` The fix misses a path. Against: H2.', 'line 3: Against: beside an id or a backticked location on a line that is no finding'],
  ['- Finding H1: `server/a.js:3` The fix misses a path. Against: H2.', 'line 3: Against: beside an id or a backticked location on a line that is no finding'],
  ['### Finding H1: `server/a.js:3` The fix misses a path. Against: H2.', 'line 3: Against: beside an id or a backticked location on a line that is no finding'],
  ['- [ ] H1 `server/a.js:3` The fix misses a path. Against: H2.', 'line 3: Against: beside an id or a backticked location on a line that is no finding'],
  ['- High H1 `server/a.js:3` The fix misses a path. Against: H2.', 'line 3: Against: beside an id or a backticked location on a line that is no finding'],
  ['<!-- - H1 `server/a.js:3` The fix misses a path. Against: H2. -->', 'line 3: Against: beside an id or a backticked location on a line that is no finding'],
];

test("verify's escaped forms are malformed: Against: beside an id or a location on a line that is no finding, a findings cell that is not exactly one id", () => {
  for (const [line, why] of ESCAPED) {
    for (const head of ['No findings.', '- M9 `server/b.js:1` Another defect. Against: money math.']) {
      const v = parseVerdictTable(`${head}\n\n${line}\n`, { findingsOnly: true });
      assert.strictEqual(v.malformed, true, `${line} (after ${head})`);
      assert.ok(v.problems.includes(why), `${line}: ${v.problems.join('; ')}`);
    }
    // Alone, it is no evidence either.
    const alone = parseVerdictTable(`${line}\n`, { findingsOnly: true });
    assert.strictEqual(alone.malformed, true, line);
  }
  // A bullet that names an id mid-line with no Against: is still prose beside a record (review 5, M2: a heading or a
  // line that opens with Finding and an id is not).
  assert.strictEqual(parseVerdictTable('No findings.\n\n- The H1 fix holds.\n', { findingsOnly: true }).malformed, false);
  assert.strictEqual(parseVerdictTable('No findings.\n\n### Finding H1\n', { findingsOnly: true }).malformed, true);
  // A finding over two lines beside the record: its Against: line holds the location, so it is malformed too.
  const twoLines = parseVerdictTable('No findings.\n\n### Finding H1\n`server/a.js:3` The fix misses a path. Against: money math.\n', { findingsOnly: true });
  assert.ok(twoLines.malformed && twoLines.problems.includes('line 4: Against: beside an id or a backticked location on a line that is no finding'), twoLines.problems.join('; '));
  // The checked list after the record names ids and paths and is no finding; with no Against: it stands.
  assert.strictEqual(parseVerdictTable('No findings.\nChecked the fixes: H1 in `server/a.js`, against the spec.\n', { findingsOnly: true }).malformed, false);
  for (const against of ['money math', 'H2']) {
    const v = parseVerdictTable(`### Finding H1\n\`server/a.js:3\` The fix misses a path. Against: ${against}.\n`, { findingsOnly: true });
    assert.ok(v.problems.includes('line 2: Against: beside an id or a backticked location on a line that is no finding'), v.problems.join('; '));
  }
  // Every finding form still reads as a finding; a cell holding exactly one id is one.
  for (const line of [...FORMS, '| **H1** (high) | `server/a.js:3` | A defect. Against: H2. |']) {
    const v = parseVerdictTable(`${line}\n`, { findingsOnly: true });
    assert.deepStrictEqual([v.malformed, v.findings.map((x) => x.id)], [false, ['H1']], `${line}: ${v.problems.join('; ')}`);
  }
});

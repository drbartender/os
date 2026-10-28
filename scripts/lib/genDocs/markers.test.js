'use strict';

// Suite for the generated-section markers (scripts/lib/genDocs/markers.js):
// replacing a body, a missing and a doubled marker as reported problems, the
// prose outside left alone, and the one-line text rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('./markers');

const doc = (...lines) => lines.join('\n');
const DOC = doc('# Title', '', 'Prose above.', '', '<!-- gen:tree -->', 'old body', '<!-- /gen:tree -->', '', 'Prose below.', '');

test('replaceSection writes the notice, a blank, the body and a blank between the markers', () => {
  const r = m.replaceSection(DOC, 'tree', 'line one\nline two', 'README.md');
  assert.equal(r.problem, null);
  assert.equal(r.changed, true);
  assert.equal(r.text, doc('# Title', '', 'Prose above.', '', '<!-- gen:tree -->', m.NOTICE, '', 'line one', 'line two', '', '<!-- /gen:tree -->', '', 'Prose below.', ''));
  assert.equal(m.readSection(r.text, 'tree'), m.expectedBody('line one\nline two'));
  const again = m.replaceSection(r.text, 'tree', 'line one\nline two', 'README.md');
  assert.equal(again.changed, false);
  assert.equal(again.text, r.text);
});

test('the prose outside the markers is untouched, byte for byte', () => {
  const r = m.replaceSection(DOC, 'tree', 'anything', 'README.md');
  const [before] = DOC.split('<!-- gen:tree -->');
  const after = DOC.split('<!-- /gen:tree -->')[1];
  assert.ok(r.text.startsWith(`${before}<!-- gen:tree -->`));
  assert.ok(r.text.endsWith(`<!-- /gen:tree -->${after}`));
});

test('a missing marker is a reported problem naming the file and section; the text is unchanged', () => {
  const noClose = DOC.replace('<!-- /gen:tree -->', '');
  for (const [text, name] of [[DOC, 'routes'], [noClose, 'tree']]) {
    const r = m.replaceSection(text, name, 'body', 'README.md');
    assert.equal(r.problem, `README.md gen:${name} missing`);
    assert.equal(r.text, text);
    assert.equal(r.changed, false);
    assert.equal(m.readSection(text, name), null);
  }
});

test('a doubled marker is a reported problem', () => {
  const twice = `${DOC}<!-- gen:tree -->\n<!-- /gen:tree -->\n`;
  const r = m.replaceSection(twice, 'tree', 'body', 'README.md');
  assert.equal(r.problem, 'README.md gen:tree doubled');
  assert.equal(r.text, twice);
  assert.equal(m.locate(twice, 'tree').problem, 'doubled');
});

test('a close marker before its open marker is out of order', () => {
  const swapped = doc('<!-- /gen:env -->', '<!-- gen:env -->');
  assert.equal(m.replaceSection(swapped, 'env', 'x', 'README.md').problem, 'README.md gen:env out of order');
});

test('a marker inside a sentence is not a marker', () => {
  const t = doc('Run it: the `<!-- gen:tree -->` line opens the section.', '');
  assert.equal(m.locate(t, 'tree').problem, 'missing');
});

test('CRLF documents keep CRLF between the markers', () => {
  const t = '# T\r\n<!-- gen:env -->\r\nold\r\n<!-- /gen:env -->\r\n';
  const r = m.replaceSection(t, 'env', 'a\nb');
  assert.equal(r.text, `# T\r\n<!-- gen:env -->\r\n${m.NOTICE}\r\n\r\na\r\nb\r\n\r\n<!-- /gen:env -->\r\n`);
  assert.equal(m.readSection(r.text, 'env'), m.expectedBody('a\nb'));
});

test('blankSection empties the body, so two docs that differ only inside compare equal', () => {
  const a = m.replaceSection(DOC, 'tree', 'one', 'README.md').text;
  const b = m.replaceSection(DOC, 'tree', 'two', 'README.md').text;
  assert.equal(m.blankSection(a, 'tree'), m.blankSection(b, 'tree'));
  assert.notEqual(m.blankSection(a, 'tree'), m.blankSection(a.replace('Prose below.', 'Edited.'), 'tree'));
  assert.equal(m.blankSection(DOC, 'routes'), null);
});

test('the six names and their files are fixed', () => {
  assert.deepEqual(m.DOC_SECTIONS, { 'README.md': ['tree', 'scripts', 'env'], 'ARCHITECTURE.md': ['routes', 'schema', 'agents'] });
  assert.equal(m.openMarker('schema'), '<!-- gen:schema -->');
  assert.equal(m.closeMarker('schema'), '<!-- /gen:schema -->');
});

test('the text rules: no em dash, one line, pipes escaped in a cell, code spans', () => {
  assert.equal(m.plain('a \u2014 b\u2014c\n  d'), 'a - b - c d');
  assert.equal(m.cell('x | y'), 'x \\| y');
  assert.equal(m.code('a|b'), '`a\\|b`');
  assert.equal(m.code('has ` tick'), '`` has ` tick ``');
  assert.ok(!m.code('a \u2014 b').includes('\u2014'));
});

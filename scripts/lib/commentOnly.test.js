'use strict';

// Tests for scripts/lib/commentOnly.js's compareFile (instruction rewrite
// step 4, lane comment-proof, the plan's acceptance check 1): for each of
// .js, .jsx, .mjs and .cjs the comment edits that pass and the code edits that
// must not, then the line rule for .sh, .sql and .env.example, and the file
// types the proof refuses. proveDiff runs in scripts/comment-only-proof.test.js
// against throwaway repos. Pure text in, nothing on disk.

const { test } = require('node:test');
const assert = require('node:assert');

const { compareFile } = require('./commentOnly');

// One base text per extension: a directive, a string, a template, a regex, a
// number, a line comment, a block comment, and for .js and .jsx (the client's
// .js files hold JSX) an element with an attribute and a text node.
function base(ext) {
  const jsx = ext === '.js' || ext === '.jsx';
  return [
    "'use strict';",
    '',
    "const name = 'item';",
    'const note = `id ${name}`;',
    'const re = /a+b/g;',
    'const n = 1;',
    ...(jsx ? ['const view = <div className="item">Hello {name}</div>;'] : []),
    'function auth(x) {',
    '  return x + n; // why',
    '}',
    '/* block',
    '   note */',
    ext === '.mjs' ? 'export { auth, re, note };' : `module.exports = { auth, re, note${jsx ? ', view' : ''} };`,
    '',
  ].join('\n');
}

const JS_EXTS = ['.js', '.jsx', '.mjs', '.cjs'];

// Each edit maps the base text to the new text; the replaced span must exist.
function edit(text, from, to) {
  assert.ok(text.includes(from), `the base has no ${JSON.stringify(from)}`);
  return text.replace(from, to);
}

const COMMENT_EDITS = {
  'a header added': (t) => edit(t, "'use strict';\n", "'use strict';\n\n// The header: what this file does,\n// in two lines.\n"),
  'a header before the directive': (t) => `// The header.\n\n${t}`,
  'a block comment added mid-file': (t) => edit(t, 'function auth', '/*\n * A block comment.\n */\nfunction auth'),
  'a trailing comment added': (t) => edit(t, 'const n = 1;', 'const n = 1; // one'),
  'a comment removed': (t) => edit(t, '  return x + n; // why', '  return x + n;'),
  'a comment reworded': (t) => edit(t, '/* block\n   note */', '/* the block, reworded\n   over two lines */'),
  'a comment line appended with no final newline before it': (t) => `${t.trimEnd()}\n// the end`,
};

const CODE_EDITS = {
  'a changed string literal': [(t) => edit(t, "'item'", "'items'"), /^code changed/],
  'a // added inside a string': [(t) => edit(t, "'item'", "'item // x'"), /^code changed/],
  'a regex literal changed': [(t) => edit(t, '/a+b/g', '/a+b/gi'), /^code changed/],
  'a template literal changed': [(t) => edit(t, '`id ${name}`', '`id: ${name}`'), /^code changed/],
  'a numeric literal respelled': [(t) => edit(t, 'const n = 1;', 'const n = 1.0;'), /^code changed/],
  'a block comment closed early with a statement after it': [(t) => edit(t, '/* block\n   note */', '/* block */ auth(0);\n/* note */'), /^code changed/],
  "a removed 'use strict'": [(t) => edit(t, "'use strict';\n", ''), /^code changed/],
  'a statement added inside a comment-looking line': [(t) => edit(t, '  return x + n; // why', '  return x + n; auth(1); // why'), /^code changed/],
  'a line break added where the grammar reads one (return)': [(t) => edit(t, '  return x + n; // why', '  return /*\n */ x + n; // why'), /line break/],
};

for (const ext of JS_EXTS) {
  const file = `server/item${ext}`;
  test(`${ext}: comment edits are comment-only`, () => {
    const b = base(ext);
    assert.deepStrictEqual(compareFile(b, b, file), { ok: true, reason: null }, 'an unchanged file');
    for (const [what, fn] of Object.entries(COMMENT_EDITS)) assert.deepStrictEqual(compareFile(b, fn(b), file), { ok: true, reason: null }, what);
  });

  test(`${ext}: code edits are not, each with a reason`, () => {
    const b = base(ext);
    for (const [what, [fn, re]] of Object.entries(CODE_EDITS)) {
      const r = compareFile(b, fn(b), file);
      assert.strictEqual(r.ok, false, what);
      assert.match(r.reason, re, what);
    }
  });

  test(`${ext}: a shebang added, removed or changed is not comment-only`, () => {
    const b = `#!/usr/bin/env node\n${base(ext)}`;
    assert.strictEqual(compareFile(b, edit(b, 'const n = 1;', 'const n = 1; // one'), file).ok, true, 'a comment under a shebang');
    assert.deepStrictEqual(compareFile(b, b.replace('#!/usr/bin/env node', '#!/usr/bin/env bash'), file), { ok: false, reason: 'the shebang line changed' });
    assert.deepStrictEqual(compareFile(base(ext), b, file), { ok: false, reason: 'a shebang line was added' });
    assert.deepStrictEqual(compareFile(b, base(ext), file), { ok: false, reason: 'the shebang line was removed' });
  });

  test(`${ext}: a side that does not parse fails the file, naming the side`, () => {
    const b = base(ext);
    const broken = `${b}const = ;\n`;
    assert.match(compareFile(broken, `// header\n${broken}`, file).reason, /^tokenize failed: the old text: /);
    const r = compareFile(b, edit(b, "'item'", "'item"), file);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /^tokenize failed: the new text \(as module\): /);
  });

  // The bare tokenizer reads `await /[//]/` as a division and a line comment,
  // so a change after it would pass; the parser reads the regex.
  test(`${ext}: a code change after a regex the bare tokenizer misreads is caught`, () => {
    const b = `${base(ext)}async function check(s) { return await /[//]/.test(s) && auth(s); }\n`;
    const r = compareFile(b, edit(b, '&& auth(s)', '&& auth(n)'), file);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /^code changed/);
  });
}

test('a comment that is a compiler directive, added, removed or changed, is not comment-only; prose is', () => {
  const directive = { ok: false, reason: 'a comment that is a compiler directive changed' };
  for (const ext of JS_EXTS) {
    const b = base(ext);
    const file = `client/src/item${ext}`;
    assert.deepStrictEqual(compareFile(b, `/* @jsxRuntime classic */\n${b}`, file), directive, `${ext} @jsxRuntime added`);
    assert.deepStrictEqual(compareFile(b, edit(b, 'auth(x) {', 'auth(x) {\n  /*#__PURE__*/'), file), directive, `${ext} __PURE__ added`);
    assert.deepStrictEqual(compareFile(b, `// pure prose about this file\n${b}`, file), { ok: true, reason: null }, `${ext} prose`);
    const marked = `/** @jsx h */\n${b}`;
    assert.deepStrictEqual(compareFile(marked, marked.replace('@jsx h', '@jsx React.createElement'), file), directive, `${ext} @jsx changed`);
    assert.deepStrictEqual(compareFile(marked, b, file), directive, `${ext} @jsx removed`);
    assert.deepStrictEqual(compareFile(marked, `// prose\n${marked}`, file), { ok: true, reason: null }, `${ext} prose beside a directive`);
  }
  const b = base('.js');
  for (const text of ['/* webpackChunkName: "x" */', '/* webpackIgnore: true */', '/* #__NO_SIDE_EFFECTS__ */', '/* @jsxImportSource preact */', '/* @jsxFrag Fragment */']) {
    assert.deepStrictEqual(compareFile(b, `${text}\n${b}`, 'client/src/x.js'), directive, text);
  }
  assert.strictEqual(compareFile(b, `// the webpack build reads this\n${b}`, 'client/src/x.js').ok, true, 'webpack in prose');
});

test('.js and .jsx: a JSX text node changed, a JSX attribute added, // typed into JSX text, or a {/* */} container added is not comment-only; a comment above the JSX is', () => {
  for (const ext of ['.js', '.jsx']) {
    const b = base(ext);
    const file = `client/src/Item${ext}`;
    for (const [what, to] of [['text', 'Hi {name}'], ['// in text', 'Hello // not a comment {name}']]) {
      const r = compareFile(b, edit(b, 'Hello {name}', to), file);
      assert.strictEqual(r.ok, false, `${ext} ${what}`);
      assert.match(r.reason, /^code changed/);
    }
    assert.strictEqual(compareFile(b, edit(b, '<div className="item">', '<div className="item" id="x">'), file).ok, false, `${ext} attribute`);
    assert.strictEqual(compareFile(b, edit(b, 'Hello {name}', 'Hello {name}{/* a comment */}'), file).ok, false, `${ext}: an expression container is code, the comment inside it aside`);
    assert.strictEqual(compareFile(b, edit(b, 'const view = <div', '// The view.\nconst view = <div'), file).ok, true, `${ext} comment above JSX`);
  }
});

test('a reason names lines and counts, never a word of the source', () => {
  const b = base('.js');
  const r = compareFile(b, edit(b, "'item'", "'zebra'"), 'server/item.js');
  assert.match(r.reason, /^code changed at token \d+ \(line 3 of the new text, line 3 of the old\)$/);
  assert.ok(!/zebra|item/.test(r.reason));
  const s = compareFile('echo item\n', 'echo zebra\n', 'scripts/x.sh');
  assert.ok(!/zebra|item/.test(s.reason), s.reason);
});

test('an ESLint configuration comment, added, removed or changed, is a directive; prose that only begins like one is not', () => {
  const directive = { ok: false, reason: 'a comment that is a compiler directive changed' };
  for (const ext of JS_EXTS) {
    const file = `client/src/item${ext}`;
    const b = edit(base(ext), 'const n = 1;', '// eslint-disable-next-line no-unused-vars\nconst n = 1;');
    assert.deepStrictEqual(compareFile(b, b.replace('// eslint-disable-next-line no-unused-vars\n', ''), file), directive, `${ext} eslint-disable-next-line deleted`);
    assert.deepStrictEqual(compareFile(b, `/* global y */\n${b}`, file), directive, `${ext} global added`);
  }
  const b = base('.js');
  for (const text of ['/* eslint no-console: 0 */', '/* eslint-disable */', '/* eslint-enable */', '/* eslint-env node */', '/* globals a, b */', '/* exported auth */', '// eslint-disable-line']) {
    assert.deepStrictEqual(compareFile(b, `${text}\n${b}`, 'client/src/x.js'), directive, text);
  }
  assert.strictEqual(compareFile(b, `// eslintrc lives at the root\n// Global state, explained\n${b}`, 'client/src/x.js').ok, true, 'prose');
});

test('a parse failure names the error class and acorn\'s line and column, never the message, which quotes the source', () => {
  const b = base('.js');
  const twice = edit(b, 'const n = 1;', 'const n = 1;\nlet secretName = 1;\nlet secretName = 2;');
  const r = compareFile(b, twice, 'server/item.js');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /^tokenize failed: the new text \(as module\): SyntaxError at line \d+, column \d+$/);
  assert.ok(!r.reason.includes('secretName'), r.reason);
  const old = compareFile(twice, `// header\n${twice}`, 'server/item.js');
  assert.match(old.reason, /^tokenize failed: the old text: SyntaxError at line \d+, column \d+$/);
  assert.ok(!old.reason.includes('secretName'), old.reason);
});

test('.sh and .sql: a comment line added is comment-only, a command line added is not', () => {
  const sh = '#!/bin/sh\n# The header.\nset -e\necho item\n';
  assert.deepStrictEqual(compareFile(sh, `${sh}# a closing note\n`, 'scripts/x.sh'), { ok: true, reason: null });
  assert.strictEqual(compareFile(sh, sh.replace('# The header.', '  # The header, reworded and indented.\n\n'), 'scripts/x.sh').ok, true);
  assert.strictEqual(compareFile(sh, sh.replace('set -e', 'set -e   '), 'scripts/x.sh').ok, true, 'trailing blanks on a code line');
  assert.match(compareFile(sh, `${sh}echo more\n`, 'scripts/x.sh').reason, /^code line 4 differs \(line 5 of the new text, the end of the old\)$/);
  assert.strictEqual(compareFile(sh, sh.replace('#!/bin/sh', '#!/bin/bash'), 'scripts/x.sh').ok, false, 'the shebang is code');
  const sql = '-- The header.\nCREATE TABLE IF NOT EXISTS item (id INT, name TEXT, note TEXT);\n';
  assert.deepStrictEqual(compareFile(sql, sql.replace('-- The header.', '-- The header.\n  -- A second comment line.'), 'server/db/x.sql'), { ok: true, reason: null });
  assert.strictEqual(compareFile(sql, `${sql}SELECT 1;\n`, 'server/db/x.sql').ok, false);
  assert.strictEqual(compareFile(sql, `${sql}# not a sql comment\n`, 'server/db/x.sql').ok, false, '# is code in .sql');
});

test('.sql: a comment counts only outside quoted strings and dollar bodies, whose text is code', () => {
  const file = 'server/db/schema.sql';
  const sql = [
    '-- The header.',
    'CREATE TABLE IF NOT EXISTS item (id INT, name TEXT, note TEXT);',
    'DO $$',
    'BEGIN',
    '  -- why the block runs',
    '  PERFORM 1;',
    'END $$;',
    "INSERT INTO item (note) VALUES ('first line",
    "-- second line, data');",
    "INSERT INTO item (name) VALUES ('a -- b');",
    '',
  ].join('\n');
  const ok = { ok: true, reason: null };
  assert.deepStrictEqual(compareFile(sql, sql.replace('-- The header.', '-- The header, reworded.\n/* and a block */'), file), ok, 'a top-level comment edited');
  assert.deepStrictEqual(compareFile(sql, sql.replace('PERFORM 1;', 'PERFORM 1; -- trailing'), file).ok, false, 'a comment inside a DO block is body text');
  assert.strictEqual(compareFile(sql, sql.replace('-- why the block runs', '-- why the block runs $$ keeps this'), file).ok, false, 'a -- line in a $$ body gaining $$');
  assert.strictEqual(compareFile(sql, sql.replace('-- second line, data', '-- second line, changed'), file).ok, false, 'a -- line inside a multi-line string');
  assert.strictEqual(compareFile(sql, sql.replace("'a -- b'", "'a -- c'"), file).ok, false, 'a -- inside a one-line string');
  const tagged = 'CREATE FUNCTION f() RETURNS INT AS $body$\n-- inside\nSELECT 1;\n$body$ LANGUAGE sql;\n';
  assert.strictEqual(compareFile(tagged, tagged.replace('-- inside', '-- inside, edited'), file).ok, false, 'a $tag$ body');
  assert.deepStrictEqual(compareFile(tagged, `-- The function.\n${tagged}`, file), ok);
});

test('a lone carriage return in a .sql, .sh or .env.example side is refused; CRLF is not', () => {
  const lone = { ok: false, reason: 'a lone carriage return is not comparable' };
  const sql = '-- The header.\nCREATE TABLE IF NOT EXISTS item (id INT);\n';
  // Postgres ends a -- comment at the CR, so the text after it would run.
  assert.deepStrictEqual(compareFile(sql, sql.replace('-- The header.', '-- The header.\rDROP TABLE item;'), 'server/db/x.sql'), lone);
  assert.deepStrictEqual(compareFile(sql.replace('\n', '\r'), sql, 'server/db/x.sql'), lone, 'on the old side');
  assert.deepStrictEqual(compareFile('# a\necho b\n', '# a\recho c\necho b\n', 'scripts/x.sh'), lone);
  assert.deepStrictEqual(compareFile('# a\nNAME=x\n', '# a\rOTHER=1\nNAME=x\n', '.env.example'), lone);
  assert.deepStrictEqual(compareFile(sql, sql.replace(/\n/g, '\r\n'), 'server/db/x.sql'), { ok: true, reason: null }, 'CRLF');
});

test('only ASCII blanks fold in .sql, and only space and tab lead a .sh or .env.example comment line', () => {
  // Built from code points, so this file holds none of them.
  const NBSP = String.fromCharCode(0xa0);
  const sql = '-- The header.\nCREATE TABLE IF NOT EXISTS item (id INT);\n';
  assert.strictEqual(compareFile(sql, sql.replace('TABLE IF', `TABLE${NBSP}IF`), 'server/db/x.sql').ok, false, 'an NBSP for a space in SQL code');
  for (const cp of [0x2028, 0x2029, 0xfeff, 0x3000, 0x2003]) {
    assert.strictEqual(compareFile(sql, sql.replace('TABLE IF', `TABLE ${String.fromCharCode(cp)}IF`), 'server/db/x.sql').ok, false, `U+${cp.toString(16)} in SQL code`);
  }
  assert.deepStrictEqual(compareFile(sql, sql.replace('TABLE IF', 'TABLE \t\f\v IF'), 'server/db/x.sql'), { ok: true, reason: null }, 'ASCII blanks fold');
  const sh = '# a\necho b\n';
  assert.strictEqual(compareFile(sh, `${sh}${NBSP}# x\n`, 'scripts/x.sh').ok, false, 'an NBSP-led # line is code');
  assert.strictEqual(compareFile(sh, sh.replace('echo b', `echo b${NBSP}`), 'scripts/x.sh').ok, false, 'a trailing NBSP is part of the word');
  assert.strictEqual(compareFile(sh, `${sh} \t# x\n`, 'scripts/x.sh').ok, true, 'a space and tab-led # line');
  assert.strictEqual(compareFile('NAME=x\n', `NAME=x\n${NBSP}# NOTE=y\n`, '.env.example').ok, false, '.env.example');
});

test('.sh: a heredoc body is code through its delimiter, and a trailing backslash keeps its blanks', () => {
  const sh = "set -e\ncat <<'EOF'\n# a heading in the output\nbody\nEOF\necho done\n";
  assert.strictEqual(compareFile(sh, sh.replace('body\n', 'body\n# another output line\n'), 'scripts/x.sh').ok, false, 'a # line inside the heredoc');
  assert.strictEqual(compareFile(sh, sh.replace('echo done\n', '# after the heredoc\necho done\n'), 'scripts/x.sh').ok, true, 'a comment after the delimiter');
  const tabs = 'cat <<-END\n\t# shown\n\tEND\necho done\n';
  assert.strictEqual(compareFile(tabs, tabs.replace('\t# shown\n', '\t# shown\n\t# also shown\n'), 'scripts/x.sh').ok, false, '<<- strips tabs from the delimiter line');
  assert.strictEqual(compareFile(tabs, `${tabs}# after\n`, 'scripts/x.sh').ok, true);
  const here = 'cat <<<"$x"\n# a comment\necho done\n';
  assert.strictEqual(compareFile(here, here.replace('# a comment', '# reworded'), 'scripts/x.sh').ok, true, 'a here-string opens no heredoc');
  const cont = 'echo a \\\n  b\n';
  assert.strictEqual(compareFile(cont, 'echo a \\ \n  b\n', 'scripts/x.sh').ok, false, 'an escaped blank is not a continuation');
});

test('.sh: a line after an unescaped trailing backslash is code, a blank or a # line included (bash joins them)', () => {
  const sh = 'cmd \\\n--arg\necho done\n';
  assert.strictEqual(compareFile(sh, 'cmd \\\n  # note\n--arg\necho done\n', 'scripts/x.sh').ok, false, 'a # line inside a continuation');
  assert.strictEqual(compareFile(sh, 'cmd \\\n\n--arg\necho done\n', 'scripts/x.sh').ok, false, 'a blank line inside a continuation');
  assert.strictEqual(compareFile(sh, 'cmd \\\n--arg\n# after\n\necho done\n', 'scripts/x.sh').ok, true, 'a comment after the continuation ends');
  const escaped = 'echo a \\\\\necho b\n';
  assert.strictEqual(compareFile(escaped, 'echo a \\\\\n# note\necho b\n', 'scripts/x.sh').ok, true, 'an escaped backslash continues nothing');
  assert.strictEqual(compareFile('# a comment \\\necho b\n', '# a comment \\\n# more\necho b\n', 'scripts/x.sh').ok, true, 'a comment line ending in a backslash continues nothing');
});

test('.sh: a joined line ending in a backslash carries the join on, a # line included', () => {
  // bash runs this as one command: echo foo#bar --x
  const sh = 'echo foo\\\n#bar \\\n--x\n';
  assert.strictEqual(compareFile(sh, 'echo foo\\\n#bar \\\n\n--x\n', 'scripts/x.sh').ok, false, 'a blank line after the joined # line');
  assert.strictEqual(compareFile(sh, 'echo foo\\\n#bar \\\n# inserted\n--x\n', 'scripts/x.sh').ok, false, 'a # line after the joined # line');
  assert.strictEqual(compareFile('# c \\\necho b\n', '# c \\\n# more\necho b\n', 'scripts/x.sh').ok, true, 'a standalone comment line continues nothing');
});

test('.env.example: # lines and blank lines are free; a variable line added, removed, moved, changed or activated is not', () => {
  const env = '# Section\n\n# about NAME\nNAME=item\n# NOTE=sample\nAUTH_KEY=\n';
  const file = '.env.example';
  const okCases = {
    'a # line added': env.replace('# about NAME\n', '# about NAME\n# more about it\n'),
    'a # line changed': env.replace('# about NAME', '# about NAME, reworded'),
    'a blank line added': env.replace('NAME=item\n', 'NAME=item\n\n'),
    'CRLF line endings': env.replace(/\n/g, '\r\n'),
  };
  for (const [what, to] of Object.entries(okCases)) assert.deepStrictEqual(compareFile(env, to, file), { ok: true, reason: null }, what);
  const noCases = {
    'a VAR= line added': `${env}OTHER=1\n`,
    'a VAR= line removed': env.replace('NAME=item\n', ''),
    'a VAR= line moved': env.replace('NAME=item\n', '').replace('AUTH_KEY=\n', 'AUTH_KEY=\nNAME=item\n'),
    'a VAR= line changed': env.replace('NAME=item', 'NAME=other'),
    '# VAR= to VAR=': env.replace('# NOTE=sample', 'NOTE=sample'),
  };
  for (const [what, to] of Object.entries(noCases)) assert.strictEqual(compareFile(env, to, file).ok, false, what);
  assert.strictEqual(compareFile(env, env.replace('# about NAME', '# about NAME, reworded'), 'config/.env.example').ok, true, 'by basename');
});

test('any other file type is not comment-only', () => {
  for (const file of ['README.md', 'package.json', 'client/src/index.css', '.env', 'server/x.ts', 'Makefile']) {
    assert.deepStrictEqual(compareFile('a\n', 'a\n// b\n', file), { ok: false, reason: 'unsupported file type' }, file);
  }
});

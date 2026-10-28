'use strict';

// Suite for the npm scripts table (scripts/lib/genDocs/scriptsTable.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('./scriptsTable');

test('one row per script in file order, each a code span', () => {
  const pkg = JSON.stringify({ name: 'x', scripts: { start: 'node server/index.js', docs: 'node scripts/gen-docs.js', build: 'cd client && npm run build' } }, null, 2);
  assert.equal(render(pkg), [
    '| Script | Command |',
    '|---|---|',
    '| `start` | `node server/index.js` |',
    '| `docs` | `node scripts/gen-docs.js` |',
    '| `build` | `cd client && npm run build` |',
  ].join('\n'));
});

test('pipes are escaped and a backtick in a command gets a double fence', () => {
  const out = render(JSON.stringify({ scripts: { audit: 'npm audit || true', odd: 'echo `x`' } }));
  assert.match(out, /^\| `audit` \| `npm audit \\\|\\\| true` \|$/m);
  assert.match(out, /^\| `odd` \| `` echo `x` `` \|$/m);
});

test('no scripts, or no package.json, is an empty table; bad JSON throws naming the file', () => {
  assert.equal(render(JSON.stringify({ name: 'x' })), '| Script | Command |\n|---|---|');
  assert.equal(render(null), '| Script | Command |\n|---|---|');
  assert.throws(() => render('{ nope'), /package\.json does not parse/);
});

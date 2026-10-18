'use strict';
// The deployed-code guard (push-1 security review, MINOR-1 class a): the fresh
// compute prices live bookings with the engine code in this checkout, so the
// run refuses unless server/ is exactly origin/main (the code prod runs) and
// the conversion tooling is committed. Pure: git is a stub.
//   node --test scripts/override-conversion/guard.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assertDeployedCode } = require('./shared');

// A stub git: answers by subcommand, records every call.
function stubGit(answers = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    const sub = args[2]; // args = ['-C', root, sub, ...]
    const a = answers[sub] || {};
    return { status: a.status ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
  };
  return { git, calls };
}
const ROOT = '/repo';
const clean = () => stubGit({ 'rev-parse': { stdout: '42ef970c1234567890abcdef1234567890abcdef\n' } });

test('a checkout whose server/ is origin/main and whose tooling is committed passes, and fetches first', () => {
  const { git, calls } = clean();
  const out = assertDeployedCode({ git, root: ROOT });
  assert.equal(out.originMain, '42ef970c1234567890abcdef1234567890abcdef');
  assert.deepEqual(calls.map((c) => c.slice(2)), [
    ['fetch', '--quiet', 'origin', 'main'],
    ['diff', '--quiet', 'origin/main', '--', 'server'],
    ['ls-files', '--others', '--exclude-standard', '--', 'server'],
    ['status', '--porcelain', '--', 'scripts/override-conversion'],
    ['rev-parse', 'origin/main'],
  ]);
  assert.ok(calls.every((c) => c[0] === '-C' && c[1] === ROOT), 'every call runs in the checkout');
  assert.ok(!calls.some((c) => c.includes('diff') && c.includes('scripts/override-conversion')),
    'the tooling is never compared with origin/main, so the guard\'s own unpushed commit cannot block a run');
});

test('a failed fetch refuses and tells the operator to fetch by hand', () => {
  const { git, calls } = stubGit({ fetch: { status: 128, stderr: 'could not read from remote' } });
  assert.throws(() => assertDeployedCode({ git, root: ROOT }), /git fetch origin main/);
  assert.equal(calls.length, 1, 'nothing compared against a stale origin/main');
});

test('server/ that differs from origin/main refuses', () => {
  const { git } = stubGit({ diff: { status: 1 } });
  assert.throws(() => assertDeployedCode({ git, root: ROOT }), /server\/ differs from origin\/main/);
});

test('a git error on the diff refuses rather than passing', () => {
  const { git } = stubGit({ diff: { status: 128, stderr: 'bad revision' } });
  assert.throws(() => assertDeployedCode({ git, root: ROOT }), /could not compare/);
});

test('an untracked file under server/ refuses and names it', () => {
  const { git } = stubGit({ 'ls-files': { stdout: 'server/utils/scratch.js\n' } });
  assert.throws(() => assertDeployedCode({ git, root: ROOT }), /untracked.*server\/utils\/scratch\.js/s);
});

test('uncommitted or untracked conversion tooling refuses', () => {
  for (const stdout of [' M scripts/override-conversion/transform.js\n', '?? scripts/override-conversion/extra.js\n']) {
    const { git } = stubGit({ status: { stdout } });
    assert.throws(() => assertDeployedCode({ git, root: ROOT }), /uncommitted or untracked/);
  }
});

test('run.js and freshCompute.js run the guard before any read, write or spawn', () => {
  const { runCli } = require('./run');
  const { freshComputeCli } = require('./freshCompute');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-guard-'));
  const refuse = () => { throw new Error('guard refused'); };
  assert.throws(() => runCli([path.join(dir, 'missing.json'), path.join(dir, 'missing2.json'), path.join(dir, 'out')],
    { log: () => {}, guard: refuse }), /guard refused/);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  let spawned = false;
  assert.throws(() => freshComputeCli(['a.uri', 'b.json', 'c.json'], { guard: refuse, spawn: () => { spawned = true; } }), /guard refused/);
  assert.equal(spawned, false);
});

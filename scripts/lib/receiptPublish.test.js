'use strict';

// Tests for scripts/lib/receiptPublish.js (instruction rewrite step 2, lane
// receipt-lib): the copy a finalize builds the receipt with. Every directory
// is a throwaway under the temp dir, removed when the test ends; nothing here
// touches git or the dev database. publish() itself runs through the CLI
// suites (review-receipt.finalize.test.js).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { copyTree, writeNotRun } = require('./receiptPublish');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-publish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('copyTree copies a nested working directory byte for byte, and never onto an existing one', (t) => {
  const root = tmpDir(t);
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'tests', 'suites-1'), { recursive: true });
  fs.writeFileSync(path.join(src, 'receipt.json'), '{"version": 1}\n');
  fs.writeFileSync(path.join(src, 'tests', 'suites-1', 'summary.json'), Buffer.from([0, 1, 2, 255]));
  copyTree(src, path.join(root, 'dest'));
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'dest', 'tests', 'suites-1', 'summary.json')), Buffer.from([0, 1, 2, 255]));
  assert.strictEqual(fs.readFileSync(path.join(root, 'dest', 'receipt.json'), 'utf8'), '{"version": 1}\n');
  assert.throws(() => copyTree(src, path.join(root, 'dest')), { code: 'EEXIST' });
});

test('copyTree throws an ordinary error on an unreadable directory, and refuses a symlink', (t) => {
  const root = tmpDir(t);
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'tests'), { recursive: true });
  fs.symlinkSync('/etc/hostname', path.join(src, 'link'));
  assert.throws(() => copyTree(src, path.join(root, 'a')), (e) => e.code === 'ENOTFILE' && e.path === path.join(src, 'link'));
  fs.rmSync(path.join(src, 'link'));
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  fs.chmodSync(path.join(src, 'tests'), 0o000);
  try {
    assert.throws(() => copyTree(src, path.join(root, 'b')), (e) => e.code === 'EACCES' && e.path === path.join(src, 'tests'));
  } finally {
    fs.chmodSync(path.join(src, 'tests'), 0o755);
  }
});

test('writeNotRun writes one line per reviewer not run and removes the file when both ran', (t) => {
  const dir = tmpDir(t);
  writeNotRun(dir, { codex: { state: 'run' }, gemini: { state: 'not_run', reason: 'quota' } });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'externals', 'not-run.txt'), 'utf8'), 'gemini: quota\n');
  writeNotRun(dir, { codex: { state: 'run' }, gemini: { state: 'run' } });
  assert.ok(!fs.existsSync(path.join(dir, 'externals', 'not-run.txt')));
});

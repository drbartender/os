// Diag capture modes and the prune (review fixes 5 and 8). A stub page and a
// temp dir; never the real profile. Run: `node --test src/diag.test.js`.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// config.js resolves the profile dir once, at load. Point it at a throwaway dir
// before anything loads it, so no test here can ever reach the real profile.
process.env.GV_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-agent-profile-guard-'));
after(() => fs.rmSync(process.env.GV_PROFILE_DIR, { recursive: true, force: true }));
const { captureDiag, pruneDiag } = require('./diag');

const tmpDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-agent-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('a diag capture is written mode 600 with its digits masked', async (t) => {
  const dir = path.join(tmpDir(t), 'diag');
  const page = {
    screenshot: async () => Buffer.from('not really a png'),
    evaluate: async () => ({ url: 'https://voice.google.com/u/0/messages?itemId=t.%2B13125550123', title: 'Voice' }),
  };
  const base = await captureDiag(page, 41, 'ui_error_before_send', dir);
  assert.ok(base, 'a capture was written');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const ext of ['.png', '.json']) assert.equal(fs.statSync(base + ext).mode & 0o777, 0o600, ext);
  const json = fs.readFileSync(`${base}.json`, 'utf8');
  assert.equal(/\d/.test(JSON.parse(json).url), false, 'every digit masked');
  assert.match(path.basename(base), /-41-ui_error_before_send$/);
});

test('the diag prune keeps the newest 40, none older than 30 days, and never throws', (t) => {
  const dir = tmpDir(t);
  const bases = [];
  for (let i = 0; i < 43; i += 1) {
    const base = `2026-10-19T17-00-${String(i).padStart(2, '0')}-000Z-41-timeout`;
    for (const ext of ['.png', '.json']) fs.writeFileSync(path.join(dir, base + ext), 'x');
    bases.push(base);
  }
  const monthAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  for (const ext of ['.png', '.json']) fs.utimesSync(path.join(dir, bases[42] + ext), monthAgo, monthAgo);
  pruneDiag(dir);
  const left = [...new Set(fs.readdirSync(dir).map((n) => n.replace(/\.(png|json)$/, '')))].sort();
  // The newest name went by age; of the 42 left, the 2 oldest went by count.
  assert.deepEqual(left, bases.slice(2, 42));
  assert.doesNotThrow(() => pruneDiag(path.join(dir, 'missing')));
});

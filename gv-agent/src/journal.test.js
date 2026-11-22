// On-disk state the box keeps in its profile dir: the never-send-twice journal
// (spec law 4), the current-job marker (plan decision 10), the box's daily
// counts, and the stale Chrome singleton cleanup. Run: `node --test src/journal.test.js`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadJournal, journalBeforeClick, writeCurrentJob, readCurrentJob, clearCurrentJob,
  clearStaleSingletons, profileInUse, readDayCount, bumpDayCount,
} = require('./journal');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gv-agent-test-'));
const SINGLETONS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

test('a journaled id is found after reload', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'gv-sent.journal');
  assert.equal(loadJournal(file).size, 0, 'no file yet is an empty journal, never a throw');
  journalBeforeClick(file, 41);
  journalBeforeClick(file, '42');
  const reloaded = loadJournal(file);
  assert.ok(reloaded.has('41'));
  assert.ok(reloaded.has('42'));
  assert.equal(reloaded.has('43'), false);
  // A failed write throws, so the caller can refuse the click.
  assert.throws(() => journalBeforeClick(path.join(dir, 'no-such-dir', 'gv-sent.journal'), 43));
  // An id that would corrupt the one-id-per-line file is refused, not written.
  assert.throws(() => journalBeforeClick(file, '4\n5'));
  assert.throws(() => journalBeforeClick(file, ''));
  assert.deepEqual([...loadJournal(file)], ['41', '42']);
});

test('a current-job marker survives reload and clears', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'gv-current-job.json');
  assert.equal(readCurrentJob(file), null);
  writeCurrentJob(file, 41);
  assert.deepEqual(readCurrentJob(file), { id: 41 });
  // Once the job has an outcome it is recorded, so an undelivered report is re-sent as itself.
  writeCurrentJob(file, 41, { outcome: 'failed_preclick', reason: 'cap' });
  assert.deepEqual(readCurrentJob(file), { id: 41, outcome: 'failed_preclick', reason: 'cap' });
  writeCurrentJob(file, 41, { outcome: 'sent' });
  assert.deepEqual(readCurrentJob(file), { id: 41, outcome: 'sent' });
  clearCurrentJob(file);
  assert.equal(readCurrentJob(file), null);
  clearCurrentJob(file); // clearing twice is fine
  fs.writeFileSync(file, 'not json');
  assert.equal(readCurrentJob(file), null, 'an unreadable marker carries no id to report');
});

test('stale singletons are removed only when no process holds the profile', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const present = () => SINGLETONS.filter((n) => {
    try { fs.lstatSync(path.join(dir, n)); return true; } catch { return false; }
  });
  // Chrome leaves these as symlinks, dangling once the process is gone.
  fs.symlinkSync('box-424242', path.join(dir, 'SingletonLock'));
  fs.symlinkSync('/tmp/.org.chromium.Chromium.none/SingletonSocket', path.join(dir, 'SingletonSocket'));
  fs.symlinkSync('1234567890123', path.join(dir, 'SingletonCookie'));
  fs.writeFileSync(path.join(dir, 'Cookies'), 'keep');

  assert.deepEqual(clearStaleSingletons(dir, () => true), { inUse: true, removed: [] });
  assert.deepEqual(present(), SINGLETONS);
  // A probe that cannot tell counts as in use: deleting a live Chrome's lock risks the profile.
  assert.deepEqual(clearStaleSingletons(dir, () => { throw new Error('no /proc'); }), { inUse: true, removed: [] });
  assert.deepEqual(present(), SINGLETONS);

  let asked = null;
  const out = clearStaleSingletons(dir, (d) => { asked = d; return false; });
  assert.equal(asked, dir);
  assert.deepEqual(out, { inUse: false, removed: SINGLETONS });
  assert.deepEqual(present(), []);
  assert.ok(fs.existsSync(path.join(dir, 'Cookies')), 'nothing but the singletons is touched');
  assert.deepEqual(clearStaleSingletons(dir, () => false), { inUse: false, removed: [] });
});

test('profileInUse reads the --user-data-dir flag from /proc', (t) => {
  const proc = tmpDir();
  t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  fs.mkdirSync(path.join(proc, '101'));
  fs.writeFileSync(path.join(proc, '101', 'cmdline'),
    ['/opt/google/chrome/chrome', '--user-data-dir=/home/someone/.gvoice-profile/', '--no-first-run', ''].join('\0'));
  fs.mkdirSync(path.join(proc, '202'));
  fs.writeFileSync(path.join(proc, '202', 'cmdline'), ['node', 'src/index.js', ''].join('\0'));
  fs.mkdirSync(path.join(proc, 'self'));
  assert.equal(profileInUse('/home/someone/.gvoice-profile', proc), true);
  assert.equal(profileInUse('/home/someone/.thumbtack-profile', proc), false);
  assert.equal(profileInUse('/x', path.join(proc, 'missing')), true, 'an unreadable /proc fails closed');
});

test('the sent count survives reload and starts over on a new Chicago day', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'gv-sent-count.json');
  assert.equal(readDayCount(file, '2026-10-19'), 0);
  bumpDayCount(file, '2026-10-19');
  bumpDayCount(file, '2026-10-19');
  assert.equal(readDayCount(file, '2026-10-19'), 2);
  assert.equal(readDayCount(file, '2026-10-20'), 0);
  bumpDayCount(file, '2026-10-20');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { day: '2026-10-20', count: 1 });
  // A bump that cannot be saved throws (the attempt budget fails closed on it).
  assert.throws(() => bumpDayCount(path.join(dir, 'no-such-dir', 'gv-attempt-count.json'), '2026-10-20'));
});

test('the box writes its state files mode 600', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = {
    journal: path.join(dir, 'gv-sent.journal'),
    marker: path.join(dir, 'gv-current-job.json'),
    count: path.join(dir, 'gv-sent-count.json'),
    attempts: path.join(dir, 'gv-attempt-count.json'),
  };
  journalBeforeClick(files.journal, 41);
  writeCurrentJob(files.marker, 41);
  writeCurrentJob(files.marker, 41, { outcome: 'sent' }); // the rewrite too
  bumpDayCount(files.count, '2026-10-19');
  bumpDayCount(files.attempts, '2026-10-19');
  for (const [name, file] of Object.entries(files)) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, name);
  }
});

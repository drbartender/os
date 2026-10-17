process.env.NODE_ENV = 'test';
require('dotenv').config();
// menuPrintFile.js, the exports Lane 3 adds (spec 2026-10-01 section 8; plan
// Task A1): setMenuPrintKey(executor, proposalId, key) and reaccrueDuty, beside
// the shipped sendMenuPrintFile, which must stay byte-identical.
//
// No database and nothing remote: the executor is a stub, storage is a
// tripwire installed through require.cache BEFORE the module loads (so a
// setMenuPrintKey that uploaded would trip it), and payrollAccrual and
// @sentry/node are fake modules placed in require.cache, which reaccrueDuty
// requires lazily inside its setImmediate.
//
// Run: node --test server/utils/menuPrintFile.test.js
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

const { NotFoundError } = require('./errors');

// ── Storage: a tripwire for uploads, a recorder for signing ─────────────────
const storagePath = require.resolve('./storage');
const realStorage = require('./storage');
const storageCalls = { upload: 0, signed: [] };
require.cache[storagePath].exports = {
  ...realStorage,
  uploadFile: async () => { storageCalls.upload += 1; throw new Error('menuPrintFile.test: nothing may upload'); },
  getSignedUrl: async (key) => { storageCalls.signed.push(key); return `https://r2.invalid/${key}`; },
};

// ── Fake modules reaccrueDuty requires at run time ──────────────────────────
function fakeModule(path, exports) {
  const saved = require.cache[path];
  const m = new Module(path);
  m.filename = path;
  m.loaded = true;
  m.exports = exports;
  require.cache[path] = m;
  return () => { if (saved) require.cache[path] = saved; else delete require.cache[path]; };
}
const accrualCalls = [];
let accrualImpl = async () => ({ skipped: true });
const restoreAccrual = fakeModule(require.resolve('./payrollAccrual'), {
  maybeReaccrueForDuty: (...args) => { accrualCalls.push(args); return accrualImpl(...args); },
});
const sentryCalls = [];
const restoreSentry = fakeModule(require.resolve('@sentry/node'), {
  captureException: (err, ctx) => { sentryCalls.push({ err, ctx }); },
});

const menuPrintFile = require('./menuPrintFile');
const { setMenuPrintKey, reaccrueDuty, sendMenuPrintFile } = menuPrintFile;

const savedDsn = process.env.SENTRY_DSN_SERVER;
const tick = () => new Promise((resolve) => { setImmediate(resolve); });
// Two turns: setImmediate runs the accrual, then its rejection's catch settles.
const settle = async () => { await tick(); await tick(); await new Promise((r) => { setTimeout(r, 5); }); };

function stubExecutor(rowCount) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rowCount, rows: [] }; } };
}

beforeEach(() => {
  accrualCalls.length = 0;
  sentryCalls.length = 0;
  storageCalls.upload = 0;
  storageCalls.signed.length = 0;
  accrualImpl = async () => ({ skipped: true });
  delete process.env.SENTRY_DSN_SERVER;
});

after(() => {
  if (savedDsn === undefined) delete process.env.SENTRY_DSN_SERVER;
  else process.env.SENTRY_DSN_SERVER = savedDsn;
  restoreAccrual();
  restoreSentry();
  require.cache[storagePath].exports = realStorage;
});

// ── setMenuPrintKey ─────────────────────────────────────────────────────────

test('setMenuPrintKey runs the one UPDATE on the executor it is given, with the key and the id', async () => {
  const exec = stubExecutor(1);
  const out = await setMenuPrintKey(exec, 42, 'menu-print/42/abc.jpg');
  assert.deepEqual(out, { rowCount: 1 });
  assert.equal(exec.calls.length, 1, 'exactly one statement');
  assert.equal(exec.calls[0].sql, 'UPDATE proposals SET menu_print_key = $1, menu_not_required = false WHERE id = $2');
  assert.deepEqual(exec.calls[0].params, ['menu-print/42/abc.jpg', 42]);
});

test('setMenuPrintKey throws NotFoundError on 0 rows (a proposal deleted in between)', async () => {
  const exec = stubExecutor(0);
  await assert.rejects(setMenuPrintKey(exec, 7, 'menu-print/7/x.pdf'), (err) => {
    assert.ok(err instanceof NotFoundError);
    assert.equal(err.statusCode, 404);
    assert.equal(err.message, 'Proposal not found.');
    return true;
  });
});

test('setMenuPrintKey never uploads and never fires duty reaccrual', async () => {
  await setMenuPrintKey(stubExecutor(1), 9, 'menu-print/9/y.png');
  await assert.rejects(setMenuPrintKey(stubExecutor(0), 9, 'menu-print/9/y.png'), NotFoundError);
  await settle();
  assert.equal(storageCalls.upload, 0, 'no upload');
  assert.equal(accrualCalls.length, 0, 'no reaccrual');
});

test('setMenuPrintKey passes an executor error through untouched', async () => {
  const boom = Object.assign(new Error('deadlock detected'), { code: '40P01' });
  await assert.rejects(setMenuPrintKey({ query: async () => { throw boom; } }, 3, 'menu-print/3/z.jpg'), (err) => err === boom);
});

// ── reaccrueDuty ────────────────────────────────────────────────────────────

test('reaccrueDuty schedules exactly one maybeReaccrueForDuty call, off the current turn, with a numeric id', async () => {
  reaccrueDuty('123');
  assert.equal(accrualCalls.length, 0, 'nothing runs synchronously');
  await settle();
  assert.deepEqual(accrualCalls, [[123]]);
});

test('reaccrueDuty swallows a failed accrual and reports it to Sentry with the shipped tags when a DSN is set', async () => {
  const unhandled = [];
  const onUnhandled = (err) => { unhandled.push(err); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const failure = new Error('accrual failed');
    accrualImpl = async () => { throw failure; };
    reaccrueDuty(5);
    await settle();
    assert.equal(sentryCalls.length, 0, 'no DSN, no report');

    process.env.SENTRY_DSN_SERVER = 'https://dsn.invalid/1';
    reaccrueDuty(6);
    await settle();
    assert.equal(sentryCalls.length, 1);
    assert.equal(sentryCalls[0].err, failure);
    assert.deepEqual(sentryCalls[0].ctx, { tags: { route: 'menuPrint', step: 'duty_reaccrual' } });
    assert.deepEqual(accrualCalls, [[5], [6]]);
    assert.deepEqual(unhandled, [], 'no unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// ── sendMenuPrintFile: unchanged ────────────────────────────────────────────

// The sha256 of the function's source text as shipped in 7a1aa28b (spec 8:
// "keeps sendMenuPrintFile exactly as it is"). The staff and admin downloads
// both import it; a change here is a change to a working money path.
const SHIPPED_SEND_SHA256 = '771fb5215882f29b116c30bf2ec00dadc0bc2ca77a17dc2a172e5fe878a84a92';

test('sendMenuPrintFile is still exported and byte-identical to the shipped function', () => {
  assert.equal(typeof sendMenuPrintFile, 'function');
  assert.equal(sendMenuPrintFile.name, 'sendMenuPrintFile');
  assert.equal(menuPrintFile.sendMenuPrintFile, sendMenuPrintFile);
  const sha = crypto.createHash('sha256').update(sendMenuPrintFile.toString()).digest('hex');
  assert.equal(sha, SHIPPED_SEND_SHA256, 'sendMenuPrintFile changed; spec 8 keeps it exactly as shipped');
  assert.deepEqual(Object.keys(menuPrintFile).sort(), ['reaccrueDuty', 'sendMenuPrintFile', 'setMenuPrintKey']);
});

test('sendMenuPrintFile still refuses a missing or foreign key before signing anything', async () => {
  const res = { set: () => { throw new Error('no header may be set'); } };
  for (const key of [null, '', 'menu-print/8/x.pdf', 'menu-print/7/../x.pdf', 'menu-print/7//x.pdf']) {
    await assert.rejects(sendMenuPrintFile(res, 7, key), NotFoundError, String(key));
  }
  assert.deepEqual(storageCalls.signed, [], 'R2 was never signed for');
});

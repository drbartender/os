const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pool } = require('../lib/db');
const phase0 = require('./phase0');
const httpFetchLib = require('../lib/httpFetch');

const FIXTURES_DIR = path.join(__dirname, '__fixtures__');

// All URLs that appear in the fixture CSVs. We scrub these from
// cc_import_phase0_failures before/after each test so reruns are deterministic.
const FIXTURE_URLS = [
  'https://example.com/resume-alpha.pdf',
  'https://example.com/w9-alpha.pdf',
  'https://example.com/w9-beta.pdf',
  'https://example.com/w9-delta.jpg',
  'https://example.com/gallery-1.jpg',
  'https://example.com/video-1.mp4',
  'https://example.com/gallery-2.jpg',
];

async function scrubFixtureRows() {
  await pool.query(
    `DELETE FROM cc_import_phase0_failures WHERE source_url = ANY($1::text[])`,
    [FIXTURE_URLS]
  );
}

before(async () => { await scrubFixtureRows(); });
beforeEach(async () => { await scrubFixtureRows(); });
after(async () => {
  await scrubFixtureRows();
  await pool.end();
});

function makeMocks(behavior) {
  // `behavior` is a map of URL → 'ok' | Error or a function(url) → Promise.
  const uploadedKeys = [];
  const fetchToBuffer = async (url) => {
    const b = behavior[url];
    if (typeof b === 'function') return b(url);
    if (b instanceof Error) throw b;
    if (b === 'ok' || b === undefined) {
      return {
        buffer: Buffer.from('test-bytes'),
        contentType: 'image/jpeg',
        originalUrl: url,
      };
    }
    throw new Error(`Unknown mock behavior for ${url}: ${b}`);
  };
  const uploadToR2 = async (key /*, buffer, contentType */) => {
    uploadedKeys.push(key);
    return key;
  };
  const captureMessage = () => {}; // no-op for tests
  return { fetchToBuffer, uploadToR2, captureMessage, uploadedKeys };
}

test('Phase 0 success path: marks rows resolved and uploads to R2', async () => {
  const mocks = makeMocks({}); // all URLs succeed
  const result = await phase0.run({ ccDir: FIXTURES_DIR, ...mocks });

  // 7 URL cells across the 3 fixture CSVs.
  assert.strictEqual(result.processed, 7);
  assert.strictEqual(result.resolved, 7);
  assert.strictEqual(result.failed, 0);
  assert.strictEqual(result.skipped, 0);
  assert.strictEqual(mocks.uploadedKeys.length, 7);

  // Every fixture URL should have a resolved row with an r2 key.
  const { rows } = await pool.query(
    `SELECT source_url, resolved_at, resolved_r2_key, last_error
       FROM cc_import_phase0_failures
      WHERE source_url = ANY($1::text[])`,
    [FIXTURE_URLS]
  );
  assert.strictEqual(rows.length, 7);
  for (const r of rows) {
    assert.ok(r.resolved_at, `expected resolved_at on ${r.source_url}`);
    assert.ok(r.resolved_r2_key, `expected resolved_r2_key on ${r.source_url}`);
    assert.strictEqual(r.last_error, null);
  }
});

test('Phase 0 permanent failure (SSRF) marks row failed with attempt_count=1, does not retry', async () => {
  let callCount = 0;
  const ssrfError = new Error('SSRF guard: refused private/loopback IP 10.0.0.1 for example.com');
  const fetchToBuffer = async (url) => {
    callCount++;
    if (url === 'https://example.com/resume-alpha.pdf') throw ssrfError;
    return { buffer: Buffer.from('x'), contentType: 'image/jpeg', originalUrl: url };
  };
  const { uploadToR2, captureMessage, uploadedKeys } = makeMocks({});
  const result = await phase0.run({
    ccDir: FIXTURES_DIR,
    fetchToBuffer,
    uploadToR2,
    captureMessage,
  });

  // The SSRF URL fails permanently (no in-memory retry inside fetchToBuffer is
  // exercised here — we mock it — so we just verify exactly 1 fetch call per URL).
  assert.strictEqual(callCount, 7);
  assert.strictEqual(result.failed, 1);
  assert.strictEqual(result.resolved, 6);
  assert.strictEqual(uploadedKeys.length, 6);

  const { rows } = await pool.query(
    `SELECT attempt_count, last_error, resolved_at FROM cc_import_phase0_failures WHERE source_url = $1`,
    ['https://example.com/resume-alpha.pdf']
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].attempt_count, 1);
  assert.strictEqual(rows[0].resolved_at, null);
  assert.match(rows[0].last_error, /SSRF guard/);
});

test('Phase 0 retry path: URL fails on first run then succeeds on second run', async () => {
  // Run 1: alpha fails, others succeed.
  const fail1 = new Error('Network: ECONNRESET');
  const fetch1 = async (url) => {
    if (url === 'https://example.com/resume-alpha.pdf') throw fail1;
    return { buffer: Buffer.from('x'), contentType: 'image/jpeg', originalUrl: url };
  };
  const { uploadToR2, captureMessage } = makeMocks({});
  const r1 = await phase0.run({ ccDir: FIXTURES_DIR, fetchToBuffer: fetch1, uploadToR2, captureMessage });
  assert.strictEqual(r1.failed, 1);
  assert.strictEqual(r1.resolved, 6);

  const after1 = await pool.query(
    `SELECT attempt_count, resolved_at FROM cc_import_phase0_failures WHERE source_url = $1`,
    ['https://example.com/resume-alpha.pdf']
  );
  assert.strictEqual(after1.rows[0].attempt_count, 1);
  assert.strictEqual(after1.rows[0].resolved_at, null);

  // Run 2: everything succeeds. Resolved URLs are skipped; the failed alpha
  // URL is re-attempted and now resolves.
  const fetch2 = async (url) => ({ buffer: Buffer.from('x'), contentType: 'image/jpeg', originalUrl: url });
  const r2 = await phase0.run({ ccDir: FIXTURES_DIR, fetchToBuffer: fetch2, uploadToR2, captureMessage });

  // On run 2, the 6 already-resolved URLs are skipped, only alpha is reattempted and resolves.
  assert.strictEqual(r2.processed, 7);
  assert.strictEqual(r2.skipped, 6);
  assert.strictEqual(r2.resolved, 1);
  assert.strictEqual(r2.failed, 0);

  const after2 = await pool.query(
    `SELECT attempt_count, resolved_at, resolved_r2_key FROM cc_import_phase0_failures WHERE source_url = $1`,
    ['https://example.com/resume-alpha.pdf']
  );
  assert.ok(after2.rows[0].resolved_at, 'alpha should be resolved after run 2');
  assert.ok(after2.rows[0].resolved_r2_key, 'alpha should have an r2 key');
  // attempt_count incremented on the resolving UPSERT.
  assert.strictEqual(after2.rows[0].attempt_count, 2);
});

test('Phase 0 attempt cap: rows with attempt_count >= 10 are skipped', async () => {
  // Preseed a failure row at the cap.
  const url = 'https://example.com/w9-delta.jpg';
  await pool.query(
    `INSERT INTO cc_import_phase0_failures
       (source_url, source_entity, source_row_hash, attempt_count, last_error, last_attempted_at)
     VALUES ($1, 'wix_payment_info', 'preseed-hash', 10, 'preseed error', NOW())`,
    [url]
  );

  let attemptedDelta = false;
  const fetchToBuffer = async (u) => {
    if (u === url) attemptedDelta = true;
    return { buffer: Buffer.from('x'), contentType: 'image/jpeg', originalUrl: u };
  };
  const { uploadToR2, captureMessage } = makeMocks({});
  const result = await phase0.run({ ccDir: FIXTURES_DIR, fetchToBuffer, uploadToR2, captureMessage });

  assert.strictEqual(attemptedDelta, false, 'over-cap URL must not be re-attempted');
  assert.strictEqual(result.skipped, 1, 'the capped URL is the one skip');
  assert.strictEqual(result.resolved, 6);

  // Row stays at attempt_count=10, last_error unchanged.
  const { rows } = await pool.query(
    `SELECT attempt_count, last_error, resolved_at FROM cc_import_phase0_failures WHERE source_url = $1`,
    [url]
  );
  assert.strictEqual(rows[0].attempt_count, 10);
  assert.strictEqual(rows[0].last_error, 'preseed error');
  assert.strictEqual(rows[0].resolved_at, null);
});

test('Phase 0 already-resolved rows are skipped (not re-fetched)', async () => {
  const url = 'https://example.com/gallery-1.jpg';
  await pool.query(
    `INSERT INTO cc_import_phase0_failures
       (source_url, source_entity, source_row_hash, attempt_count,
        last_error, last_attempted_at, resolved_at, resolved_r2_key)
     VALUES ($1, 'cc_invoice', 'preseed', 1, NULL, NOW(), NOW(), 'legacy/cc/inv-001/gallery/preseed.jpg')`,
    [url]
  );

  let attemptedGallery = false;
  const fetchToBuffer = async (u) => {
    if (u === url) attemptedGallery = true;
    return { buffer: Buffer.from('x'), contentType: 'image/jpeg', originalUrl: u };
  };
  const { uploadToR2, captureMessage } = makeMocks({});
  const result = await phase0.run({ ccDir: FIXTURES_DIR, fetchToBuffer, uploadToR2, captureMessage });

  assert.strictEqual(attemptedGallery, false, 'resolved URL must not be re-fetched');
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.resolved, 6);

  // Existing resolved_r2_key untouched.
  const { rows } = await pool.query(
    `SELECT resolved_r2_key FROM cc_import_phase0_failures WHERE source_url = $1`,
    [url]
  );
  assert.strictEqual(rows[0].resolved_r2_key, 'legacy/cc/inv-001/gallery/preseed.jpg');
});

test('Phase 0 given-up rows are skipped (counted as resolved by sunset gate)', async () => {
  const url = 'https://example.com/video-1.mp4';
  await pool.query(
    `INSERT INTO cc_import_phase0_failures
       (source_url, source_entity, source_row_hash, attempt_count,
        last_error, last_attempted_at, given_up_at, given_up_reason)
     VALUES ($1, 'cc_invoice', 'preseed', 10, 'dead', NOW(), NOW(), 'URL permanently dead')`,
    [url]
  );

  let attemptedVideo = false;
  const fetchToBuffer = async (u) => {
    if (u === url) attemptedVideo = true;
    return { buffer: Buffer.from('x'), contentType: 'image/jpeg', originalUrl: u };
  };
  const { uploadToR2, captureMessage } = makeMocks({});
  const result = await phase0.run({ ccDir: FIXTURES_DIR, fetchToBuffer, uploadToR2, captureMessage });

  assert.strictEqual(attemptedVideo, false);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.resolved, 6);
});

test('Phase 0 --retry-from-db only processes URLs already in the failures table', async () => {
  const url = 'https://example.com/w9-beta.pdf';
  await pool.query(
    `INSERT INTO cc_import_phase0_failures
       (source_url, source_entity, source_row_hash, attempt_count, last_error, last_attempted_at)
     VALUES ($1, 'wix_contractor', 'preseed', 2, 'prior error', NOW())`,
    [url]
  );

  const calledFor = [];
  const fetchToBuffer = async (u) => {
    calledFor.push(u);
    return { buffer: Buffer.from('x'), contentType: 'image/jpeg', originalUrl: u };
  };
  const { uploadToR2, captureMessage } = makeMocks({});
  const result = await phase0.run({
    ccDir: FIXTURES_DIR,
    retryFromDb: true,
    fetchToBuffer,
    uploadToR2,
    captureMessage,
  });

  // Only the preseeded URL is fetched; the other 6 are skipped because they're
  // not in the failures table.
  assert.deepStrictEqual(calledFor, [url]);
  assert.strictEqual(result.processed, 7);
  assert.strictEqual(result.skipped, 6);
  assert.strictEqual(result.resolved, 1);
  assert.strictEqual(result.failed, 0);
});

// Unit-test the SSRF guard in isolation since it has security-critical logic.
test('isPrivateIp identifies all 6 required private ranges', () => {
  // IPv4 ranges from spec §8.0
  assert.strictEqual(httpFetchLib.isPrivateIp('10.0.0.1'), true);
  assert.strictEqual(httpFetchLib.isPrivateIp('10.255.255.254'), true);
  assert.strictEqual(httpFetchLib.isPrivateIp('172.16.0.1'), true);
  assert.strictEqual(httpFetchLib.isPrivateIp('172.31.255.254'), true);
  assert.strictEqual(httpFetchLib.isPrivateIp('192.168.1.1'), true);
  assert.strictEqual(httpFetchLib.isPrivateIp('127.0.0.1'), true);
  assert.strictEqual(httpFetchLib.isPrivateIp('169.254.169.254'), true); // AWS metadata
  // IPv6 link-local
  assert.strictEqual(httpFetchLib.isPrivateIp('fe80::1'), true);
  assert.strictEqual(httpFetchLib.isPrivateIp('fe80:0000:0000:0000:abcd:abcd:abcd:abcd'), true);
  // Public IPs allowed
  assert.strictEqual(httpFetchLib.isPrivateIp('8.8.8.8'), false);
  assert.strictEqual(httpFetchLib.isPrivateIp('1.1.1.1'), false);
  assert.strictEqual(httpFetchLib.isPrivateIp('172.32.0.1'), false); // just outside 172.16/12
  assert.strictEqual(httpFetchLib.isPrivateIp('2001:4860:4860::8888'), false); // public IPv6
});

test('isAllowedType allows image/*, application/pdf, video/* only', () => {
  assert.strictEqual(httpFetchLib.isAllowedType('image/jpeg'), true);
  assert.strictEqual(httpFetchLib.isAllowedType('image/png; charset=binary'), true);
  assert.strictEqual(httpFetchLib.isAllowedType('application/pdf'), true);
  assert.strictEqual(httpFetchLib.isAllowedType('video/mp4'), true);
  assert.strictEqual(httpFetchLib.isAllowedType('text/html'), false);
  assert.strictEqual(httpFetchLib.isAllowedType('application/octet-stream'), false);
  assert.strictEqual(httpFetchLib.isAllowedType(''), false);
  assert.strictEqual(httpFetchLib.isAllowedType(null), false);
});

test('isPermanentFailure flags SSRF, size, content-type — not network errors', () => {
  assert.strictEqual(httpFetchLib.isPermanentFailure(new Error('SSRF guard: refused')), true);
  assert.strictEqual(httpFetchLib.isPermanentFailure(new Error('Size exceeded: 100')), true);
  assert.strictEqual(httpFetchLib.isPermanentFailure(new Error('Disallowed content-type: text/html')), true);
  assert.strictEqual(httpFetchLib.isPermanentFailure(new Error('ECONNRESET')), false);
  assert.strictEqual(httpFetchLib.isPermanentFailure(new Error('Server error 502')), false);
});

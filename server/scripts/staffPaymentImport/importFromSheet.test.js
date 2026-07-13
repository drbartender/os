// Pure-logic tests for the retraction guard (VECTOR 2). NO DB. importFromSheet is
// insert/update-only: a row imported by a prior --execute run, later corrected to
// ignore/unsure in the sheet, silently persists in the ledger. findOrphanedFinger-
// prints compares the prior run logs against the current toImport so the import
// (and verifyImport) can REFUSE rather than let the orphan rot. readPriorRunLogs
// globs the durable import-run-*.json logs out of the review dir.
// Run: node --test server/scripts/staffPaymentImport/importFromSheet.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  findOrphanedFingerprints, readPriorRunLogs, readRetractions,
  findReimportedRetractions, runLogUserIds,
} = require('./importFromSheet');

const toImport = (fps) => fps.map((fp) => ({ fingerprint: fp }));

test('a fingerprint in a prior run log but absent from toImport is orphaned', () => {
  const priorLogs = [{ fingerprints: ['fp-a', 'fp-b'] }];
  assert.deepStrictEqual(findOrphanedFingerprints(priorLogs, toImport(['fp-a'])), ['fp-b']);
});

test('no orphans when every prior fingerprint is still in toImport', () => {
  const priorLogs = [{ fingerprints: ['fp-a', 'fp-b'] }];
  assert.deepStrictEqual(findOrphanedFingerprints(priorLogs, toImport(['fp-a', 'fp-b', 'fp-c'])), []);
});

test('no prior logs ⇒ no orphans', () => {
  assert.deepStrictEqual(findOrphanedFingerprints([], toImport(['fp-a'])), []);
});

test('orphans union across multiple prior logs, deduped and sorted', () => {
  const priorLogs = [{ fingerprints: ['fp-b', 'fp-a'] }, { fingerprints: ['fp-a', 'fp-c'] }];
  assert.deepStrictEqual(findOrphanedFingerprints(priorLogs, toImport([])), ['fp-a', 'fp-b', 'fp-c']);
});

test('a run log with no fingerprints array is ignored (no throw)', () => {
  assert.deepStrictEqual(findOrphanedFingerprints([{}, null, { fingerprints: ['fp-a'] }], toImport([])), ['fp-a']);
});

test('readPriorRunLogs globs import-run-*.json (and ignores other files) from a review dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spi-e-runlogs-'));
  try {
    fs.writeFileSync(path.join(dir, 'import-run-2026-01-01T00-00-00-000Z.json'), JSON.stringify({ fingerprints: ['fp-a'] }));
    fs.writeFileSync(path.join(dir, 'import-run-2026-02-02T00-00-00-000Z.json'), JSON.stringify({ fingerprints: ['fp-b'] }));
    fs.writeFileSync(path.join(dir, 'people.csv'), 'not a run log');
    fs.writeFileSync(path.join(dir, 'reconciliation-report.csv'), 'nope');
    const logs = readPriorRunLogs(dir);
    assert.strictEqual(logs.length, 2);
    assert.deepStrictEqual(logs.flatMap((l) => l.fingerprints).sort(), ['fp-a', 'fp-b']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readPriorRunLogs returns [] for a missing dir', () => {
  assert.deepStrictEqual(readPriorRunLogs(path.join(os.tmpdir(), 'spi-e-does-not-exist-zzz')), []);
});

// End-to-end of the pure guard: a prior run imported {a,b}; the sheet was later
// corrected so b is no longer staff-pay → b is orphaned and the import must refuse.
test('the retraction guard flags a fingerprint dropped from the sheet since a prior run', () => {
  const priorRunLogs = [{ fingerprints: ['fp-a', 'fp-b'] }];
  const currentToImport = toImport(['fp-a']); // b corrected to ignore/unsure
  const orphaned = findOrphanedFingerprints(priorRunLogs, currentToImport);
  assert.deepStrictEqual(orphaned, ['fp-b']);
});

// ==== E2: retraction lifecycle ==============================================

// A recorded retraction excludes the fingerprint from the orphan set, so a
// legitimate retraction unsticks future runs without deleting any run log.
test('findOrphanedFingerprints excludes retracted fingerprints', () => {
  const priorRunLogs = [{ fingerprints: ['fp-a', 'fp-b', 'fp-c'] }];
  // fp-b and fp-c are gone from the sheet; fp-b was formally retracted → only fp-c orphaned.
  assert.deepStrictEqual(findOrphanedFingerprints(priorRunLogs, toImport(['fp-a']), ['fp-b']), ['fp-c']);
  // everything dropped is retracted → no orphans.
  assert.deepStrictEqual(findOrphanedFingerprints(priorRunLogs, toImport(['fp-a']), ['fp-b', 'fp-c']), []);
});

// Code review: a corrupt/unparseable run log must be a HARD ERROR naming the
// file (fail closed), never silently dropped — a dropped log weakens the union.
test('readPriorRunLogs throws (naming the file) on a corrupt run log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spi-e-corrupt-'));
  try {
    fs.writeFileSync(path.join(dir, 'import-run-2026-01-01T00-00-00-000Z.json'), '{ this is not json');
    assert.throws(() => readPriorRunLogs(dir), /import-run-2026-01-01T00-00-00-000Z\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readRetractions reads fingerprints from retractions.json; [] when missing; throws on corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spi-e-retract-'));
  try {
    assert.deepStrictEqual(readRetractions(dir), []); // missing file
    fs.writeFileSync(path.join(dir, 'retractions.json'), JSON.stringify({ fingerprints: ['fp-x', 'fp-y'] }));
    assert.deepStrictEqual(readRetractions(dir), ['fp-x', 'fp-y']);
    fs.writeFileSync(path.join(dir, 'retractions.json'), '{ nope');
    assert.throws(() => readRetractions(dir), /retractions\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ==== E2 residue: retractions never reconcile ================================

// A retracted fingerprint that REAPPEARS as staff-pay in the current sheet must be
// a HARD ERROR — a retraction whitelists forever, so a silent re-import (and any
// later re-drop) would be invisible. Explicit un-retract beats silent reconcile.
test('findReimportedRetractions: a toImport fp present in retractions is flagged; disjoint is clean', () => {
  assert.deepStrictEqual(findReimportedRetractions(toImport(['fp-a', 'fp-b']), ['fp-b', 'fp-z']), ['fp-b']);
  assert.deepStrictEqual(findReimportedRetractions(toImport(['fp-a']), ['fp-z']), []);
  assert.deepStrictEqual(findReimportedRetractions(toImport([]), ['fp-z']), []);
});

// verifyImport widens its residue scan to users recorded in surviving run logs, so a
// fully-dropped person's stale rows are still scanned. runLogUserIds unions the
// created/reused/existing user-id arrays the run logs already carry.
test('runLogUserIds unions created/reused/existing user ids across logs (deduped)', () => {
  const logs = [
    { created_user_ids: [1, 2], reused_user_ids: [3], existing_user_ids: [] },
    { created_user_ids: [2], reused_user_ids: [], existing_user_ids: [9] },
  ];
  assert.deepStrictEqual(runLogUserIds(logs).sort((a, b) => a - b), [1, 2, 3, 9]);
  assert.deepStrictEqual(runLogUserIds([{}]), []);
});

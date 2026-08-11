const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MARKETING_TAGS, isValidTag, DO_NOT_CONTACT_ID } = require('./marketingTags');

test('MARKETING_TAGS matches the approved vocabulary in order', () => {
  assert.deepEqual(MARKETING_TAGS.map(t => t.id), [
    'corporate', 'wedding', 'birthday', 'graduation', 'thumbtack',
  ]);
});

test('every tag has a human label', () => {
  for (const t of MARKETING_TAGS) {
    assert.equal(typeof t.label, 'string');
    assert.ok(t.label.length > 0, `${t.id} has no label`);
  }
});

test('isValidTag accepts the vocabulary and rejects everything else', () => {
  assert.equal(isValidTag('corporate'), true);
  assert.equal(isValidTag('Corporate'), false, 'ids are lowercase, no case folding');
  assert.equal(isValidTag('vip'), false);
  assert.equal(isValidTag(''), false);
  assert.equal(isValidTag(null), false);
  assert.equal(isValidTag(undefined), false);
  assert.equal(isValidTag(123), false);
});

test('do-not-contact is NOT a client_tags value', () => {
  assert.equal(DO_NOT_CONTACT_ID, 'do-not-contact');
  assert.equal(isValidTag(DO_NOT_CONTACT_ID), false,
    'backed by clients columns; must never be insertable into client_tags');
});

test('the vocabulary matches the DB CHECK constraint exactly', () => {
  // schema.sql's client_tags_tag_check. Drift here means a valid-looking tag
  // 23514s at insert time instead of 400ing at validation time.
  const sql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  const m = sql.match(/client_tags_tag_check[\s\S]*?CHECK \(tag IN \(([^)]*)\)\)/);
  assert.ok(m, 'client_tags_tag_check not found in schema.sql');
  const inCheck = m[1].split(',').map(s => s.trim().replace(/'/g, ''));
  assert.deepEqual(inCheck.sort(), MARKETING_TAGS.map(t => t.id).sort());
});

test('the client mirror is byte-identical in ids and labels', () => {
  // Client and server bundles are separate, so these are hand-synced (the
  // eventTypes.js / gratuityLabels.js arrangement). A silent divergence shows
  // up as a tag the UI offers and the API rejects.
  const mirror = fs.readFileSync(
    path.join(__dirname, '../../client/src/utils/marketingTags.js'), 'utf8');
  for (const t of MARKETING_TAGS) {
    assert.ok(mirror.includes(`id: '${t.id}'`), `client mirror missing id ${t.id}`);
    assert.ok(mirror.includes(`label: '${t.label}'`), `client mirror missing label ${t.label}`);
  }
  assert.ok(mirror.includes(`DO_NOT_CONTACT_ID = '${DO_NOT_CONTACT_ID}'`),
    'client mirror missing DO_NOT_CONTACT_ID');
  // The mirror must not invent tags the server does not know.
  const mirrorIds = [...mirror.matchAll(/id: '([a-z-]+)'/g)].map(m2 => m2[1]);
  assert.deepEqual(mirrorIds, MARKETING_TAGS.map(t => t.id),
    'client mirror has extra or reordered tags');
});

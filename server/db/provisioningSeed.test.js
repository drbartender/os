const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

// requires_provisioning drives two things: the shift's supply_run_required
// default (eventCreation.computeSupplyRunDefault) and the $20
// equipment_supplies / $50 hosted_supplies duty lines (dutyLines.js). A seeded
// add-on left out of the seed list is silently "no supply run": the three BYOB
// bundles and the class supply packs sat that way until 2026-09-28. This test
// makes every add-on schema.sql seeds take a side, so the next one cannot slip
// through by omission.

// Staffing and pure-fee add-ons: DRB neither buys nor carries anything for them.
const NOT_PROVISIONING = new Set([
  'additional-bartender', 'barback', 'banquet-server', 'parking-fee',
]);

const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

function seededAddonSlugs() {
  const slugs = new Set();
  const inserts = sql.match(/INSERT INTO service_addons[\s\S]*?ON CONFLICT \(slug\) DO NOTHING;/g) || [];
  for (const stmt of inserts) {
    // VALUES rows open a line with ('slug', and the INSERT ... SELECT form
    // reads SELECT 'slug',
    for (const m of stmt.matchAll(/(?:^\s*\(|SELECT)\s*'([a-z0-9-]+)',/gm)) slugs.add(m[1]);
  }
  return slugs;
}

function provisioningSlugs() {
  const blocks = [...sql.matchAll(
    /UPDATE service_addons SET requires_provisioning = true WHERE slug IN \(([\s\S]*?)\);/g,
  )];
  assert.equal(blocks.length, 1, 'expected exactly one requires_provisioning seed statement');
  return new Set([...blocks[0][1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]));
}

test('the parser finds the add-on seed (guards against a vacuous pass)', () => {
  const seeded = seededAddonSlugs();
  assert.ok(seeded.size >= 40, `only ${seeded.size} seeded add-ons parsed`);
  for (const slug of ['the-formula', 'parking-fee', 'mixology-101-supplies', 'class-tool-kit-rental']) {
    assert.ok(seeded.has(slug), `parser missed ${slug}`);
  }
});

test('every seeded add-on is either provisioning or explicitly not', () => {
  const seeded = seededAddonSlugs();
  const prov = provisioningSlugs();
  const unclassified = [...seeded].filter((s) => !prov.has(s) && !NOT_PROVISIONING.has(s));
  assert.deepEqual(unclassified, [],
    'add to the requires_provisioning seed in schema.sql, or to NOT_PROVISIONING here if DRB buys and carries nothing for it');
});

test('no add-on is on both sides, and the seed names no unknown slug', () => {
  const seeded = seededAddonSlugs();
  const prov = provisioningSlugs();
  assert.deepEqual([...NOT_PROVISIONING].filter((s) => prov.has(s)), []);
  assert.deepEqual([...prov].filter((s) => !seeded.has(s)), [],
    'a slug in the seed list that no INSERT creates is a typo: the UPDATE silently matches nothing');
});

test('the BYOB bundles are provisioning (the 2026-09-28 omission)', () => {
  const prov = provisioningSlugs();
  for (const slug of ['the-foundation', 'the-formula', 'the-full-compound']) {
    assert.ok(prov.has(slug), `${slug} must set supply_run_required`);
  }
});

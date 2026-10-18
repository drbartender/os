'use strict';
// run.js (plan 2026-10-16-price-override-removal, Task V3): the change set, the
// report and both blocks from one plan, and the step-5 compare that decides
// whether a re-cut branch produced the same conversion. Pure.
//   node --test scripts/override-conversion/run.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { calculateProposal } = require('../../server/utils/pricingEngine');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runConversion, diffChangeSets, reportText, runCli } = require('./run');

const PKG = {
  id: 9001, slug: 'test-pkg', name: 'Test Package', category: 'hosted', pricing_type: 'per_guest',
  base_rate_4hr: 30, base_rate_4hr_small: 35, extra_hour_rate: 6, extra_hour_rate_small: 7, min_guests: 50,
  guests_per_bartender: 100, bar_type: 'full_bar', includes: [], first_bar_fee: 75, additional_bar_fee: 125,
};
const price = (override = null) => JSON.parse(JSON.stringify(calculateProposal({
  pkg: PKG, guestCount: 120, durationHours: 4, numBars: 1, numBartenders: null, addons: [], syrupSelections: [],
  adjustments: [], totalPriceOverride: override, gratuityRate: 0, tipJar: true, gratuityFloorRate: null,
})));
const row = (id, status, override) => ({
  id, status, total_price: override.toFixed(2), amount_paid: '0.00', total_price_override: override.toFixed(2),
  adjustments: [], adjustments_type: 'array', pricing_snapshot: price(override), money_md5: 'a'.repeat(32),
  refunds: [], addons: [], additional_services_invoices: [], pending_change_requests: [],
});
const exportData = { rows: [row(5001, 'archived', 1500), row(5002, 'confirmed', 2000)] };
const freshOf = () => ({ rows: [{ id: 5002, money_md5: 'a'.repeat(32), freshServiceCents: Math.round(price().total * 100), snapshot: price() }] });

test('one plan feeds the change set, the report and both blocks', () => {
  const out = runConversion({ exportData, freshData: freshOf(), extraHeldIds: [] });
  assert.equal(out.planned.changes.length, 2);
  assert.match(out.forward, new RegExp(`run ${out.tag}`));
  assert.match(out.reverse, new RegExp(`run ${out.tag}`));
  const text = reportText(out.tag, out.planned, '2026-10-18T00:00:00Z');
  assert.match(text, /5001 archived override_terminal/);
  assert.match(text, /5002 confirmed override_live/);
  assert.match(text, /Agreed price adjustment/);
  assert.match(text, /5002 confirmed override_live .*payroll gratuity \$0\.00 -> \$0\.00/);
  assert.match(text, /Payroll gratuity pool moves \(staff pay\): none/);
  const moved = structuredClone(out.planned);
  Object.assign(moved.report[1], { payrollGratuityBeforeCents: 6000, payrollGratuityAfterCents: 0, payrollGratuityChanged: true });
  assert.match(reportText(out.tag, moved, 'x'), /Payroll gratuity pool moves \(staff pay\): 5002 \$60\.00 -> \$0\.00/);
});

test('a held id stays out of the run entirely', () => {
  const out = runConversion({ exportData, freshData: freshOf(), extraHeldIds: [5001] });
  assert.deepEqual(out.planned.changes.map((c) => c.id), [5002]);
  assert.ok(!out.forward.includes('5001') && !out.reverse.includes('5001'));
});

test('the compare ignores the fresh compute\'s timestamp and catches anything else', () => {
  const a = runConversion({ exportData, freshData: freshOf(), extraHeldIds: [] }).planned.changes;
  const later = freshOf();
  later.rows[0].snapshot.calculated_at = '2099-01-01T00:00:00.000Z';
  const b = runConversion({ exportData, freshData: later, extraHeldIds: [] }).planned.changes;
  assert.deepEqual(diffChangeSets(a, b), [], 'a re-run of the same rows is identical');
  const moved = structuredClone(b);
  moved[0].lines[0].amount += 1;
  assert.deepEqual(diffChangeSets(a, moved), [5001]);
  assert.deepEqual(diffChangeSets(a, b.slice(1)), [5001], 'a missing booking differs');
  const md5 = structuredClone(b);
  md5[1].money_md5 = 'b'.repeat(32);
  assert.deepEqual(diffChangeSets(a, md5), [5002]);
});

// Fix round (code MAJOR-1): the step-5 compare must read the change set Dallas
// approved before anything is written, and can never compare a run with itself
// or overwrite the approved dry run.
function inputs(dir, override = 2000) {
  const exp = structuredClone(exportData);
  exp.rows[1].total_price_override = override.toFixed(2);
  fs.writeFileSync(path.join(dir, 'export.json'), JSON.stringify(exp));
  fs.writeFileSync(path.join(dir, 'fresh.json'), JSON.stringify(freshOf()));
  return [path.join(dir, 'export.json'), path.join(dir, 'fresh.json')];
}
const noGuard = () => {}; // the deployed-code guard has its own suite (guard.test.js)
const quiet = { log: () => {}, guard: noGuard };
const snapshotDir = (d) => Object.fromEntries(fs.readdirSync(d).sort().map((f) => [f, fs.readFileSync(path.join(d, f), 'utf8')]));

test('a compare path inside the out-dir is refused before anything is written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-run-'));
  const [exp, fresh] = inputs(dir);
  const run1 = path.join(dir, 'run1');
  assert.equal(runCli([exp, fresh, run1], quiet), 0);
  const approved = snapshotDir(run1);
  assert.throws(() => runCli([exp, fresh, run1, '--compare', path.join(run1, 'changes.json')], quiet), /outside the out-dir/);
  const run2 = path.join(dir, 'run2');
  assert.throws(() => runCli([exp, fresh, run2, '--compare', path.join(run2, 'changes.json')], quiet), /outside the out-dir/);
  assert.equal(fs.existsSync(run2), false, 'nothing written');
  assert.deepEqual(snapshotDir(run1), approved, 'the approved dry run is untouched');
});

test('a non-empty out-dir is refused, so no run overwrites another', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-run-'));
  const [exp, fresh] = inputs(dir);
  const run1 = path.join(dir, 'run1');
  runCli([exp, fresh, run1], quiet);
  const approved = snapshotDir(run1);
  assert.throws(() => runCli([exp, fresh, run1], quiet), /not empty/);
  assert.deepEqual(snapshotDir(run1), approved);
});

test('step 5: a different change set exits 2, the same one exits 0, the approved run is untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-run-'));
  const [exp, fresh] = inputs(dir);
  const run1 = path.join(dir, 'run1');
  runCli([exp, fresh, run1], quiet);
  const approved = snapshotDir(run1);
  const cmp = ['--compare', path.join(run1, 'changes.json')];
  assert.equal(runCli([exp, fresh, path.join(dir, 'run2'), ...cmp], quiet), 0);
  const moved = path.join(dir, 'moved');
  fs.mkdirSync(moved);
  const [exp3, fresh3] = inputs(moved, 2001);
  const lines = [];
  assert.equal(runCli([exp3, fresh3, path.join(dir, 'run3'), ...cmp], { log: (l) => lines.push(l), guard: noGuard }), 2);
  assert.ok(lines.some((l) => /DIFFERS/.test(l) && /5002/.test(l)));
  assert.deepEqual(snapshotDir(run1), approved);
  assert.throws(() => runCli([exp, fresh, path.join(dir, 'run4'), '--compare', exp], quiet), /not a changes\.json/);
  assert.equal(fs.existsSync(path.join(dir, 'run4')), false, 'an unreadable compare stops the run before any write');
});

// Fix round (database MINOR 1, code MINOR-2): a reverse for a subset of rows
// keeps the whole run's tag, so it finds those rows' activity entries.
const { renderForwardBlock, renderReverseBlock } = require('./doBlock');
const { reverseCli } = require('./reverse');

test('a subset reverse keeps the run tag of the whole set and names only its rows', () => {
  const { planned, tag } = runConversion({ exportData, freshData: freshOf(), extraHeldIds: [] });
  const sql = renderReverseBlock(planned.changes, { onlyIds: [5002] });
  assert.ok(sql.includes(`run ${tag}`) && sql.includes(`'run' = '${tag}'`));
  assert.equal(sql.match(/v_ids integer\[\] := '\{([0-9,]+)\}'/)[1], '5002');
  assert.throws(() => renderReverseBlock(planned.changes, { onlyIds: [9999] }), /not in the change set/);
  assert.throws(() => renderReverseBlock(planned.changes, { onlyIds: [] }), /no rows/);
  assert.match(renderForwardBlock(planned.changes), /FOR NO KEY UPDATE/);
  assert.match(renderForwardBlock(planned.changes), /set_config\('lock_timeout', '5s', true\)/);
  assert.match(sql, /FOR NO KEY UPDATE/);
});

test('the renderer refuses breakdown rows that do not match their lines', () => {
  const { planned } = runConversion({ exportData, freshData: freshOf(), extraHeldIds: [] });
  const bad = structuredClone(planned.changes);
  const c = bad.find((x) => x.placement !== 'none');
  c.breakdownRows[0].visible = !c.breakdownRows[0].visible;
  assert.throws(() => renderForwardBlock(bad), /breakdown rows do not match/);
});

test('reverse.js renders the subset from changes.json, checks its tag, and never overwrites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-rev-'));
  const [exp, fresh] = inputs(dir);
  runCli([exp, fresh, path.join(dir, 'run1')], quiet);
  const changes = path.join(dir, 'run1', 'changes.json');
  const out = path.join(dir, 'reverse-rest.sql');
  assert.equal(reverseCli([changes, out, '--except', '5001'], quiet), 0);
  const sql = fs.readFileSync(out, 'utf8');
  assert.equal(sql.match(/v_ids integer\[\] := '\{([0-9,]+)\}'/)[1], '5002');
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.throws(() => reverseCli([changes, out, '--except', '5001'], quiet), /exists/);
  const edited = JSON.parse(fs.readFileSync(changes, 'utf8'));
  edited.changes[0].lines = [];
  fs.writeFileSync(path.join(dir, 'edited.json'), JSON.stringify(edited));
  assert.throws(() => reverseCli([path.join(dir, 'edited.json'), path.join(dir, 'x.sql'), '--except', '5001'], quiet), /tag/);
  assert.throws(() => reverseCli([changes, path.join(dir, 'y.sql')], quiet), /--except or --only/);
});

test('readUriFile accepts only a URI file branch.js wrote', () => {
  const { readUriFile } = require('./shared');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-uri-'));
  const handMade = path.join(dir, 'prod.uri');
  fs.writeFileSync(handMade, 'postgresql://u:p@host/db');
  assert.throws(() => readUriFile(handMade), /branch\.js/);
  const ours = path.join(dir, 'override-conversion-20261018-0101.uri');
  fs.writeFileSync(ours, 'postgresql://u:p@host/db\n');
  assert.equal(readUriFile(ours), 'postgresql://u:p@host/db');
});

test('the census check stops on an override id outside the census, and reports census ids gone', () => {
  const { checkCensus } = require('./export');
  const rows = [{ id: 11, total_price_override: '100.00' }, { id: 12, total_price_override: null }, { id: 13, total_price_override: '5.00' }];
  assert.deepEqual(checkCensus(rows, [11, 13, 14]), { unexpected: [], missing: [14] });
  assert.deepEqual(checkCensus(rows, [11]), { unexpected: [13], missing: [] });
});

test('a held id in the census file is dropped before any compare or print', () => {
  const { checkCensus } = require('./export');
  const { __setLegalHoldIdsForTest } = require('../../server/utils/legalHold');
  const rows = [{ id: 11, total_price_override: '100.00' }]; // the export never holds a held row
  assert.deepEqual(checkCensus(rows, [11, 15], { extraHeldIds: [15] }), { unexpected: [], missing: [] },
    'never reported as a census id with no override now');
  __setLegalHoldIdsForTest([16]);
  try {
    assert.deepEqual(checkCensus(rows, [11, 16]), { unexpected: [], missing: [] }, 'the seam drops it too');
  } finally {
    __setLegalHoldIdsForTest(null);
  }
});

#!/usr/bin/env node
'use strict';
// The override conversion's dry run (plan 2026-10-16-price-override-removal,
// Task V3; spec 8.5): the export and the fresh compute in; the change set, the
// report and both DO blocks out, all chmod 600 in the scratchpad (they carry
// free-text labels; the repo is public, so none of it is ever committed).
//
//   node scripts/override-conversion/run.js <export.json> <fresh.json> <out-dir>
//        [--also-held <id,...>] [--compare <previous changes.json>]
//
// --compare is runbook step 5: the change set from a re-cut branch against the
// one Dallas read. Identical (ignoring only the fresh compute's timestamp) exits
// 0; anything else lists the ids that differ and exits 2.

const fs = require('fs');
const path = require('path');
const { planConversion, canonical } = require('./transform');
const { renderForwardBlock, renderReverseBlock, runTag } = require('./doBlock');
const { parseIdList, readJson, writePrivate, writePrivateJson, argValue } = require('./shared');

function runConversion({ exportData, freshData, extraHeldIds = [] }) {
  const planned = planConversion({ rows: exportData.rows, fresh: freshData.rows, legalHoldIds: extraHeldIds });
  if (planned.changes.length === 0) return { tag: null, planned, forward: null, reverse: null };
  return {
    tag: runTag(planned.changes), planned,
    forward: renderForwardBlock(planned.changes), reverse: renderReverseBlock(planned.changes),
  };
}

// A change as the compare sees it: everything but the fresh compute's clock.
function comparable(c) {
  const copy = structuredClone(c);
  if (copy.after && copy.after.pricing_snapshot && c.kind === 'override_live') delete copy.after.pricing_snapshot.calculated_at;
  return canonical(copy);
}
function diffChangeSets(a, b) {
  const left = new Map(a.map((c) => [c.id, comparable(c)]));
  const right = new Map(b.map((c) => [c.id, comparable(c)]));
  return [...new Set([...left.keys(), ...right.keys()])].sort((x, y) => x - y)
    .filter((id) => left.get(id) !== right.get(id));
}

const money = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toFixed(2)}`;
const lineText = (l) => `${l.label} ${money(Math.round(l.amount * 100) * (l.type === 'discount' ? -1 : 1))}`;
function reportText(tag, planned, generatedAt) {
  const { report, dallasLists: d, absorbedRefunds } = planned;
  const out = [`Override conversion dry run, run ${tag || 'none'}, ${generatedAt}`,
    `${report.length} bookings change. Ids, kinds and amounts only; labels are the fixed conversion labels.`, ''];
  for (const r of report) {
    const drift = r.catalogDriftCents === null ? '' : `  catalog drift ${money(r.catalogDriftCents)}`;
    const pool = r.kind === 'override_live' || r.payrollGratuityChanged
      ? `  payroll gratuity ${money(r.payrollGratuityBeforeCents)} -> ${money(r.payrollGratuityAfterCents)}${r.payrollGratuityChanged ? ' MOVES' : ''}` : '';
    out.push(`  ${r.id} ${r.status} ${r.kind}  ${r.lines.length ? r.lines.map(lineText).join(', ') : 'even, no line'}`
      + `${drift}${pool}  page ${r.pageVerdict}  invoice ${r.invoiceVerdict}  pending change requests ${r.pendingChangeRequests.length}`);
  }
  out.push('', 'For Dallas:');
  const moves = report.filter((r) => r.payrollGratuityChanged)
    .map((r) => `${r.id} ${money(r.payrollGratuityBeforeCents)} -> ${money(r.payrollGratuityAfterCents)}`);
  out.push(`  Payroll gratuity pool moves (staff pay): ${moves.join('; ') || 'none'}`);
  out.push(`  Row and snapshot lines differ (left unchanged): ${d.snapshotMismatch.map((e) => e.id).join(', ') || 'none'}`);
  out.push(`  Refund with no line but no gap (likely billed again): ${d.refundGapZero.length ? '' : 'none'}`);
  for (const e of d.refundGapZero) {
    out.push(`    ${e.id}: ${e.refunds.map((x) => `refund ${x.id} ${money(x.dropCents)}`
      + `${x.additionalServicesAfter.length ? `, Additional Services after it: ${x.additionalServicesAfter.map((i) => `invoice ${i.id} ${money(i.amount_due)} ${i.status}`).join('; ')}` : ''}`).join('; ')}`);
  }
  out.push(`  Refund gap not equal to the unlined refunds: ${d.refundGapUnequal.length ? '' : 'none'}`);
  for (const e of d.refundGapUnequal) out.push(`    ${e.id}: gap ${money(e.gapCents)}, unlined refunds ${money(e.unbackedCents)}`);
  out.push(`  Not converted: ${d.unconverted.length ? '' : 'none'}`);
  for (const e of d.unconverted) out.push(`    ${e.id} ${e.status} ${e.kind}: ${e.reason}`);
  out.push(`  Refunds absorbed by an agreed-price line: ${absorbedRefunds.map((a) => `${a.proposalId} (refunds ${a.refundIds.join(', ')})`).join('; ') || 'none'}`);
  return `${out.join('\n')}\n`;
}

// A path with its symlinks resolved; for a path that does not exist yet, its
// parent's real path plus its own name.
function realPath(p) {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) return fs.realpathSync(abs);
  return path.join(realPath(path.dirname(abs)), path.basename(abs));
}

/**
 * The CLI. Returns the exit code: 0, or 2 when --compare finds a different
 * change set. Throws (writing nothing) on bad input. The --compare file is
 * read and checked BEFORE anything is written, may not sit inside the out-dir,
 * and the out-dir must be new or empty: a run never compares with itself and
 * never overwrites the dry run Dallas approved (fix round, code MAJOR-1).
 */
function runCli(argv, { log = console.log } = {}) {
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
  const [exportFile, freshFile, outDir] = positional;
  if (!exportFile || !freshFile || !outDir) {
    throw new Error('usage: run.js <export.json> <fresh.json> <out-dir> [--also-held <id,...>] [--compare <changes.json>]');
  }
  const outReal = realPath(outDir);
  const compareFile = argValue(argv, '--compare');
  let approved = null;
  if (compareFile) {
    const compareReal = realPath(compareFile);
    if (compareReal === outReal || compareReal.startsWith(outReal + path.sep)) {
      throw new Error('--compare must name a change set outside the out-dir: the approved dry run stays where it is, untouched');
    }
    try {
      approved = readJson(compareFile);
    } catch (err) {
      throw new Error(`--compare ${compareFile} is not a changes.json (${err.message})`);
    }
    if (!approved || !Array.isArray(approved.changes)) throw new Error(`--compare ${compareFile} is not a changes.json`);
  }
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`${outDir} is not empty: every run writes into a new directory`);
  }
  const generatedAt = new Date().toISOString();
  const { tag, planned, forward, reverse } = runConversion({
    exportData: readJson(exportFile), freshData: readJson(freshFile), extraHeldIds: parseIdList(argValue(argv, '--also-held')),
  });
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const file = (name) => path.join(outDir, name);
  writePrivateJson(file('changes.json'), { tag, generated_at: generatedAt, ...planned });
  writePrivate(file('report.txt'), reportText(tag, planned, generatedAt));
  if (forward) {
    writePrivate(file('forward.sql'), forward);
    writePrivate(file('reverse.sql'), reverse);
  }
  const d = planned.dallasLists;
  const kinds = ['override_live', 'override_terminal', 'refund_backfill']
    .map((k) => `${planned.changes.filter((c) => c.kind === k).length} ${k}`).join(', ');
  log(`run ${tag || 'none'}: ${planned.changes.length} changes (${kinds}); for Dallas: `
    + `${d.snapshotMismatch.length} lines differ, ${d.refundGapZero.length} refund gap 0, `
    + `${d.refundGapUnequal.length} refund gap unequal, ${d.unconverted.length} not converted`);
  log(`wrote ${forward ? 'changes.json, report.txt, forward.sql, reverse.sql' : 'changes.json, report.txt (nothing to convert)'} to ${outDir}`);
  if (!approved) return 0;
  const differ = diffChangeSets(approved.changes, planned.changes);
  log(differ.length ? `change set DIFFERS from ${compareFile}: ${differ.join(', ')}` : `change set identical to ${compareFile}`);
  return differ.length ? 2 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (err) {
    console.error(`run.js: ${err && err.message}`);
    process.exit(1);
  }
}

module.exports = { runConversion, diffChangeSets, reportText, runCli };

'use strict';

// The Established section of the review brief (instruction rewrite step 2,
// lane review-tooling; scripts/review-brief.js renders it, split out in fix
// pass 3 to keep that file under its size line). It carries the pre-step
// result, the code-path sections diff.patch shows only as Binary files lines,
// the tests run with their counts and logs, the client build, what the tiers
// require, and the questions already settled.
//
// Nothing a pre-step result or a run summary holds may add a line to the brief
// or print a raw value: a file or suite name goes through piiShapes.maskPath
// (a segment carrying a shape prints as <SHAPE>), a name holding a control,
// format, line-separator or pipe character (review-select's UNSAFE) prints as
// the fixed marker UNPRINTABLE instead, and a finding text is masked by its
// path and kept on one line. A refusal throws an Error, which the CLI prints
// as its one-line reason (exit 1).

const fs = require('fs');
const path = require('path');
const { parse: parseTap } = require('./tapSummary');
const { mask, maskPath } = require('./piiShapes');
const { isCodePath } = require('../sensitive-match');
const { UNSAFE } = require('../review-select');

const UNPRINTABLE = '(a name the brief cannot print)';

const isObject = (o) => Boolean(o) && typeof o === 'object' && !Array.isArray(o);
const fail = (why) => {
  throw new Error(why);
};

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fail(`${what} ${file} is missing or not JSON`);
  }
}

function readText(file, what) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fail(`${what} ${file} cannot be read`);
  }
}

// A file or suite name as the brief may print it.
const printName = (p) => (UNSAFE.test(String(p)) ? UNPRINTABLE : maskPath(String(p)));
// A text on one line: every control, format and separator character a space.
const oneLine = (s) => String(s).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ');

/**
 * The code-path sections (sensitive-match's isCodePath) that diff.patch shows
 * only as a Binary files line in their header zone.
 * @param {string[]} lines     the diff body's lines
 * @param {{path: string, start: number, end: number}[]} sections
 * @returns {string[]} their paths
 */
function binaryCodeSections(lines, sections) {
  return sections
    .filter((s) => {
      if (!isCodePath(s.path)) return false;
      for (const l of lines.slice(s.start, s.end)) {
        if (l.startsWith('@@')) return false;
        if (/^Binary files .* differ$/.test(l)) return true;
      }
      return false;
    })
    .map((s) => s.path);
}

// One --tests or --smoke entry as Established lines.
function runLines(p, label) {
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    return fail(`${label} ${p} cannot be read`);
  }
  if (!stat.isDirectory()) {
    const s = parseTap(readText(p, 'the log'));
    const name = path.basename(p);
    return [s.found ? `- ${name}: pass ${s.pass}, fail ${s.fail} (log ${p})` : `- ${name}: no TAP summary: a failure, never a zero (log ${p})`];
  }
  const file = path.join(p, 'summary.json');
  const sum = readJson(file, 'the run summary');
  if (!isObject(sum) || !Array.isArray(sum.suites)) fail(`${file} is not a runner summary`);
  const head = `- ${label === 'the smoke' ? 'the smoke, run dir' : 'run dir'} ${p}: ${sum.suites.length} suite(s), pass ${sum.total_pass}, fail ${sum.total_fail}`;
  const notes = [];
  if (sum.skipped === true) notes.push('SKIPPED (no Neon key resolved): not a pass');
  if (sum.did_not_run) notes.push(`did not run: ${oneLine(mask(String(sum.did_not_run)))}`);
  const lines = [`${head}${notes.length ? `, ${notes.join(', ')}` : ''} (summary ${file})`];
  for (const s of sum.suites) lines.push(`  - ${printName(s.file)}: pass ${s.pass}, fail ${s.fail}${s.ok === false ? ', not ok' : ''}`);
  return lines;
}

/**
 * The Established section's text.
 * @param {object} o
 * @param {object} o.pre     static-checks.js output
 * @param {object} o.opts    review-brief's options: tests, smoke, build, buildExit, settled
 * @param {object} o.sel     select.json
 * @param {string[]} [o.binary]  binaryCodeSections of the diff
 */
function established({ pre, opts, sel, binary = [] }) {
  const where = (f) => (f.file === null || f.file === undefined ? '(no file)' : f.line === null || f.line === undefined ? printName(f.file) : `${printName(f.file)}:${f.line}`);
  const n = (v) => (v === undefined || v === null ? 'unknown' : v);
  const out = [`Static pre-step (scripts/static-checks.js): ${n(pre.files)} file(s) in the diff, blocking ${pre.blocking}, allowed ${n(pre.allowed)}, eslint linted ${n(pre.eslint_files)} file(s).`];
  if (pre.findings.length === 0) out.push('- No finding.');
  // Masked again by the finding's path: already-masked text is unchanged.
  for (const f of pre.findings) out.push(`- ${oneLine(f.rule)} ${where(f)}: ${oneLine(mask(String(f.text), { path: f.file }))}${f.allowed ? ' (allowed by its marker)' : ''}`);
  out.push('', `Binary sections on code paths: ${binary.length ? `${binary.map(printName).join(', ')}; the diff hides their content, a finding to name.` : 'none.'}`);
  out.push('', 'Tests run before this brief:');
  const runs = [...opts.tests.flatMap((p) => runLines(p, 'the run')), ...(opts.smoke ? runLines(opts.smoke, 'the smoke') : [])];
  if (opts.build) {
    readText(opts.build, 'the build log');
    out.push(...runs, `- client build: exit ${opts.buildExit}, ${Number(opts.buildExit) === 0 ? 'green' : 'failed'} (log ${opts.build})`);
  } else {
    out.push(...(runs.length ? runs : ['- None were given to this brief.']));
  }
  const t = sel.tests;
  out.push('', `The tiers require: ${t.smoke ? 'the smoke' : 'no smoke'}; the reached suites: ${t.suites.length ? t.suites.map(printName).join(', ') : 'none reached'}; ${t.client_build ? 'the client build' : 'no client build'}.`);
  if (opts.settled) out.push('', 'Questions already settled:', '', mask(readText(opts.settled, 'the settled file')).trimEnd());
  return out.join('\n');
}

module.exports = { established, binaryCodeSections, runLines, printName, UNPRINTABLE };

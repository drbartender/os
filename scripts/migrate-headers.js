#!/usr/bin/env node
'use strict';

/*
 * migrate-headers.js: the one-shot migration of the docs' hand mirrors into
 * the code (instruction rewrite step 4, lane migrate-headers; plan 2026-10-27
 * decisions 2, 6 and 8, the contract "scripts/migrate-headers.js"). It stays on
 * main after its run as the record of what the migration did (decision 17).
 *
 *   node scripts/migrate-headers.js headers [--readme <path>] [--write] [--dropped <file>]
 *   node scripts/migrate-headers.js route-rows [--arch <path>] [--max-chars 400] [--write]
 *   node scripts/migrate-headers.js route-notes [--arch <path>]
 *   node scripts/migrate-headers.js env-draft [--readme <path>] [--claude <path>] --out <file>
 *   node scripts/migrate-headers.js env-check [--readme <path>] [--claude <path>]
 *
 * --readme, --arch and --claude default to README.md, ARCHITECTURE.md and
 * .claude/CLAUDE.md at HEAD, read through git, so a later lane can run these
 * after the tables are gone from its working tree. The source files and
 * .env.example are read from the working tree of the repo the command runs
 * in. Every command is a dry run that prints counts unless --write.
 *
 *   headers      every source file (genDocs/headers.isSource) with no header
 *                gets README's tree description for its path, or the form
 *                generated from its exports (readmeTree.js), as `//` lines
 *                wrapped at 100 and one blank line at insertionPoint (moved
 *                above an eslint-disable-next-line directly over it). Prints
 *                `described: <n>, generated: <n>, skipped (has header): <n>,
 *                dropped files: <n>`, the last the README-described files that
 *                are not source files and so take no header. --dropped writes
 *                the directory and route-group descriptions, the continuation
 *                lines and those files' descriptions, `<path>: <text>`, in
 *                either mode.
 *   route-rows   ARCHITECTURE's route rows moved above their handlers when the
 *                match is unambiguous (archRows.js, decision 8). Prints
 *                `moved: <n>, left: <n>` and the left count by reason.
 *   route-notes  the markdown of the rows route-rows leaves and the prose under
 *                each heading, for the "Route notes" section. It refuses
 *                (exit 1, the count on stderr, no notes) while any row would
 *                move but its comment is not on disk: run route-rows --write
 *                first.
 *   env-draft    .env.example brought to the convention with each table row
 *                folded above its variable, labelled by source (envTables.js),
 *                written to --out; the table variables the file lacks on
 *                stderr.
 *   env-check    every code span, number and required word of every row in
 *                its variable's block; prints `<VAR>: <token>` per miss (a
 *                phone-shaped token by its last four digits only).
 *
 * Every planned file is checked before it is counted or written: the header
 * or each route comment must read back as written (readHeader, a second route
 * walk), the file must not pass 1,000 lines by the insert (the ratchet), and
 * the change must prove comment-only (scripts/lib/commentOnly.js). For headers,
 * a file that fails is not written, is listed on stderr with the reason, and
 * the command exits 1. For route-rows, a row that fails is not written and
 * nothing goes to stderr: it is counted on stdout under its reason (a file past
 * the cap under "file at cap"; "would not prove comment-only" and "would not
 * read back" printed beside the five reasons when not 0), and it stays a left
 * row, so route-notes prints it.
 *
 * Exit: 0 done; 1 a header not written, an env-check miss, route-notes with a
 * row not yet written, or an error; 2 argv misuse.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('./lib/genDocs/source');
const { isSource, readHeader, insertionPoint, extOf } = require('./lib/genDocs/headers');
const { walk } = require('./lib/genDocs/routes');
const { compareFile } = require('./lib/commentOnly');
const { countLines, FAIL_LIMIT } = require('./check-file-size');
const tree = require('./lib/migrate/readmeTree');
const arch = require('./lib/migrate/archRows');
const env = require('./lib/migrate/envTables');

const COMMANDS = Object.freeze({
  headers: ['readme', 'write', 'dropped'],
  'route-rows': ['arch', 'max-chars', 'write'],
  'route-notes': ['arch'],
  'env-draft': ['readme', 'claude', 'out'],
  'env-check': ['readme', 'claude'],
});
const VALUED = new Set(['readme', 'arch', 'claude', 'dropped', 'max-chars', 'out']);
const USAGE = 'usage: node scripts/migrate-headers.js (headers [--readme <path>] [--write] [--dropped <file>]'
  + ' | route-rows [--arch <path>] [--max-chars 400] [--write] | route-notes [--arch <path>]'
  + ' | env-draft [--readme <path>] [--claude <path>] --out <file> | env-check [--readme <path>] [--claude <path>])';

class UsageError extends Error {}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, cmd || '')) throw new UsageError(cmd ? `unknown command: ${cmd}` : 'no command');
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const m = /^--([a-z-]+)$/.exec(rest[i]);
    if (!m || !COMMANDS[cmd].includes(m[1])) throw new UsageError(`${cmd} does not take ${rest[i]}`);
    if (Object.prototype.hasOwnProperty.call(opts, m[1])) throw new UsageError(`--${m[1]} given twice`);
    if (VALUED.has(m[1])) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`--${m[1]} needs a value`);
      opts[m[1]] = v;
      i += 1;
    } else opts[m[1]] = true;
  }
  if (cmd === 'env-draft' && !opts.out) throw new UsageError('env-draft needs --out <file>');
  if (opts['max-chars'] !== undefined && !/^[1-9]\d*$/.test(opts['max-chars'])) throw new UsageError('--max-chars takes a positive whole number');
  return { cmd, opts };
}

function input(top, flag, rel) {
  if (flag) return fs.readFileSync(path.resolve(process.cwd(), flag), 'utf8');
  try {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: top, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error(`cannot read ${rel} at HEAD`);
  }
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---- headers -----------------------------------------------------------------

function withHeader(text, ext, description) {
  const words = arch.noEmDash(description).replace(/\s+/g, ' ').trim();
  const { lines } = arch.splitText(text);
  let at = insertionPoint(text, ext);
  while (at > 0 && at <= lines.length && /eslint-disable-next-line/.test(lines[at - 1].c) && arch.isDirectiveLine(lines[at - 1].c)) at -= 1;
  const header = arch.commentLines(words, '');
  return { text: arch.insertAt(text, at, at >= lines.length ? header : [...header, '']), expect: words };
}

function refusal(file, before, after, readsBack) {
  if (!readsBack) return 'would not read back';
  const n = countLines(after);
  if (n > FAIL_LIMIT && n > countLines(before)) return 'file would pass 1,000 lines';
  if (!compareFile(before, after, file).ok) return 'would not prove comment-only';
  return null;
}

function headers(top, opts) {
  const parsed = tree.parseTree(input(top, opts.readme, 'README.md'));
  const described = tree.fileDescriptions(parsed);
  const src = open({ mode: 'worktree', cwd: top });
  const files = src.list().filter(isSource);
  src.prefetch(files);
  const date = today();
  const n = { described: 0, generated: 0, skipped: 0 };
  const refused = [];
  const writes = [];
  for (const file of files) {
    const text = src.read(file);
    if (text == null) continue;
    const ext = extOf(file);
    if (readHeader(text, ext).present) { n.skipped += 1; continue; }
    let kind = 'described';
    let description = described.get(file);
    if (!description) {
      const info = tree.readExports(text, file);
      if (!info) { refused.push([file, 'does not parse']); continue; }
      description = tree.generatedDescription(info, file, date);
      kind = 'generated';
    }
    const next = withHeader(text, ext, description);
    const back = readHeader(next.text, ext);
    const why = refusal(file, text, next.text, back.present && back.description === next.expect);
    if (why) { refused.push([file, why]); continue; }
    n[kind] += 1;
    writes.push([file, next.text]);
  }
  console.log(`described: ${n.described}, generated: ${n.generated}, skipped (has header): ${n.skipped}, dropped files: ${parsed.droppedFiles}`);
  for (const [file, why] of refused) process.stderr.write(`not written (${why}): ${file}\n`);
  if (refused.length) console.log(`not written: ${refused.length} (listed on stderr)`);
  if (opts.dropped) {
    const lines = tree.droppedLines(parsed);
    fs.writeFileSync(path.resolve(process.cwd(), opts.dropped), lines.length ? `${lines.join('\n')}\n` : '');
    console.log(`dropped: ${lines.length} lines written to ${opts.dropped}`);
  }
  if (opts.write) {
    for (const [file, text] of writes) fs.writeFileSync(path.join(top, file), text);
    console.log(`written: ${writes.length} files`);
  }
  return refused.length ? 1 : 0;
}

// ---- route rows --------------------------------------------------------------

const routeKey = (r) => `${r.method} ${r.path} ${r.file}`;

// The plan, then the planned files checked: each must prove comment-only and
// every moved route must read its row back through a second walk; a row that
// fails is left with the reason and the rest planned again.
function routePlan(top, opts) {
  const { sections } = arch.parseArch(input(top, opts.arch, 'ARCHITECTURE.md'));
  const src = open({ mode: 'worktree', cwd: top });
  const walked = walk(src);
  const maxChars = opts['max-chars'] ? Number(opts['max-chars']) : 400;
  const plan = arch.planRows(sections, walked, { maxChars, read: (f) => src.read(f) });
  const before = walked.mounts.flatMap((m) => m.routes).filter((r) => !r.unparsed).map((r) => `${routeKey(r)} ${r.auth}`).sort();
  for (;;) {
    const texts = new Map();
    for (const [file, list] of plan.inserts) texts.set(file, arch.applyInserts(src.read(file), list));
    const failed = new Map();
    for (const [file, list] of plan.inserts) {
      if (!compareFile(src.read(file), texts.get(file), file).ok) for (const ins of list) failed.set(ins.decision, 'would not prove comment-only');
    }
    const again = walk({ ...src, read: (p) => (texts.has(p) ? texts.get(p) : src.read(p)) });
    const after = again.mounts.flatMap((m) => m.routes).filter((r) => !r.unparsed);
    if (after.map((r) => `${routeKey(r)} ${r.auth}`).sort().join('\n') !== before.join('\n')) throw new Error('the route walk changed after the planned comments; nothing written');
    const byKey = new Map(after.map((r) => [routeKey(r), r]));
    for (const list of plan.inserts.values()) {
      for (const ins of list) {
        const r = byKey.get(routeKey(ins.decision.route));
        if (!failed.has(ins.decision) && (!r || r.description !== ins.decision.text)) {
          failed.set(ins.decision, 'would not read back');
        }
      }
    }
    if (failed.size === 0) return { sections, plan, texts, src };
    for (const [d, why] of failed) {
      d.status = 'left';
      d.reason = why;
      const list = plan.inserts.get(d.route.file).filter((ins) => ins.decision !== d);
      if (list.length) plan.inserts.set(d.route.file, list); else plan.inserts.delete(d.route.file);
    }
  }
}

function routeRows(top, opts) {
  const { plan, texts } = routePlan(top, opts);
  const c = arch.counts(plan.decisions);
  console.log(`moved: ${c.moved}, left: ${c.left}`);
  for (const [reason, count] of Object.entries(c.byReason)) {
    if (arch.REASONS.includes(reason) || count > 0) console.log(`  ${reason}: ${count}`);
  }
  if (opts.write) {
    let comments = 0;
    for (const [file, text] of texts) {
      fs.writeFileSync(path.join(top, file), text);
      comments += plan.inserts.get(file).length;
    }
    console.log(`written: ${comments} comments in ${texts.size} files`);
  }
  return 0;
}

// A row counts as covered only when its comment is on disk: a row the plan
// would move that is not written yet would drop out of the notes with its
// text nowhere once the hand table goes, so the notes refuse instead.
function routeNotes(top, opts) {
  const { sections, plan } = routePlan(top, opts);
  const waiting = arch.pending(plan.decisions).length;
  if (waiting) {
    process.stderr.write(`${waiting} row(s) would move but are not written: run route-rows --write first\n`);
    return 1;
  }
  process.stdout.write(arch.renderNotes(sections, plan.decisions));
  return 0;
}

// ---- env ---------------------------------------------------------------------

function envInputs(top, opts) {
  const rows = [
    ...env.parseTable(input(top, opts.readme, 'README.md'), 'README'),
    ...env.parseTable(input(top, opts.claude, '.claude/CLAUDE.md'), 'CLAUDE.md'),
  ];
  const file = path.join(top, '.env.example');
  if (!fs.existsSync(file)) throw new Error('no .env.example in the working tree');
  return { rows, text: fs.readFileSync(file, 'utf8') };
}

function envDraft(top, opts) {
  const { rows, text } = envInputs(top, opts);
  const out = env.draft(text, rows);
  fs.writeFileSync(path.resolve(process.cwd(), opts.out), out.text);
  const lacking = new Map();
  for (const m of out.missing) {
    if (!lacking.has(m.name)) lacking.set(m.name, new Set());
    lacking.get(m.name).add(m.source);
  }
  for (const [name, sources] of lacking) process.stderr.write(`not in .env.example: ${name} (${[...sources].join(', ')})\n`);
  console.log(`env-draft: ${rows.length} rows read; draft written to ${opts.out}; ${lacking.size} table variables not in .env.example`);
  return 0;
}

const shown = (token) => {
  const digits = token.replace(/\D/g, '');
  return !/[A-Za-z]/.test(token) && digits.length >= 10 && digits.length <= 15 ? `phone number ending ${digits.slice(-4)}` : token;
};

function envCheck(top, opts) {
  const { rows, text } = envInputs(top, opts);
  const misses = env.check(text, rows);
  for (const m of misses) console.log(`${m.name}: ${shown(m.token)}`);
  const vars = new Set(misses.map((m) => m.name));
  process.stderr.write(misses.length ? `env-check: ${misses.length} misses in ${vars.size} variables\n` : `env-check: every token of ${rows.length} rows found\n`);
  return misses.length ? 1 : 0;
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`migrate-headers: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const run = { headers, 'route-rows': routeRows, 'route-notes': routeNotes, 'env-draft': envDraft, 'env-check': envCheck }[parsed.cmd];
    return run(top, parsed.opts);
  } catch (err) {
    process.stderr.write(`migrate-headers: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parseArgs, withHeader };

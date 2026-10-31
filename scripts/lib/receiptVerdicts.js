'use strict';

// The verdict table of a lens report (instruction rewrite step 2, lane
// receipt-lib; spec 2026-10-19 section 3.5), re-exported by
// scripts/lib/receipt.js. Pure: text in, rows and findings out.
//
// The verdict table (spec 3.5): the LAST markdown table in a lens report,
// header `| file | verdict | note |`, an optional `|---|---|---|` separator
// (skipped), one row per file, verdict exactly one of pass, finding, not
// reached, escalate (case and inner spacing aside). No table, a bad header, a
// row of the wrong width, an empty file cell, a file listed twice or an
// unknown verdict make the report malformed, and a malformed report yields no
// rows, so every file it should have covered reads as not reached. Findings
// are the lines `- H1 \`path:line\` text ... Check: <id>` (verify writes
// Against:) in every form a lens writes them (findingShapes below: a bold or
// bracketed id, a severity in parentheses, a dash or colon before the
// location, no bullet, the location first, a findings table row), and a line
// without the backticked location is prose (`- H1 from the first pass is
// fixed`). A finding is read whether or not the table is sound. An id is an
// uppercase whole-word token, H, M or L and a number (NOTE_ID): "the h1
// heading" and "M2's" are prose. So that no finding escapes triage, the
// report is also malformed when an id is read twice; when a line that is no
// finding opens with an id (after a bullet, number, heading mark, quote mark
// or bold) and holds a backticked path (`### H1 \`a.js:3\``, `1. H1 ...`,
// `- H1 is covered by \`a.js\``), "a finding not in bullet form"; when a
// finding's own shape carries a lowercase id; when a finding or escalate row
// has an empty note, or a finding row's note names no id; or when any row's
// note, a pass row's too, names an id no finding line carries. So a re-pass
// row's note names an earlier pass's id only when this report carries it
// (`| a.js | pass | fixed |`). Verify's report is read with findingsOnly:
// whole, no table, malformed for the line rules above and verify's own, and
// when it holds neither a finding nor the record, the line No findings alone
// (the checked list on the lines after it), outside every fence. A collapsed
// report (below) is read one lens section at a time.
// Problems name a line number, an id and what is wrong, never the report's
// words.

const VERDICTS = Object.freeze(['pass', 'finding', 'not reached', 'escalate']);
const LENSES = Object.freeze(['money', 'lifecycle', 'concurrency', 'business-time', 'outcomes-providers', 'access-egress', 'seams', 'schema-data', 'client']);

const SEPARATOR_CELL = /^:?-+:?$/;
// A finding (review 3, M4): the id and the backticked location, in any of the
// forms a lens writes. The line may open with quote marks and a bullet (-, *
// or +) or neither; the id may be bold or bracketed, carry a severity in
// parentheses and a colon, period or paren; an em dash, an en dash, a hyphen
// or a colon may stand between it and the location; the location may come
// first (`- \`a.js:3\` H1 text`); and a findings table row carries the id in
// its first cell and the location in a later backticked cell. A bullet
// without the location is prose. `letters` is HML; the same shapes with any
// case find a lowercase id, which makes the report malformed (L3).
function findingShapes(letters) {
  const id = `(?:\\*\\*|__)?\\[?([${letters}])(\\d+)\\]?(?:\\s*\\([A-Za-z][A-Za-z -]{0,19}\\))?[:.)]?(?:\\*\\*|__)?(?:\\s*\\([A-Za-z][A-Za-z -]{0,19}\\))?`;
  const sep = '(?:\\s*(?:\\u2014|\\u2013|--?|:)\\s*|\\s+)';
  const lead = '^(?:>\\s*)*(?:[-*+]\\s+)?';
  return {
    idFirst: new RegExp(`${lead}${id}${sep}\`([^\`]+)\`\\s*(.*)$`),
    locFirst: new RegExp(`${lead}\`([^\`]+)\`${sep}${id}(?=$|[\\s,;])\\s*(.*)$`),
    cell: new RegExp(`^${id}$`),
  };
}
const SHAPES = findingShapes('HML');
const ANY_CASE = findingShapes('HMLhml');
const TICKED_CELL = /^`([^`]+)`$/;
// An id in a note or prose: an uppercase token, H, M or L and a number, whole:
// after the start, whitespace, a bracket, a bold mark, a comma, a semicolon or
// a slash, and before the end, whitespace, a colon, a bracket, a bold mark, a
// comma, a period, a semicolon or a slash.
const ID_END = '(?=$|[\\s:)\\]}*_,.;/])';
const NOTE_ID = new RegExp(`(?<=^|[\\s([{*_,;/])[HML]\\d+${ID_END}`, 'g');
// A line that opens with an id after bullets, numbers, heading marks, quote
// marks or bold, and holds a backticked path. Unless it parsed as a finding,
// it would escape triage: the report is malformed.
const OPENS_WITH_ID = new RegExp(`^(?:(?:>|[-*+]|\\d+[.)]|#+)\\s*)*(?:\\*\\*|__)?\\[?[HML]\\d+${ID_END}`);
const TICKED = /`[^`]+`/;

function notBullet(t) {
  return OPENS_WITH_ID.test(t) && TICKED.test(t);
}
// A code fence (CommonMark): three or more backticks or tildes; it closes only
// on a line of the same character, at least as long, with nothing after it.
const FENCE = /^(`{3,}|~{3,})(.*)$/;

// The fence state after line `t`: {fence, isFence} where isFence says the
// line opened or closed one.
function fenceStep(fence, t) {
  const m = FENCE.exec(t);
  if (!m) return { fence, isFence: false };
  const ch = m[1][0];
  const len = m[1].length;
  if (!fence) return ch === '`' && m[2].includes('`') ? { fence, isFence: false } : { fence: { ch, len }, isFence: true };
  if (ch === fence.ch && len >= fence.len && !m[2].trim()) return { fence: null, isFence: true };
  return { fence, isFence: false };
}
const FILE_LINE = /^(.+?):(\d+)(?:[-,:]\d+)*$/;
const CHECK = /\b(?:Check|Against):\s*(.+?)\s*\.?\s*$/;

// Cells of one markdown table row; `\|` is a literal pipe.
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += s[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

function stripTicks(cell) {
  const m = /^`([^`]*)`$/.exec(cell);
  return m ? m[1].trim() : cell;
}

function finding(sev, num, location, rest) {
  const severity = sev.toUpperCase();
  const loc = location.trim();
  const fl = FILE_LINE.exec(loc);
  const text = rest.trim();
  const check = CHECK.exec(text);
  return { id: `${severity}${num}`, severity, file: fl ? fl[1] : loc, line: fl ? Number(fl[2]) : null, text, check: check ? check[1] : null };
}

// A finding line -> {finding}, {lower} (a finding's shape with a lowercase
// id), or null.
function parseFinding(line) {
  const a = SHAPES.idFirst.exec(line);
  if (a) return { finding: finding(a[1], a[2], a[3], a[4]) };
  const b = SHAPES.locFirst.exec(line);
  if (b) return { finding: finding(b[2], b[3], b[1], b[4]) };
  return ANY_CASE.idFirst.test(line) || ANY_CASE.locFirst.test(line) ? { lower: true } : null;
}

// A findings table row (`| H1 | \`a.js:3\` | text |`) -> {finding}, {bad}
// (an id in the first cell and no backticked location), {lower}, or null when
// the first cell is no id.
function parseFindingRow(t) {
  const cells = splitRow(t);
  const m = SHAPES.cell.exec(cells[0]);
  if (!m) return ANY_CASE.cell.test(cells[0]) ? { lower: true } : null;
  const at = cells.findIndex((c, i) => i > 0 && TICKED_CELL.test(c));
  if (at < 0) return { bad: true };
  return { finding: finding(m[1], m[2], TICKED_CELL.exec(cells[at])[1], cells.slice(at + 1).join(' | ')) };
}

// The finding ids a row's note names (uppercase whole-word tokens, NOTE_ID).
function noteIds(note) {
  return String(note == null ? '' : note).match(NOTE_ID) || [];
}

// A row's note names the findings it stands for (uppercase id tokens): a
// note on any row, a pass row's too, naming an id no finding line carries,
// an empty note on a finding or escalate row, or a finding row naming no id
// would let a finding escape triage, so each makes the report malformed.
function noteProblem(n, verdict, note, ids) {
  const named = note.match(NOTE_ID) || [];
  const missing = named.find((id) => !ids.has(id));
  if (missing) return `line ${n}: the note names ${missing}, which no finding line carries`;
  if (verdict !== 'finding' && verdict !== 'escalate') return null;
  if (!note.trim()) return `line ${n}: a ${verdict} row with no note`;
  return verdict === 'finding' && named.length === 0 ? `line ${n}: a finding row whose note names no finding id` : null;
}

function toLines(markdown) {
  return String(markdown == null ? '' : markdown).split('\n').map((l) => l.replace(/\r$/, ''));
}

// A collapsed one-agent report (spec 3.3's collapse rule) carries one section
// per lens, each opened by a `## Lens: <name>` heading and holding that lens's
// findings and its one table. Every line that starts with # outside a code
// fence is a heading and ends the section before it, so a sub-heading or a
// trailing `## Overall` table is never read as a lens's. A heading that names
// a lens (the word, any case) but is not `## Lens: <one of the nine>`, or a
// second section for one lens, makes the report malformed, so a mistyped
// heading cannot fold one lens's section into another's. A closing sequence
// of # marks (`## Lens: money ##`) is part of the heading, never its name.
const LENS_HEADING = /^##\s+Lens:\s*(\S+?)(?:\s+#+)?\s*$/i;
const LENS_WORD = /\blens/i;
const LOOSE = 'a heading names a lens but is not ## Lens: <one of the nine lenses>';

// Every heading outside a fence: [{i (0-based), name (a known lens or null),
// lensLike}], the sections, the heading problems, and whether any heading
// names a lens (the report is read as collapsed).
function headingFacts(lines) {
  const hs = [];
  let fence = null;
  lines.forEach((raw, i) => {
    const t = raw.trim();
    const step = fenceStep(fence, t);
    fence = step.fence;
    if (step.isFence || fence || !t.startsWith('#')) return;
    const m = LENS_HEADING.exec(t);
    const name = m && LENSES.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
    hs.push({ i, name, lensLike: LENS_WORD.test(t) });
  });
  const sections = hs.filter((h) => h.name).map((h) => ({ name: h.name, line: h.i + 1 }));
  const problems = hs.filter((h) => h.lensLike && !h.name).map((h) => `line ${h.i + 1}: ${LOOSE}`);
  const seen = new Set();
  for (const sec of sections) {
    if (seen.has(sec.name)) problems.push(`line ${sec.line}: a second ## Lens: section for one lens`);
    seen.add(sec.name);
  }
  return { hs, sectioned: hs.some((h) => h.lensLike), sections, problems };
}

function lensHeadings(markdown) {
  const { sectioned, sections, problems } = headingFacts(toLines(markdown));
  return { sectioned, sections, problems };
}

// Verify's own line rules (review 4, M3): verify writes `- H1 \`path:line\`
// ... Against: ...`, so a line that is no finding but carries Against: beside
// an id or a backticked location (one finding written over two lines, the id
// on a heading above, among them), or a findings table row whose first cell
// holds an id but is not exactly one, is a finding the reading would miss;
// so is a line that opens with the word Finding (or Findings) and an id,
// with or without a location (review 5, M2: `Finding H1 at \`a.js:3\`: ...`
// after the record, `### Finding H1`). A checked line names its id mid-line.
// For a line that parsed as nothing: {bad: why} or null.
const AGAINST = /\bAgainst:/;
const OPENS_WITH_FINDING = new RegExp(`^(?:(?:>|[-*+]|\\d+[.)]|#+)\\s*)*(?:\\*\\*|__)?(?:[Ff]indings?|FINDINGS?)\\b[\\s:*_]*\\[?[HML]\\d+${ID_END}`);
function verifyLine(t) {
  if (t.startsWith('|') && (splitRow(t)[0].match(NOTE_ID) || []).length) return { bad: 'a findings table row whose first cell is not exactly one id' };
  const finding = AGAINST.test(t) && ((t.match(NOTE_ID) || []).length || TICKED.test(t));
  if (finding) return { bad: 'Against: beside an id or a backticked location on a line that is no finding' };
  return OPENS_WITH_FINDING.test(t) ? { bad: 'a line that opens with Finding and an id, which no finding form reads' } : null;
}

// The record verify writes when it finds nothing (verify.md, review 5, M2):
// the line No findings, alone; the fixes and expressions it checked follow on
// lines of their own. A line that opens with No findings and goes on ("No
// findings on the fixes, but M1 ...") is no record.
const RECORD = /^No findings\.?\s*$/;

// The tables and findings of lines[from, to), numbered as in the report.
// `verify` adds verify's line rules and notes the record line.
function scan(lines, from, to, { verify = false } = {}) {
  const blocks = [];
  const findings = [];
  const problems = [];
  const ids = new Set();
  let block = null;
  let fence = null;
  let flagged = false;
  let record = false;
  for (let i = from; i < to; i++) {
    const t = lines[i].trim();
    const step = fenceStep(fence, t);
    fence = step.fence;
    if (step.isFence) {
      block = null;
      continue;
    }
    if (fence) continue;
    let r;
    if (t.startsWith('|')) {
      if (!block) {
        block = [];
        blocks.push(block);
      }
      block.push({ n: i + 1, text: t });
      r = parseFindingRow(t);
    } else {
      block = null;
      r = parseFinding(t);
      if (!r && notBullet(t)) r = { bad: 'a finding not in bullet form' };
    }
    if (verify) {
      if (!r) r = verifyLine(t);
      if (RECORD.test(t)) record = true;
    }
    const why = r && (r.bad ? (r.bad === true ? 'a finding not in bullet form' : r.bad) : r.lower ? 'a finding id in lowercase (ids are uppercase: H1, M2, L3)' : null);
    if (why) {
      problems.push(`line ${i + 1}: ${why}`);
      flagged = true;
    }
    const f = r && r.finding;
    if (!f) continue;
    if (ids.has(f.id)) {
      problems.push(`line ${i + 1}: finding ${f.id} listed twice; the first is kept`);
      flagged = true;
      continue;
    }
    ids.add(f.id);
    findings.push({ ...f, n: i + 1 });
  }
  // flagged: an id read twice, a finding not in bullet form, a lowercase id,
  // or (verify) a line its rules refuse.
  return { blocks, findings, problems, ids, flagged, record };
}

// The lines of `lens`'s section of a collapsed report -> {from, to}, or
// {fail} when the report is malformed: read without a lens, a heading
// problem, no section for the lens, or a finding outside every section (before
// the first heading, or under a heading that is no lens's).
function sectionOf(lines, h, lens) {
  if (!lens) return { fail: ['a collapsed report (## Lens: sections) is read one lens at a time'] };
  if (h.problems.length) return { fail: h.problems };
  const at = h.hs.findIndex((x) => x.name === lens);
  if (at < 0) return { fail: [`no ## Lens: ${lens} section`] };
  const end = (k) => (k + 1 < h.hs.length ? h.hs[k + 1].i : lines.length);
  const outside = [[0, h.hs[0].i], ...h.hs.flatMap((x, k) => (x.name ? [] : [[x.i + 1, end(k)]]))];
  // A heading-form finding is itself a heading, in no region.
  const heading = h.hs.find((x) => notBullet(lines[x.i].trim()));
  if (heading) return { fail: [`line ${heading.i + 1}: a finding not in bullet form`] };
  for (const [a, b] of outside) {
    const r = scan(lines, a, b);
    if (r.findings[0]) return { fail: [`line ${r.findings[0].n}: a finding outside any ## Lens: section`] };
    if (r.flagged) return { fail: r.problems };
  }
  return { from: h.hs[at].i + 1, to: end(at) };
}

// `lens` selects that lens's section of a collapsed report (any heading that
// names a lens makes a report collapsed); a report with no such heading is
// read whole, whatever `lens` says. A malformed collapsed report yields no
// rows and no findings, so the files it should have covered read as not
// reached. `findingsOnly` (verify, which returns findings and no table, spec
// 3.5): the report is read whole and no table is needed; it is malformed for
// the line rules above, for verify's own (verifyLine: Against: beside an id
// or a backticked location on a line that is no finding, a findings cell that
// is not exactly one id, a line that opens with Finding and an id), and
// when it holds neither a finding nor the No findings record outside every
// fence (review 4, M3; the record is the line alone, review 5, M2): a finding
// inside a fence of either kind, closed or not, is outside the report.
function parseVerdictTable(markdown, { findingsOnly = false, lens } = {}) {
  const lines = toLines(markdown);
  let from = 0;
  let to = lines.length;
  const h = findingsOnly ? null : headingFacts(lines);
  const collapsed = Boolean(h && h.sectioned);
  if (collapsed) {
    const sec = sectionOf(lines, h, lens);
    if (sec.fail) return { rows: [], findings: [], malformed: true, problems: sec.fail };
    ({ from, to } = sec);
  }
  const { blocks, findings, problems, ids, flagged, record } = scan(lines, from, to, { verify: findingsOnly });

  const bad = (why) => {
    if (why) problems.push(why);
    return { rows: [], findings, malformed: true, problems };
  };
  if (findingsOnly) {
    if (flagged) return bad();
    // Positive evidence (review 4, M3): silence, or findings only inside a
    // fence, is no verdict.
    if (!findings.length && !record) return bad('verify must raise a finding or record No findings (the line No findings alone, outside any fence)');
    return { rows: [], findings, malformed: false, problems };
  }
  if (blocks.length === 0) return bad('no verdict table');
  if (collapsed && blocks.length > 1) return bad(`line ${blocks[1][0].n}: a second table in the ## Lens: ${lens} section`);
  const table = blocks[blocks.length - 1];
  const header = splitRow(table[0].text).map((c) => c.toLowerCase());
  if (header.length !== 3 || header[0] !== 'file' || header[1] !== 'verdict' || header[2] !== 'note') {
    return bad(`line ${table[0].n}: the last table's header is not | file | verdict | note |`);
  }
  const rows = [];
  const seen = new Set();
  for (const { n, text } of table.slice(1)) {
    const cells = splitRow(text);
    if (cells.every((c) => SEPARATOR_CELL.test(c))) continue;
    if (cells.length !== 3) return bad(`line ${n}: a row with ${cells.length} cells, not 3`);
    const file = stripTicks(cells[0]);
    if (!file) return bad(`line ${n}: a row with no file`);
    const verdict = cells[1].toLowerCase().replace(/\s+/g, ' ').trim();
    if (!VERDICTS.includes(verdict)) return bad(`line ${n}: unknown verdict`);
    if (seen.has(file)) return bad(`line ${n}: a file listed twice`);
    seen.add(file);
    const why = noteProblem(n, verdict, cells[2], ids);
    if (why) return bad(why);
    rows.push({ file, verdict, note: cells[2] });
  }
  if (flagged) return bad();
  return { rows, findings, malformed: false, problems };
}

// What the store reads before it writes (scripts/review-receipt.js verdicts
// and verify; plan 2026-10-28, lane receipt-cap): the lenses a report is
// stored under, and whether each parses. `lens` is the lens a one-lens report
// is stored under, 'verify' (read findings-only), or null (--collapsed: every
// `## Lens: <name>` section) -> {refusal} for a one-lens report carrying
// another lens's heading or a collapsed one with no heading or a loose one,
// else {lenses, malformed}: malformed is null, or the refusal for a report
// the parser calls malformed (any section of a collapsed one), one message
// with each problem on a line of its own, which the store makes once its
// snapshot checks pass and before it writes, so it never writes a malformed
// report: the agent re-emits it, and the re-emission is stored in its place.
function storable(base, text, lens) {
  let lenses = [lens];
  if (lens !== 'verify') {
    const { sectioned, sections, problems } = lensHeadings(text);
    const other = lens && sections.find((x) => x.name !== lens);
    if (other) return { refusal: `${base} line ${other.line}: a ## Lens: heading for a lens other than ${lens}; a collapsed report is stored with --collapsed` };
    if (!lens && !sectioned) return { refusal: `${base} has no ## Lens: <name> heading; a one-lens report is stored with verdicts <name> <lens> <report.md>` };
    if (!lens && problems.length) return { refusal: `${base} ${problems.join('; ')} (one of ${LENSES.join(', ')})` };
    if (!lens) lenses = sections.map((x) => x.name);
  }
  const bad = lenses.map((l) => [l, parseVerdictTable(text, l === 'verify' ? { findingsOnly: true } : { lens: l })]).filter(([, p]) => p.malformed);
  if (!bad.length) return { lenses, malformed: null };
  const lines = bad.flatMap(([l, p]) => (p.problems.length ? p.problems : ['malformed']).map((x) => `  ${lens ? '' : `${l}: `}${x}`));
  return { lenses, malformed: [`${base} is malformed (${lines.length} problem(s)); nothing was stored: ask the agent to re-emit it in the form the store reads, then store the re-emission`, ...lines].join('\n') };
}

// file -> {verdict, note, report}; the latest report that lists a file wins.
function mergeVerdicts(reportsInOrder) {
  const merged = Object.create(null);
  for (const r of reportsInOrder || []) {
    for (const row of (r && r.rows) || []) merged[row.file] = { verdict: row.verdict, note: row.note, report: (r && r.name) || null };
  }
  return merged;
}

// One lens's coverage of the diff: a file has a verdict when its merged verdict
// is anything but not reached; a file with no row is not reached.
function coverage(fileList, merged) {
  const files = [...new Set(fileList || [])];
  const has = (f) => Object.prototype.hasOwnProperty.call(merged || {}, f) && merged[f].verdict !== 'not reached';
  return {
    files_in_diff: files,
    files_with_verdicts: files.filter(has),
    not_reached: files.filter((f) => !has(f)),
  };
}

module.exports = { parseVerdictTable, lensHeadings, storable, noteIds, mergeVerdicts, coverage, VERDICTS, LENSES };

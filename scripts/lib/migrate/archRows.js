'use strict';

// ARCHITECTURE.md's hand route tables, read for the one-shot migration
// (instruction rewrite step 4, lane migrate-headers; plan 2026-10-27 decision
// 8 and the contract "scripts/migrate-headers.js"), and the comment writer the
// three migration commands share.
//
//   parseArch(text)          {sections: [{heading, prefix, items}]}: the lines
//                            between `## API Routes` and `## Database Schema`.
//                            A `###` heading opens a section; its prefix is the
//                            first backticked token starting /api (a heading
//                            with none has prefix '', its rows read as full
//                            paths). A prose line holding the words "mounted
//                            at" and a backticked /api token re-mounts the
//                            rows after it, until the next heading or the next
//                            such line. An item is {type: 'row', method,
//                            prefix, path, auth, description, matchable, line}
//                            or {type: 'prose', text}. A row is a line of a route table
//                            (after a `| Method | Path | Auth | Description |`
//                            header) with four cells or more (the fourth on
//                            is the description, a bare pipe in it kept), or
//                            such a line anywhere whose first cell is one
//                            HTTP verb and whose second is one code span; it
//                            is matchable when it has both. The route header and its
//                            separator are dropped; every other line is prose.
//   planRows(sections, walked, {maxChars, read})
//                            one decision per row, in document order:
//                            {row, full, status: 'moved' | 'left', reason,
//                            route, text, lines, done}. full is the row's
//                            prefix plus its path (a path starting /api is
//                            used as is; `/` is the prefix alone; trailing
//                            slashes and a query string trimmed), compared
//                            with each walked path whose parameters lose their
//                            regex constraints (plainParams: `:id(\\d+)` reads
//                            `:id`), an exact normalization. And the per-file
//                            inserts, file -> [{line, lines, decision}].
//                            The reasons, first that applies: no match, more
//                            than one (two routes match, or the matched
//                            route's statement line registers another route
//                            too), handler commented (the route has a comment,
//                            or an earlier row took it), over max, file at cap
//                            (the file would pass 1,000 lines). A row whose
//                            text already sits above its handler is moved and
//                            done (the run is idempotent, and route-notes
//                            after the run leaves it out).
//   applyInserts(text, inserts)  the file with each insert's lines placed
//                            directly above its statement, above any directive
//                            comment lines sitting directly over it
//   renderNotes(sections, decisions)  the markdown route-notes prints: every
//                            row not covered (a row is covered only when its
//                            comment is on disk, done), then the prose
//   pending(decisions)       the rows that would move but are not written
//
// The writer, shared with the headers and env-draft commands:
//   wrapText(text, width)    lines of at most width characters, a code span
//                            never split, no line opening with a word ESLint
//                            reads as a directive (the last word of the line
//                            above is carried down instead)
//   commentLines(text, indent, width)  `//` lines at that indent
//   noEmDash(s)              U+2014 replaced by " - "
//   splitText(text) / joinText(parts)  lines with their own endings kept and
//                            the byte-order mark set aside, so CRLF and a BOM
//                            survive an insert
//   insertAt(text, index, newLines)    newLines placed before line index
//   isDirectiveLine(line)    a comment line the comment-only proof compares
//                            like code (scripts/lib/commentOnly.js's rule)

const { countLines, FAIL_LIMIT } = require('../../check-file-size');

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL', 'OPTIONS', 'HEAD']);
const ROUTE_HEADER = /^\|\s*method\s*\|\s*path\s*\|\s*auth\s*\|\s*description\s*\|\s*$/i;
const SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;
const REASONS = Object.freeze(['no match', 'more than one', 'handler commented', 'over max', 'file at cap']);

// The two regexes scripts/lib/commentOnly.js compares like code (kept in step
// with it; the migrate suite proves a written file through compareFile).
const DIRECTIVE = /@jsx|__PURE__|__NO_SIDE_EFFECTS__|\bwebpack[A-Z]/;
const ESLINT_DIRECTIVE = /^\s*(?:eslint(?:-[a-z-]+)?|exported|globals?)(?:\s|$)/;
const DIRECTIVE_WORD = /^(?:eslint(?:-.*)?|exported|globals?)$/;

function noEmDash(s) {
  return String(s == null ? '' : s).replace(/[ \t]*\u2014[ \t]*/g, ' - ');
}

// Words, each code span (a run of N backticks to the next run of exactly N)
// one unit whatever spaces it holds.
function units(text) {
  const s = String(text);
  const out = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '`') {
      let n = 0;
      while (s[i + n] === '`') n += 1;
      let close = -1;
      for (let j = i + n; j < s.length;) {
        const k = s.indexOf('`'.repeat(n), j);
        if (k === -1) break;
        let m = 0;
        while (s[k + m] === '`') m += 1;
        if (m === n) { close = k; break; }
        j = k + m;
      }
      const end = close === -1 ? i + n : close + n;
      cur += s.slice(i, end);
      i = end;
    } else if (/\s/.test(s[i])) {
      if (cur) out.push(cur);
      cur = '';
      i += 1;
    } else {
      cur += s[i];
      i += 1;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function wrapText(text, width) {
  const lines = [];
  let line = [];
  let len = 0;
  for (const u of units(text)) {
    const next = line.length ? len + 1 + u.length : u.length;
    if (line.length && next > width) {
      if (DIRECTIVE_WORD.test(u) && line.length > 1) {
        const carried = line.pop();
        lines.push(line);
        line = [carried, u];
        len = carried.length + 1 + u.length;
      } else {
        lines.push(line);
        line = [u];
        len = u.length;
      }
    } else {
      line.push(u);
      len = next;
    }
  }
  if (line.length) lines.push(line);
  return lines.map((l) => l.join(' '));
}

function commentLines(text, indent = '', width = 100) {
  const prefix = `${indent}// `;
  return wrapText(text, Math.max(20, width - prefix.length)).map((l) => prefix + l);
}

function isDirectiveLine(line) {
  const t = String(line).trim();
  let value = null;
  if (t.startsWith('//')) value = t.slice(2);
  else if (t.startsWith('/*') && t.endsWith('*/') && t.length >= 4) value = t.slice(2, -2);
  return value !== null && (ESLINT_DIRECTIVE.test(value) || DIRECTIVE.test(value));
}

function splitText(text) {
  let body = String(text == null ? '' : text);
  let bom = '';
  if (body.charCodeAt(0) === 0xfeff) {
    bom = '\ufeff';
    body = body.slice(1);
  }
  const lines = [];
  const re = /\r?\n/g;
  let at = 0;
  let m;
  while ((m = re.exec(body)) !== null) {
    lines.push({ c: body.slice(at, m.index), e: m[0] });
    at = m.index + m[0].length;
  }
  if (at < body.length) lines.push({ c: body.slice(at), e: '' });
  const eol = lines.some((l) => l.e === '\r\n') ? '\r\n' : '\n';
  return { bom, lines, eol };
}

function joinText(parts) {
  return parts.bom + parts.lines.map((l) => l.c + l.e).join('');
}

function insertAt(text, index, newLines) {
  const parts = splitText(text);
  const at = Math.max(0, Math.min(index, parts.lines.length));
  const last = parts.lines[parts.lines.length - 1];
  if (at === parts.lines.length && last && last.e === '') last.e = parts.eol;
  parts.lines.splice(at, 0, ...newLines.map((c) => ({ c, e: parts.eol })));
  return joinText(parts);
}

// ---- ARCHITECTURE's route section -------------------------------------------

// A table line's cells, untrimmed, split at every pipe no backslash escapes
// (GitHub splits there too, inside a code span or not). `last(cells, k)` is
// cell k and every cell after it joined back as written, so a description
// holding a bare pipe (`a || b`) keeps it.
function splitCells(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === '|' && inner[i - 1] !== '\\') { cells.push(cur); cur = ''; } else cur += inner[i];
  }
  cells.push(cur);
  return cells;
}

const last = (cells, k) => cells.slice(k).join('|').trim();

const unescapeCell = (s) => String(s).replace(/\\\|/g, '|');
const singleSpan = (cell) => {
  const m = /^`([^`]+)`$/.exec(cell);
  return m && m[1].startsWith('/') ? m[1] : null;
};

function parseArch(text) {
  const lines = String(text == null ? '' : text).split('\n').map((l) => l.replace(/\r$/, ''));
  const start = lines.findIndex((l) => /^##\s+API Routes\s*$/.test(l));
  if (start === -1) throw new Error('ARCHITECTURE.md has no "## API Routes" section');
  let end = lines.findIndex((l, i) => i > start && /^##\s+Database Schema\s*$/.test(l));
  if (end === -1) end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end === -1) end = lines.length;
  const sections = [{ heading: null, prefix: '', items: [] }];
  let mount = '';
  let routeTable = false;
  let afterHeader = false;
  for (let i = start + 1; i < end; i += 1) {
    const l = lines[i];
    const sec = sections[sections.length - 1];
    if (/^###\s/.test(l)) {
      const m = /`(\/api[^`]*)`/.exec(l);
      sections.push({ heading: l.trim(), prefix: m ? m[1] : '', items: [] });
      mount = m ? m[1] : '';
      routeTable = false;
      continue;
    }
    const remount = !l.trim().startsWith('|') && /\bmounted at\b/i.test(l) ? /`(\/api[^`]*)`/.exec(l) : null;
    if (remount) mount = remount[1];
    const table = l.trim().startsWith('|');
    if (!table) routeTable = false;
    if (table && ROUTE_HEADER.test(l.trim())) { routeTable = true; afterHeader = true; continue; }
    if (table && routeTable && afterHeader && SEPARATOR.test(l.trim())) { afterHeader = false; continue; }
    afterHeader = false;
    const raw = table ? splitCells(l) : null;
    const cells = raw && raw.length >= 4 ? [...raw.slice(0, 3).map((c) => c.trim()), last(raw, 3)] : null;
    const verb = cells && METHODS.has(cells[0]);
    const span = cells ? singleSpan(cells[1]) : null;
    if (cells && (routeTable || (verb && span !== null))) {
      sec.items.push({
        type: 'row',
        method: cells[0],
        prefix: mount,
        path: span !== null ? span : unescapeCell(cells[1]),
        auth: unescapeCell(cells[2]),
        description: unescapeCell(cells[3]),
        matchable: Boolean(verb && span !== null),
        line: i + 1,
      });
      continue;
    }
    sec.items.push({ type: 'prose', text: l });
  }
  return { sections: sections.filter((s, k) => k > 0 || s.items.some((it) => it.type === 'row' || it.text.trim() !== '')) };
}

const normPath = (p) => String(p).replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';

function fullPath(prefix, p) {
  const bare = String(p).split('?')[0];
  if (/^\/api(?:\/|$)/.test(bare)) return normPath(bare);
  return normPath(bare === '/' ? (prefix || '/') : `${prefix}${bare}`);
}

// A walked path with each parameter's regex constraint dropped (`:id(\\d+)`
// reads `:id`), so it compares with the doc's plain row exactly.
const plainParams = (p) => String(p).replace(/(:[A-Za-z_$][\w$]*)\((?:[^()\\]|\\.|\((?:[^()\\]|\\.)*\))*\)/g, '$1');

// The text a moved row's comment reads back as: what describeComment returns.
const expected = (row) => noEmDash(row.description).replace(/\s+/g, ' ').trim();

function planRows(sections, walked, { maxChars = 400, read }) {
  const routes = [];
  for (const m of (walked && walked.mounts) || []) for (const r of m.routes) if (!r.unparsed) routes.push(r);
  const atLine = new Map();
  for (const r of routes) {
    const k = `${r.file}:${r.line}`;
    atLine.set(k, (atLine.get(k) || 0) + 1);
  }
  const texts = new Map();
  const size = new Map();
  const taken = new Set();
  const inserts = new Map();
  const decisions = [];
  for (const sec of sections) {
    for (const row of sec.items) {
      if (row.type !== 'row') continue;
      const d = { row, section: sec, full: row.matchable ? fullPath(row.prefix, row.path) : null, status: 'left', reason: null, route: null, text: null, lines: null, done: false };
      decisions.push(d);
      if (!row.matchable) { d.reason = 'no match'; continue; }
      const hits = routes.filter((r) => r.method === row.method && normPath(plainParams(r.path)) === d.full);
      if (hits.length === 0) { d.reason = 'no match'; continue; }
      const route = hits[0];
      if (hits.length > 1 || atLine.get(`${route.file}:${route.line}`) > 1) { d.reason = 'more than one'; continue; }
      d.route = route;
      const key = `${route.file}:${route.line}`;
      if (taken.has(key)) { d.reason = 'handler commented'; continue; }
      if (route.description) {
        if (route.description === expected(row)) { taken.add(key); d.status = 'moved'; d.done = true; continue; }
        d.reason = 'handler commented';
        continue;
      }
      if (row.description.length > maxChars) { d.reason = 'over max'; continue; }
      if (!texts.has(route.file)) {
        const t = read(route.file);
        texts.set(route.file, t);
        size.set(route.file, t == null ? Infinity : countLines(t));
      }
      const text = texts.get(route.file);
      const stmt = text == null ? null : splitText(text).lines[route.line - 1];
      if (!stmt) { d.reason = 'no match'; continue; }
      d.text = expected(row);
      const lines = commentLines(d.text, /^[ \t]*/.exec(stmt.c)[0]);
      if (size.get(route.file) + lines.length > FAIL_LIMIT) { d.reason = 'file at cap'; continue; }
      size.set(route.file, size.get(route.file) + lines.length);
      taken.add(key);
      d.status = 'moved';
      d.lines = lines;
      if (!inserts.has(route.file)) inserts.set(route.file, []);
      inserts.get(route.file).push({ line: route.line, lines, decision: d });
    }
  }
  return { decisions, inserts };
}

function applyInserts(text, inserts) {
  let out = text;
  for (const ins of [...inserts].sort((a, b) => b.line - a.line)) {
    const { lines } = splitText(out);
    let at = ins.line - 1;
    while (at > 0 && isDirectiveLine(lines[at - 1].c)) at -= 1;
    out = insertAt(out, at, ins.lines);
  }
  return out;
}

function counts(decisions) {
  const left = Object.fromEntries(REASONS.map((r) => [r, 0]));
  let moved = 0;
  for (const d of decisions) {
    if (d.status === 'moved') moved += 1;
    else left[d.reason] = (left[d.reason] || 0) + 1;
  }
  return { moved, left: decisions.length - moved, byReason: left };
}

const pending = (decisions) => decisions.filter((d) => d.status === 'moved' && !d.done);

function renderNotes(sections, decisions) {
  const leftRows = new Set(decisions.filter((d) => !d.done).map((d) => d.row));
  const out = [];
  for (const sec of sections) {
    const rows = sec.items.filter((it) => it.type === 'row' && leftRows.has(it));
    const prose = [];
    for (const it of sec.items) {
      if (it.type !== 'prose') continue;
      if (it.text.trim() === '') { if (prose.length && prose[prose.length - 1] !== '') prose.push(''); } else prose.push(noEmDash(it.text));
    }
    while (prose.length && prose[prose.length - 1] === '') prose.pop();
    if (!rows.length && !prose.length) continue;
    if (sec.heading) out.push(noEmDash(sec.heading), '');
    for (const r of rows) {
      const where = r.matchable ? fullPath(r.prefix, r.path) : `${r.prefix ? `${r.prefix} ` : ''}${r.path}`;
      out.push(`- **${noEmDash(r.method)} ${noEmDash(where)}** (${noEmDash(r.auth)}): ${noEmDash(r.description)}`);
    }
    if (rows.length && prose.length) out.push('');
    out.push(...prose, '');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

module.exports = {
  REASONS,
  noEmDash,
  units,
  wrapText,
  commentLines,
  isDirectiveLine,
  splitText,
  joinText,
  insertAt,
  splitCells,
  last,
  unescapeCell,
  parseArch,
  normPath,
  fullPath,
  plainParams,
  planRows,
  applyInserts,
  counts,
  pending,
  renderNotes,
};

'use strict';

// The schema index for ARCHITECTURE.md's gen:schema section, read from
// server/db/schema.sql (instruction rewrite step 4, lane gen-docs; plan
// 2026-10-27 decision 9 and the contract "The schema index"). It parses the
// file and never requires server/db/index.js, which opens a pool at load.
//
//   parse(text)        -> {tables: [{name, line, description, columns: [{name,
//                         type, line}], constraints: [{name, text, lines}],
//                         indexes: [{name, lines}], triggers: [{name, lines}]}]}
//   render(parsed, file = 'server/db/schema.sql')
//                      -> per table `**<name>** (<file>:<line>) <description>`
//                         then `- columns:`, `- constraints:`, `- indexes:`,
//                         `- triggers:` lines (an empty one omitted)
//
// Statements split on `;` outside quotes, dollar-quoted bodies, `--` comments
// and block comments (the rules server/db/index.js documents). A DO block's
// body is split the same way and read like the top level, so an ADD CONSTRAINT
// or ADD COLUMN inside one counts. Per statement, in file order: CREATE TABLE
// (columns from the body split at top-level commas; an entry opening with
// CONSTRAINT, PRIMARY KEY, UNIQUE, CHECK, FOREIGN KEY or EXCLUDE is a
// constraint), every ALTER TABLE clause (ADD [COLUMN], DROP [COLUMN],
// RENAME [COLUMN], ADD/DROP/RENAME CONSTRAINT), CREATE/DROP INDEX and
// CREATE/DROP TRIGGER. A dropped column, constraint, index or trigger leaves
// the index, so it shows what the file builds; a constraint added at several
// sites lists every site's line. A table's description is the run of `--`
// lines directly above its CREATE (no blank line between), first paragraph.
// A column's type text is compacted to one line and cut at 80 characters.
// ALTER COLUMN TYPE, SET or DROP DEFAULT and SET or DROP NOT NULL are applied
// to that text in file order, and an altered column carries the line of its
// last change (`note TEXT NOT NULL (:3012)`). A column's own CHECK or
// REFERENCES goes by Postgres's name for it (<table>_<column>_check or
// <table>_<column>_fkey, or its CONSTRAINT name):
// a DROP CONSTRAINT by that name takes it out of the column's text, and an
// ADD CONSTRAINT by that name lists it under the constraints.

const { describeComment } = require('./headers');
const { plain } = require('./markers');

const FILE = 'server/db/schema.sql';
const ID = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)';
const NAME = `(${ID}(?:\\s*\\.\\s*${ID})?)`;
const TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

function ident(raw) {
  const last = raw.split(/\s*\.\s*(?=(?:"|[A-Za-z_]))/).pop();
  return last.startsWith('"') ? last.slice(1, -1).replace(/""/g, '"') : last.toLowerCase();
}

const compact = (s) => s.replace(/\s+/g, ' ').trim();
const cut = (s, n = 80) => (s.length <= n ? s : `${s.slice(0, n - 3)}...`);

// A column definition as its data type and its constraint clauses, each clause
// starting at a keyword at paren depth 0 outside quotes (CONSTRAINT <name>
// stays with the clause after it; a NULL or DEFAULT inside a REFERENCES action
// or a NULL default is not a keyword), so an ALTER COLUMN can change one
// clause and leave the rest of the text as it was written.
const CLAUSE = /^(?:CONSTRAINT|NOT\s+NULL|NULL|DEFAULT|CHECK|UNIQUE|PRIMARY\s+KEY|REFERENCES|GENERATED|COLLATE)\b/i;

function splitDef(def) {
  const cuts = [];
  let depth = 0;
  let quote = null;
  for (let i = 0; i < def.length; i += 1) {
    const c = def[i];
    if (quote) {
      if (c === quote) { if (def[i + 1] === quote) i += 1; else quote = null; }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0 && (i === 0 || def[i - 1] === ' ')) {
      const m = CLAUSE.exec(def.slice(i));
      // NULL or DEFAULT right after SET is a REFERENCES action (ON DELETE SET
      // NULL), and NULL right after DEFAULT is the default's value: neither
      // opens a clause.
      const before = (/(\S+)\s*$/.exec(def.slice(0, i)) || [])[1];
      const inside = m && /^(?:NULL|DEFAULT)\b/i.test(m[0]) && /^(?:SET|DEFAULT)$/i.test(before || '');
      if (m && !inside) { cuts.push(i); i += m[0].length - 1; }
    }
  }
  const parts = cuts.map((c, k) => def.slice(c, k + 1 < cuts.length ? cuts[k + 1] : def.length).trim());
  for (let k = parts.length - 2; k >= 0; k -= 1) {
    if (/^CONSTRAINT\s+\S+$/i.test(parts[k])) parts.splice(k, 2, `${parts[k]} ${parts[k + 1]}`);
  }
  return { type: def.slice(0, cuts.length ? cuts[0] : def.length).trim(), parts };
}

const joinDef = (d) => [d.type, ...d.parts].filter(Boolean).join(' ');

// Splits [from, to) into statements, blanking comments in nc and co and string
// contents in co (quotes kept), so offsets stay aligned with the text.
function scan(text, from, to, nc, co) {
  const out = [];
  let start = from;
  let bodies = [];
  const blank = (arr, a, b) => { for (let k = a; k < b; k += 1) if (text[k] !== '\n') arr[k] = ' '; };
  let i = from;
  while (i < to) {
    const ch = text[i];
    const nx = text[i + 1];
    if (ch === '-' && nx === '-') {
      const eol = text.indexOf('\n', i);
      const stop = eol === -1 || eol > to ? to : eol;
      blank(nc, i, stop); blank(co, i, stop); i = stop; continue;
    }
    if (ch === '/' && nx === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 || end + 2 > to ? to : end + 2;
      blank(nc, i, stop); blank(co, i, stop); i = stop; continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < to) {
        if (text[j] === ch) { if (text[j + 1] === ch) { j += 2; continue; } break; }
        j += 1;
      }
      if (ch === "'") blank(co, i + 1, Math.min(j, to));
      i = j + 1; continue;
    }
    if (ch === '$') {
      const m = TAG_RE.exec(text.slice(i, i + 64));
      if (m) {
        const close = text.indexOf(m[0], i + m[0].length);
        const bodyEnd = close === -1 || close > to ? to : close;
        bodies.push([i + m[0].length, bodyEnd]);
        i = bodyEnd === to ? to : bodyEnd + m[0].length; continue;
      }
    }
    if (ch === ';') {
      out.push({ start, end: i, bodies });
      start = i + 1; bodies = []; i += 1; continue;
    }
    i += 1;
  }
  if (text.slice(start, to).trim() !== '') out.push({ start, end: to, bodies });
  return out;
}

// Splits [a, b) of co at depth-0 commas into [start, end) ranges.
function splitTop(co, a, b) {
  const parts = [];
  let depth = 0;
  let s = a;
  for (let k = a; k < b; k += 1) {
    if (co[k] === '(') depth += 1;
    else if (co[k] === ')') depth -= 1;
    else if (co[k] === ',' && depth === 0) { parts.push([s, k]); s = k + 1; }
  }
  parts.push([s, b]);
  return parts;
}

function parse(text) {
  const src = String(text == null ? '' : text);
  const nc = src.split('');
  const co = src.split('');
  const lineStarts = [0];
  for (let k = 0; k < src.length; k += 1) if (src[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (off) => {
    let lo = 0; let hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const firstCode = (a, b) => { let k = a; while (k < b && /\s/.test(co[k])) k += 1; return k; };
  const srcLines = src.split('\n');
  const tables = new Map();
  const order = [];

  const describeAbove = (line) => {
    const raw = [];
    for (let k = line - 2; k >= 0 && srcLines[k].trim().startsWith('--'); k -= 1) raw.unshift(srcLines[k]);
    return raw.length ? describeComment(raw) : '';
  };

  function createTable(stmt, s) {
    const m = new RegExp(`\\bCREATE\\s+(?:(?:GLOBAL|LOCAL)\\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${NAME}\\s*\\(`, 'i').exec(s);
    if (!m) return;
    const name = ident(m[1]);
    if (tables.has(name)) return;
    const at = stmt.start + m.index;
    const open = at + m[0].length - 1;
    let depth = 0;
    let close = stmt.end;
    for (let k = open; k < stmt.end; k += 1) {
      if (co[k] === '(') depth += 1;
      else if (co[k] === ')') { depth -= 1; if (depth === 0) { close = k; break; } }
    }
    const t = { name, line: lineOf(at), description: describeAbove(lineOf(at)), columns: [], constraints: new Map(), unnamed: [], indexes: new Map(), triggers: new Map(), inline: new Map() };
    for (const [a, b] of splitTop(co, open + 1, close)) {
      const txt = compact(nc.slice(a, b).join(''));
      if (!txt) continue;
      const line = lineOf(firstCode(a, b));
      const cm = /^CONSTRAINT\s+(\S+)/i.exec(txt);
      if (cm) addConstraint(t, ident(cm[1]), txt, line);
      else if (/^(?:PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE)\b/i.test(txt)) t.unnamed.push({ name: null, text: txt, lines: [line] });
      else if (!/^LIKE\b/i.test(txt)) addColumn(t, txt, line);
    }
    tables.set(name, t);
    order.push(name);
  }

  function addColumn(t, txt, line) {
    const m = new RegExp(`^${NAME}\\s*([\\s\\S]*)$`).exec(txt);
    if (!m) return;
    const name = ident(m[1]);
    if (t.columns.some((c) => c.name === name)) return;
    const def = compact(m[2]);
    t.columns.push({ name, def, line, altered: null });
    // A column's own CHECK or REFERENCES goes by the name Postgres gives it,
    // <table>_<column>_check or <table>_<column>_fkey, or by its CONSTRAINT
    // name, so a later DROP CONSTRAINT by that name can take it out of the
    // column's text.
    const seen = new Set();
    for (const part of splitDef(def).parts) {
      const named = /^CONSTRAINT\s+(\S+)\s+(CHECK|REFERENCES)\b/i.exec(part);
      const kind = named ? named[2].toUpperCase() : (/^(CHECK|REFERENCES)\b/i.exec(part) || [])[1];
      if (!kind) continue;
      const clause = kind.toUpperCase();
      if (named) t.inline.set(ident(named[1]), { column: name, named: true, clause });
      else if (!seen.has(clause)) {
        seen.add(clause);
        t.inline.set(`${t.name}_${name}_${clause === 'CHECK' ? 'check' : 'fkey'}`, { column: name, named: false, clause });
      }
    }
  }

  function addConstraint(t, name, txt, line) {
    const c = t.constraints.get(name);
    if (c) { c.lines.push(line); c.text = txt; c.live = true; }
    else t.constraints.set(name, { name, text: txt, lines: [line], live: true });
  }

  // ALTER COLUMN c TYPE t, SET DATA TYPE t, SET DEFAULT e, DROP DEFAULT,
  // SET NOT NULL, DROP NOT NULL: applied to the column's text in file order,
  // the line of the last one kept for the render.
  function alterColumn(t, name, rest, line) {
    const col = t.columns.find((c) => c.name === name);
    if (!col) return;
    const d = splitDef(col.def);
    let m;
    if ((m = /^(?:SET\s+DATA\s+)?TYPE\s+([\s\S]+?)(?:\s+USING\s[\s\S]*)?$/i.exec(rest))) d.type = m[1].replace(/\s+COLLATE\s[\s\S]*$/i, '').trim();
    else if ((m = /^SET\s+DEFAULT\s+([\s\S]+)$/i.exec(rest))) {
      const at = d.parts.findIndex((p) => /^DEFAULT\b/i.test(p));
      if (at === -1) d.parts.push(`DEFAULT ${m[1].trim()}`); else d.parts[at] = `DEFAULT ${m[1].trim()}`;
    } else if (/^DROP\s+DEFAULT$/i.test(rest)) d.parts = d.parts.filter((p) => !/^DEFAULT\b/i.test(p));
    else if (/^SET\s+NOT\s+NULL$/i.test(rest)) {
      if (!d.parts.some((p) => /^NOT\s+NULL$/i.test(p))) d.parts = [...d.parts.filter((p) => !/^NULL$/i.test(p)), 'NOT NULL'];
    } else if (/^DROP\s+NOT\s+NULL$/i.test(rest)) d.parts = d.parts.filter((p) => !/^NOT\s+NULL$/i.test(p));
    else return;
    col.def = joinDef(d);
    col.altered = line;
  }

  // Takes a dropped inline CHECK or REFERENCES out of its column's text.
  function dropInline(t, name) {
    const inl = t.inline.get(name);
    if (!inl) return;
    t.inline.delete(name);
    const col = t.columns.find((c) => c.name === inl.column);
    if (!col) return;
    const d = splitDef(col.def);
    const own = inl.named
      ? (p) => new RegExp(`^CONSTRAINT\\s+"?${(inl.renamedFrom || name).replace(/[^A-Za-z0-9_]/g, '')}"?\\s`, 'i').test(p)
      : (p) => new RegExp(`^${inl.clause}\\b`, 'i').test(p);
    const at = d.parts.findIndex(own);
    if (at !== -1) d.parts.splice(at, 1);
    col.def = joinDef(d);
  }

  function alterAction(t, a, b) {
    const s = compact(co.slice(a, b).join(''));
    const n = compact(nc.slice(a, b).join(''));
    const line = lineOf(firstCode(a, b));
    let m;
    if ((m = new RegExp(`^ALTER\\s+(?:COLUMN\\s+)?${NAME}\\s+([\\s\\S]*)$`, 'i').exec(n))) alterColumn(t, ident(m[1]), m[2], line);
    else if ((m = new RegExp(`^ADD\\s+CONSTRAINT\\s+${NAME}`, 'i').exec(s))) addConstraint(t, ident(m[1]), n.replace(/^ADD\s+/i, ''), line);
    else if (/^ADD\s+(?:PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE)\b/i.test(s)) t.unnamed.push({ name: null, text: n.replace(/^ADD\s+/i, ''), lines: [line] });
    else if ((m = new RegExp(`^ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${ID}\\s[\\s\\S]*)$`, 'i').exec(n))) addColumn(t, compact(m[1]), line);
    else if ((m = new RegExp(`^DROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?${NAME}`, 'i').exec(s))) {
      const name = ident(m[1]);
      const c = t.constraints.get(name);
      if (c) c.live = false;
      dropInline(t, name);
    } else if ((m = new RegExp(`^DROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?${NAME}`, 'i').exec(s))) {
      const name = ident(m[1]);
      t.columns = t.columns.filter((c) => c.name !== name);
    } else if ((m = new RegExp(`^RENAME\\s+CONSTRAINT\\s+${NAME}\\s+TO\\s+${NAME}`, 'i').exec(s))) {
      const c = t.constraints.get(ident(m[1]));
      if (c) { t.constraints.delete(c.name); c.name = ident(m[2]); t.constraints.set(c.name, c); }
      const inl = t.inline.get(ident(m[1]));
      if (inl) { t.inline.delete(ident(m[1])); t.inline.set(ident(m[2]), { ...inl, renamedFrom: ident(m[1]) }); }
    } else if ((m = new RegExp(`^RENAME\\s+(?:COLUMN\\s+)?${NAME}\\s+TO\\s+${NAME}`, 'i').exec(s))) {
      const c = t.columns.find((col) => col.name === ident(m[1]));
      if (c) c.name = ident(m[2]);
      // Postgres keeps an auto-named constraint's old name across a column
      // rename: the registry keeps the name and follows the column.
      for (const inl of t.inline.values()) if (inl.column === ident(m[1])) inl.column = ident(m[2]);
    }
  }

  function statement(stmt) {
    const s = co.slice(stmt.start, stmt.end).join('');
    if (/^\s*DO\b/i.test(s)) {
      for (const [a, b] of stmt.bodies) for (const sub of scan(src, a, b, nc, co)) statement(sub);
      return;
    }
    for (const [a, b] of stmt.bodies) for (let k = a; k < b; k += 1) if (co[k] !== '\n') co[k] = ' ';
    const blanked = co.slice(stmt.start, stmt.end).join('');
    createTable(stmt, blanked);
    const alters = [...blanked.matchAll(new RegExp(`\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${NAME}`, 'gi'))];
    alters.forEach((m, k) => {
      const t = tables.get(ident(m[1]));
      if (!t) return;
      const a = stmt.start + m.index + m[0].length;
      const b = k + 1 < alters.length ? stmt.start + alters[k + 1].index : stmt.end;
      for (const [x, y] of splitTop(co, a, b)) alterAction(t, x, y);
    });
    const at = (m) => lineOf(stmt.start + m.index);
    for (const m of blanked.matchAll(new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:(?:IF\\s+NOT\\s+EXISTS\\s+)?${NAME}\\s+)?ON\\s+(?:ONLY\\s+)?${NAME}`, 'gi'))) {
      const t = tables.get(ident(m[2]));
      if (t) mark(t.indexes, m[1] ? ident(m[1]) : `(unnamed index ${at(m)})`, at(m));
    }
    for (const m of blanked.matchAll(new RegExp(`\\bDROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?${NAME}`, 'gi'))) {
      for (const t of tables.values()) { const x = t.indexes.get(ident(m[1])); if (x) x.live = false; }
    }
    for (const m of blanked.matchAll(new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+${NAME}[\\s\\S]*?\\bON\\s+(?:ONLY\\s+)?${NAME}`, 'gi'))) {
      const t = tables.get(ident(m[2]));
      if (t) mark(t.triggers, ident(m[1]), at(m));
    }
    for (const m of blanked.matchAll(new RegExp(`\\bDROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${NAME}\\s+ON\\s+(?:ONLY\\s+)?${NAME}`, 'gi'))) {
      const t = tables.get(ident(m[2]));
      const x = t && t.triggers.get(ident(m[1]));
      if (x) x.live = false;
    }
  }

  function mark(map, name, line) {
    const x = map.get(name);
    if (x) { x.lines.push(line); x.live = true; } else map.set(name, { name, lines: [line], live: true });
  }

  for (const stmt of scan(src, 0, src.length, nc, co)) statement(stmt);

  const live = (map) => [...map.values()].filter((x) => x.live).map(({ name, lines, text }) => (text === undefined ? { name, lines } : { name, text, lines }));
  return {
    tables: order.map((name) => {
      const t = tables.get(name);
      return {
        name: t.name,
        line: t.line,
        description: t.description,
        columns: t.columns.map((c) => ({ name: c.name, type: cut(c.def), line: c.line, altered: c.altered })),
        constraints: [...live(t.constraints), ...t.unnamed],
        indexes: live(t.indexes),
        triggers: live(t.triggers),
      };
    }),
  };
}

const pointers = (lines) => `(${lines.map((l) => `:${l}`).join(', ')})`;

function render(parsed, file = FILE) {
  const out = [];
  for (const t of (parsed && parsed.tables) || []) {
    const desc = plain(t.description);
    out.push(`**${t.name}** (${file}:${t.line})${desc ? ` ${desc}` : ''}`);
    if (t.columns.length) out.push(`- columns: ${t.columns.map((c) => plain(`${c.name} ${c.type}${c.altered ? ` (:${c.altered})` : ''}`)).join(', ')}`);
    if (t.constraints.length) out.push(`- constraints: ${t.constraints.map((c) => `${plain(c.name || cut(compact(c.text)))} ${pointers(c.lines)}`).join(', ')}`);
    if (t.indexes.length) out.push(`- indexes: ${t.indexes.map((x) => `${x.name} ${pointers(x.lines)}`).join(', ')}`);
    if (t.triggers.length) out.push(`- triggers: ${t.triggers.map((x) => `${x.name} ${pointers(x.lines)}`).join(', ')}`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

module.exports = { parse, render, FILE };

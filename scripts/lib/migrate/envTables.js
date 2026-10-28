'use strict';

// The two hand environment-variable tables (README.md's and the project
// CLAUDE.md's), read for the port into .env.example (instruction rewrite step
// 4, lane migrate-headers; plan 2026-10-27 decision 6, the contract
// "scripts/migrate-headers.js"): the draft the env-port lane edits, and the
// row-by-row check that the port kept every row.
//
//   parseTable(markdown, source)  rows of the first table under `##
//                          Environment Variables`: {source, line, names, globs,
//                          required, description}. The Variable cell may name
//                          several variables (`A` / `B`) or a prefix glob
//                          (`R2_*`); README's table has a Required column,
//                          CLAUDE.md's has Purpose for Description. Escaped
//                          pipes are unescaped; the last column keeps a bare
//                          pipe its text holds.
//   requiredPhrase(cell)   the line a Required cell opens as: null for No or
//                          Optional, "Required." for Yes ("Required*." for
//                          Yes*), "Required for <rest>." for "For <rest>",
//                          "Required (<cell>)." otherwise
//   requiredWords(cell)    what env-check looks for: none for No; "optional"
//                          for Optional (decision 6 keeps it); else "required"
//                          and every word of the cell but "yes"
//   rowTokens(row)         {spans, numbers}: every code span's text, and every
//                          number outside them (a date as one, a decimal or a
//                          clock time as one, any other separator splitting)
//   toConvention(lines)    decision 6's convention: a group's first comment
//                          line becomes a section heading with a blank line
//                          after it when it is a rule-decorated line (`# ───
//                          Title ───`), or a short title (45 characters or
//                          fewer, no closing punctuation) over two or more
//                          variables; every other line stays where it is
//   draft(envText, rows)   {text, missing}: the file brought to the convention,
//                          and above each variable (its kept declaration, the
//                          one env.js reads) its existing block, then the
//                          Required line (or "Optional." when the cell is
//                          Optional and the block does not say it), then each
//                          row description the block does not already hold
//                          verbatim, first line labelled `# [README] ` or `#
//                          [CLAUDE.md] `, wrapped at 100. Adjacent variables
//                          share their block (env.js reads it so), so every
//                          member's lines go above the chain's first line, in
//                          member order, each skipped when the shared text
//                          already holds it, and the declarations stay
//                          adjacent. When a chain's members' Required phrases
//                          differ (a member with none, a No, differs), each
//                          Required or Optional line names the members it
//                          covers: "Required for uploads (A, B)." or
//                          "Optional (C)."; when they share one phrase, and
//                          for a single variable, the line is bare. Comment
//                          lines lose their em dashes; variable lines are
//                          byte-identical. missing
//                          names each table variable the file lacks.
//   check(envText, rows)   [{name, token}]: for every row and every variable it
//                          names, each code span, number and required word
//                          missing from that variable's block (env.js parse).
//                          The required words are looked for anywhere in the
//                          block, so a named line ("Required for uploads (A,
//                          B).") satisfies them for every variable of its
//                          chain: the names neither add a word nor are
//                          checked. A number is found only as a token of the
//                          block by the same rule the row is read with, so a
//                          row's 30 is not found inside a block's 2026-09-30,
//                          nor its 5 inside 1.5. A code span is found as
//                          written anywhere in the block, except a span the
//                          number rule reads as exactly one number and nothing
//                          else (`0`, `60`, `2026-08-25`): that span is a
//                          number and found only as a token, so a row's `0`
//                          is not found inside a block's 300 or 2026-08-25,
//                          while `2560x3200` and `gpt-5.4-mini` are still
//                          found as written. A phone-shaped token (10 to 15
//                          digits, no letters) is found as written, or by its
//                          last four digits standing alone (the business
//                          lines are named by them, never added as a literal);
//                          an email-shaped one also on the variable's own
//                          line. A table variable the file lacks reads
//                          `not in .env.example`.

const { parse: parseEnv } = require('../genDocs/env');
const { plain } = require('../genDocs/markers');
const { splitCells, last, unescapeCell, noEmDash, wrapText, splitText, joinText } = require('./archRows');

// The variable-line shapes of scripts/lib/genDocs/env.js (kept in step with it).
const ACTIVE = /^([A-Z][A-Z0-9_]*)=(.*)$/;
const COMMENTED = /^#\s?([A-Z][A-Z0-9_]*)=('[^']*'|"[^"]*"|\S*)$/;
const SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;
const LABELS = Object.freeze({ README: '# [README] ', 'CLAUDE.md': '# [CLAUDE.md] ' });

function varLine(line) {
  const l = String(line).trimEnd();
  const m = ACTIVE.exec(l) || COMMENTED.exec(l);
  return m ? { name: m[1], active: Boolean(ACTIVE.exec(l)) } : null;
}

function parseTable(markdown, source) {
  const lines = String(markdown == null ? '' : markdown).split('\n').map((l) => l.replace(/\r$/, ''));
  const h = lines.findIndex((l) => /^##\s+Environment Variables\s*$/.test(l));
  if (h === -1) throw new Error(`${source} has no "## Environment Variables" section`);
  let i = h + 1;
  while (i < lines.length && !lines[i].trim().startsWith('|') && !/^##\s/.test(lines[i])) i += 1;
  if (i >= lines.length || !lines[i].trim().startsWith('|')) throw new Error(`${source} "## Environment Variables" holds no table`);
  const head = splitCells(lines[i]).map((c) => c.trim().toLowerCase());
  const col = { name: head.indexOf('variable'), required: head.indexOf('required'), text: head.findIndex((c) => c === 'description' || c === 'purpose') };
  if (col.name === -1 || col.text === -1) throw new Error(`${source} env table has no Variable or Description column`);
  const rows = [];
  for (let j = i + 1; j < lines.length && lines[j].trim().startsWith('|'); j += 1) {
    if (SEPARATOR.test(lines[j].trim())) continue;
    const raw = splitCells(lines[j]);
    const cells = raw.map((c) => c.trim());
    const spans = [...(cells[col.name] || '').matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    rows.push({
      source,
      line: j + 1,
      names: spans.filter((s) => /^[A-Z][A-Z0-9_]*$/.test(s)),
      globs: spans.filter((s) => /^[A-Z][A-Z0-9_]*\*$/.test(s)),
      required: col.required === -1 ? null : unescapeCell(cells[col.required] || ''),
      description: unescapeCell(col.text === head.length - 1 ? last(raw, col.text) : (cells[col.text] || '')),
    });
  }
  return rows;
}

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function requiredPhrase(cell) {
  const c = String(cell || '').trim();
  if (!c || /^(?:no|optional)$/i.test(c)) return null;
  const yes = /^yes(\*?)$/i.exec(c);
  if (yes) return `Required${yes[1]}.`;
  if (/^for\s/i.test(c)) return `Required ${lowerFirst(c)}.`;
  return `Required (${lowerFirst(c)}).`;
}

function requiredWords(cell) {
  const c = String(cell || '').trim();
  if (!c || /^no$/i.test(c)) return [];
  if (/^optional$/i.test(c)) return ['optional'];
  const words = c.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && w !== 'yes' && w !== 'required');
  return ['required', ...words];
}

// The numbers in a text, by one rule for both sides: a date (YYYY-MM-DD) is
// one, a decimal or a clock time is one, any other separator splits.
const NUMBER = /\d{4}-\d{2}-\d{2}|\d+(?:[.:]\d+)*/g;
const numbersIn = (text) => String(text).match(NUMBER) || [];

function rowTokens(row) {
  const spans = [];
  const rest = String(row.description).replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (m, fence, inner) => {
    spans.push(plain(inner));
    return ' ';
  });
  const numbers = numbersIn(rest);
  return { spans: [...new Set(spans.filter(Boolean))], numbers: [...new Set(numbers)] };
}

// The variables a row names among the file's, and the names it names that the
// file lacks.
function expand(row, fileNames) {
  const names = [];
  const missing = [];
  for (const n of row.names) (fileNames.includes(n) ? names : missing).push(n);
  for (const g of row.globs) {
    const hits = fileNames.filter((n) => n.startsWith(g.slice(0, -1)));
    if (hits.length) names.push(...hits); else missing.push(g);
  }
  return { names: [...new Set(names)], missing };
}

// ---- the draft ---------------------------------------------------------------

const isComment = (c) => c.trimStart().startsWith('#') && !varLine(c);

function isTitle(c, variables) {
  const t = c.trim().replace(/^#+\s*/, '').trim();
  if (/^[─-╿=~*_-]{2,}/.test(t)) return true;
  return variables >= 2 && t.length > 0 && t.length <= 45 && !/[.:;,]$/.test(t);
}

function toConvention(lines, eol = '\n') {
  const out = [];
  let group = [];
  const flush = () => {
    const vars = group.filter((l) => varLine(l.c)).length;
    if (vars > 0 && group.length > 1 && isComment(group[0].c) && isTitle(group[0].c, vars)) {
      out.push(group[0], { c: '', e: group[0].e || eol }, ...group.slice(1));
    } else out.push(...group);
    group = [];
  };
  for (const l of lines) {
    if (l.c.trim() === '') { flush(); out.push(l); } else group.push(l);
  }
  flush();
  return out;
}

const stripHashes = (c) => c.replace(/^\s*#+/, '').trim();
const holds = (ctx, d) => {
  const c = plain(ctx);
  return c.includes(d) || c.includes(d.replace(/`/g, ''));
};

function labelled(label, text) {
  const words = wrapText(text, 100 - LABELS['CLAUDE.md'].length);
  const out = [];
  words.forEach((w, k) => {
    const line = k === 0 ? `${LABELS[label]}${w}` : `# ${w}`;
    if (k > 0 && varLine(line)) out[out.length - 1] += ` ${w}`;
    else out.push(line);
  });
  return out;
}

// A variable's Required line text ("Optional." for an Optional cell), or null.
function headPhrase(rows) {
  const cell = (rows.find((r) => r.source === 'README' && r.required) || {}).required;
  return requiredPhrase(cell) || (/^optional$/i.test(String(cell || '').trim()) ? 'Optional.' : null);
}

// One variable's added lines: the head (the Required or Optional line), then
// each row description, each skipped when the shared block already holds it.
// head is the lines to use, or null for the bare phrase, itself skipped when
// the block already says it.
function additions(rows, context, head = null) {
  const descs = [];
  let ctx = context;
  for (const r of rows) {
    const d = plain(noEmDash(r.description));
    if (!d || holds(ctx, d)) continue;
    descs.push(...labelled(r.source, d));
    ctx = `${ctx} ${d}`;
  }
  if (head) return [...head, ...descs];
  const phrase = headPhrase(rows);
  const bare = [];
  if (phrase === 'Optional.') { if (!/\boptional\b/i.test(ctx)) bare.push('# Optional.'); } else if (phrase && !plain(ctx).toLowerCase().includes(phrase.toLowerCase())) bare.push(`# ${phrase}`);
  return [...bare, ...descs];
}

// The head lines of a chain's members: when the members' phrases differ (a
// member with none counts as different), each phrase is one line naming the
// members it covers, written with the first of them; otherwise null for each
// (the bare line, as for a single variable).
function chainHeads(members) {
  const phrases = members.map((m) => headPhrase(m.rows));
  if (members.length < 2 || new Set(phrases).size < 2) return members.map(() => null);
  const seen = new Set();
  return phrases.map((p) => {
    if (!p || seen.has(p)) return [];
    seen.add(p);
    const covers = members.filter((_, x) => phrases[x] === p).map((m) => m.name);
    return [`# ${p.replace(/\.$/, '')} (${covers.join(', ')}).`];
  });
}

function draft(envText, rows) {
  const parts = splitText(envText);
  const lines = toConvention(parts.lines, parts.eol);
  const kept = new Map();
  lines.forEach((l, k) => {
    const v = varLine(l.c);
    if (v && (!kept.has(v.name) || v.active)) kept.set(v.name, k);
  });
  const fileNames = [...kept.keys()];
  const byName = new Map();
  const missing = [];
  for (const r of rows) {
    const { names, missing: lack } = expand(r, fileNames);
    for (const n of names) {
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(r);
    }
    for (const n of lack) missing.push({ name: n, source: r.source });
  }
  for (const list of byName.values()) list.sort((a, b) => (a.source === b.source ? 0 : a.source === 'README' ? -1 : 1));
  const out = [];
  let block = [];
  for (let k = 0; k < lines.length;) {
    const l = lines[k];
    if (varLine(l.c)) {
      // A chain of adjacent declarations shares the block above its first
      // line, so every member's additions go there, in member order.
      let j = k;
      while (j < lines.length && varLine(lines[j].c)) j += 1;
      let ctx = block.join(' ');
      const members = [];
      for (let m = k; m < j; m += 1) {
        const name = varLine(lines[m].c).name;
        if (kept.get(name) === m) members.push({ name, rows: byName.get(name) || [] });
      }
      const heads = chainHeads(members);
      members.forEach((member, x) => {
        const add = additions(member.rows, ctx, heads[x]);
        for (const a of add) out.push({ c: a, e: parts.eol });
        ctx = `${ctx} ${add.map(stripHashes).join(' ')}`;
      });
      out.push(...lines.slice(k, j));
      block = [];
      k = j;
      continue;
    }
    if (l.c.trim() !== '' && isComment(l.c)) {
      block.push(stripHashes(l.c));
      out.push({ c: noEmDash(l.c), e: l.e });
    } else {
      block = [];
      out.push(l);
    }
    k += 1;
  }
  return { text: joinText({ bom: parts.bom, lines: out }), missing };
}

// ---- the check ---------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const digitsOf = (s) => s.replace(/\D/g, '');
const phoneShaped = (s) => !/[A-Za-z]/.test(s) && digitsOf(s).length >= 10 && digitsOf(s).length <= 15;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// A number is found only where it stands as its own token by the row side's
// rule, never inside a date, a time or a decimal (2026-09-30 holds no 30).
const hasNumber = (text, n) => numbersIn(text).includes(n);
// A code span the number rule reads as exactly one number and nothing else
// (`0`, `60`, `2026-08-25`) is checked as that number, never by substring, so
// a row's `0` is not found inside a block's 300; any other span (`2560x3200`,
// `gpt-5.4-mini`) is found as written.
const isOneNumber = (span) => {
  const n = numbersIn(span);
  return n.length === 1 && n[0] === span;
};

function found(token, block, own, number) {
  if (phoneShaped(token)) return block.includes(token) || hasNumber(block, digitsOf(token)) || hasNumber(block, digitsOf(token).slice(-4));
  if (number) return hasNumber(block, token);
  if (EMAIL.test(token)) return block.includes(token) || own.includes(token);
  return block.includes(token);
}

function check(envText, rows) {
  const vars = new Map();
  for (const s of parseEnv(envText).sections) for (const v of s.variables) vars.set(v.name, v);
  const fileLines = String(envText).split('\n');
  const misses = [];
  const seen = new Set();
  const miss = (name, token) => {
    const k = `${name}\u0000${token}`;
    if (!seen.has(k)) { seen.add(k); misses.push({ name, token }); }
  };
  for (const row of rows) {
    const { names, missing } = expand(row, [...vars.keys()]);
    for (const n of missing) miss(n, 'not in .env.example');
    const { spans, numbers } = rowTokens(row);
    const words = requiredWords(row.required);
    for (const name of names) {
      const v = vars.get(name);
      const block = v.description;
      const own = fileLines[v.line - 1] || '';
      for (const t of spans) if (!found(t, block, own, isOneNumber(t))) miss(name, t);
      for (const n of numbers) if (!found(n, block, own, true)) miss(name, n);
      for (const w of words) if (!new RegExp(`\\b${escapeRe(w)}\\b`, 'i').test(block)) miss(name, w);
    }
  }
  return misses;
}

module.exports = { parseTable, requiredPhrase, requiredWords, rowTokens, expand, toConvention, draft, check, varLine };

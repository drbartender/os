'use strict';

// The environment-variable table for README.md's gen:env section, read from
// .env.example (instruction rewrite step 4, lane gen-docs; plan 2026-10-27
// decision 6 and the contract "The env table").
//
//   parse(text)    -> {sections: [{heading, note, variables: [{name, default,
//                     active, description, line}]}]}
//   render(parsed) -> a notice line, then per section a `### <heading>` line,
//                     its note, and a
//                     `| Variable | Value in .env.example | Description |` table
//
// The convention, line by line:
//   - a variable line is `NAME=value` (active) or `#NAME=value` / `# NAME=value`
//     (commented out, one space at most after the #, nothing after the
//     value), NAME matching [A-Z][A-Z0-9_]*; any other comment line is text;
//   - a heading is a comment line, or a run of them, followed by a blank line
//     (or the end of the file) with no variable line before the blank; it
//     opens a section. Its first line is the heading, the rest its note;
//   - a variable's block is the run of comment lines directly above it;
//     adjacent variable lines (nothing between them) share the block above the
//     first; a variable with no block above it has an empty description.
// The value column is the literal value on the template's line (the file is a
// template and holds no secret), or `unset` for a commented-out line. It is
// the template's sample, never the default the code uses when the variable is
// unset (that lives in the block, when the block says it), and the section's
// first line says so (plan 2026-10-27 decision 6, as amended). The
// description is the
// block's lines joined with single spaces. Variables before the first heading
// render with no heading line. A name declared more than once is one entry,
// its last active declaration, value and block (dotenv keeps the last);
// declared active more than once, its row ends `(declared twice, lines 295
// and 533; dotenv keeps the last)`.

const { cell, code, plain } = require('./markers');

const ACTIVE = /^([A-Z][A-Z0-9_]*)=(.*)$/;
// `#NAME=value` or `# NAME=value` with nothing after the value (a quoted
// value may hold spaces): an indented line such as `#   NAME=true   force-on
// locally`, or one with prose after the value, is description text.
const COMMENTED = /^#\s?([A-Z][A-Z0-9_]*)=('[^']*'|"[^"]*"|\S*)$/;

const stripHash = (l) => l.replace(/^#+/, '').trim();
const undecorate = (s) => s.replace(/^[\s─═=_~*-]+/, '').replace(/[\s─═=_~*-]+$/, '').trim();

function parse(text) {
  const lines = String(text == null ? '' : text).split('\n').map((l) => l.replace(/\r$/, ''));
  const sections = [{ heading: null, note: '', variables: [] }];
  let pending = [];
  let lastWasVar = false;
  let shared = '';

  const openSection = (run) => {
    const words = run.map(stripHash);
    const at = words.findIndex((w) => undecorate(w) !== '');
    const heading = at === -1 ? '' : undecorate(words[at]);
    const note = at === -1 ? '' : words.slice(at + 1).join(' ');
    sections.push({ heading, note: plain(note), variables: [] });
  };

  lines.forEach((raw, k) => {
    const l = raw.trimEnd();
    const active = ACTIVE.exec(l);
    const commented = active ? null : COMMENTED.exec(l);
    if (active || commented) {
      const m = active || commented;
      let description;
      if (pending.length) {
        description = plain(pending.map(stripHash).join(' '));
      } else if (lastWasVar) {
        description = shared;
      } else {
        description = '';
      }
      shared = description;
      sections[sections.length - 1].variables.push({
        name: m[1],
        default: active ? m[2] : null,
        active: Boolean(active),
        description,
        line: k + 1,
      });
      pending = [];
      lastWasVar = true;
      return;
    }
    if (l.trim() === '') {
      if (pending.length) openSection(pending);
      pending = [];
      lastWasVar = false;
      return;
    }
    if (l.trimStart().startsWith('#')) {
      pending.push(l.trimStart());
      lastWasVar = false;
      return;
    }
    // Anything else (not a comment, not a variable) separates like a blank.
    if (pending.length) openSection(pending);
    pending = [];
    lastWasVar = false;
  });
  if (pending.length) openSection(pending);
  // One entry per name: the last active declaration (dotenv parses the file
  // top to bottom and a later line overwrites an earlier one), else the
  // first; a name declared active more than once records its lines.
  const all = sections.flatMap((s) => s.variables);
  const keep = new Map();
  for (const v of all) {
    const k = keep.get(v.name);
    if (!k || v.active) keep.set(v.name, v);
  }
  for (const v of keep.values()) {
    const actives = all.filter((x) => x.name === v.name && x.active).map((x) => x.line);
    if (actives.length > 1) v.declared = actives;
  }
  for (const s of sections) s.variables = s.variables.filter((v) => keep.get(v.name) === v);
  return { sections: sections.filter((s, i) => i > 0 || s.variables.length > 0) };
}

const TIMES = ['', 'once', 'twice', 'three times'];
function declaredNote(lines) {
  const list = lines.length === 2 ? `${lines[0]} and ${lines[1]}` : `${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}`;
  return `(declared ${TIMES[lines.length] || `${lines.length} times`}, lines ${list}; dotenv keeps the last)`;
}

const NOTICE = 'Each value is the sample .env.example carries, never the default the code uses when the variable is unset.';

function render(parsed) {
  const out = [];
  const sections = (parsed && parsed.sections) || [];
  if (sections.some((s) => s.variables.length)) out.push(NOTICE, '');
  for (const s of sections) {
    if (s.heading !== null) {
      out.push(`### ${plain(s.heading) || '(untitled)'}`, '');
      if (s.note) out.push(plain(s.note), '');
    }
    if (s.variables.length) {
      out.push('| Variable | Value in .env.example | Description |', '|---|---|---|');
      for (const v of s.variables) {
        const value = v.active ? (v.default === '' ? '' : code(v.default)) : 'unset';
        const description = v.declared ? `${v.description} ${declaredNote(v.declared)}`.trim() : v.description;
        out.push(`| ${code(v.name)} | ${value} | ${cell(description)} |`);
      }
      out.push('');
    }
  }
  return out.join('\n').trimEnd();
}

module.exports = { parse, render };

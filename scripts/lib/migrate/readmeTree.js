'use strict';

// README's hand folder tree, read for the one-shot header migration
// (instruction rewrite step 4, lane migrate-headers; plan 2026-10-27
// decisions 2 and 3, the contract "scripts/migrate-headers.js"), and the
// header text a header-less source file gets.
//
//   parseTree(readmeText)  {entries: [{path, kind, description, line}],
//                          dropped: [{path, text, line, file}], droppedFiles}
//                          from the fenced
//                          block under `## Folder Structure`. A line's depth
//                          is its count of four-character branch units
//                          (`│   `, `├── `, `└── `, four spaces) up to and with
//                          its branch; its name is the text after the branch
//                          up to `#`, its description the text after `#`. A
//                          name ending in `/` is a directory (kind 'dir'), a
//                          name in parentheses a route group (kind 'group',
//                          not a file), anything else a file; a name may hold
//                          slashes (`proposalEditor/editorCore.js`). The path
//                          is the open directories at smaller depths joined
//                          with the name; the root line (`dr-bartender/`, no
//                          branch) is dropped. A `#` line with no branch
//                          continues the entry above it. Every directory and
//                          route-group description, every continuation line,
//                          and every described file that is not a source file
//                          (genDocs/headers.isSource, so it can take no
//                          header) is a dropped item, its path the entry's (a
//                          directory's ending in `/`); droppedFiles counts the
//                          files.
//   droppedLines(parsed)   `<path>: <text>` per dropped item, README order, no
//                          em dash
//   fileDescriptions(parsed)  Map path -> description for the file entries
//                          (the first, when a path is listed twice)
//   readExports(text, path) {kind: 'component' | 'default' | 'named' |
//                          'none', name, names} by acorn with acorn-jsx,
//                          module then script, or null when neither parses.
//                          ESM first (export default, export named, export
//                          *), else CommonJS (module.exports = ..., exports.x
//                          = ..., module.exports.x = ...). A default export
//                          is a component when it is a function or class
//                          (or a call wrapping one, memo(...) and the like)
//                          whose name starts with a capital, in a file under
//                          client/src or a .jsx file; a server class is not
//                          a React component.
//   generatedDescription(exportsInfo, path, date)  the generated form (plan
//                          decision 2): "<Name> (React component, default
//                          export).", "<Name> (default export).", "Exports a,
//                          b, c." (eight names, then "and N more") or
//                          "<basename>: entry point, no exports.", then
//                          "Header generated from the file's exports by
//                          migrate-headers on <date>; replace with what it
//                          does."

const path = require('node:path');
const acorn = require('acorn');
const acornJsx = require('acorn-jsx');
const { noEmDash } = require('./archRows');
const { isSource } = require('../genDocs/headers');

const PARSER = acorn.Parser.extend(acornJsx());
const UNITS = ['│   ', '├── ', '└── ', '    '];
const BRANCHES = new Set(['├── ', '└── ']);

function fenced(text) {
  const lines = String(text == null ? '' : text).split('\n').map((l) => l.replace(/\r$/, ''));
  const h = lines.findIndex((l) => /^##\s+Folder Structure\s*$/.test(l));
  if (h === -1) throw new Error('README.md has no "## Folder Structure" section');
  let open = -1;
  for (let i = h + 1; i < lines.length && !/^##\s/.test(lines[i]); i += 1) {
    if (lines[i].trim().startsWith('```')) { open = i; break; }
  }
  if (open === -1) throw new Error('README.md "## Folder Structure" holds no fenced block');
  let close = lines.findIndex((l, i) => i > open && l.trim().startsWith('```'));
  if (close === -1) close = lines.length;
  return { lines: lines.slice(open + 1, close), offset: open + 2 };
}

function measure(line) {
  let i = 0;
  let depth = 0;
  for (;;) {
    const u = UNITS.find((x) => line.startsWith(x, i));
    if (!u) return { depth, branch: false, rest: line.slice(i) };
    depth += 1;
    i += u.length;
    if (BRANCHES.has(u)) return { depth, branch: true, rest: line.slice(i) };
  }
}

function parseTree(readmeText) {
  const { lines, offset } = fenced(readmeText);
  const entries = [];
  const dropped = [];
  const stack = [];
  let last = null;
  lines.forEach((raw, k) => {
    const line = offset + k;
    const m = measure(raw);
    if (!m.branch) {
      const t = m.rest.trim();
      if (t.startsWith('#') && last) dropped.push({ path: last.key, text: t.slice(1).replace(/^ /, '').trimEnd(), line });
      return;
    }
    const hash = m.rest.indexOf('#');
    const name = (hash === -1 ? m.rest : m.rest.slice(0, hash)).trim();
    const description = hash === -1 ? '' : m.rest.slice(hash + 1).trim();
    if (!name) return;
    stack.length = m.depth;
    const parents = stack.slice(1, m.depth);
    const kind = name.endsWith('/') ? 'dir' : /^\(.*\)$/.test(name) ? 'group' : 'file';
    const bare = name.replace(/\/+$/, '');
    const p = Array.from(parents).every((x) => typeof x === 'string') ? [...parents, bare].join('/') : null;
    if (kind === 'dir') stack[m.depth] = bare;
    const entry = { path: p, kind, description, line, key: kind === 'dir' ? `${p}/` : p };
    entries.push(entry);
    last = p === null ? null : entry;
    const noHeader = kind !== 'file' || !isSource(p);
    if (p !== null && noHeader && description) dropped.push({ path: entry.key, text: description, line, file: kind === 'file' });
  });
  return { entries: entries.map(({ key, ...e }) => e), dropped, droppedFiles: dropped.filter((d) => d.file).length };
}

function droppedLines(parsed) {
  return parsed.dropped.map((d) => noEmDash(`${d.path}: ${d.text}`));
}

function fileDescriptions(parsed) {
  const map = new Map();
  for (const e of parsed.entries) {
    if (e.kind === 'file' && e.path && e.description && !map.has(e.path)) map.set(e.path, e.description);
  }
  return map;
}

// ---- the generated form ------------------------------------------------------

function parse(text) {
  const body = String(text).charCodeAt(0) === 0xfeff ? String(text).slice(1) : String(text);
  for (const sourceType of ['module', 'script']) {
    try {
      return PARSER.parse(body, { ecmaVersion: 'latest', sourceType, allowHashBang: true, allowReturnOutsideFunction: sourceType === 'script' });
    } catch {
      // static-checks: allow swallowed-catch (a module parse failure means the script grammar is tried next; readExports returns null when neither parses)
    }
  }
  return null;
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassDeclaration', 'ClassExpression']);
const isId = (n, name) => n && n.type === 'Identifier' && (name === undefined || n.name === name);
const keyName = (k) => (k && k.type === 'Identifier' ? k.name : k && k.type === 'Literal' ? String(k.value) : null);

function topBindings(ast) {
  const map = new Map();
  for (const s of ast.body) {
    const d = (s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration') ? s.declaration : s;
    if (!d) continue;
    if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) map.set(d.id.name, d);
    if (d.type === 'VariableDeclaration') for (const v of d.declarations) if (isId(v.id)) map.set(v.id.name, v.init || null);
  }
  return map;
}

// {name, fn}: the value's own name when it has one, and whether it is a
// function or a class (or a call wrapping one).
function valueOf(node, bindings, depth = 0) {
  if (!node || depth > 4) return { name: null, fn: false };
  if (FUNCTIONS.has(node.type)) return { name: node.id ? node.id.name : null, fn: true };
  if (isId(node)) {
    const b = bindings.get(node.name);
    return { name: node.name, fn: b && b !== node ? valueOf(b, bindings, depth + 1).fn : false };
  }
  if (node.type === 'CallExpression') {
    const c = node.callee;
    if (c.type === 'MemberExpression' && isId(c.object, 'Object') && keyName(c.property) === 'assign') return valueOf(node.arguments[0], bindings, depth + 1);
    for (const a of node.arguments) {
      const v = valueOf(a, bindings, depth + 1);
      if (v.fn) return v;
    }
    if (c.type === 'CallExpression') return valueOf(c, bindings, depth + 1);
  }
  return { name: null, fn: false };
}

function patternNames(p, out) {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'ObjectPattern') p.properties.forEach((q) => patternNames(q.type === 'RestElement' ? q.argument : q.value, out));
  else if (p.type === 'ArrayPattern') p.elements.forEach((q) => patternNames(q, out));
  else if (p.type === 'RestElement') patternNames(p.argument, out);
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  return out;
}

const isModuleExports = (n) => n && n.type === 'MemberExpression' && isId(n.object, 'module') && keyName(n.property) === 'exports' && !n.computed;

function readExports(text, file) {
  const ast = parse(text);
  if (!ast) return null;
  const bindings = topBindings(ast);
  const base = path.posix.basename(file).replace(/\.[^.]+$/, '');
  let def = null;
  let named = [];
  for (const s of ast.body) {
    if (s.type === 'ExportDefaultDeclaration') def = valueOf(s.declaration, bindings);
    else if (s.type === 'ExportNamedDeclaration') {
      const d = s.declaration;
      if (d && d.type === 'VariableDeclaration') d.declarations.forEach((v) => patternNames(v.id, named));
      else if (d && d.id) named.push(d.id.name);
      for (const sp of s.specifiers || []) {
        const exported = keyName(sp.exported);
        if (exported === 'default') {
          const local = keyName(sp.local);
          def = local === 'default' && s.source ? { name: path.posix.basename(String(s.source.value)).replace(/\.[^.]+$/, ''), fn: false } : valueOf(sp.local, bindings);
        } else if (exported) named.push(exported);
      }
    } else if (s.type === 'ExportAllDeclaration') {
      named.push(s.exported ? keyName(s.exported) : `everything from ${s.source.value}`);
    }
  }
  if (!def && named.length === 0) {
    for (const s of ast.body) {
      const e = s.type === 'ExpressionStatement' && s.expression.type === 'AssignmentExpression' && s.expression.operator === '=' ? s.expression : null;
      if (!e) continue;
      if (isModuleExports(e.left)) {
        if (e.right.type === 'ObjectExpression') {
          def = null;
          named = e.right.properties.map((p) => (p.type === 'Property' && !p.computed ? keyName(p.key) : null)).filter(Boolean);
        } else {
          def = valueOf(e.right, bindings);
          named = [];
        }
      } else if (e.left.type === 'MemberExpression' && !e.left.computed && (isModuleExports(e.left.object) || isId(e.left.object, 'exports'))) {
        named.push(keyName(e.left.property));
      }
    }
  }
  named = [...new Set(named.filter(Boolean))];
  if (def) {
    const name = def.name || base;
    const client = file.startsWith('client/src/') || file.endsWith('.jsx');
    return { kind: def.fn && client && /^[A-Z]/.test(name) ? 'component' : 'default', name, names: named };
  }
  if (named.length) return { kind: 'named', name: null, names: named };
  return { kind: 'none', name: null, names: [] };
}

function generatedDescription(info, file, date) {
  let what;
  if (info.kind === 'component') what = `${info.name} (React component, default export).`;
  else if (info.kind === 'default') what = `${info.name} (default export).`;
  else if (info.kind === 'named') {
    const shown = info.names.slice(0, 8).join(', ');
    what = `Exports ${shown}${info.names.length > 8 ? ` and ${info.names.length - 8} more` : ''}.`;
  } else what = `${path.posix.basename(file)}: entry point, no exports.`;
  return `${what} Header generated from the file's exports by migrate-headers on ${date}; replace with what it does.`;
}

module.exports = { parseTree, droppedLines, fileDescriptions, readExports, generatedDescription };

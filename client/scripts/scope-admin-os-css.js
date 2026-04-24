#!/usr/bin/env node
/* eslint-disable */
// One-shot utility: takes the handoff admin-os styles.css and scopes every
// selector under `html[data-app="admin-os"]` so it only takes effect when
// AdminLayout is mounted and sets that attribute. Keeps media queries intact.
//
// Usage:
//   node client/scripts/scope-admin-os-css.js <input.css> > <output.css>
//
// Transforms:
//   :root                              -> html[data-app="admin-os"]
//   [data-skin="dark"] { ... }         -> html[data-app="admin-os"][data-skin="dark"] { ... }
//   [data-skin="light"] .foo { ... }   -> html[data-app="admin-os"][data-skin="light"] .foo { ... }
//   :root[data-palette="rainbow"] ...  -> html[data-app="admin-os"][data-palette="rainbow"] ...
//   [data-density="compact"] { ... }   -> html[data-app="admin-os"][data-density="compact"] { ... }
//   [data-sidebar="rail"] .shell {..}  -> html[data-app="admin-os"][data-sidebar="rail"] .shell {..}
//   html, body { ... }                 -> html[data-app="admin-os"], html[data-app="admin-os"] body { ... }
//   button { ... }                     -> html[data-app="admin-os"] button { ... }
//   .foo { ... }                       -> html[data-app="admin-os"] .foo { ... }
//   *, .bar:hover                      -> same treatment; prefixes each comma-separated selector
//   ::-webkit-scrollbar (global pseudo)-> html[data-app="admin-os"] ::-webkit-scrollbar
//   @media (...) { .foo { ... } }      -> @media (...) { <recursive prefix inside> }
//
// Idempotent: if a selector is already scoped, it is left alone.

const fs = require('fs');

const SCOPE = 'html[data-app="admin-os"]';
const SCOPE_ATTR_PREFIX = /^\[data-(skin|density|sidebar|palette)=/;
const ALREADY_SCOPED = /\bhtml\[data-app="admin-os"\]/;

function prefixSelector(sel) {
  sel = sel.trim();
  if (!sel) return sel;
  if (ALREADY_SCOPED.test(sel)) return sel;

  // `html` alone — replace with scoped element
  if (sel === 'html') return SCOPE;
  // `body` alone — scope descendant
  if (sel === 'body') return `${SCOPE} body`;

  // `:root` — replace with SCOPE itself (since :root is the html element)
  if (sel === ':root') return SCOPE;

  // `:root[data-palette="rainbow"]` — combine as attribute on scope
  if (sel.startsWith(':root[')) {
    return SCOPE + sel.slice(5); // strip ":root"
  }

  // `[data-skin="dark"]`, `[data-density="comfy"]`, etc. — attr lives on
  // the SAME element as data-app, so merge into the attribute chain.
  if (SCOPE_ATTR_PREFIX.test(sel)) {
    // extract the attribute(s) sequence, and the rest
    // examples: `[data-skin="light"]`  or `[data-skin="light"] .foo` or `[data-skin="light"].bar`
    const m = sel.match(/^((?:\[data-(?:skin|density|sidebar|palette)="[^"]+"\])+)(.*)$/);
    if (m) {
      const attrs = m[1];
      const rest = m[2];
      return SCOPE + attrs + rest;
    }
  }

  // Everything else: prefix with SCOPE + space
  return `${SCOPE} ${sel}`;
}

function prefixSelectorList(list) {
  return list
    .split(',')
    .map(s => prefixSelector(s.trim()))
    .join(', ');
}

// A tiny CSS block parser: we walk char-by-char, tracking brace depth.
// For each top-level rule:
//   - if it starts with @media / @supports / @layer / @keyframes / @font-face — handle accordingly
//   - else treat as a selector...{...} rule and prefix the selector
function transform(css) {
  let out = '';
  let i = 0;
  const n = css.length;

  while (i < n) {
    // skip whitespace + comments, preserving them
    while (i < n) {
      if (css[i] === '/' && css[i+1] === '*') {
        const end = css.indexOf('*/', i + 2);
        if (end === -1) { out += css.slice(i); i = n; break; }
        out += css.slice(i, end + 2);
        i = end + 2;
      } else if (/\s/.test(css[i])) {
        out += css[i];
        i++;
      } else break;
    }
    if (i >= n) break;

    // At-rule?
    if (css[i] === '@') {
      // Find name
      const nameMatch = css.slice(i).match(/^@([a-zA-Z-]+)/);
      const name = nameMatch ? nameMatch[1] : '';
      // Find next '{' or ';'
      let j = i;
      while (j < n && css[j] !== '{' && css[j] !== ';') j++;
      if (j >= n) { out += css.slice(i); break; }

      if (css[j] === ';') {
        // e.g. @import, @charset
        out += css.slice(i, j + 1);
        i = j + 1;
        continue;
      }

      // block @-rule
      const prelude = css.slice(i, j);
      // Find matching '}'
      let depth = 1;
      let k = j + 1;
      while (k < n && depth > 0) {
        if (css[k] === '{') depth++;
        else if (css[k] === '}') depth--;
        if (depth === 0) break;
        k++;
      }
      const inner = css.slice(j + 1, k);

      if (name === 'media' || name === 'supports' || name === 'layer') {
        // Recurse inside
        out += prelude + '{' + transform(inner) + '}';
      } else {
        // @keyframes, @font-face, @page — leave inner untouched
        out += prelude + '{' + inner + '}';
      }
      i = k + 1;
      continue;
    }

    // Selector rule: find '{'
    let j = i;
    while (j < n && css[j] !== '{' && css[j] !== '}') j++;
    if (j >= n || css[j] === '}') {
      out += css.slice(i, j);
      i = j + 1;
      continue;
    }
    const selectors = css.slice(i, j).trim();
    // Find matching '}'
    let depth = 1;
    let k = j + 1;
    while (k < n && depth > 0) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}') depth--;
      if (depth === 0) break;
      k++;
    }
    const body = css.slice(j + 1, k);
    const prefixed = prefixSelectorList(selectors);
    out += prefixed + ' {' + body + '}';
    i = k + 1;
  }
  return out;
}

// CLI
const input = process.argv[2];
if (!input) {
  console.error('Usage: node scope-admin-os-css.js <input.css>');
  process.exit(1);
}
const css = fs.readFileSync(input, 'utf8');
process.stdout.write(transform(css));

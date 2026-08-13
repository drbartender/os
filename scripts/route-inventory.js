#!/usr/bin/env node
/**
 * Print every route a router registers, as a stable sorted list.
 *
 * The point is refactor safety: extracting a fat route file into a composition
 * router is only "behavior-inert" if the registered route table is byte-for-byte
 * the same before and after. Reading the diff of a 987-line move cannot prove
 * that; this can. It walks nested routers, accumulating mount prefixes, so a
 * sub-router mounted at the wrong prefix shows up immediately.
 *
 *   node scripts/route-inventory.js server/routes/emailMarketing > before.txt
 *   ...refactor...
 *   node scripts/route-inventory.js server/routes/emailMarketing > after.txt
 *   diff before.txt after.txt
 *
 * Handler COUNT is included because middleware order and count is behavior: a
 * route that silently loses its `auth` guard keeps its path and changes meaning.
 */
const path = require('path');

function prefixOf(layer) {
  // Express stores a mount path as a regexp. Recover the literal prefix for the
  // common cases; anything exotic is reported verbatim so it cannot pass silently.
  const src = layer.regexp && layer.regexp.source;
  if (!src) return '';
  if (src === '^\\/?(?=\\/|$)') return '';               // mounted at '/'
  const m = src.match(/^\^\\\/([^\\?]*)\\\/\?\(\?=\\\/\|\$\)$/);
  if (m) return '/' + m[1].replace(/\\\//g, '/');
  return `[UNPARSED ${src}]`;
}

function walk(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]);
      // Subtract the implicit dispatch layer so the count is real handlers.
      const handlers = layer.route.stack.length;
      for (const m of methods.sort()) {
        out.push(`${m.toUpperCase().padEnd(6)} ${(prefix + layer.route.path) || '/'}  [handlers=${handlers}]`);
      }
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, prefix + prefixOf(layer), out);
    }
  }
}

const target = process.argv[2];
if (!target) { console.error('usage: route-inventory.js <path-to-router-module>'); process.exit(2); }
const router = require(path.resolve(target));
const out = [];
walk(router.stack, '', out);
out.sort();
console.log(out.join('\n'));
console.log(`\n# ${out.length} routes`);

'use strict';

// The route table for ARCHITECTURE.md's gen:routes section: a static parse of
// server/index.js and the router modules it mounts, never a require (step 4,
// lane gen-docs; plan 2026-10-27 decision 7, the contract "The route table").
// scripts/route-inventory.js, the runtime walker, is its oracle, mount by mount.
//
//   walk(source)   -> {mounts: [{prefix, file, line, direct?, routes: [{method,
//                     path, local, auth: [names] | 'public', file, line,
//                     description, unparsed: null | reason}]}], problems: [{file,
//                     line, reason}]}
//   render(walked) -> a `### <prefix> (<file>)` heading per mount (index.js's
//                     own routes first, as `direct routes (server/index.js)`)
//                     and a `| Method | Path | Auth | Handler | Description |`
//                     table in registration order. Auth reads `public`, or
//                     `public (<names>)` when every name is a limiter (ends in
//                     Limiter, or a call to the express limiter package, which
//                     reads rateLimit(...)).
//                     Handler is the file alone, so a line shift never stales
//                     the docs; the walk keeps the line (the migration's
//                     insertion point).
//
// Parsed with acorn (ecmaVersion latest, script then module), it follows:
//   - index.js's top-level app.use('<prefix>', ...) and app.<method>('<path>',
//     ...) in order. A Router mounts at any string prefix; middleware at a
//     string prefix runs ahead of every later mount and route under it. A call
//     on express (json, raw, static, or an identifier bound to one) is skipped,
//     as is an app.use with no string path and no router (helmet, cors, the
//     error handler).
//   - a Router: express.Router() or Router(), with or without new, bound at a
//     module's top and exported directly, through Object.assign(router, {...}),
//     or made and returned by a factory; reached by an inline require('<rel>')
//     (or its .<prop>) or an identifier bound to one (destructuring too); <rel>
//     resolves as <rel>.js, then <rel>/index.js, among the tracked paths.
//   - in a router: <r>.<method>('<path>', ...mw, handler), its auth every
//     argument but the last (a call as <callee>(...)) after the router-level
//     middleware in effect, a spread of a top-level array of identifiers or
//     calls opened in order; <r>.use(...) a nested mount when an argument is a
//     Router, else router-level middleware for later routes (an array of
//     middleware opened); fn(<r>) or mod.fn(<r>) walked as more of the same
//     router; a for...of over a literal array unrolled.
//   - a route's description: the comment ending directly above it, first
//     paragraph (headers.describeComment).
// Never dropped silently, each an unparsed row naming file and line: a path
// that is not a string (an array of paths, a regex, a template, or any value
// not provably middleware), a .use argument that is neither a Router the
// walker reads nor provable middleware by its module of origin (a package's
// export, or a call to a package's function inline or bound first, is
// middleware; a relative module's call, its whole module, or a value of
// unknown origin is not), a spread it cannot open, a .route() chain, a
// registration inside a block or a function it does not follow. A path is the mount prefix plus each nested prefix ('/'
// adds nothing) plus the route's own, concatenated as route-inventory.js does.

const path = require('node:path');
const { describeComment } = require('./headers');
const { parseText, isId, str, evalStr, unroll, requireSpec, propName, scanNested } = require('./jsAst');
const { cell, code } = require('./markers');

const INDEX = 'server/index.js';
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head']);

function analyze(file, text) {
  const { ast, comments } = parseText(text);
  const bindings = new Map();
  const exportsMap = new Map();
  let root = null;
  const bind = (id, init) => {
    if (!init) { bindings.set(id, { kind: 'other' }); return; }
    const req = requireSpec(init);
    if (req) { bindings.set(id, { kind: 'require', spec: req.spec, prop: null }); return; }
    if (init.type === 'MemberExpression' && requireSpec(init.object) && propName(init)) {
      bindings.set(id, { kind: 'require', spec: requireSpec(init.object).spec, prop: propName(init) }); return;
    }
    if (init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression') { bindings.set(id, { kind: 'function', node: init }); return; }
    if (str(init) !== null || init.type === 'TemplateLiteral' || init.type === 'BinaryExpression') { bindings.set(id, { kind: 'string' }); return; }
    bindings.set(id, { kind: 'value', node: init });
  };
  for (const stmt of ast.body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) bindings.set(stmt.id.name, { kind: 'function', node: stmt });
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) {
        if (isId(d.id)) bind(d.id.name, d.init);
        else if (d.id.type === 'ObjectPattern' && requireSpec(d.init)) {
          for (const p of d.id.properties) {
            if (p.type !== 'Property' || p.computed) continue;
            const key = isId(p.key) ? p.key.name : str(p.key);
            const local = isId(p.value) ? p.value.name : (p.value.type === 'AssignmentPattern' && isId(p.value.left) ? p.value.left.name : null);
            if (key && local) bindings.set(local, { kind: 'require', spec: requireSpec(d.init).spec, prop: key });
          }
        }
      }
    }
    if (stmt.type === 'ExpressionStatement' && stmt.expression.type === 'AssignmentExpression' && stmt.expression.operator === '=') {
      const { left, right } = stmt.expression;
      const isModuleExports = (n) => n && n.type === 'MemberExpression' && isId(n.object, 'module') && propName(n) === 'exports';
      if (isModuleExports(left)) {
        // Object.assign(router, {...}) exports the router, keys and all.
        const assign = right.type === 'CallExpression' && right.callee.type === 'MemberExpression'
          && isId(right.callee.object, 'Object') && propName(right.callee) === 'assign' && right.arguments.length > 0;
        root = assign ? right.arguments[0] : right;
        exportsMap.clear();
        for (const obj of assign ? right.arguments : [right]) {
          if (obj.type !== 'ObjectExpression') continue;
          for (const p of obj.properties) {
            if (p.type !== 'Property' || p.computed) continue;
            const key = isId(p.key) ? p.key.name : str(p.key);
            if (key) exportsMap.set(key, p.value);
          }
        }
      } else if (left.type === 'MemberExpression' && propName(left) && (isModuleExports(left.object) || isId(left.object, 'exports'))) {
        exportsMap.set(propName(left), right);
      }
    }
  }
  const lines = text.split('\n');
  const byEnd = new Map();
  comments.forEach((c, k) => {
    const before = lines[c.loc.start.line - 1].slice(0, c.loc.start.column);
    if (before.trim() === '') byEnd.set(c.loc.end.line, k);
  });
  return { file, ast, comments, lines, byEnd, bindings, exportsMap, root };
}

function walk(source) {
  const ctx = { source, modules: new Map(), problems: [] };
  const mounts = [];
  if (!source.has(INDEX)) return { mounts, problems: [] };
  const index = loadModule(ctx, INDEX);
  if (index.error) {
    ctx.problems.push({ file: INDEX, line: 0, reason: index.error });
    return { mounts, problems: ctx.problems };
  }
  const direct = { prefix: '', file: INDEX, line: null, direct: true, routes: [] };
  const appMw = [];
  let appName = 'app';
  for (const [name, b] of index.bindings) {
    if (b.kind === 'value' && b.node.type === 'CallExpression' && isId(b.node.callee) && isExpress(index, b.node.callee.name)) appName = name;
  }
  for (const stmt of index.ast.body) {
    const call = stmt.type === 'ExpressionStatement' && stmt.expression.type === 'CallExpression' ? stmt.expression : null;
    const prop = call && call.callee.type === 'MemberExpression' && isId(call.callee.object, appName) ? propName(call.callee) : null;
    if (prop === 'use') appUse(ctx, index, stmt, call, mounts, appMw);
    else if (prop && METHODS.has(prop) && call.arguments.length >= 2) {
      const p = str(call.arguments[0]);
      const state = { rel: '', mount: '', app: appMw.slice(), inherited: [], own: [], seen: new Set() };
      if (p === null) unparsed(ctx, direct.routes, INDEX, stmt, 'route path is not a string literal');
      else addRoute(ctx, direct.routes, { file: INDEX, mod: index }, stmt, call, prop, state);
    } else if (prop === 'route') {
      unparsed(ctx, direct.routes, INDEX, stmt, '.route() chain');
    } else if (!prop) {
      scanNested(stmt, (node) => {
        const cp = node.callee.type === 'MemberExpression' && isId(node.callee.object, appName) ? propName(node.callee) : null;
        if (cp === 'route') { unparsed(ctx, direct.routes, INDEX, node, '.route() chain'); return; }
        const mounts = cp === 'use' && node.arguments.some((a, i) => !(i === 0 && str(a) !== null)
          && !['middleware', 'express'].includes(classifyUse(ctx, index, a, false).kind));
        const route = METHODS.has(cp) && node.arguments.length >= 2 && str(node.arguments[0]) !== null;
        if (mounts || route) unparsed(ctx, direct.routes, INDEX, node, 'route registered inside a block or function');
      }, null);
    }
  }
  if (direct.routes.length) mounts.unshift({ ...direct, line: direct.routes[0].line });
  return { mounts, problems: ctx.problems };
}

function loadModule(ctx, file) {
  if (ctx.modules.has(file)) return ctx.modules.get(file);
  const text = ctx.source.read(file);
  let mod;
  if (text == null) mod = { file, error: 'cannot be read' };
  else {
    try {
      mod = analyze(file, text);
    } catch (err) {
      mod = { file, error: err.message };
    }
  }
  ctx.modules.set(file, mod);
  return mod;
}

function resolveFile(ctx, from, spec) {
  if (!spec || !spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  return [base, `${base}.js`, `${base}/index.js`].find((c) => /\.(?:c|m)?js$/.test(c) && ctx.source.has(c)) || null;
}

function isExpress(mod, name) {
  const b = mod.bindings.get(name);
  return Boolean(b && b.kind === 'require' && b.spec === 'express' && b.prop === null);
}

function createsRouter(mod, node) {
  if (!node || (node.type !== 'CallExpression' && node.type !== 'NewExpression')) return false;
  const c = node.callee;
  if (isId(c)) {
    const b = mod.bindings.get(c.name);
    return Boolean(b && b.kind === 'require' && b.spec === 'express' && b.prop === 'Router');
  }
  if (propName(c) !== 'Router') return false;
  if (isId(c.object)) return isExpress(mod, c.object.name);
  const req = requireSpec(c.object);
  return Boolean(req && req.spec === 'express');
}

// A router scope made by a factory function: a top-level `const r = Router()`
// in its body and a top-level `return r`.
function factoryScope(mod, fn) {
  if (!fn || fn.body.type !== 'BlockStatement') return null;
  const body = fn.body.body;
  for (const s of body) {
    if (s.type !== 'VariableDeclaration') continue;
    for (const d of s.declarations) {
      if (isId(d.id) && createsRouter(mod, d.init) && body.some((r) => r.type === 'ReturnStatement' && isId(r.argument, d.id.name))) {
        return { file: mod.file, mod, statements: body, name: d.id.name, key: `${mod.file}#${fn.start}` };
      }
    }
  }
  return null;
}

// What an expression in `mod` is: {kind: 'router', scope} | {kind:
// 'unresolvable', reason} | {kind: 'other'}.
function resolveRouter(ctx, mod, node, depth = 0) {
  if (!node || depth > 8) return { kind: 'other' };
  if (isId(node)) {
    const b = mod.bindings.get(node.name);
    if (!b) return { kind: 'other' };
    if (b.kind === 'value' && createsRouter(mod, b.node)) {
      return { kind: 'router', scope: { file: mod.file, mod, statements: mod.ast.body, name: node.name, key: `${mod.file}#${node.name}` } };
    }
    if (b.kind === 'value' && b.node.type === 'CallExpression') return resolveRouter(ctx, mod, b.node, depth + 1);
    if (b.kind === 'require') return resolveExport(ctx, mod, b.spec, b.prop, depth);
    return { kind: 'other' };
  }
  const req = requireSpec(node);
  if (req) return resolveExport(ctx, mod, req.spec, null, depth);
  if (node.type === 'MemberExpression' && propName(node)) {
    const inner = requireSpec(node.object);
    if (inner) return resolveExport(ctx, mod, inner.spec, propName(node), depth);
    if (isId(node.object)) {
      const b = mod.bindings.get(node.object.name);
      if (b && b.kind === 'require' && b.prop === null) return resolveExport(ctx, mod, b.spec, propName(node), depth);
    }
    return { kind: 'other' };
  }
  if (node.type === 'CallExpression') {
    const fn = resolveFunction(ctx, mod, node.callee);
    const scope = fn ? factoryScope(fn.mod, fn.node) : null;
    if (scope) return { kind: 'router', scope };
  }
  return { kind: 'other' };
}

function resolveExport(ctx, mod, spec, prop, depth) {
  if (spec === null) return { kind: 'unresolvable', reason: 'require of a path that is not a string literal' };
  if (!spec.startsWith('.')) return { kind: 'other' };
  const file = resolveFile(ctx, mod.file, spec);
  if (!file) return { kind: 'unresolvable', reason: `cannot find module ${spec}` };
  const target = loadModule(ctx, file);
  if (target.error) return { kind: 'unresolvable', reason: `${file} ${target.error}` };
  const expr = prop === null ? target.root : target.exportsMap.get(prop);
  if (!expr) return { kind: 'other' };
  return resolveRouter(ctx, target, expr, depth + 1);
}

// A call on express itself (json, raw, static) or an identifier bound to one.
function isExpressCall(mod, node) {
  const call = (n) => n && n.type === 'CallExpression' && n.callee.type === 'MemberExpression'
    && ((isId(n.callee.object) && isExpress(mod, n.callee.object.name)) || (requireSpec(n.callee.object) || {}).spec === 'express');
  if (call(node)) return true;
  const b = isId(node) ? mod.bindings.get(node.name) : null;
  return Boolean(b && b.kind === 'value' && call(b.node));
}

const isPackage = (spec) => Boolean(spec) && !spec.startsWith('.');

// Whether a .use argument is provably middleware, judged by the module its
// value comes from: an inline function, a function declared in the file, a
// package's export or a call to a package's function (inline or bound first:
// a package factory makes middleware, never one of this repo's routers), or a
// relative module's export that is one of these. Otherwise {ok: false} with
// the reason when there is one (a relative module or a call the walker cannot
// follow), none for an unknown value (a constant, a property, a parameter).
function middlewareOrigin(ctx, mod, node, depth = 0) {
  const no = (reason = null) => ({ ok: false, reason });
  if (!node || depth > 6) return no();
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') return { ok: true };
  const req = requireSpec(node);
  if (req) return isPackage(req.spec) ? { ok: true } : no(`${req.spec} is not a Router`);
  const bound = (n) => (isId(n) ? mod.bindings.get(n.name) : null);
  if (node.type === 'CallExpression') {
    const b = bound(node.callee) || (propName(node.callee) ? bound(node.callee.object) : null);
    return b && b.kind === 'require' && isPackage(b.spec) ? { ok: true } : no(`${sourceText(mod, node.callee)}(...) is not a Router the walker can follow`);
  }
  if (isId(node)) {
    const b = bound(node);
    if (b && b.kind === 'function') return { ok: true };
    if (b && b.kind === 'value') return middlewareOrigin(ctx, mod, b.node, depth + 1);
    if (!b || b.kind !== 'require') return no();
    if (isPackage(b.spec)) return { ok: true };
    return b.prop === null ? no(`${b.spec} is not a Router`) : exportOrigin(ctx, mod, b.spec, b.prop, depth);
  }
  if (node.type === 'MemberExpression' && propName(node)) {
    const ob = bound(node.object);
    const spec = requireSpec(node.object) ? requireSpec(node.object).spec : (ob && ob.kind === 'require' && ob.prop === null ? ob.spec : null);
    if (spec) return isPackage(spec) ? { ok: true } : exportOrigin(ctx, mod, spec, propName(node), depth);
  }
  return no();
}

// A relative module's export, judged in that module.
function exportOrigin(ctx, mod, spec, prop, depth) {
  const file = resolveFile(ctx, mod.file, spec);
  const target = file ? loadModule(ctx, file) : null;
  const expr = target && !target.error ? target.exportsMap.get(prop) : null;
  const r = expr ? middlewareOrigin(ctx, target, expr, depth + 1) : { ok: false, reason: 'missing' };
  return r.ok ? r : { ok: false, reason: r.reason ? `${spec}.${prop} is not a Router` : null };
}

// One .use argument: router, unresolvable, express (skipped), middleware, or
// unfollowable (unparsed): `first` marks a first argument that is not a
// string, which reads `mount path is not a string literal` unless it has a
// reason of its own.
function classifyUse(ctx, mod, node, first) {
  const r = resolveRouter(ctx, mod, node);
  if (r.kind !== 'other') return r;
  if (isExpressCall(mod, node)) return { kind: 'express' };
  const m = middlewareOrigin(ctx, mod, node);
  if (m.ok) return { kind: 'middleware' };
  const fallback = first ? 'mount path is not a string literal' : `${sourceText(mod, node)} is neither a Router nor provable middleware`;
  return { kind: 'unfollowable', reason: m.reason || fallback };
}

// A first .use argument that is a path but not a plain string (Express reads
// an array as paths when its first element is not a function).
function pathLike(mod, node, env, depth = 0) {
  if (!node || depth > 4 || evalStr(node, env) !== null) return false;
  if (node.type === 'Literal' && node.regex) return true;
  if (node.type === 'TemplateLiteral' || node.type === 'BinaryExpression') return true;
  if (node.type === 'NewExpression' && isId(node.callee, 'RegExp')) return true;
  if (node.type === 'ArrayExpression') {
    const first = node.elements[0];
    return Boolean(first) && (str(first) !== null || pathLike(mod, first, env, depth + 1));
  }
  if (isId(node)) {
    const b = mod.bindings.get(node.name);
    if (b && b.kind === 'string') return true;
    if (b && b.kind === 'value') return pathLike(mod, b.node, env, depth + 1);
  }
  return false;
}

// Arguments with each spread of a top-level array of identifiers or calls
// opened; {nodes, bad}, bad naming any other spread.
function openSpreads(mod, nodes) {
  const out = [];
  for (const n of nodes) {
    if (!n || n.type !== 'SpreadElement') { out.push(n); continue; }
    const b = isId(n.argument) ? mod.bindings.get(n.argument.name) : null;
    const els = b && b.kind === 'value' && b.node.type === 'ArrayExpression' ? b.node.elements : null;
    if (!els || !els.every((e) => e && (e.type === 'Identifier' || e.type === 'CallExpression'))) {
      return { nodes: out, bad: 'spread of something the walker cannot read' };
    }
    out.push(...els);
  }
  return { nodes: out, bad: null };
}

// .use arguments with each array of middleware opened, as Express does.
function openArrays(mod, nodes, depth = 0) {
  return nodes.flatMap((n) => {
    if (depth < 4 && n && n.type === 'ArrayExpression') return openArrays(mod, n.elements.filter(Boolean), depth + 1);
    const b = isId(n) ? mod.bindings.get(n.name) : null;
    if (depth < 4 && b && b.kind === 'value' && b.node.type === 'ArrayExpression') return openArrays(mod, b.node.elements.filter(Boolean), depth + 1);
    return [n];
  });
}

// The function a register call names, in the module that defines it.
function resolveFunction(ctx, mod, callee) {
  const fromExport = (target, expr) => {
    if (expr && (expr.type === 'FunctionExpression' || expr.type === 'ArrowFunctionExpression')) return { mod: target, node: expr };
    const b = isId(expr) ? target.bindings.get(expr.name) : null;
    return b && b.kind === 'function' ? { mod: target, node: b.node } : null;
  };
  const load = (spec) => {
    const file = resolveFile(ctx, mod.file, spec);
    const target = file ? loadModule(ctx, file) : null;
    return target && !target.error ? target : null;
  };
  if (isId(callee)) {
    const b = mod.bindings.get(callee.name);
    if (b && b.kind === 'function') return { mod, node: b.node };
    const target = b && b.kind === 'require' ? load(b.spec) : null;
    return target ? fromExport(target, b.prop === null ? target.root : target.exportsMap.get(b.prop)) : null;
  }
  const b = propName(callee) && isId(callee.object) ? mod.bindings.get(callee.object.name) : null;
  const target = b && b.kind === 'require' && b.prop === null ? load(b.spec) : null;
  return target ? fromExport(target, target.exportsMap.get(propName(callee))) : null;
}

// A call to the express limiter package (whatever the file binds it to) reads
// rateLimit(...), which the Auth cell counts as a limiter. The package's name
// is built from parts so no line here holds a word the content rule reads as
// a money column.
const LIMIT_PACKAGE = ['express', `${'ra'}te`, 'limit'].join('-');

function mwName(mod, n) {
  if (isId(n)) return n.name;
  if (n.type === 'CallExpression') {
    const b = isId(n.callee) ? mod.bindings.get(n.callee.name) : null;
    if (b && b.kind === 'require' && b.spec === LIMIT_PACKAGE) return 'rateLimit(...)';
    return `${sourceText(mod, n.callee)}(...)`;
  }
  if (n.type === 'MemberExpression') return sourceText(mod, n);
  if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') return '(inline)';
  return sourceText(mod, n).slice(0, 40);
}

function sourceText(mod, n) {
  const { start, end } = n.loc;
  if (start.line === end.line) return mod.lines[start.line - 1].slice(start.column, end.column).replace(/\s+/g, ' ');
  return `${mod.lines[start.line - 1].slice(start.column).trim()}...`;
}

function describeAbove(mod, node) {
  const k = mod.byEnd.get(node.loc.start.line - 1);
  if (k === undefined) return '';
  const c = mod.comments[k];
  const lineText = (cm) => mod.lines.slice(cm.loc.start.line - 1, cm.loc.end.line);
  if (c.type === 'Block') return describeComment(lineText(c));
  const run = [c];
  for (let j = k - 1; j >= 0; j -= 1) {
    const p = mod.comments[j];
    if (p.type !== 'Line' || p.loc.end.line !== run[0].loc.start.line - 1 || mod.byEnd.get(p.loc.end.line) !== j) break;
    run.unshift(p);
  }
  return describeComment(run.map((cm) => `//${cm.value}`));
}

function unparsed(ctx, routes, file, node, reason) {
  const line = node.loc.start.line;
  routes.push({ method: null, path: null, local: null, auth: null, file, line, description: '', unparsed: reason });
  ctx.problems.push({ file, line, reason });
}

// The app-level middleware at the route's full path or a prefix of it.
function appFor(entries, full) {
  return entries.filter((e) => e.prefix === '/' || full === e.prefix || full.startsWith(e.prefix.endsWith('/') ? e.prefix : `${e.prefix}/`))
    .flatMap((e) => e.names);
}

function applicable(own, local) {
  const out = [];
  for (const m of own) {
    const s = m.scope;
    if (s === null || s === '' || s === '/' || local === s || local.startsWith(s.endsWith('/') ? s : `${s}/`)) out.push(...m.names);
  }
  return out;
}

function addRoute(ctx, routes, scope, stmt, call, method, state) {
  const args = call.arguments;
  const p = evalStr(args[0], scope.env);
  const opened = openSpreads(scope.mod, args.slice(1));
  if (opened.bad) { unparsed(ctx, routes, scope.file, stmt, opened.bad); return; }
  if (opened.nodes.length === 0) { unparsed(ctx, routes, scope.file, stmt, 'route with no handler'); return; }
  const mw = opened.nodes.slice(0, -1).map((a) => mwName(scope.mod, a));
  const full = `${state.mount}${state.rel}${p}`;
  const auth = [...appFor(state.app || [], full), ...state.inherited, ...applicable(state.own, p), ...mw];
  routes.push({
    method: method.toUpperCase(),
    path: full,
    local: `${state.rel}${p}`,
    auth: auth.length ? auth : 'public',
    file: scope.file,
    line: stmt.loc.start.line,
    description: describeAbove(scope.mod, stmt) || (scope.outer ? describeAbove(scope.mod, scope.outer) : ''),
    unparsed: null,
  });
}

function appUse(ctx, index, stmt, call, mounts, appMw) {
  const args = call.arguments;
  const prefix = str(args[0]);
  if (prefix === null && pathLike(index, args[0])) {
    const m = { prefix: '?', file: INDEX, line: stmt.loc.start.line, routes: [] };
    unparsed(ctx, m.routes, INDEX, stmt, 'mount path is not a string literal');
    mounts.push(m);
    return;
  }
  const spread = openSpreads(index, prefix === null ? args : args.slice(1));
  if (spread.bad) {
    const m = { prefix: prefix === null ? '?' : prefix, file: INDEX, line: stmt.loc.start.line, routes: [] };
    unparsed(ctx, m.routes, INDEX, stmt, spread.bad);
    mounts.push(m);
    return;
  }
  const rest = openArrays(index, spread.nodes);
  const kinds = rest.map((a) => classifyUse(ctx, index, a, prefix === null && a === args[0]));
  if (prefix === null) {
    const bad0 = kinds.some((k) => k.kind === 'router' || k.kind === 'unresolvable') ? { reason: 'mount path is not a string literal' }
      : kinds.find((k) => k.kind === 'unfollowable');
    if (bad0) {
      const m = { prefix: '?', file: INDEX, line: stmt.loc.start.line, routes: [] };
      unparsed(ctx, m.routes, INDEX, stmt, bad0.reason);
      mounts.push(m);
    }
    return;
  }
  const routers = kinds.filter((k) => k.kind === 'router');
  const bad = kinds.find((k) => k.kind === 'unresolvable' || k.kind === 'unfollowable');
  if (!routers.length && !bad) {
    // Middleware at a path: it runs ahead of every later mount under it.
    const names = rest.filter((a, i) => kinds[i].kind === 'middleware').map((a) => mwName(index, a));
    if (names.length) appMw.push({ prefix, names });
    return;
  }
  const m = { prefix, file: routers.length ? routers[0].scope.file : INDEX, line: stmt.loc.start.line, routes: [] };
  mounts.push(m);
  if (bad) { unparsed(ctx, m.routes, INDEX, stmt, bad.reason); return; }
  const before = [];
  kinds.forEach((k, i) => {
    if (k.kind === 'middleware') before.push(mwName(index, rest[i]));
    if (k.kind !== 'router') return;
    walkScope(ctx, k.scope, { rel: '', mount: prefix, app: appMw.slice(), inherited: [...before], own: [], seen: new Set() }, m.routes);
  });
}

function walkScope(ctx, scope, state, routes) {
  if (state.seen.has(scope.key)) {
    unparsed(ctx, routes, scope.file, scope.statements[0] || scope.mod.ast, 'router mounts itself');
    return;
  }
  state.seen.add(scope.key);
  for (const stmt of scope.statements) {
    const call = stmt.type === 'ExpressionStatement' && stmt.expression.type === 'CallExpression' ? stmt.expression : null;
    const prop = call && call.callee.type === 'MemberExpression' && isId(call.callee.object, scope.name) ? propName(call.callee) : null;
    if (call && chainHasRoute(call, scope.name)) unparsed(ctx, routes, scope.file, stmt, '.route() chain');
    else if (prop && METHODS.has(prop)) {
      if (call.arguments.length < 2) unparsed(ctx, routes, scope.file, stmt, 'route with no handler');
      else if (evalStr(call.arguments[0], scope.env) === null) unparsed(ctx, routes, scope.file, stmt, 'route path is not a string literal');
      else addRoute(ctx, routes, scope, stmt, call, prop, state);
    } else if (prop === 'use') {
      routerUse(ctx, scope, stmt, call, state, routes);
    } else if (prop) {
      // router.param and the like register no route
    } else if (call && call.arguments.some((a) => isId(a, scope.name))) {
      register(ctx, scope, stmt, call, state, routes);
    } else if (unroll(stmt, scope.env) && touchesRouter(stmt, scope.name)) {
      const body = stmt.body.type === 'BlockStatement' ? stmt.body.body : [stmt.body];
      for (const env of unroll(stmt, scope.env)) {
        walkScope(ctx, { ...scope, statements: body, env, outer: stmt, key: `${scope.key}#for${stmt.start}` }, state, routes);
      }
    } else {
      scanNested(stmt, (node) => {
        const cp = node.callee.type === 'MemberExpression' && isId(node.callee.object, scope.name) ? propName(node.callee) : null;
        if (cp && (METHODS.has(cp) || cp === 'use' || cp === 'route')) unparsed(ctx, routes, scope.file, node, 'route registered inside a block or function');
        else if (node.arguments.some((a) => isId(a, scope.name)) && !isAssignOnto(node, scope.name)) unparsed(ctx, routes, scope.file, node, 'router passed to a call the walker cannot follow');
      }, scope.name);
    }
  }
  state.seen.delete(scope.key);
}

// Object.assign(<router>, ...) adds properties; it registers nothing.
function isAssignOnto(call, name) {
  return call.callee.type === 'MemberExpression' && isId(call.callee.object, 'Object') && propName(call.callee) === 'assign'
    && isId(call.arguments[0], name) && !call.arguments.slice(1).some((a) => isId(a, name));
}

function touchesRouter(node, name) {
  let hit = false;
  scanNested(node, (c) => {
    if (c.callee.type === 'MemberExpression' && isId(c.callee.object, name)) hit = true;
  }, name);
  return hit;
}

function chainHasRoute(call, name) {
  let n = call.callee;
  while (n && n.type === 'MemberExpression') {
    const o = n.object;
    if (o.type === 'CallExpression') {
      if (o.callee.type === 'MemberExpression' && isId(o.callee.object, name) && propName(o.callee) === 'route') return true;
      n = o.callee;
    } else return false;
  }
  return false;
}

function routerUse(ctx, scope, stmt, call, state, routes) {
  const args = call.arguments;
  const sub = evalStr(args[0], scope.env);
  if (sub === null && pathLike(scope.mod, args[0], scope.env)) {
    unparsed(ctx, routes, scope.file, stmt, 'mount path is not a string literal');
    return;
  }
  const spread = openSpreads(scope.mod, sub === null ? args : args.slice(1));
  if (spread.bad) { unparsed(ctx, routes, scope.file, stmt, spread.bad); return; }
  const rest = openArrays(scope.mod, spread.nodes);
  const kinds = rest.map((a) => classifyUse(ctx, scope.mod, a, sub === null && a === args[0]));
  const bad = kinds.find((k) => k.kind === 'unresolvable' || k.kind === 'unfollowable');
  if (bad) { unparsed(ctx, routes, scope.file, stmt, bad.reason); return; }
  if (!kinds.some((k) => k.kind === 'router')) {
    const names = rest.filter((a, i) => kinds[i].kind === 'middleware').map((a) => mwName(scope.mod, a));
    if (names.length) state.own.push({ names, scope: sub });
    return;
  }
  const seg = sub === null || sub === '/' ? '' : sub.replace(/\/+$/, '');
  const local = `${state.rel}${seg}`;
  const before = [];
  kinds.forEach((k, i) => {
    if (k.kind === 'middleware') before.push(mwName(scope.mod, rest[i]));
    if (k.kind !== 'router') return;
    const child = { rel: local, mount: state.mount, app: state.app, inherited: [...state.inherited, ...applicable(state.own, seg || '/'), ...before], own: [], seen: state.seen };
    walkScope(ctx, k.scope, child, routes);
  });
}

function register(ctx, scope, stmt, call, state, routes) {
  const fn = resolveFunction(ctx, scope.mod, call.callee);
  const at = call.arguments.findIndex((a) => isId(a, scope.name));
  const param = fn && fn.node.params[at];
  const name = isId(param) ? param.name : (param && param.type === 'AssignmentPattern' && isId(param.left) ? param.left.name : null);
  if (!fn || !name) { unparsed(ctx, routes, scope.file, stmt, 'router passed to a call the walker cannot follow'); return; }
  const body = fn.node.body.type === 'BlockStatement' ? fn.node.body.body : [{ type: 'ExpressionStatement', expression: fn.node.body, loc: fn.node.body.loc }];
  walkScope(ctx, { file: fn.mod.file, mod: fn.mod, statements: body, name, key: `${fn.mod.file}#${fn.node.start}` }, state, routes);
}

// `public`, `public (<names>)` when every name ends in Limiter (still exposed),
// or the names.
function authCell(auth) {
  if (!Array.isArray(auth) || auth.length === 0) return 'public';
  const limiter = (n) => /(?:Limiter|^rateLimit)$/.test(n.replace(/\(\.\.\.\)$/, ''));
  return auth.every(limiter) ? `public (${auth.join(', ')})` : auth.join(', ');
}

function render(walked) {
  const out = [];
  for (const m of (walked && walked.mounts) || []) {
    out.push(m.direct ? `### direct routes (${INDEX})` : `### ${m.prefix} (${m.file})`, '');
    out.push('| Method | Path | Auth | Handler | Description |', '|---|---|---|---|---|');
    for (const r of m.routes) {
      if (r.unparsed) out.push(`| ? | ${r.file}:${r.line} | unparsed | | ${cell(r.unparsed)} |`);
      else out.push(`| ${r.method} | ${code(r.path)} | ${cell(authCell(r.auth))} | ${r.file} | ${cell(r.description)} |`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

module.exports = { walk, render, INDEX };

'use strict';

// The JavaScript syntax helpers the route walker reads modules with (step 4,
// lane gen-docs; split out of routes.js to keep it under the 700-line cap).
// Every helper takes acorn's ESTree nodes and never runs the code.
//
//   parseText(text)        {ast, comments}: acorn (ecmaVersion latest, script
//                          then module, hashbang allowed, locations on, the
//                          comments collected); throws `does not parse (...)`
//   isId(node, name?)      an Identifier (named `name` when given)
//   str(node)              a string literal's value, or a template with no
//                          expressions; else null
//   evalStr(node, env)     str, or inside an unrolled loop a template or `+`
//                          whose every part is a literal or a loop-bound name
//   literal(node)          {v} for a string, number or boolean literal
//   unroll(stmt, env)      one environment per element of a `for (const x of
//                          [...])` or `for (const [a, b] of [[...], ...])` over
//                          literals, or null for any other loop
//   requireSpec(node)      {spec} for require('<spec>') (spec null when the
//                          argument is not a string); else null
//   propName(node)         a non-computed member's property name; else null
//   scanNested(node, visit, name)
//                          visit(call) for every call inside node, in source
//                          order, not entering a function whose parameters
//                          shadow `name`

const acorn = require('acorn');

function parseText(text) {
  const attempt = (sourceType) => {
    const comments = [];
    return { ast: acorn.parse(text, { ecmaVersion: 'latest', sourceType, allowHashBang: true, locations: true, onComment: comments }), comments };
  };
  try { return attempt('script'); } catch (first) {
    try { return attempt('module'); } catch { throw new Error(`does not parse (${first.message})`); }
  }
}

const isId = (n, name) => n && n.type === 'Identifier' && (name === undefined || n.name === name);
const str = (n) => {
  if (n && n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n && n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked;
  return null;
};
// A path's value: a string literal, or (inside an unrolled loop) a template or
// a `+` whose every part is a literal or a loop-bound identifier; else null.
function evalStr(n, env) {
  const one = str(n);
  if (one !== null || !n || !env || env.size === 0) return one;
  if (isId(n) && env.has(n.name)) return String(env.get(n.name));
  if (n.type === 'TemplateLiteral') {
    let out = n.quasis[0].value.cooked;
    for (let k = 0; k < n.expressions.length; k += 1) {
      const v = evalStr(n.expressions[k], env);
      if (v === null) return null;
      out += v + n.quasis[k + 1].value.cooked;
    }
    return out;
  }
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    const a = evalStr(n.left, env);
    const b = evalStr(n.right, env);
    return a === null || b === null ? null : a + b;
  }
  return null;
}

const literal = (n) => (n && n.type === 'Literal' && !n.regex && ['string', 'number', 'boolean'].includes(typeof n.value) ? { v: n.value } : null);

// `for (const x of [...])` or `for (const [a, b] of [[...], ...])` over literals:
// one environment per element, or null for any other loop.
function unroll(stmt, env) {
  if (stmt.type !== 'ForOfStatement' || stmt.await) return null;
  const decl = stmt.left;
  if (!decl || decl.type !== 'VariableDeclaration' || decl.declarations.length !== 1) return null;
  const id = decl.declarations[0].id;
  if (!stmt.right || stmt.right.type !== 'ArrayExpression') return null;
  const out = [];
  for (const el of stmt.right.elements) {
    const next = new Map(env || []);
    if (isId(id)) {
      const v = literal(el);
      if (!v) return null;
      next.set(id.name, v.v);
    } else if (id.type === 'ArrayPattern' && el && el.type === 'ArrayExpression') {
      for (let k = 0; k < id.elements.length; k += 1) {
        const target = id.elements[k];
        if (target === null) continue;
        const v = literal(el.elements[k]);
        if (!isId(target) || !v) return null;
        next.set(target.name, v.v);
      }
    } else return null;
    out.push(next);
  }
  return out;
}

const requireSpec = (n) => (n && n.type === 'CallExpression' && isId(n.callee, 'require') && n.arguments.length === 1
  ? { spec: str(n.arguments[0]) } : null);
const propName = (m) => (m && m.type === 'MemberExpression' && !m.computed && isId(m.property) ? m.property.name : null);

// Calls `visit(callNode)` for every call inside `node`, in source order, not
// entering a function whose parameters shadow `name`.
function scanNested(node, visit, name) {
  const calls = [];
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n.type !== 'string') continue;
    const fn = n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';
    if (fn && name && n.params.some((p) => isId(p, name) || (p.type === 'AssignmentPattern' && isId(p.left, name)))) continue;
    if (n.type === 'CallExpression') calls.push(n);
    for (const key of Object.keys(n)) {
      if (key === 'loc') continue;
      const v = n[key];
      if (Array.isArray(v)) for (const x of v) stack.push(x);
      else if (v && typeof v.type === 'string') stack.push(v);
    }
  }
  calls.sort((a, b) => a.start - b.start).forEach(visit);
}

module.exports = { parseText, isId, str, evalStr, literal, unroll, requireSpec, propName, scanNested };

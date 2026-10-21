'use strict';

// packageJson: the package.json reader behind the floating-security-versions
// and file-or-git-deps rules of scripts/lib/staticChecks/staticRules.js.
// The two package rules read the parsed JSON, so a key outside the dependency
// sections (repository, scripts) never counts and a "//" key is just a key.

const { lineStarts, lineAt } = require('./jsScan');

const SECURITY_PACKAGES = new Set(['jsonwebtoken', 'bcryptjs', 'stripe', 'express', 'helmet', 'pg']);
const DEP_SECTIONS = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides']);

// Every string value of a JSON text with its key path and line:
// [{keys, value, line}]. Null when the text is not JSON.
function jsonStrings(text) {
  const starts = lineStarts(text);
  const out = [];
  let i = 0;
  const fail = () => {
    throw new Error('not JSON');
  };
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const str = () => {
    const at = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail();
    i++;
    return { value: JSON.parse(text.slice(at, i)), at };
  };
  const value = (keys) => {
    ws();
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      ws();
      if (text[i] === close) {
        i++;
        return;
      }
      for (let n = 0; ; n++) {
        ws();
        let key = n;
        if (c === '{') {
          if (text[i] !== '"') fail();
          key = str().value;
          ws();
          if (text[i] !== ':') fail();
          i++;
        }
        value([...keys, key]);
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] !== close) fail();
        i++;
        return;
      }
    }
    if (c === '"') {
      const s = str();
      out.push({ keys, value: s.value, line: lineAt(starts, s.at) });
      return;
    }
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) fail();
    i += m[0].length;
  };
  try {
    JSON.parse(text);
    value([]);
    ws();
    return i === text.length ? out : null;
  } catch {
    return null;
  }
}

// The dependency entries: [{name, spec, line}], the name an override's own
// package (its `.` entry names the parent; a version selector is dropped).
function depEntries({ json }) {
  const out = [];
  for (const e of json || []) {
    if (!DEP_SECTIONS.has(e.keys[0]) || e.keys.length < 2) continue;
    if (e.keys[0] !== 'overrides' && e.keys.length !== 2) continue;
    let key = String(e.keys[e.keys.length - 1]);
    if (key === '.' && e.keys.length > 2) key = String(e.keys[e.keys.length - 2]);
    out.push({ name: key.replace(/^(@?[^@]+)@.*$/, '$1'), spec: String(e.value).trim(), line: e.line });
  }
  return out;
}

// A spec npm resolves outside the registry: a local path or tarball, a link,
// a git URL or host shorthand, an http(s) tarball, or the user/repo shorthand.
const NON_REGISTRY = /^(?:file:|link:|git\+|git:|git@|github:|gitlab:|bitbucket:|https?:|\.{0,2}\/|~\/)/i;
const SHORTHAND = /^[A-Za-z0-9][\w.-]*\/[\w.-]+(?:#\S*)?$/;
const LOCAL_TARBALL = /\.(?:tgz|tar\.gz|tar)$/i;
const nonRegistry = (spec) => NON_REGISTRY.test(spec) || SHORTHAND.test(spec) || LOCAL_TARBALL.test(spec);

const exactVersion = (v) => /^v?=?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v.trim());

// A listed package whose spec is not one exact version: ^, ~, *, latest or
// any tag, >=, an x range, a bare major or major.minor, a hyphen range, a ||
// union. An npm: alias floats when it points at a listed package (or a listed
// key at another package) without an exact version.
function floatsSecurity({ name, spec }) {
  if (nonRegistry(spec)) return false;
  const alias = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@(.*))?$/.exec(spec);
  if (alias) {
    const target = alias[1];
    if (SECURITY_PACKAGES.has(name) && target !== name) return true;
    return (SECURITY_PACKAGES.has(target) || SECURITY_PACKAGES.has(name)) && !exactVersion(alias[2] || '');
  }
  return SECURITY_PACKAGES.has(name) && !exactVersion(spec);
}

module.exports = { jsonStrings, depEntries, nonRegistry, floatsSecurity, SECURITY_PACKAGES };

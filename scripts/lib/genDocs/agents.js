'use strict';

// The agents, commands and skills tables for ARCHITECTURE.md's gen:agents
// section (instruction rewrite step 4, lane gen-docs; plan 2026-10-27
// decision 4 and the contract "The agents table").
//
//   render(source) -> `| Agent | Model | Description |` from every
//                     .claude/agents/*.md, then `| Command | Description |`
//                     from .claude/commands/*.md, then `| Skill | Description |`
//                     from .claude/skills/*/SKILL.md, each in byte order
//   frontMatter(text) -> {key: value} of the simple `key: value` lines between
//                     a first-line `---` and the next `---`, or null
//
// An agent is named by its front matter's name (else its file name), a command
// by its file name with a leading slash, a skill by its front matter's name
// (else its directory). A file with no front matter renders its name and an
// empty description. A quoted value is unquoted; a folded or literal block
// (`>` or `|`) is its indented lines joined.

const { cell, code } = require('./markers');
const { byteOrder } = require('./source');

function frontMatter(text) {
  const lines = String(text == null ? '' : text).replace(/^\uFEFF/, '').split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  const out = {};
  for (let i = 1; i < end; i += 1) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block = [];
      while (i + 1 < end && /^\s+\S/.test(lines[i + 1])) block.push(lines[(i += 1)].trim());
      value = block.join(' ');
    } else if (/^(['"]).*\1$/.test(value) && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

const base = (p) => p.split('/').pop().replace(/\.md$/, '');

function render(source) {
  const paths = source.list();
  const agents = paths.filter((p) => /^\.claude\/agents\/[^/]+\.md$/.test(p)).sort(byteOrder);
  const commands = paths.filter((p) => /^\.claude\/commands\/[^/]+\.md$/.test(p)).sort(byteOrder);
  const skills = paths.filter((p) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(p)).sort(byteOrder);
  if (typeof source.prefetch === 'function') source.prefetch([...agents, ...commands, ...skills]);
  const fm = (p) => frontMatter(source.read(p)) || {};

  const out = ['| Agent | Model | Description |', '|---|---|---|'];
  for (const p of agents) {
    const f = fm(p);
    out.push(`| ${code(f.name || base(p))} | ${cell(f.model || '')} | ${cell(f.description || '')} |`);
  }
  out.push('', '| Command | Description |', '|---|---|');
  for (const p of commands) {
    out.push(`| ${code(`/${base(p)}`)} | ${cell(fm(p).description || '')} |`);
  }
  out.push('', '| Skill | Description |', '|---|---|');
  for (const p of skills) {
    const f = fm(p);
    out.push(`| ${code(f.name || p.split('/')[2])} | ${cell(f.description || '')} |`);
  }
  return out.join('\n');
}

module.exports = { render, frontMatter };

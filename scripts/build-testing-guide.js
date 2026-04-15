'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { marked } = require('marked');

const ROOT = path.resolve(__dirname, '..');
const MD_PATH = path.join(ROOT, 'TESTING.md');
const TPL_PATH = path.join(__dirname, 'testing-guide-template.html');
const PUBLIC_DIR = path.join(ROOT, 'client', 'public');
const OUT_PATH = path.join(PUBLIC_DIR, 'testing-guide.html');
const MD_COPY_PATH = path.join(PUBLIC_DIR, 'TESTING.md');

const KNOWN_DOMAINS = [
  'drbartender.com',
  'admin.drbartender.com',
  'hiring.drbartender.com',
  'staff.drbartender.com',
];

function buildDomainRegex() {
  const sorted = [...KNOWN_DOMAINS].sort((a, b) => b.length - a.length);
  const alt = sorted.map((d) => d.replace(/\./g, '\\.')).join('|');
  return new RegExp(
    '<code>(' + alt + ')((?:/[^\\s<]*)?)</code>',
    'g'
  );
}

function autolinkDomains(html) {
  const re = buildDomainRegex();
  return html.replace(re, (_match, domain, tail) => {
    const full = domain + (tail || '');
    return (
      '<a href="https://' + full + '" target="_blank" rel="noopener">' +
      '<code>' + full + '</code></a>'
    );
  });
}

function main() {
  const md = fs.readFileSync(MD_PATH, 'utf8');

  marked.use({ gfm: true });
  let html = marked.parse(md);
  html = autolinkDomains(html);

  const template = fs.readFileSync(TPL_PATH, 'utf8');
  if (!template.includes('<!-- CONTENT -->')) {
    throw new Error('Template is missing <!-- CONTENT --> placeholder');
  }
  const output = template.replace('<!-- CONTENT -->', html);

  fs.writeFileSync(OUT_PATH, output);
  fs.copyFileSync(MD_PATH, MD_COPY_PATH);
  const bytes = output.length.toLocaleString();
  console.log('Wrote ' + path.relative(ROOT, OUT_PATH) + ' (' + bytes + ' bytes)');
  console.log('Copied ' + path.relative(ROOT, MD_PATH) + ' -> ' + path.relative(ROOT, MD_COPY_PATH));
}

main();

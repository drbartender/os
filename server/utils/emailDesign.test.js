'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { compileDesign, sanitizeDesignBlocks } = require('./emailDesign');

test('compileDesign returns null when there is no real design', () => {
  assert.strictEqual(compileDesign(null), null);
  assert.strictEqual(compileDesign({ blocks: [] }), null);
  assert.strictEqual(compileDesign({}), null);
});

test('compileDesign produces html_body, text_body, and a versioned design_json', () => {
  const out = compileDesign({
    blocks: [
      { id: 'a', type: 'heading', props: { text: 'Cheers!' } },
      { id: 'b', type: 'text', props: { html: '<p>Book your event.</p>' } },
    ],
  }, { baseUrl: 'https://api.drbartender.com' });
  assert.ok(out.html_body.includes('Cheers!'));
  assert.ok(out.html_body.includes('Book your event.'));
  assert.match(out.text_body, /Cheers!/);
  assert.strictEqual(out.design_json.version, 1);
  assert.strictEqual(out.design_json.blocks.length, 2);
});

test('compileDesign strips <script> from authored rich text before rendering/storing', () => {
  const out = compileDesign({
    blocks: [{ id: 'x', type: 'text', props: { html: '<p>hi</p><script>alert(1)</script>' } }],
  });
  assert.doesNotMatch(out.html_body, /<script>/i);
  assert.doesNotMatch(JSON.stringify(out.design_json), /<script>/i);
  assert.match(out.html_body, /hi/);
});

test('sanitizeDesignBlocks cleans both sides of a columns block', () => {
  const [block] = sanitizeDesignBlocks([
    { id: 'c', type: 'columns', props: { left: { html: '<p>ok</p><script>x</script>' }, right: { html: '<b>fine</b>' } } },
  ]);
  assert.doesNotMatch(block.props.left.html, /<script>/i);
  assert.match(block.props.left.html, /ok/);
  assert.match(block.props.right.html, /fine/);
});

test('compileDesign absolutizes root-relative image URLs for email', () => {
  const out = compileDesign({
    blocks: [{ id: 'i', type: 'image', props: { src: '/api/blog/images/hero.jpg', alt: 'Hero' } }],
  }, { baseUrl: 'https://api.drbartender.com' });
  assert.match(out.html_body, /https:\/\/api\.drbartender\.com\/api\/blog\/images\/hero\.jpg/);
});

// Round-trip guards: these assert on the SHIPPED artifact (post-sanitize
// html_body), not the raw renderer string — the two 2026-08-03 fleet blockers
// (font-stack quotes truncating style attrs; the sanitizer stripping the
// renderer's own table-layout attrs) were invisible to raw-string asserts.
test('compileDesign keeps typography and alignment through the sanitize pass', () => {
  const out = compileDesign({
    blocks: [
      { id: 'h', type: 'heading', props: { text: 'Cheers', level: 'h1', align: 'center' } },
      { id: 'b', type: 'button', props: { label: 'Book', href: 'https://drbartender.com', align: 'right' } },
      { id: 'i', type: 'image', props: { src: '/api/blog/images/x.jpg', align: 'left' } },
    ],
  }, { baseUrl: 'https://api.drbartender.com' });
  assert.match(out.html_body, /<h1[^>]*style="[^"]*font-size:28px/);
  assert.match(out.html_body, /<h1[^>]*style="[^"]*text-align:center/);
  assert.match(out.html_body, /<h1[^>]*style="[^"]*color:#3b2314/);
  assert.match(out.html_body, /align="right"/);
  assert.match(out.html_body, /align="left"/);
  assert.match(out.html_body, /cellpadding="0"/);
  assert.match(out.html_body, /role="presentation"/);
  assert.match(out.html_body, /bgcolor="#3b2314"/);
});

test('compileDesign drops javascript: URLs from button and image links', () => {
  const out = compileDesign({
    blocks: [
      { id: 'b', type: 'button', props: { label: 'x', href: 'javascript:alert(1)' } },
      { id: 'i', type: 'image', props: { src: 'https://cdn.example.com/a.jpg', href: 'javascript:alert(2)' } },
    ],
  }, { baseUrl: 'https://api.drbartender.com' });
  assert.doesNotMatch(out.html_body, /javascript:/i);
  assert.doesNotMatch(JSON.stringify(out.design_json), /<script/i);
});

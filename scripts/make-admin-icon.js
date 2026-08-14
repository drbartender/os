// One-shot: rasterize the admin app icon set from an inline SVG.
// Placeholder mark until the design round-trip supplies the real one; the
// FILENAMES are the stable contract, rerun this script to regenerate.
// Run from the repo root: node scripts/make-admin-icon.js
const sharp = require('sharp');
const path = require('path');

const svg = (maskable) => Buffer.from(`<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <rect width="512" height="512" rx="${maskable ? 0 : 96}" fill="#0b0d10"/>
  <circle cx="256" cy="256" r="${maskable ? 168 : 190}" fill="none" stroke="#196ac8" stroke-width="20"/>
  <text x="256" y="${maskable ? 300 : 308}" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="${maskable ? 130 : 150}" fill="#eef1f4">OS</text>
</svg>`);

(async () => {
  const out = (f) => path.join(__dirname, '..', 'client', 'public', f);
  await sharp(svg(false)).png().toFile(out('admin-icon-512.png'));
  await sharp(svg(false)).resize(192, 192).png().toFile(out('admin-icon-192.png'));
  await sharp(svg(true)).png().toFile(out('admin-icon-maskable-512.png'));
  console.log('admin icons written to client/public/');
})();

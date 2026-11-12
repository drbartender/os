// make-admin-icon: rasterize the admin app icon set (client/public/admin-icon-*.png) from an inline SVG.
// The mark is the OS brand mark the desktop sidebar and the phone header draw: the Rx glyph (U+211E),
// white on the default accent tile (#196ac8, hsl 212 78% 44%, the admin manifest's theme_color).
// "any" icons are a rounded tile with transparent corners; the maskable one is full bleed with the
// glyph inside the 80% safe circle a launcher's mask keeps. The FILENAMES are the stable contract
// (client/public/admin-manifest.json names them). The glyph is set in Noto Sans Display, which must be
// installed where this runs (librsvg resolves it through fontconfig); check the output by eye.
// Run from the repo root: node scripts/make-admin-icon.js
const sharp = require('sharp');
const path = require('path');

const ACCENT = '#196ac8';
const svg = (maskable) => Buffer.from(`<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <rect width="512" height="512" rx="${maskable ? 0 : 96}" fill="${ACCENT}"/>
  <text x="256" y="${maskable ? 333 : 362}" text-anchor="middle" font-family="Noto Sans Display" font-weight="500"
    font-size="${maskable ? 215 : 287}" fill="#ffffff">&#8478;</text>
</svg>`);

(async () => {
  const out = (f) => path.join(__dirname, '..', 'client', 'public', f);
  await sharp(svg(false)).png().toFile(out('admin-icon-512.png'));
  await sharp(svg(false)).resize(192, 192).png().toFile(out('admin-icon-192.png'));
  await sharp(svg(true)).png().toFile(out('admin-icon-maskable-512.png'));
  console.log('admin icons written to client/public/');
})();

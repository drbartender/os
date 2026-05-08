// One-shot asset optimization. Run from project root:
//   npm run optimize:assets
//
// What it does:
//   1. Re-exports the apothecary-press tile backgrounds as WebP at the actual
//      repeat-tile size (parchment-bg as 600×600, chalkboard-bg as 1200×1200).
//      The originals were full-resolution PNGs that the browser was downscaling
//      anyway — switching to WebP at the natural tile size cuts ~2.5MB on the
//      public TipPage and ~150KB on the homepage.
//   2. Converts the three IM Fell English TTFs to WOFF2 (typical 30-40% smaller,
//      universal modern-browser support).
//
// Idempotent: each task is skipped when the optimized output already exists.
// Sources are NOT deleted — that's a separate `git rm` so the deletion lands in
// a reviewable commit.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const wawoff2 = require('wawoff2');

const ROOT = path.resolve(__dirname, '..');

const IMAGE_TASKS = [
  {
    source: 'client/src/assets/tip-page/parchment-bg.png',
    output: 'client/src/assets/tip-page/parchment-bg.webp',
    size: 600,
    quality: 78,
  },
  {
    source: 'client/src/assets/tip-page/chalkboard-bg.png',
    output: 'client/src/assets/tip-page/chalkboard-bg.webp',
    size: 1200,
    quality: 78,
  },
];

const FONT_TASKS = [
  'client/src/fonts/IMFellEnglish-Regular.ttf',
  'client/src/fonts/IMFellEnglish-Italic.ttf',
  'client/src/fonts/IMFellEnglishSC-Regular.ttf',
];

function fmtKB(bytes) {
  return `${(bytes / 1024).toFixed(0)}KB`;
}

async function convertImage({ source, output, size, quality }) {
  const src = path.join(ROOT, source);
  const dst = path.join(ROOT, output);
  if (!fs.existsSync(src)) {
    console.log(`[image] skip — no source: ${source}`);
    return;
  }
  if (fs.existsSync(dst)) {
    console.log(`[image] skip — output exists: ${output}`);
    return;
  }
  const before = fs.statSync(src).size;
  // `fit: inside` keeps aspect; `withoutEnlargement: true` avoids upscaling a
  // smaller-than-target source. The originals are larger than `size`, so this
  // is mostly defensive.
  await sharp(src)
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toFile(dst);
  const after = fs.statSync(dst).size;
  const pct = Math.round((1 - after / before) * 100);
  console.log(`[image] ${source} → ${output}  ${fmtKB(before)} → ${fmtKB(after)} (-${pct}%)`);
}

async function convertFont(srcRel) {
  const src = path.join(ROOT, srcRel);
  const dstRel = srcRel.replace(/\.ttf$/i, '.woff2');
  const dst = path.join(ROOT, dstRel);
  if (!fs.existsSync(src)) {
    console.log(`[font]  skip — no source: ${srcRel}`);
    return;
  }
  if (fs.existsSync(dst)) {
    console.log(`[font]  skip — output exists: ${dstRel}`);
    return;
  }
  const ttf = fs.readFileSync(src);
  const woff2 = await wawoff2.compress(ttf);
  fs.writeFileSync(dst, woff2);
  const pct = Math.round((1 - woff2.length / ttf.length) * 100);
  console.log(`[font]  ${srcRel} → ${dstRel}  ${fmtKB(ttf.length)} → ${fmtKB(woff2.length)} (-${pct}%)`);
}

(async () => {
  for (const t of IMAGE_TASKS) await convertImage(t);
  for (const t of FONT_TASKS) await convertFont(t);
  console.log('\nDone. To finalize, switch the CSS references and `git rm` the originals:');
  console.log('  client/src/index.css                — @font-face src → .woff2 format(\'woff2\')');
  console.log('  client/src/styles/drb-tokens.css    — @font-face src → .woff2 format(\'woff2\') (same family declared twice; both files reference the .ttf)');
  console.log('  client/src/pages/public/TipPage.css — background-image url(... .webp)');
  console.log('  git rm client/src/fonts/IMFellEnglish*.ttf');
  console.log('  git rm client/src/assets/tip-page/{parchment-bg,chalkboard-bg}.png');
})().catch(err => {
  console.error('optimize-assets failed:', err);
  process.exit(1);
});

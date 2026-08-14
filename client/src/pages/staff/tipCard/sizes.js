// Canvas sizes and the capture scale each one needs.
//
// The two surfaces are authored at DIFFERENT resolutions on purpose, so the
// capture scale is per-surface and lives here next to the dimensions. Reading
// one without the other is how a file silently ships at 150 or 600 DPI.
//
//   SIGN  authored at 150 DPI of 5x7  -> captureScale 2 -> 300 DPI
//   CARD  authored at 300 DPI natively -> captureScale 1 -> 300 DPI
//
// The card is native 300 because it goes to a real press with bleed and trim
// marks, where the artboard IS the deliverable. The sign goes to a photo
// counter, which prints an image at a named size, so it is authored at the
// friendlier 150 and doubled on capture.

// ── Bar sign ────────────────────────────────────────────────
// EXACTLY 5 x 7, no bleed. Bleed is a press concept: a shop prints oversized
// and trims to marks. Walgreens does not trim. A 5.25 x 7.25 artboard uploaded
// as a "5x7" print comes back cropped or letterboxed (aspect 1.381 vs 1.400),
// and the bleed area prints as image. The frame-lip clearance that bleed was
// reaching for is just content inset, which costs nothing.
export const SIGN_SIZES = {
  '5x7': {
    label: '5 × 7',
    fileLabel: '5x7',
    w: 750,
    h: 1050,
    inW: 5,
    inH: 7,
    captureScale: 2,
  },
};

// One sign size (2026-08-11). A QR wants about a tenth of its scan distance
// plus 20-30% more in low light, and a bar is low light.
export const DISPLAY_SIGN_SIZE = '5x7';

// Content inset from the trim edge, so an acrylic frame lip (typically 3-5mm)
// can overlap the edge without eating any artwork.
export const SIGN_INSET = { y: 56, x: 72 };

// ── QR plate ────────────────────────────────────────────────
// The quiet zone is the plate band itself, not padding inside the SVG, so the
// two numbers below are a pair and must move together.
//
// Our tip URL is 37x37 modules at level Q. With 318px of code that is 8.59px
// per module, so 4 modules of quiet zone needs 35px. The design's 26px was
// 3.03 modules, under the spec. The plate grew rather than the code shrinking:
// the code is what has to be scannable across a bar top.
export const SIGN_QR = { plate: 388, pad: 35, radius: 14 };

// ── Hand-out card ───────────────────────────────────────────
// PORTRAIT 2 x 3.5in, native 300 DPI, WITH bleed: this one really does go to a
// press that trims to marks, which is exactly where bleed belongs.
// The inch pair is the BLEED artboard, because that is what gets captured and
// what the PDF page has to be. Naming a trim-sized `inW`/`inH` here the way
// SIGN_SIZES does — where the inches ARE the page size — is how a 675 x 1125
// image ends up squashed onto a 2 x 3.5in page.
export const CARD_SIZE = {
  wBleed: 675,   // 2.25in
  hBleed: 1125,  // 3.75in
  w: 600,        // 2.00in trim
  h: 1050,       // 3.50in trim
  inWBleed: 2.25,
  inHBleed: 3.75,
  bleed: 37.5,   // 0.125in on every side
  captureScale: 1,
};

// Same quiet-zone arithmetic as the sign, run for the card's own numbers: at
// 342px of code the 37 modules are 9.24px each, so 39px of plate band is 4.2
// modules. The design's 30px was 3.08. Here the code shrank rather than the
// plate growing, because the card is read in the hand at ~11in and has the
// scan margin to spare, where the sign does not.
export const CARD_QR = { plate: 420, pad: 39, radius: 24 };

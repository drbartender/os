// Canvas sizes. Every layout is authored at 150 DPI of its real print size, so
// an html2canvas capture at scale 2 lands on exactly 300 DPI, which is what a
// photo counter wants. Changing a canvas here without changing its inches (or
// the reverse) silently changes the output DPI.
//
// `label` is what a bartender reads on the button. `fileLabel` is ASCII and is
// the ONLY one allowed into a filename: '×' is not the letter x, and it lands
// in download folders and photo-counter kiosks as an encoding surprise.
export const SIGN_SIZES = {
  '4x6': { label: '4 × 6', fileLabel: '4x6', w: 600, h: 900, inW: 4, inH: 6 },
  '5x7': { label: '5 × 7', fileLabel: '5x7', w: 750, h: 1050, inW: 5, inH: 7 },
};

export const CARD_SIZE = { w: 525, h: 300, inW: 3.5, inH: 2 };

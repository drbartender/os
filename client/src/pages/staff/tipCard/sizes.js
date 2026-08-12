// Canvas sizes. Every layout is authored at 150 DPI of its real print size, so
// an html2canvas capture at scale 2 lands on exactly 300 DPI, which is what a
// photo counter wants. Changing a canvas here without changing its inches (or
// the reverse) silently changes the output DPI.
//
// ONE sign size, 5 x 7 (2026-08-11). A QR should be about a tenth of its scan
// distance, plus 20-30% more in low light, and a bar is low light: the 5 x 7
// clears a guest standing at the bar with margin where the 4 x 6 was marginal.
// It also removes a decision from a bartender who just wants the thing
// printed, for about $2.60 (4x6 ~ $0.19-0.39, 5x7 ~ $2.99, both same-day at
// CVS and Walgreens).
//
// `label` is what a bartender reads on the button. `fileLabel` is ASCII and is
// the ONLY one allowed into a filename: '×' is not the letter x, and it lands
// in download folders and photo-counter kiosks as an encoding surprise.
export const SIGN_SIZES = {
  '5x7': { label: '5 × 7', fileLabel: '5x7', w: 750, h: 1050, inW: 5, inH: 7 },
};

// The one size display mode scales onto a screen. Named rather than inlined so
// a future second sign size cannot silently change what the tablet shows.
export const DISPLAY_SIGN_SIZE = '5x7';

export const CARD_SIZE = { w: 525, h: 300, inW: 3.5, inH: 2 };

// Review source is a key in the payload and a label on screen. Every artboard
// (1h, 1i) prints it capitalized; the raw enum never reaches the page. Unknown
// sources fall through unchanged so a new one still shows something.
const SOURCE_LABEL = { google: 'Google', thumbtack: 'Thumbtack' };

export const sourceLabel = (s) => SOURCE_LABEL[s] || s;

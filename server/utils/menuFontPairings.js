// The fixed font pairing ids for the menu art generator (spec 10.3).
//
// The server knows only the ids: the words step's output schema and the draft
// PATCH validation both read them from here. Faces, sizes and default colors
// live on the client (client/src/pages/admin/menuDesigner/fontPairings.js),
// which must carry exactly these ids.

const FONT_PAIRING_IDS = Object.freeze([
  'elegant-script',
  'rustic',
  'modern-clean',
  'retro',
  'spooky',
  'tropical',
]);

function isFontPairingId(value) {
  return typeof value === 'string' && FONT_PAIRING_IDS.includes(value);
}

module.exports = { FONT_PAIRING_IDS, isFontPairingId };

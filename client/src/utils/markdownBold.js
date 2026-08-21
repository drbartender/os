// The ONE client-side reader of the `**bold**` runs our legal copy carries.
//
// server/data/contractorAgreement.js writes clause bodies with `**bold**` lead-ins
// ("**Mutual.**", "**From Contractor.**"). Two surfaces render that same frozen
// string and until 2026-08-20 only one of them understood it: the archived PDF
// parsed the runs (agreementPdf.js renderMixedBoldText) while the SIGNING SCREEN
// printed the asterisks raw. The person signing saw a worse document than the one
// that gets filed, which is backwards, and stray ** on a contract reads as
// sloppiness at the one moment you are asking for trust.
//
// The split is deliberately IDENTICAL to the server's, so the two surfaces cannot
// disagree about what is bold. It is NOT a markdown parser and must not become
// one: the copy is frozen (contractorAgreement.js deep-freezes V2 and V3, and V3
// aliases most of V2's clause objects), so the set of constructs it can contain
// is closed and known.
//
// One deliberate DIFFERENCE from the server twin: no character normalization.
// agreementPdf.js rewrites bullets and em dashes to ASCII because its PDF font
// lacks the glyphs. A browser has them, so rewriting here would make the screen
// worse to fix a problem it does not have.
//
// An UNMATCHED marker stays literal, exactly as it does server-side: the pattern
// requires both delimiters, so "**oops" renders as "**oops" on both surfaces
// rather than one of them swallowing it.

/**
 * Split a string into ordered bold / plain runs.
 *
 * @param {string} str
 * @returns {Array<{text: string, bold: boolean}>} empty array for empty input
 */
export function splitBoldRuns(str) {
  if (typeof str !== 'string' || str === '') return [];
  return str
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part) => (part.startsWith('**') && part.endsWith('**')
      ? { text: part.slice(2, -2), bold: true }
      : { text: part, bold: false }));
}

export default splitBoldRuns;

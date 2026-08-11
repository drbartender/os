// Filenames for browser-triggered downloads. Extracted from MenuPNG.jsx
// (2026-08-11) when the tip-sign download needed the same sanitizing; a second
// private copy is how two exports start disagreeing about what a legal
// filename is.

export function sanitizeFilenamePart(name) {
  return (name || '')
    // Intentionally strips ASCII control chars to keep filenames safe
    // for Windows/macOS download dialogs (filesystems reject these).
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:"*?<>|\x00-\x1f]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim()
    // Trailing dots and spaces, last. A staff display_name carries the
    // seniority disambiguator, so "Marcus R." is the COMMON shape, and it
    // produced "Tip Sign 4x6 - Marcus R..jpg". Windows also rejects a filename
    // ending in a dot outright. Caught by driving a real download, 2026-08-11.
    .replace(/[.\s]+$/, '');
}

export function buildDownloadFilename(base, part, ext) {
  const safe = sanitizeFilenamePart(part);
  return safe ? `${base} - ${safe}.${ext}` : `${base}.${ext}`;
}

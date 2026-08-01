const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidUpload,
  isValidImageUpload,
  isValidOnboardingDocument,
  safeUploadExtension,
} = require('./fileValidation');

const file = (bytes, name = 'x.bin') => ({ data: Buffer.from(bytes), name });

const PDF  = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
const PNG  = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d];
const ZIP  = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00];
const OLE  = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00];
const EXE  = [0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00];

const webp = () => [
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
];
// ftyp box at offset 4, brand at offset 8.
const heic = (brand = 'heic') => [
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  ...Buffer.from(brand, 'latin1'),
];

test('accepts the self-identifying formats on magic bytes alone', () => {
  assert.equal(isValidOnboardingDocument(file(PDF, 'resume.pdf')), true);
  assert.equal(isValidOnboardingDocument(file(JPEG, 'cert.jpg')), true);
  assert.equal(isValidOnboardingDocument(file(PNG, 'cert.png')), true);
  assert.equal(isValidOnboardingDocument(file(webp(), 'cert.webp')), true);
});

test('accepts HEIC and its sibling brands', () => {
  for (const brand of ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']) {
    assert.equal(isValidOnboardingDocument(file(heic(brand), 'photo.heic')), true, brand);
  }
});

test('accepts a docx only when magic and extension agree', () => {
  assert.equal(isValidOnboardingDocument(file(ZIP, 'resume.docx')), true);
  assert.equal(isValidOnboardingDocument(file(ZIP, 'payload.zip')), false);
  assert.equal(isValidOnboardingDocument(file(ZIP, 'noext')), false);
});

test('accepts a legacy doc only when magic and extension agree', () => {
  assert.equal(isValidOnboardingDocument(file(OLE, 'resume.doc')), true);
  assert.equal(isValidOnboardingDocument(file(OLE, 'book.xls')), false);
});

test('extension matching is case insensitive', () => {
  assert.equal(isValidOnboardingDocument(file(ZIP, 'Resume.DOCX')), true);
});

test('rejects executables and malformed input', () => {
  assert.equal(isValidOnboardingDocument(file(EXE, 'virus.exe')), false);
  assert.equal(isValidOnboardingDocument(null), false);
  assert.equal(isValidOnboardingDocument({}), false);
  assert.equal(isValidOnboardingDocument({ data: 'not-a-buffer', name: 'a.pdf' }), false);
  assert.equal(isValidOnboardingDocument(file([], 'empty.pdf')), false);
});

// 'MZ\x90\x00' is a working DOS/PE header and leaves offsets 4..12 free, so a
// real executable can carry 'ftyp' + a HEIF brand and still run. The unanchored
// brand check accepted it, and the R2 key took its extension from the client's
// filename, so it landed on the admin's disk as a runnable .exe named after the
// resume they asked for.
test('rejects an executable wearing a HEIF brand (unanchored-magic polyglot)', () => {
  const polyglot = [...EXE.slice(0, 4), 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63];
  assert.equal(isValidOnboardingDocument(file(polyglot, 'resume.exe')), false);
  assert.equal(isValidOnboardingDocument(file(polyglot, 'resume.heic')), false);
  // Any ASCII-leading file (shell script, .bat) reads as a huge box size too.
  const batish = [...Buffer.from('@ech', 'latin1'), 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63];
  assert.equal(isValidOnboardingDocument(file(batish, 'cert.bat')), false);
});

test('safeUploadExtension names the sniffed type, never the client filename', () => {
  assert.equal(safeUploadExtension(file(PDF, 'payload.bat')), '.pdf');
  assert.equal(safeUploadExtension(file(JPEG, 'photo.exe')), '.jpg');
  assert.equal(safeUploadExtension(file(PNG, 'a.sh')), '.png');
  assert.equal(safeUploadExtension(file(webp(), 'a.dll')), '.webp');
  assert.equal(safeUploadExtension(file(heic(), 'photo.exe')), '.heic');
  // Containers still need the extension to agree, so they keep their own.
  assert.equal(safeUploadExtension(file(ZIP, 'resume.docx')), '.docx');
  assert.equal(safeUploadExtension(file(OLE, 'resume.doc')), '.doc');
  assert.equal(safeUploadExtension(file(ZIP, 'payload.zip')), '');
  assert.equal(safeUploadExtension(null), '');
});

// A validated file must never be rejected for how it was named: the extension
// is sanitized on the way to R2 instead. Rejecting real uploads strands
// recruits (incident 2026-07-23).
test('a genuine photo named .exe is still accepted, just stored safely', () => {
  assert.equal(isValidOnboardingDocument(file(heic(), 'photo.exe')), true);
  assert.equal(safeUploadExtension(file(heic(), 'photo.exe')), '.heic');
});

test('the shared validators are unchanged and stay narrow', () => {
  assert.equal(isValidUpload(file(PDF, 'a.pdf')), true);
  assert.equal(isValidUpload(file(ZIP, 'a.docx')), false, 'blog/W-9 path must not accept docx');
  assert.equal(isValidUpload(file(heic(), 'a.heic')), false, 'blog/W-9 path must not accept heic');
  assert.equal(isValidImageUpload(file(PNG, 'a.png')), true);
  assert.equal(isValidImageUpload(file(heic(), 'a.heic')), false, 'drink-plan images must not accept heic');
});

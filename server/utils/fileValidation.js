/**
 * Allowed MIME / magic bytes for uploads (PDF, JPEG, PNG, WebP).
 * express-fileupload provides file.data buffer.
 */
const path = require('path');

const PDF  = Buffer.from([0x25, 0x50, 0x44, 0x46]);                          // %PDF
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const PNG  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RIFF = Buffer.from([0x52, 0x49, 0x46, 0x46]);
const WEBP = Buffer.from([0x57, 0x45, 0x42, 0x50]);

const ALLOWED = [
  { mime: 'application/pdf', magic: PDF },
  { mime: 'image/jpeg', magic: JPEG },
  { mime: 'image/png', magic: PNG },
];

function isWebp(buf) {
  // RIFF....WEBP (check both RIFF header and WEBP signature at offset 8)
  return buf.length >= 12
    && buf.subarray(0, 4).equals(RIFF)
    && buf.subarray(8, 12).equals(WEBP);
}

function isValidUpload(file) {
  if (!file || !file.data || !Buffer.isBuffer(file.data)) return false;
  const buf = file.data;
  for (const { magic } of ALLOWED) {
    if (buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic)) return true;
  }
  if (isWebp(buf)) return true;
  return false;
}

function isValidImageUpload(file) {
  if (!file || !file.data || !Buffer.isBuffer(file.data)) return false;
  const buf = file.data;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length >= pngMagic.length && buf.slice(0, pngMagic.length).equals(pngMagic)) return true;
  // JPEG: FF D8 FF
  const jpegMagic = Buffer.from([0xff, 0xd8, 0xff]);
  if (buf.length >= jpegMagic.length && buf.slice(0, jpegMagic.length).equals(jpegMagic)) return true;
  return false;
}

const FTYP = Buffer.from([0x66, 0x74, 0x79, 0x70]);                          // 'ftyp' at offset 4
const ZIP  = Buffer.from([0x50, 0x4b, 0x03, 0x04]);                          // PK.. (docx, and every other zip)
const OLE  = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);  // legacy Office compound file
const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'];

function startsWith(buf, magic) {
  return buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic);
}

function isHeif(buf) {
  if (buf.length < 12) return false;
  if (!buf.subarray(4, 8).equals(FTYP)) return false;
  // Bytes 0..4 are the ISO-BMFF box SIZE, not free space. Checking it is what
  // keeps this from admitting an executable polyglot: 'MZ\x90\x00' is a valid
  // DOS/PE header AND leaves offsets 4..12 free, so an .exe carrying
  // 'MZ\x90\x00ftypheic' used to validate as an iPhone photo.
  //
  // A real ftyp box is 16 bytes minimum (size + type + major_brand +
  // minor_version) and only a few dozen bytes in practice, since the tail is a
  // short compatible_brands list. Any file whose first four bytes are ASCII or
  // an 'MZ' header reads as at least 0x20202020 (538M) here, so this bound
  // rejects every executable and script shape without depending on the file
  // length (file.data can be a partial read).
  const boxSize = buf.readUInt32BE(0);
  if (boxSize < 16 || boxSize > 1024) return false;
  return HEIF_BRANDS.includes(buf.subarray(8, 12).toString('latin1'));
}

/**
 * Onboarding documents only: resume and alcohol certification.
 *
 * Wider than isValidUpload on purpose. These files are stored in R2 and opened
 * by an admin through a signed URL, never rendered on a public page, so an
 * iPhone photo or a Word document is a legitimate thing for a recruit to hand
 * us. Rejecting them strands people (incident 2026-07-23).
 *
 * Container formats (DOC, DOCX) share their magic bytes with every other OLE
 * or zip file, so they are accepted ONLY when the magic and the filename
 * extension agree. PK magic alone never admits an arbitrary .zip.
 *
 * Deliberately NOT used by payment.js (W-9), admin/blog.js (blog images), or
 * staffPortal.js. Those keep the narrow isValidUpload.
 */
function isValidOnboardingDocument(file) {
  if (!file || !file.data || !Buffer.isBuffer(file.data)) return false;
  const buf = file.data;
  if (isValidUpload(file)) return true;   // PDF, JPEG, PNG, WebP
  if (isHeif(buf)) return true;

  const ext = extensionOf(file);
  if (startsWith(buf, ZIP) && ext === '.docx') return true;
  if (startsWith(buf, OLE) && ext === '.doc') return true;
  return false;
}

function extensionOf(file) {
  return typeof file.name === 'string' ? path.extname(file.name).toLowerCase() : '';
}

/**
 * The extension an upload should be STORED under, derived from the sniffed
 * bytes rather than from the filename the client sent.
 *
 * The filename is attacker-controlled and is what decides how the admin's OS
 * treats the download, so it must never reach the R2 key. A file that
 * validated as a photo or a PDF but was named "resume.exe" used to be stored
 * as .exe and handed to the admin as a runnable file; deriving the extension
 * here means the worst an attacker can do is store their payload under the
 * extension its own magic bytes claim. The original filename is still kept for
 * display in the *_name columns.
 *
 * Returns '' when nothing matches, which cannot happen for a file that already
 * passed isValidUpload / isValidOnboardingDocument — call this only after one
 * of those has said yes.
 */
function safeUploadExtension(file) {
  if (!file || !file.data || !Buffer.isBuffer(file.data)) return '';
  const buf = file.data;
  if (startsWith(buf, PDF)) return '.pdf';
  if (startsWith(buf, JPEG)) return '.jpg';
  if (startsWith(buf, PNG)) return '.png';
  if (isWebp(buf)) return '.webp';
  if (isHeif(buf)) return '.heic';
  const ext = extensionOf(file);
  if (startsWith(buf, ZIP) && ext === '.docx') return '.docx';
  if (startsWith(buf, OLE) && ext === '.doc') return '.doc';
  return '';
}

module.exports = {
  isValidUpload,
  isValidImageUpload,
  isValidOnboardingDocument,
  safeUploadExtension,
};

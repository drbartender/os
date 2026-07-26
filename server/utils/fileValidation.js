/**
 * Allowed MIME / magic bytes for uploads (PDF, JPEG, PNG, WebP).
 * express-fileupload provides file.data buffer.
 */
const path = require('path');

const ALLOWED = [
  { mime: 'application/pdf', magic: Buffer.from([0x25, 0x50, 0x44, 0x46]) },  // %PDF
  { mime: 'image/jpeg', magic: Buffer.from([0xff, 0xd8, 0xff]) },
  { mime: 'image/png', magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
];

function isValidUpload(file) {
  if (!file || !file.data || !Buffer.isBuffer(file.data)) return false;
  const buf = file.data;
  for (const { magic } of ALLOWED) {
    if (buf.length >= magic.length && buf.slice(0, magic.length).equals(magic)) return true;
  }
  // WebP: RIFF....WEBP (check both RIFF header and WEBP signature at offset 8)
  if (buf.length >= 12 &&
      buf.slice(0, 4).equals(Buffer.from([0x52, 0x49, 0x46, 0x46])) &&
      buf.slice(8, 12).equals(Buffer.from([0x57, 0x45, 0x42, 0x50]))) {
    return true;
  }
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

  const ext = typeof file.name === 'string' ? path.extname(file.name).toLowerCase() : '';
  if (startsWith(buf, ZIP) && ext === '.docx') return true;
  if (startsWith(buf, OLE) && ext === '.doc') return true;
  return false;
}

module.exports = { isValidUpload, isValidImageUpload, isValidOnboardingDocument };

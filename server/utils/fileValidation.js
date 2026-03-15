/**
 * Allowed MIME / magic bytes for uploads (PDF, JPEG, PNG).
 * express-fileupload provides file.data buffer.
 */
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
  return false;
}

module.exports = { isValidUpload };

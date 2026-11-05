// The one check both signature writers run on a signature payload (the staff agreement sign in
// routes/agreement.js and the proposal sign in routes/proposals/publicToken.js): a drawn
// signature is a PNG or JPEG data URL whose decoded bytes carry that image's magic bytes and
// fit SIGNATURE_MAX_BYTES, a typed one is a 2 to 120 character name; anything else is a field
// error for the route to 400 with. Pure: no DB, no Express.
//
// Why both shapes are checked here and not where they are drawn (agreementPdf.js prints
// "[No signature captured]" for a draw value that is not an image, DocumentsTab hands the value
// to an <img>): a row that says signed must hold a signature. The caps are the renderer's
// contract (agreementPdf.js accepts png|jpe?g) and a size a canvas signature never reaches
// (a 600x200 pad PNG is under 30 KB); the public page used to ship whatever was stored on
// every token load.

'use strict';

const { PNG_MAGIC, JPEG_MAGIC } = require('./fileValidation');

const SIGNATURE_MAX_BYTES = 200 * 1024;
// Base64 grows bytes by 4/3, so a payload past this cannot decode under the cap;
// checked first so an oversize string is refused without decoding it.
const MAX_BASE64_LENGTH = Math.ceil(SIGNATURE_MAX_BYTES / 3) * 4;
const DATA_URL_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;
const TYPED_MIN = 2;
const TYPED_MAX = 120;
// A typed signature is a name: letters and marks in any script, digits (a
// "3rd"), spaces, and the punctuation names carry. No slash, colon, angle
// bracket or parenthesis, so a URL or markup is never stored as a signature.
const TYPED_RE = /^[\p{L}\p{M}\p{N} .,'’-]+$/u;
const METHODS = ['draw', 'type'];

const MAGIC = { png: PNG_MAGIC, jpeg: JPEG_MAGIC };

/**
 * @param {{ data: unknown, method: unknown }} payload  the posted signature and its method
 * @returns {{ value: string|null, error: string|null }}  value is the string to store
 *   (the data URL as sent, or the trimmed typed name); error is the field message
 */
function validateSignaturePayload({ data, method } = {}) {
  if (!METHODS.includes(method)) return { value: null, error: 'Invalid signature method.' };
  if (typeof data !== 'string' || data.length === 0) {
    return { value: null, error: 'Please sign before continuing.' };
  }
  if (method === 'type') {
    const name = data.trim();
    if (name.length < TYPED_MIN || name.length > TYPED_MAX) {
      return { value: null, error: `Type your full name (${TYPED_MIN} to ${TYPED_MAX} characters).` };
    }
    if (!TYPED_RE.test(name)) return { value: null, error: 'Type your name using letters only.' };
    return { value: name, error: null };
  }
  if (data.length > MAX_BASE64_LENGTH + 'data:image/jpeg;base64,'.length) {
    return { value: null, error: 'Signature image is too large. Please clear and sign again.' };
  }
  const m = DATA_URL_RE.exec(data);
  if (!m) return { value: null, error: 'Signature must be a PNG or JPEG image. Please clear and sign again.' };
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > SIGNATURE_MAX_BYTES) {
    return { value: null, error: 'Signature image is too large. Please clear and sign again.' };
  }
  const magic = MAGIC[m[1]];
  if (bytes.length < magic.length || !bytes.subarray(0, magic.length).equals(magic)) {
    return { value: null, error: 'Signature must be a PNG or JPEG image. Please clear and sign again.' };
  }
  return { value: data, error: null };
}

module.exports = { validateSignaturePayload, SIGNATURE_MAX_BYTES, TYPED_MIN, TYPED_MAX };

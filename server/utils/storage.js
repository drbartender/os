// Cloudflare R2 upload + signed URL helpers + readFile (an object's bytes and content type, time
// and size bounded; the menu art job and r2Proxy.js)

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl: createSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { ExternalServiceError, NotFoundError } = require('./errors');

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

async function uploadFile(buffer, filename) {
  const ext = (filename.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  try {
    await client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: filename,
      Body: buffer,
      ContentType: contentType,
    }));
  } catch (err) {
    throw new ExternalServiceError('r2', err, 'File storage is temporarily unavailable. Please try again in a moment.');
  }
}

async function getSignedUrl(filename) {
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: filename,
  });
  try {
    return await createSignedUrl(client, command, { expiresIn: 900 }); // 15 minutes
  } catch (err) {
    throw new ExternalServiceError('r2', err, 'File is temporarily unavailable. Please try again in a moment.');
  }
}

/**
 * Read an R2 object back into memory: `{ buffer, contentType }`. The same
 * bounded fetch sendMenuPrintFile uses (a signed URL, then `fetch` under an
 * AbortController), except the timer also covers the body read, since the
 * whole object is buffered here rather than streamed.
 *
 * Throws NotFoundError when there is no key or R2 answers 404, so a caller can
 * say "missing", and ExternalServiceError('r2', ...) on a fetch error, a
 * timeout or any other non-OK status. R2's error body is never forwarded.
 * Callers that hand these bytes to anyone else check the key's prefix first.
 *
 * `maxBytes` (default 25 MB, well over the upload cap) bounds what is held in
 * memory: an object whose Content-Length is over it is refused unread, and a
 * body that passes it while streaming in is cut off there. Both are
 * ExternalServiceError('r2', ...), since a stored object that large means
 * something upstream went wrong.
 */
async function readFile(key, { timeoutMs = 8000, maxBytes = 25 * 1024 * 1024 } = {}) {
  if (typeof key !== 'string' || !key) throw new NotFoundError('File not found.');
  // Signed through module.exports, not the local binding, so a test that swaps
  // this module's exports through require.cache (menuPrint.test.js does) also
  // stubs the presign inside readFile.
  const url = await module.exports.getSignedUrl(key);
  const unavailable = 'File is temporarily unavailable. Please try again in a moment.';
  const tooLarge = 'This file is too large to open.';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let upstream;
    try {
      upstream = await fetch(url, { signal: ac.signal });
    } catch (err) {
      throw new ExternalServiceError('r2', err, unavailable);
    }
    if (!upstream.ok) {
      if (upstream.body) upstream.body.cancel().catch(() => {});
      if (upstream.status === 404) throw new NotFoundError('File not found.');
      throw new ExternalServiceError('r2', new Error(`Upstream returned ${upstream.status}`), unavailable);
    }
    // Number(null) is 0 and Number('junk') is NaN, so a missing or unreadable
    // Content-Length never refuses here; the streamed count below still holds.
    const declared = Number(upstream.headers.get('content-length'));
    if (declared > maxBytes) {
      if (upstream.body) upstream.body.cancel().catch(() => {});
      throw new ExternalServiceError('r2', new Error(`Upstream declared ${declared} bytes, over the ${maxBytes} byte cap`), tooLarge);
    }
    // Read chunk by chunk rather than arrayBuffer(), so a body past the cap is
    // cut off as it passes maxBytes instead of being held whole first.
    const chunks = [];
    let total = 0;
    let overCap = false;
    try {
      const reader = upstream.body && upstream.body.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          overCap = true;
          reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
    } catch (err) {
      throw new ExternalServiceError('r2', err, unavailable);
    }
    if (overCap) {
      throw new ExternalServiceError('r2', new Error(`Upstream body passed the ${maxBytes} byte cap`), tooLarge);
    }
    return {
      buffer: Buffer.concat(chunks, total),
      contentType: upstream.headers.get('content-type') || 'application/octet-stream',
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { uploadFile, getSignedUrl, readFile };

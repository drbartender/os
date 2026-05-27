// Thin wrapper around server/utils/storage.js (the existing R2 client).
// Phase 0 needs to pass the content-type explicitly because we get it from the
// HTTP response, not from a file extension. The storage.js helper derives type
// from filename — so we go directly to S3Client/PutObjectCommand here.
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

let _client = null;
function getClient() {
  if (_client) return _client;
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return _client;
}

async function uploadToR2(key, buffer, contentType) {
  if (!key) throw new Error('uploadToR2: key required');
  if (!Buffer.isBuffer(buffer)) throw new Error('uploadToR2: buffer required');
  await getClient().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
  return key;
}

module.exports = { uploadToR2 };

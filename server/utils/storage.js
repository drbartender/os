const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl: createSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { ExternalServiceError } = require('./errors');

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

module.exports = { uploadFile, getSignedUrl };

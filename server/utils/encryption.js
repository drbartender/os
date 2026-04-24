const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 64) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY must be set to 64 hex chars in production');
    }
    return null; // dev fallback only
  }
  return Buffer.from(key, 'hex');
}

function encrypt(text) {
  if (!text) return text;
  const key = getKey();
  if (!key) {
    console.warn('[encryption] ENCRYPTION_KEY missing — storing plaintext (dev only)');
    return text;
  }
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `enc:${iv.toString('hex')}:${tag}:${enc}`;
}

function decrypt(data) {
  if (!data) return data;
  if (!data.startsWith('enc:')) return data; // unencrypted legacy value
  const key = getKey();
  if (!key) {
    console.warn('[encryption] ENCRYPTION_KEY missing — returning ciphertext (dev only)');
    return data;
  }
  const [, ivHex, tagHex, encHex] = data.split(':');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  let dec = decipher.update(encHex, 'hex', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

module.exports = { encrypt, decrypt };

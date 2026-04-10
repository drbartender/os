const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 64) return null;
  return Buffer.from(key, 'hex');
}

function encrypt(text) {
  if (!text) return text;
  const key = getKey();
  if (!key) return text; // graceful fallback if key not configured yet
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
  if (!key) return data;
  const [, ivHex, tagHex, encHex] = data.split(':');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  let dec = decipher.update(encHex, 'hex', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

module.exports = { encrypt, decrypt };

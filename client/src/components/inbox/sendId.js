// A send id is a version 4 UUID (spec section 8: send_id is a client-generated
// UUID). It only has to be unique per attempt, never secret, so the last
// fallback is Math.random.
function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newSendId() {
  const c = typeof window !== 'undefined' ? window.crypto : null;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  let bytes;
  if (c && typeof c.getRandomValues === 'function') bytes = c.getRandomValues(new Uint8Array(16));
  else bytes = Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

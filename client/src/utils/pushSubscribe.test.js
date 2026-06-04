import { urlBase64ToUint8Array } from './pushSubscribe';

// The real DrB VAPID public key (uncompressed P-256 point, 65 bytes:
// 0x04 prefix + 32-byte X + 32-byte Y) encoded as base64url. We test against
// the production value so a regression in the decoder shows up here instead
// of at runtime in pushManager.subscribe().
const VAPID_PUBLIC_KEY =
  'BJ3wofapYuJxZLJIjw7ytucfavC7v1_WkVPG9IDPY-8AN_EulCTtB7JfwVZ1lFotJbtaKcsVhTMrjtltE6MtSIE';

describe('urlBase64ToUint8Array', () => {
  test('decodes the real VAPID public key to a 65-byte Uint8Array', () => {
    const out = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
    expect(out).toBeInstanceOf(Uint8Array);
    // 65 bytes = uncompressed P-256 point (0x04 || X || Y). Any other length
    // means we mangled the base64url → raw bytes conversion.
    expect(out.length).toBe(65);
    // First byte of an uncompressed P-256 point is always 0x04.
    expect(out[0]).toBe(0x04);
  });

  test('handles base64url padding (length % 4 != 0)', () => {
    // 'TQ' decodes to 'M' (1 byte). Without padding, naive atob would throw.
    const out = urlBase64ToUint8Array('TQ');
    expect(out.length).toBe(1);
    expect(out[0]).toBe(0x4d);
  });

  test('translates URL-safe alphabet (- → +, _ → /)', () => {
    // '-_' in base64url is '+/' in standard base64. atob('+/==') yields
    // [0xfb] — verifies both substitutions are applied before atob().
    const out = urlBase64ToUint8Array('-_');
    expect(out.length).toBe(1);
    expect(out[0]).toBe(0xfb);
  });
});

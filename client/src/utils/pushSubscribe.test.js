import '@testing-library/jest-dom';
import { urlBase64ToUint8Array } from './pushSubscribe';
import { isPushSubscribed, unsubscribePush, subscribePush } from './pushSubscribe';
import api from './api';

jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn(), delete: jest.fn() } }));

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

// What this block proves, and what it does not: the fake below resolves a
// registration by SCRIPT PATH, but the browser's getRegistration resolves by
// SCOPE (client/src/utils/adminSw.js:21-22). On one origin the staff and admin
// workers share the root scope, so in a real browser the path selects nothing.
// These tests prove the plumbing passes the path and the key through to the
// service-worker calls; they do NOT prove the two workers are kept apart.
function fakeServiceWorker(regs) {
  // regs: { [swPath]: { sub | null } }. getRegistration(path) resolves the
  // registration for that path; register(path) creates one.
  const made = {};
  const regFor = (path) => {
    if (!made[path]) {
      const state = regs[path] || { sub: null };
      made[path] = {
        pushManager: {
          getSubscription: async () => state.sub,
          subscribe: async () => {
            state.sub = { endpoint: `https://push.example.test${path}`, toJSON: () => ({ endpoint: `https://push.example.test${path}`, keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: async () => { state.sub = null; return true; } };
            return state.sub;
          },
        },
      };
    }
    return made[path];
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async (p) => (p in regs ? regFor(p) : undefined), register: async (p) => regFor(p), ready: Promise.resolve() },
  });
  return { regFor, regs };
}

describe('pushSubscribe takes the service worker path', () => {
  afterEach(() => { delete navigator.serviceWorker; delete window.PushManager; delete window.Notification; });

  test('isPushSubscribed reads the registration it is asked about, staff by default', async () => {
    fakeServiceWorker({ '/staff-sw.js': { sub: null }, '/admin-sw.js': { sub: { endpoint: 'e' } } });
    expect(await isPushSubscribed()).toBe(false);
    expect(await isPushSubscribed({ swPath: '/admin-sw.js' })).toBe(true);
  });

  test('subscribePush registers the path it is given with the key it is given', async () => {
    window.PushManager = function PushManager() {};
    window.Notification = { permission: 'granted', requestPermission: async () => 'granted' };
    const sw = fakeServiceWorker({});
    const r = await subscribePush({ swPath: '/admin-sw.js', vapidKey: 'BJ3wofapYuJxZLJIjw7ytucfavC7v1_WkVPG9IDPY-8AN_EulCTtB7JfwVZ1lFotJbtaKcsVhTMrjtltE6MtSIE' });
    expect(r).toEqual({ ok: true, state: 'granted' });
    expect(await sw.regFor('/admin-sw.js').pushManager.getSubscription()).not.toBeNull();
    expect(api.post).toHaveBeenCalledWith('/me/push-subscriptions', expect.objectContaining({ endpoint: 'https://push.example.test/admin-sw.js' }));
  });

  test('subscribePush carries the surface it is given in the server body, and none by default', async () => {
    window.PushManager = function PushManager() {};
    window.Notification = { permission: 'granted', requestPermission: async () => 'granted' };
    fakeServiceWorker({});
    await subscribePush({ swPath: '/admin-sw.js', vapidKey: VAPID_PUBLIC_KEY, surface: 'admin' });
    expect(api.post).toHaveBeenLastCalledWith('/me/push-subscriptions', expect.objectContaining({ surface: 'admin' }));
    await subscribePush({ vapidKey: VAPID_PUBLIC_KEY });
    expect(api.post.mock.calls[1][1]).not.toHaveProperty('surface');
  });

  // A device subscribed with no server row would read as on and never get a
  // banner: a rejected POST drops the browser subscription again.
  test('subscribePush whose server POST rejects leaves no subscription and answers failed', async () => {
    window.PushManager = function PushManager() {};
    window.Notification = { permission: 'granted', requestPermission: async () => 'granted' };
    const sw = fakeServiceWorker({ '/admin-sw.js': { sub: null } });
    api.post.mockRejectedValueOnce(new Error('Request failed with status code 500'));
    expect(await subscribePush({ swPath: '/admin-sw.js', vapidKey: VAPID_PUBLIC_KEY, surface: 'admin' })).toEqual({ ok: false, state: 'failed' });
    expect(await sw.regFor('/admin-sw.js').pushManager.getSubscription()).toBeNull();
    expect(await isPushSubscribed({ swPath: '/admin-sw.js' })).toBe(false);
  });

  test('subscribePush with no key is unsupported, and a denied permission is denied', async () => {
    window.PushManager = function PushManager() {};
    window.Notification = { permission: 'denied', requestPermission: async () => 'denied' };
    fakeServiceWorker({});
    expect(await subscribePush({ swPath: '/admin-sw.js', vapidKey: null })).toEqual({ ok: false, state: 'unsupported' });
    expect(await subscribePush({ swPath: '/admin-sw.js', vapidKey: 'k' })).toEqual({ ok: false, state: 'denied' });
  });

  test('unsubscribePush tears down the path it is given and tells the server', async () => {
    const sw = fakeServiceWorker({ '/admin-sw.js': { sub: null } });
    await sw.regFor('/admin-sw.js').pushManager.subscribe();
    await unsubscribePush({ swPath: '/admin-sw.js' });
    expect(await sw.regFor('/admin-sw.js').pushManager.getSubscription()).toBeNull();
    expect(api.delete).toHaveBeenCalledWith('/me/push-subscriptions', { data: { endpoint: 'https://push.example.test/admin-sw.js' } });
  });

  // Logout (2026-10-14): the token is gone before a DELETE could go out, so
  // logout drops only the browser's subscription; the server prunes on 410.
  test('unsubscribePush with notifyServer false drops the browser subscription and never calls the server', async () => {
    const sw = fakeServiceWorker({ '/admin-sw.js': { sub: null } });
    await sw.regFor('/admin-sw.js').pushManager.subscribe();
    expect(await unsubscribePush({ swPath: '/admin-sw.js', notifyServer: false })).toEqual({ ok: true });
    expect(await sw.regFor('/admin-sw.js').pushManager.getSubscription()).toBeNull();
    expect(api.delete).not.toHaveBeenCalled();
  });
});

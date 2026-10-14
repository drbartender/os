// The admin phone's push state and switches (spec 2026-08-13-mobile-admin
// section 7, 2026-10-14). Thin over pushSubscribe.js: this file knows the
// admin worker's path and the rule that the switch shows this device's REAL
// state (Android's permission, then whether the admin registration holds a
// subscription), never a stored flag. The VAPID key comes from the API
// (GET /me/notification-preferences, push.public_key), not from the build.
//
// Every entry point is a no-op off the admin host (2026-10-14), the same gate
// utils/adminSw.js uses: getRegistration resolves by SCOPE, not script URL, so
// on the staff host the admin path would find the STAFF registration and
// read, subscribe or tear down the staff portal's push instead.
import * as Sentry from '@sentry/react';
import { permissionState, isPushSubscribed, subscribePush, unsubscribePush } from './pushSubscribe';
import { isAdminHost } from './installAdminPwaMeta';

export const ADMIN_SW_PATH = '/admin-sw.js';

function onAdminHost() {
  return typeof window !== 'undefined' && isAdminHost(window.location && window.location.hostname);
}

export async function readDevicePushState() {
  if (!onAdminHost()) return 'unsupported';
  const perm = permissionState();
  if (perm === 'unsupported') return 'unsupported';
  if (perm === 'denied') return 'blocked';
  const subscribed = await isPushSubscribed({ swPath: ADMIN_SW_PATH });
  return perm === 'granted' && subscribed ? 'on' : 'off';
}

// Resolves a state object, never throws: the switch's row says why. The
// states: 'granted' (on), 'denied', 'default' (the prompt was dismissed),
// 'unsupported' (no push in this browser, no key, or off the admin host),
// 'server_unset' (the API served no key), 'failed' (subscribe threw, or the
// server POST failed and the device was unsubscribed again). Tasks 7 and 8
// map every one of them.
export async function enableAdminPush(publicKey) {
  if (!onAdminHost()) return { ok: false, state: 'unsupported' };
  if (!publicKey) return { ok: false, state: 'server_unset' };
  try {
    return await subscribePush({ swPath: ADMIN_SW_PATH, vapidKey: publicKey, surface: 'admin' });
  } catch (e) {
    return { ok: false, state: 'failed' };
  }
}

// notifyServer: false drops only the browser's subscription (logout; see
// unsubscribePush). The screen's Off switch keeps the default, the server
// DELETE, because the token is present there.
export async function disableAdminPush({ notifyServer = true } = {}) {
  if (!onAdminHost()) return { ok: true };
  try {
    return await unsubscribePush({ swPath: ADMIN_SW_PATH, notifyServer });
  } catch (e) {
    // The device may still hold its subscription. A count only: no endpoint,
    // no error text (the endpoint is a capability URL).
    Sentry.captureMessage('admin push: local unsubscribe failed', { level: 'warning' });
    return { ok: true };
  }
}

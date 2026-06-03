// Web-Push subscription helper for the staff portal (Phase 11, Task 53).
//
// The server already owns the dispatch path (scheduledMessageDispatcher fans
// out to stored subscriptions; pushSender is the per-row VAPID send). This
// module is the BROWSER side: register the SW, obtain a PushSubscription, and
// POST it to /me/push-subscriptions. unsubscribePush() reverses both halves.
//
// Public surface — consumed by Tasks 54 + 56 (Notifications UI):
//   permissionState()  → 'unsupported' | 'granted' | 'denied' | 'default'
//   subscribePush()    → { ok, state }
//   unsubscribePush()  → { ok }
//
// urlBase64ToUint8Array is also exported (named) for unit testing.

import api from './api';

/**
 * Decode a base64url-encoded VAPID public key into a Uint8Array. The browser's
 * PushManager.subscribe() requires the raw 65-byte uncompressed P-256 point
 * (0x04 || x || y), not a string. This is the canonical conversion that
 * every web-push doc recommends.
 *
 * Exported (named) so the unit test can verify the decode end-to-end without
 * touching navigator / PushManager.
 */
export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Quick capability check. 'unsupported' covers desktop Safari < 16, every
 * private/incognito context that strips PushManager, and any UA without the
 * three APIs we actually use. Otherwise we just defer to the spec-mandated
 * Notification.permission so the caller can drive the UI deterministically.
 */
export function permissionState() {
  if (
    typeof navigator === 'undefined' ||
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    return 'unsupported';
  }
  return Notification.permission;
}

/**
 * Register the service worker, prompt for permission if needed, create a
 * PushSubscription, and POST it to the server. Resolves with a status object
 * rather than throwing so the UI can branch on `state` without try/catch
 * gymnastics.
 *
 * Server contract (matches the existing /me/push-subscriptions endpoint):
 *   { endpoint, keys: { p256dh, auth }, user_agent }
 */
export async function subscribePush() {
  if (permissionState() === 'unsupported') {
    return { ok: false, state: 'unsupported' };
  }

  const vapidKey = process.env.REACT_APP_VAPID_PUBLIC_KEY;
  if (!vapidKey) {
    // Treat a missing key as unsupported from the caller's perspective —
    // they cannot do anything useful with an environment that hasn't been
    // configured yet, and we don't want to call subscribe() with `undefined`.
    return { ok: false, state: 'unsupported' };
  }

  // Prompt only when the user hasn't decided yet. 'denied' is terminal until
  // they reset it in browser settings; we must not re-prompt.
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') {
      return { ok: false, state: result === 'denied' ? 'denied' : 'default' };
    }
  } else if (Notification.permission !== 'granted') {
    return { ok: false, state: Notification.permission };
  }

  // Register the SW served at the origin root. `register` is idempotent — a
  // repeat call returns the same registration object — so this is safe to
  // invoke on every subscribePush() without bookkeeping.
  const reg = await navigator.serviceWorker.register('/staff-sw.js');
  await navigator.serviceWorker.ready;

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey),
  });

  // sub.toJSON() yields exactly { endpoint, keys: { p256dh, auth } } — the
  // same shape the server expects, so we just spread it.
  const subJson = sub.toJSON();

  await api.post('/me/push-subscriptions', {
    endpoint: subJson.endpoint,
    keys: subJson.keys,
    user_agent: navigator.userAgent,
  });

  return { ok: true, state: 'granted' };
}

/**
 * Tear down a previous subscription. Null-safe at every step so callers can
 * fire it on logout / preference-flip without first checking whether a
 * subscription exists. Always returns `{ ok: true }`; the server side
 * tolerates missing-row deletes (it's a DELETE-by-endpoint, idempotent).
 */
export async function unsubscribePush() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return { ok: true };
  }

  const reg = await navigator.serviceWorker.getRegistration('/staff-sw.js');
  if (!reg) return { ok: true };

  const sub = await reg.pushManager.getSubscription();
  if (!sub) return { ok: true };

  // Best-effort server cleanup, then drop the local subscription regardless.
  // A failed DELETE (404 already-gone, or a network blip) is non-fatal: the
  // server prunes any dead endpoint on the next 410 from the push service, so
  // we never block the user's unsubscribe on the round-trip.
  try {
    await api.delete('/me/push-subscriptions', { data: { endpoint: sub.endpoint } });
  } catch (e) {
    // Swallow — see above. The unsubscribe below still runs so the browser
    // state matches what the user just asked for.
  }

  await sub.unsubscribe();
  return { ok: true };
}

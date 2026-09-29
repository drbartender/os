import api from './api';

// A read that may be answered from the phone's cache (spec
// 2026-08-13-mobile-admin section 7).
//
// The admin service worker stores a response, and serves the stored copy when
// the network fails or stalls, ONLY for a request that carries this header.
// The header is a promise the caller makes: "I render the staleness line, and
// I do not act on a cache-served copy." A screen that cannot keep that promise
// must use api.get and get the network or an error, never old data dressed as
// new. That is every desktop screen, and every write-adjacent re-read.
//
// The response carries res.staleAt when the service worker served it.
export const OFFLINE_OK_HEADER = 'X-Offline-Ok';

export function offlineGet(url, config = {}) {
  return api.get(url, {
    ...config,
    headers: { ...(config.headers || {}), [OFFLINE_OK_HEADER]: '1' },
  });
}

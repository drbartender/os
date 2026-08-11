import { useEffect, useRef } from 'react';

// Screen Wake Lock, for a phone or tablet propped on the bar showing a tip sign.
//
// The lock is dropped by the browser every time the tab is backgrounded or the
// device locks, and it is NOT restored automatically. Requesting once and
// assuming it holds is the classic bug here: the screen stays awake until the
// first notification pulls focus away, then sleeps for the rest of the shift.
// So it is re-acquired on every visibilitychange.
//
// Unsupported in practice means an iPhone or iPad older than iOS 16.4. The
// caller surfaces that with a line telling the bartender to set auto-lock to
// Never. There is deliberately no muted-video fallback: it burns battery and
// fails quietly, and a quiet failure on a bar top is a dark screen nobody
// notices.
//
// TWO GUARDS, both load-bearing, both added after a review reproduced the
// failure in-browser:
//
//   1. The `release` listener is identity-checked. Without it, an old
//      sentinel's release event nulls the ref while a NEWER lock is live, so
//      the live one is orphaned and cleanup can never release it. Escape out
//      of fullscreen and tap back in and the screen then stays awake forever,
//      which is precisely the failure this hook exists to prevent, inverted.
//
//   2. `acquiringRef` closes the in-flight window. `sentinelRef` is checked
//      before the await but only assigned after it, so a visibilitychange
//      landing mid-request would request a second lock and overwrite the ref.
export function useWakeLock(active) {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  const sentinelRef = useRef(null);
  const acquiringRef = useRef(false);

  useEffect(() => {
    if (!active || !supported) return undefined;
    let cancelled = false;

    const acquire = async () => {
      if (sentinelRef.current || acquiringRef.current) return;
      if (document.visibilityState !== 'visible') return;
      acquiringRef.current = true;
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (cancelled) {
          sentinel.release().catch(() => {});
          return;
        }
        sentinelRef.current = sentinel;
        sentinel.addEventListener('release', () => {
          // Only clear if this is still the lock we hold.
          if (sentinelRef.current !== sentinel) return;
          sentinelRef.current = null;
        });
      } catch {
        // Denied (low battery, policy, backgrounded). Not fatal: the sign still
        // shows, the screen just sleeps on the device's own timer.
      } finally {
        acquiringRef.current = false;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') acquire();
    };

    acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (sentinelRef.current) {
        sentinelRef.current.release().catch(() => {});
        sentinelRef.current = null;
      }
    };
  }, [active, supported]);

  return { supported };
}

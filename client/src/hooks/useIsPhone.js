import { useEffect, useState } from 'react';

// The single mobile breakpoint for the phone-first admin surfaces
// (spec 2026-08-13-mobile-admin, section 3). ONE constant, defined once.
// Never add another width query for the mobile shell.
export const PHONE_BREAKPOINT_PX = 700;
// Exported so the lock model (utils/mobileLock.js) arms on the IDENTICAL
// query the chrome forks on; a second hand-built string would drift.
export const PHONE_MEDIA_QUERY = `(max-width: ${PHONE_BREAKPOINT_PX - 1}px)`;
const QUERY = PHONE_MEDIA_QUERY;

const canQuery = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function';

export default function useIsPhone() {
  const [isPhone, setIsPhone] = useState(() =>
    canQuery() ? window.matchMedia(QUERY).matches : false
  );

  useEffect(() => {
    if (!canQuery()) return undefined;
    const mql = window.matchMedia(QUERY);
    const onChange = (e) => setIsPhone(e.matches);
    // Older engines expose addListener only; the guard costs two lines.
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
    setIsPhone(mql.matches);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, []);

  return isPhone;
}

// useNow (default export). Header generated from the file's exports by migrate-headers on
// 2026-10-27; replace with what it does.

import { useEffect, useState } from 'react';

// The Inbox's clock: Date.now(), refreshed every `everyMs`, so a wait ticks
// from 46 to 47 hrs and the late-hours note appears without a reload.
export default function useNow(everyMs = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

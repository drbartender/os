import { useCallback, useRef, useState } from 'react';

// What a phone detail screen hands the chrome for its rich header (client,
// kind, guests, venue link), held WITH the path it was set for. The chrome
// draws it only while that path is the one on screen, so event 13's header is
// never over event 14, from the very render that changes the route.
//
// It was plain state, reset by a layout effect on every path change. React
// runs a layout effect again when a suspended boundary hides the chrome and
// reveals it, so that reset ran with no route change at all and wiped a header
// the page had no reason to set twice. Nothing here is an effect.
export default function usePhoneHeader(pathname) {
  const [held, setHeld] = useState(null);   // { path, detail }
  const path = useRef(pathname);
  path.current = pathname;
  const setHeaderDetail = useCallback((detail) => {
    setHeld(detail ? { path: path.current, detail } : null);
  }, []);
  const headerDetail = held && held.path === pathname ? held.detail : null;
  return { headerDetail, setHeaderDetail };
}

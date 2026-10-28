// isPhone (the ONE 700px fork, latched per route so a resize never remounts the open page) +
// per-screen Desktop-view overrides (sticky, from the header's escape) and a one-visit override
// (setDesktopForVisit, held in memory, ending when the user backs out of the page and what they
// opened from it; global search opens its desktop pages with it); provided by AdminLayout
// (mobile-admin spec section 3)

import React, {
  createContext, useCallback, useContext, useMemo, useState,
} from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import useIsPhone from '../hooks/useIsPhone';
import { readOverrides, persistOverrides } from '../utils/desktopViewStore';
import { routeScreenKey } from '../utils/screenKey';

// isPhone plus the per-screen Desktop-view overrides (spec section 3): the
// sticky kind the header's escape sets, and the one-visit kind search uses.
// Provided by AdminLayout so every admin page, current and future, can fork.

// One step of a one-visit desktop view (setDesktopForVisit, below). `at` is
// the history entry the visit last saw, `chain` every entry of the visit, and
// `onScreen` the entries showing the visit's own screen, the only ones drawn
// in desktop view. Returns the next visit, or null once it has ended.
function stepVisit(visit, { key, routed, navType }) {
  const onTarget = routed === visit.screenKey;
  // Armed, waiting for its navigation: it lands on its screen or not at all.
  if (!visit.chain.length) {
    return onTarget ? { ...visit, at: key, chain: [key], onScreen: [key] } : null;
  }
  // Back or Forward: inside the visit it lives on; anywhere else it ends.
  if (navType === 'POP') return visit.chain.includes(key) ? { ...visit, at: key } : null;
  // A new entry opened from inside the visit. Its own screen's tabs, filters
  // and drawers stay in it; a page opened from it (an event from the desktop
  // list) joins it, so Back returns to the desktop list. Arriving at the
  // screen afresh from another page of the visit (the tab bar) ends it.
  if (onTarget && !visit.onScreen.includes(visit.at)) return null;
  return {
    ...visit,
    at: key,
    chain: [...visit.chain, key],
    onScreen: onTarget ? [...visit.onScreen, key] : visit.onScreen,
  };
}

const MobileViewContext = createContext({
  isPhone: false,
  desktopView: () => false,
  setDesktopView: () => {},
  setDesktopForVisit: () => {},
});

export function MobileViewProvider({ children }) {
  // Phone or desktop is decided when a page OPENS, not on every resize. The
  // phone chrome and the desktop shell render the page at different places in
  // the tree, so flipping mid-page remounts it and throws away whatever was
  // open: an unsaved edit, a message draft, a dialog. A window dragged across
  // 700px, docked devtools, or a phone browser tab rotated now keeps its page;
  // the new width takes effect on the next route (Dallas, 2026-09-30). Keyed
  // on the pathname only, so a sheet's ?drawer= param never re-forks. The lock
  // model (utils/mobileLock.js) keeps reading the live query on its own.
  const liveIsPhone = useIsPhone();
  const { pathname, key } = useLocation();
  const navType = useNavigationType();
  const [latch, setLatch] = useState(() => ({ pathname, isPhone: liveIsPhone }));
  if (latch.pathname !== pathname) setLatch({ pathname, isPhone: liveIsPhone });
  const isPhone = latch.pathname === pathname ? latch.isPhone : liveIsPhone;
  const [overrides, setOverrides] = useState(readOverrides);
  // A desktop view for ONE visit (lane ma-f3; Dallas, 2026-10-16: "I'd rather
  // it not stick"). Global search opens its desktop pages this way. It lives
  // in memory only, never in the store, and stepVisit decides, entry by
  // entry, whether the user is still in it. The render-time update follows
  // the latch above: React re-renders at once and the second pass is a no-op.
  const [visit, setVisit] = useState(null);
  let liveVisit = visit;
  if (visit && visit.at !== key) {
    liveVisit = stepVisit(visit, { key, routed: routeScreenKey(pathname), navType });
    setVisit(liveVisit);
  }
  const visitKey = liveVisit && liveVisit.onScreen.includes(key) ? liveVisit.screenKey : null;
  // Null never names a screen, so a null key never matches the null visitKey
  // of an entry the visit does not draw, or of no visit at all.
  const desktopView = useCallback(
    (screenKey) => !!overrides[screenKey] || (visitKey !== null && screenKey === visitKey),
    [overrides, visitKey]
  );
  const setDesktopView = useCallback((screenKey, on) => {
    // The Phone view pill calls this with false; it ends a visit too.
    if (!on) setVisit((v) => (v && v.screenKey === screenKey ? null : v));
    // The context owns the merge; the store only persists. Storage failures
    // therefore never drop other screens' overrides from live state.
    setOverrides((prev) => {
      const next = { ...prev };
      if (on) next[screenKey] = true;
      else delete next[screenKey];
      persistOverrides(next);
      return next;
    });
  }, []);
  // Called just before the navigation it is for: the visit waits on this
  // entry and starts on the next one, if that one shows `screenKey`.
  const setDesktopForVisit = useCallback((screenKey) => {
    setVisit({ screenKey, at: key, chain: [], onScreen: [] });
  }, [key]);
  const value = useMemo(
    () => ({ isPhone, desktopView, setDesktopView, setDesktopForVisit }),
    [isPhone, desktopView, setDesktopView, setDesktopForVisit]
  );
  return (
    <MobileViewContext.Provider value={value}>
      {children}
    </MobileViewContext.Provider>
  );
}

export const useMobileView = () => useContext(MobileViewContext);
export default MobileViewContext;

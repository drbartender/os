import React, {
  createContext, useCallback, useContext, useMemo, useState,
} from 'react';
import { useLocation } from 'react-router-dom';
import useIsPhone from '../hooks/useIsPhone';
import { readOverrides, persistOverrides } from '../utils/desktopViewStore';

// isPhone plus the per-screen Desktop-view overrides (spec section 3).
// Provided by AdminLayout so every admin page, current and future, can fork.
const MobileViewContext = createContext({
  isPhone: false,
  desktopView: () => false,
  setDesktopView: () => {},
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
  const { pathname } = useLocation();
  const [latch, setLatch] = useState(() => ({ pathname, isPhone: liveIsPhone }));
  if (latch.pathname !== pathname) setLatch({ pathname, isPhone: liveIsPhone });
  const isPhone = latch.pathname === pathname ? latch.isPhone : liveIsPhone;
  const [overrides, setOverrides] = useState(readOverrides);
  const desktopView = useCallback(
    (screenKey) => !!overrides[screenKey],
    [overrides]
  );
  const setDesktopView = useCallback((screenKey, on) => {
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
  const value = useMemo(
    () => ({ isPhone, desktopView, setDesktopView }),
    [isPhone, desktopView, setDesktopView]
  );
  return (
    <MobileViewContext.Provider value={value}>
      {children}
    </MobileViewContext.Provider>
  );
}

export const useMobileView = () => useContext(MobileViewContext);
export default MobileViewContext;

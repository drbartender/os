import React, {
  createContext, useCallback, useContext, useMemo, useState,
} from 'react';
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
  const isPhone = useIsPhone();
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

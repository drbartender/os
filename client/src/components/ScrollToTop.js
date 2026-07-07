import { useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// Resets scroll to top when the route PATHNAME changes. Yields to hash-anchor
// navigation (e.g. /#services) so PublicLayout's scrollIntoView can win —
// effect order runs children before parents, and this sits at the router root,
// so without the guard it would clobber deeper anchor handlers. Also yields
// to POP (Back/Forward) so the browser's native scroll restoration works:
// returning to a long admin list lands where you left it. Search-only
// changes (filter flips, drawer opens; they navigate with replace) never
// scroll — the pathname ref gate is what suppresses them, since the effect
// re-runs on navigationType transitions even when the pathname is unchanged.
export default function ScrollToTop() {
  const { pathname, hash } = useLocation();
  const navigationType = useNavigationType();
  const prevPathRef = useRef(pathname);
  useEffect(() => {
    const pathChanged = prevPathRef.current !== pathname;
    prevPathRef.current = pathname;
    if (!pathChanged) return;
    if (hash) return;
    if (navigationType === 'POP') return;
    window.scrollTo(0, 0);
  }, [pathname, hash, navigationType]);
  return null;
}

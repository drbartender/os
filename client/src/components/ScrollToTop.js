import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// Resets scroll to top on every route-pathname change. Yields to hash-anchor
// navigation (e.g. /#services) so PublicLayout's scrollIntoView can win —
// effect order runs children before parents, and this sits at the router root,
// so without the guard it would clobber deeper anchor handlers.
export default function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) return;
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

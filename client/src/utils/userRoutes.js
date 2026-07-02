// Applicant-tier routes (/apply, /application-status) are mounted on
// hiring.drbartender.com and the admin app, but NOT on staff.drbartender.com
// (see App.js StaffSiteRoutes). An applicant who lands on staff.* (a bookmark,
// a stale link, a fresh login) would otherwise resolve to the staff catch-all
// '/', which RequirePortal rejects back to getHomePath('/application-status'),
// an infinite Navigate-replace loop that trips Safari's "replaceState more than
// 100x/10s" limiter (Sentry CLIENT-5 / CLIENT-6). Kick them cross-domain to the
// hiring portal where the route exists. A full page load (window.location) is
// required because Vercel cross-subdomain rewrites do not fire on client-side
// React Router navs.
function applicantRoute(path) {
  if (typeof window !== 'undefined' && window.location.hostname === 'staff.drbartender.com') {
    return kickCrossDomain('https://hiring.drbartender.com' + path);
  }
  return path;
}

// Shared by every "you belong on another subdomain" branch. Clears this
// origin's token BEFORE the hard navigate: tokens don't transfer across
// origins, so a token left behind makes THIS origin bounce every future visit
// to the other subdomain until the user hand-clears localStorage (the
// 2026-07-02 poisoned-browser incident — a staff login saved on
// admin.drbartender.com made admin permanently redirect to staff).
function kickCrossDomain(url) {
  try { localStorage.removeItem('token'); } catch (e) { /* storage blocked — still kick */ }
  window.location.replace(url);
  return '/login'; // moot: the full-page redirect above already navigated away
}

/**
 * Canonical "where should this user land" decision tree. Used by:
 *   - App.js — RedirectIfLoggedIn, getHomePath in the main routes file
 *   - PreHireOnboarding.js — fallback when /auth/claim-pre-hire fails so a
 *                            logged-in visitor still ends up somewhere sensible
 *
 * KEEP IN SYNC WITH:
 *   - server/middleware/auth.js (the statuses that survive the 'staff'-only
 *     deactivated/rejected block)
 *   - server/routes/application.js POST handler (sets 'applied' or 'hired')
 *   - App.js RequirePortal allowed list (submitted/reviewed/approved) — the
 *     admin/manager kick below mirrors it to decide who can land on staff.*
 *
 * @param {object} user  AuthContext user — { role, onboarding_status, has_application }
 * @returns {string}     React Router path to navigate to
 */
export function getHomePath(user) {
  if (!user) return '/login';
  // Admins and managers always land on the dashboard
  if (user.role === 'admin' || user.role === 'manager') {
    // An admin-tier user WITHOUT portal status has no landable route on the
    // staff/hiring hosts: /dashboard resolves to a RequirePortal mount that
    // rejects them back here → /dashboard → an infinite <Navigate> loop that
    // renders a blank page (same class as the applicant loop above, but the
    // admin/manager case). Kick them to the admin app. Portal-status admins
    // pass RequirePortal and may legitimately browse the staff portal, so
    // they stay.
    const passesPortal = ['submitted', 'reviewed', 'approved'].includes(user.onboarding_status);
    if (!passesPortal && typeof window !== 'undefined'
        && (window.location.hostname === 'staff.drbartender.com'
            || window.location.hostname === 'hiring.drbartender.com')) {
      return kickCrossDomain('https://admin.drbartender.com/dashboard');
    }
    return '/dashboard';
  }
  switch (user.onboarding_status) {
    case 'applied':
    case 'interviewing':
      return applicantRoute('/application-status');
    // Completed onboarding → portal
    case 'submitted':
    case 'reviewed':
    case 'approved':
      // Portal-status users belong on staff.drbartender.com. If they end up on
      // admin.drbartender.com (rare — bookmark, copy-paste, etc.), kick them
      // cross-domain. Vercel cross-subdomain redirects only fire on full page
      // loads, not client-side React Router navs, so use window.location here.
      if (typeof window !== 'undefined' && window.location.hostname === 'admin.drbartender.com') {
        return kickCrossDomain('https://staff.drbartender.com/dashboard');
      }
      return '/dashboard';
    // Actively going through onboarding. 'hired' is the legacy onboarding status.
    // An admin-Hired applicant from the hiring board reaches onboarding as
    // 'in_progress' WITH an application on file (the Hire button moves
    // interviewing to in_progress). 'in_progress' WITHOUT an application is a
    // pre-hire registrant who still needs to apply, so has_application
    // disambiguates the two.
    case 'hired':
      return '/welcome';
    case 'in_progress':
      return user.has_application ? '/welcome' : applicantRoute('/apply');
    default:
      return user.has_application ? applicantRoute('/application-status') : applicantRoute('/apply');
  }
}

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
    window.location.replace('https://hiring.drbartender.com' + path);
    return '/login'; // moot: the full-page redirect above already navigated away
  }
  return path;
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
 *
 * @param {object} user  AuthContext user — { role, onboarding_status, has_application }
 * @returns {string}     React Router path to navigate to
 */
export function getHomePath(user) {
  if (!user) return '/login';
  // Admins and managers always land on the dashboard
  if (user.role === 'admin' || user.role === 'manager') return '/dashboard';
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
        window.location.replace('https://staff.drbartender.com/dashboard');
        return '/login';
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

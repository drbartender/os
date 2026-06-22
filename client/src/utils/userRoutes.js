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
      return '/application-status';
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
      return user.has_application ? '/welcome' : '/apply';
    default:
      return user.has_application ? '/application-status' : '/apply';
  }
}

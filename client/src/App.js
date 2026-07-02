import React, { Suspense, lazy as lazyBase, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams, useNavigate } from 'react-router-dom';
import api from './utils/api';
import { getHomePath } from './utils/userRoutes';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ClientAuthProvider } from './context/ClientAuthContext';
import { ToastProvider } from './context/ToastContext';
import { UserPrefsProvider } from './context/UserPrefsContext';
import ErrorBoundary from './components/ErrorBoundary';
import ScrollToTop from './components/ScrollToTop';
import SessionExpiryHandler from './components/SessionExpiryHandler';
import Layout from './components/Layout';
// HomePage stays eager — LCP-critical for the marketing site root.
import HomePage from './pages/website/HomePage';

// Wrap React.lazy so a stale code-split chunk after a deploy self-heals. When a
// new deploy replaces the hashed chunk files, a still-open tab requests an old
// chunk hash; the SPA host serves index.html in place of the missing JS, so the
// browser fails to parse it ("Unexpected token '<'") or raises a ChunkLoadError.
// On a chunk-load failure we reload, but never twice in quick succession: the
// attempt time is recorded in sessionStorage so it survives the reload. A second
// failure WITHIN the TTL window is treated as a genuinely broken (non-stale)
// build and falls back to the ErrorBoundary rather than looping. A failure
// OUTSIDE the window (a later, separate deploy mid-session) is allowed to reload
// again — the stale-recorded attempt has expired. Blocked storage also falls
// back to the ErrorBoundary's manual refresh rather than risking a loop.
// The local `lazy` shadows React's so every route definition below stays idiomatic.
// (Sentry DRBARTENDER-CLIENT-4.)
const CHUNK_RELOAD_KEY = 'chunk_reload_attempted_at';
// Loop-prevention window: a repeat chunk failure inside this span is the same
// broken build, so suppress the reload. A failure after it is a fresh stale-chunk
// event and earns a new reload attempt.
const CHUNK_RELOAD_TTL_MS = 10000;
function lazy(factory) {
  return lazyBase(() =>
    factory().catch((err) => {
      let canReload = false;
      try {
        const last = Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY));
        const now = Date.now();
        // Reload unless a prior attempt is recorded and still within the TTL.
        if (!last || now - last > CHUNK_RELOAD_TTL_MS) {
          window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
          canReload = true;
        }
      } catch (_e) {
        canReload = false; // storage unavailable — no durable guard, don't risk a loop
      }
      if (canReload) {
        window.location.reload();
        return new Promise(() => {}); // hold the Suspense fallback until reload lands
      }
      throw err; // reloaded too recently, or no durable guard — let the ErrorBoundary surface it
    })
  );
}

// Secondary public marketing routes — lazy so they don't bloat the initial bundle.
const QuotePage = lazy(() => import('./pages/website/QuotePage'));
const FaqPage = lazy(() => import('./pages/website/FaqPage'));
const ServicesPage = lazy(() => import('./pages/website/ServicesPage'));
const MethodPage = lazy(() => import('./pages/website/MethodPage'));
const AboutPage = lazy(() => import('./pages/website/AboutPage'));
const Blog = lazy(() => import('./pages/public/Blog'));
const BlogPost = lazy(() => import('./pages/public/BlogPost'));
const HiringLanding = lazy(() => import('./pages/HiringLanding'));

// Auth entry points — chunked once, cached after first login.
const Register = lazy(() => import('./pages/Register'));
const PreHireOnboarding = lazy(() => import('./pages/PreHireOnboarding'));
const Login = lazy(() => import('./pages/Login'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const ClientLogin = lazy(() => import('./pages/public/ClientLogin'));

// Application + token-gated client surfaces.
const Application = lazy(() => import('./pages/Application'));
const ApplicationStatus = lazy(() => import('./pages/ApplicationStatus'));
const PotionPlanningLab = lazy(() => import('./pages/plan/PotionPlanningLab'));
const ClientShoppingList = lazy(() => import('./pages/public/ClientShoppingList'));
const PortalHome = lazy(() => import('./pages/public/portal/PortalHome'));

// Lazy-loaded: Lab Rat tester program (kept out of main bundle for non-tester visitors)
const LabRatLanding = lazy(() => import('./pages/labrat/LabRatLanding'));
const LabRatQuiz = lazy(() => import('./pages/labrat/LabRatQuiz'));
const LabRatMissions = lazy(() => import('./pages/labrat/LabRatMissions'));
const LabRatMission = lazy(() => import('./pages/labrat/LabRatMission'));

// Lazy-loaded: public token-gated pages (Stripe SDK stays out of main bundle)
const ProposalView = lazy(() => import('./pages/proposal/proposalView/ProposalView'));
const ProposalCompare = lazy(() => import('./pages/proposal/compare/ProposalCompare'));
const InvoicePage = lazy(() => import('./pages/invoice/InvoicePage'));
const TipPage = lazy(() => import('./pages/public/TipPage'));
const TipPageThanks = lazy(() => import('./pages/public/TipPageThanks'));
const FeedbackPage = lazy(() => import('./pages/public/FeedbackPage'));

// Lazy-loaded: onboarding, staff portal, admin shell — not needed on public marketing site
const Welcome = lazy(() => import('./pages/Welcome'));
const FieldGuide = lazy(() => import('./pages/FieldGuide'));
const Agreement = lazy(() => import('./pages/Agreement'));
const ContractorProfile = lazy(() => import('./pages/ContractorProfile'));
const PaydayProtocols = lazy(() => import('./pages/PaydayProtocols'));
const Completion = lazy(() => import('./pages/Completion'));
// Old StaffLayout + staff page fragments removed at cutover (Task 48/49); their
// files are deleted in Task 50. PrintTipCard stays — the print flow lives on.
const PrintTipCard = lazy(() => import('./pages/staff/PrintTipCard'));
// Staff portal v2 (redesign in flight — early stub mount per Task 31).
// StaffShellWithThemeWiring fetches /api/me/ui-preferences on mount and
// persists toggles via PATCH. The current StaffLayout mount stays in place
// until the Task 48 cutover.
const StaffShellWithThemeWiring = lazy(() => import('./components/StaffShellWithThemeWiring'));
const StaffV2HomePage = lazy(() => import('./pages/staff/HomePage'));
// ShiftsPage owns the `shifts/*` splat — it internally dispatches to
// ShiftDetail when the wildcard's first segment is a numeric shift id
// (see ShiftsPage.js head). One lazy chunk loads ShiftsPage + ShiftDetail
// + DropCoverModal together, which matches the "Shifts" tab's usage pattern.
const StaffV2ShiftsPage = lazy(() => import('./pages/staff/ShiftsPage'));
const StaffV2PayoutDetail = lazy(() => import('./pages/staff/PayoutDetail'));
const StaffV2PayPage = lazy(() => import('./pages/staff/PayPage'));
const StaffV2TipCardPage = lazy(() => import('./pages/staff/TipCardPage'));
const StaffV2AccountPage = lazy(() => import('./pages/staff/account/AccountPage'));
// Email-change verification landing (spec §6.10). UNAUTHENTICATED — the user
// who clicks the link from their inbox may be signed out or signed in as a
// different account, so the route is mounted OUTSIDE every RequirePortal
// block, siblingly with /tip/:token. Token-by-possession is the proof of
// intent; the server pulls user_id from the matched pending row, never
// from any local JWT.
const StaffV2EmailVerifyPage = lazy(() => import('./pages/staff/EmailVerifyPage'));
const AdminLayout = lazy(() => import('./components/AdminLayout'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const AdminStaffDashboard = lazy(() => import('./pages/admin/StaffDashboard'));
const AdminUserDetail = lazy(() => import('./pages/admin/userDetail/AdminUserDetail'));
const AdminApplicationDetail = lazy(() => import('./pages/admin/applicationDetail/AdminApplicationDetail'));
const EventsDashboard = lazy(() => import('./pages/admin/EventsDashboard'));
const EventDetailPage = lazy(() => import('./pages/admin/EventDetailPage'));
const ClientsDashboard = lazy(() => import('./pages/admin/ClientsDashboard'));
const FinancialsDashboard = lazy(() => import('./pages/admin/FinancialsDashboard'));
const PayrollPage = lazy(() => import('./pages/admin/payroll/PayrollPage'));
const HiringDashboard = lazy(() => import('./pages/admin/HiringDashboard'));
const SettingsDashboard = lazy(() => import('./pages/admin/SettingsDashboard'));
const DrinkPlansDashboard = lazy(() => import('./pages/admin/DrinkPlansDashboard'));
const DrinkPlanDetail = lazy(() => import('./pages/admin/DrinkPlanDetail'));
const ProposalsDashboard = lazy(() => import('./pages/admin/ProposalsDashboard'));
const ProposalCreate = lazy(() => import('./pages/admin/ProposalCreate'));
const ProposalDetail = lazy(() => import('./pages/admin/ProposalDetail'));
const ChangeRequestsDashboard = lazy(() => import('./pages/admin/ChangeRequestsDashboard'));
const ClientDetail = lazy(() => import('./pages/admin/ClientDetail'));
const Dashboard = lazy(() => import('./pages/admin/Dashboard'));
const BlogDashboard = lazy(() => import('./pages/admin/BlogDashboard'));
const EmailMarketingDashboard = lazy(() => import('./pages/admin/EmailMarketingDashboard'));
const EmailLeadsDashboard = lazy(() => import('./pages/admin/EmailLeadsDashboard'));
const EmailLeadDetail = lazy(() => import('./pages/admin/EmailLeadDetail'));
const EmailCampaignsDashboard = lazy(() => import('./pages/admin/EmailCampaignsDashboard'));
const EmailCampaignCreate = lazy(() => import('./pages/admin/EmailCampaignCreate'));
const EmailCampaignDetail = lazy(() => import('./pages/admin/EmailCampaignDetail'));
const EmailAnalyticsDashboard = lazy(() => import('./pages/admin/EmailAnalyticsDashboard'));
const EmailConversations = lazy(() => import('./pages/admin/EmailConversations'));
const Messages = lazy(() => import('./pages/admin/Messages'));
const TipsAdmin = lazy(() => import('./pages/admin/TipsAdmin'));
const LabRatBugsPage = lazy(() => import('./pages/admin/LabRatBugsPage'));
const CcImportWrapUpPage = lazy(() => import('./pages/admin/CcImportWrapUpPage'));
const CcImportReviewPage = lazy(() => import('./pages/admin/CcImportReviewPage'));
const ClassWizard = lazy(() => import('./pages/website/ClassWizard'));

const SuspenseFallback = (
  <div
    className="loading"
    style={{ minHeight: '50vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    role="status"
    aria-live="polite"
  >
    <div className="spinner" aria-hidden="true" />
  </div>
);

/**
 * /events/shift/:id → /events/:eventId?drawer=shift&drawerId=:id
 * The legacy ShiftDetail page was retired in favor of ShiftDrawer mounted on
 * EventDetailPage. Old bookmarks and email links land here, look up the
 * shift's parent proposal/event, and forward to the canonical URL with the
 * drawer pre-opened. Falls back to the events list when the shift is gone.
 */
function ShiftDetailRedirect() {
  const { id } = useParams();
  const navigate = useNavigate();
  useEffect(() => {
    let cancelled = false;
    api.get(`/shifts/detail/${id}`)
      .then(r => {
        if (cancelled) return;
        const eventId = r.data?.shift?.proposal_id;
        if (eventId) {
          navigate(`/events/${eventId}?drawer=shift&drawerId=${id}`, { replace: true });
        } else {
          navigate('/events', { replace: true });
        }
      })
      .catch(() => { if (!cancelled) navigate('/events', { replace: true }); });
    return () => { cancelled = true; };
  }, [id, navigate]);
  return (
    <div
      className="loading"
      style={{ minHeight: '50vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      role="status"
      aria-live="polite"
    >
      <div className="spinner" aria-hidden="true" />
    </div>
  );
}

/**
 * /events/:proposalId/beo → /shifts/:shiftId
 * Pre-cutover BEO nudge SMS link to the proposalId-keyed BEO path. Post-cutover
 * the BEO viewer is ShiftDetail (shiftId-keyed), so resolve the signed-in
 * staffer's shift on that proposal and forward. Mounted inside RequirePortal,
 * so `user` is guaranteed. Future nudges link straight to /shifts/:shiftId
 * (see server/utils/beoHandlers.js) — this only catches already-sent links.
 */
function BeoByProposalRedirect() {
  const { proposalId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  useEffect(() => {
    let cancelled = false;
    const pid = parseInt(proposalId, 10);
    if (!user?.id || !Number.isFinite(pid)) {
      navigate('/shifts/mine', { replace: true });
      return undefined;
    }
    api.get(`/shifts/user/${user.id}/events`)
      .then(r => {
        if (cancelled) return;
        const rows = [...(r.data?.upcoming || []), ...(r.data?.past || [])];
        const match = rows.find(row => row.proposal_id === pid);
        navigate(match ? `/shifts/${match.id}` : '/shifts/mine', { replace: true });
      })
      .catch(() => { if (!cancelled) navigate('/shifts/mine', { replace: true }); });
    return () => { cancelled = true; };
  }, [proposalId, user?.id, navigate]);
  return (
    <div
      className="loading"
      style={{ minHeight: '50vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      role="status"
      aria-live="polite"
    >
      <div className="spinner" aria-hidden="true" />
    </div>
  );
}

/**
 * Detect which domain context we're on:
 * - 'public'  → drbartender.com / www.drbartender.com (marketing site)
 * - 'hiring'  → hiring.drbartender.com (applicant portal)
 * - 'staff'   → staff.drbartender.com (staff portal)
 * - 'app'     → admin.drbartender.com / localhost (full admin/staff app)
 */
function getSiteContext() {
  const host = window.location.hostname;
  if (host.startsWith('hiring.')) return 'hiring';
  if (host.startsWith('staff.')) return 'staff';
  if (host.startsWith('admin.')) return 'app';
  if (host === 'localhost' || host === '127.0.0.1') return 'app';
  return 'public';
}

// getHomePath is now imported from ./utils/userRoutes — see import above.

/** Requires auth. adminOnly also allows managers (they share the dashboard);
 *  adminStrict is admin-only (rejects managers) for admin-exclusive surfaces. */
function ProtectedRoute({ children, adminOnly = false, adminStrict = false }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading" role="status" aria-live="polite"><div className="spinner" aria-hidden="true" />Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (adminStrict && user.role !== 'admin') {
    return <Navigate to={getHomePath(user)} replace />;
  }
  if (adminOnly && user.role !== 'admin' && user.role !== 'manager') {
    return <Navigate to={getHomePath(user)} replace />;
  }
  return children;
}

function RedirectIfLoggedIn({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading" role="status" aria-live="polite"><div className="spinner" aria-hidden="true" />Loading...</div>;
  if (user) return <Navigate to={getHomePath(user)} replace />;
  return children;
}

/** Onboarding flow — accessible for hired staff still working through steps */
function RequireHired({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading" role="status" aria-live="polite"><div className="spinner" aria-hidden="true" />Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  const allowed = ['hired', 'in_progress', 'submitted', 'reviewed', 'approved'];
  if (!allowed.includes(user.onboarding_status)) {
    return <Navigate to={getHomePath(user)} replace />;
  }
  return children;
}

/** Requires completed onboarding (submitted / reviewed / approved) */
function RequirePortal({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading" role="status" aria-live="polite"><div className="spinner" aria-hidden="true" />Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  const allowed = ['submitted', 'reviewed', 'approved'];
  if (!allowed.includes(user.onboarding_status)) {
    return <Navigate to={getHomePath(user)} replace />;
  }
  return children;
}

function PublicWebsiteRoutes() {
  return (
    <Suspense fallback={SuspenseFallback}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/services" element={<ServicesPage />} />
        <Route path="/method" element={<MethodPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/quote" element={<QuotePage />} />
        <Route path="/faq" element={<FaqPage />} />
        <Route path="/classes" element={<ClassWizard />} />
        {/* These public token-based routes work on both domains */}
        <Route path="/plan/:token" element={<PotionPlanningLab />} />
        <Route path="/proposal/:token" element={<ProposalView />} />
        <Route path="/compare/:token" element={<ProposalCompare />} />
        <Route path="/invoice/:token" element={<InvoicePage />} />
        <Route path="/shopping-list/:token" element={<ClientShoppingList />} />
        <Route path="/tip/:token" element={<TipPage />} />
        <Route path="/tip/:token/thanks" element={<TipPageThanks />} />
        <Route path="/feedback/:token" element={<FeedbackPage />} />
        <Route path="/verify-email/:token" element={<StaffV2EmailVerifyPage />} />
        <Route path="/labnotes" element={<Blog />} />
        <Route path="/labnotes/:slug" element={<BlogPost />} />
        <Route path="/login" element={<ClientLogin />} />
        <Route path="/my-proposals" element={<PortalHome />} />
        <Route path="/my-proposals/archive" element={<PortalHome />} />
        <Route path="/my-proposals/:token/:tab" element={<PortalHome />} />
        {/* Lab Rat tester program */}
        <Route path="/labrat" element={<LabRatLanding />} />
        <Route path="/labrat/quiz" element={<LabRatQuiz />} />
        <Route path="/labrat/missions" element={<LabRatMissions />} />
        <Route path="/labrat/m/:id" element={<LabRatMission />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

/** hiring.drbartender.com — applicant intake + post-hire onboarding/portal (mirrors staff.drbartender.com once logged in) */
function HiringRoutes() {
  return (
    <Suspense fallback={SuspenseFallback}>
      <Routes>
        <Route path="/" element={<RedirectIfLoggedIn><HiringLanding /></RedirectIfLoggedIn>} />
        <Route path="/register" element={<RedirectIfLoggedIn><Register /></RedirectIfLoggedIn>} />
        {/* /onboarding intentionally has NO RedirectIfLoggedIn — already-logged-in users
            visiting the URL should still get flagged as pre_hired via claim-pre-hire,
            not silently bounced. The page handles both cases internally. */}
        <Route path="/onboarding" element={<PreHireOnboarding />} />
        <Route path="/login" element={<RedirectIfLoggedIn><Login /></RedirectIfLoggedIn>} />
        <Route path="/forgot-password" element={<RedirectIfLoggedIn><ForgotPassword /></RedirectIfLoggedIn>} />
        <Route path="/reset-password/:token" element={<RedirectIfLoggedIn><ResetPassword /></RedirectIfLoggedIn>} />
        <Route path="/apply" element={<ProtectedRoute><Application /></ProtectedRoute>} />
        <Route path="/application-status" element={<ProtectedRoute><ApplicationStatus /></ProtectedRoute>} />
        {/* Onboarding flow — hired contractors complete paperwork here without jumping to staff subdomain */}
        <Route element={<RequireHired><Layout /></RequireHired>}>
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/field-guide" element={<FieldGuide />} />
          <Route path="/agreement" element={<Agreement />} />
          <Route path="/contractor-profile" element={<ContractorProfile />} />
          <Route path="/payday-protocols" element={<PaydayProtocols />} />
          <Route path="/complete" element={<Completion />} />
        </Route>
        {/* Staff portal v2 — production mount on hiring.drbartender.com too, so
            fully-onboarded users who bookmarked hiring.drb.com reach the portal.
            `/` stays the applicant HiringLanding; the portal home is /dashboard
            (getHomePath sends portal users to /dashboard → HomePage here). */}
        <Route element={<RequirePortal><StaffShellWithThemeWiring /></RequirePortal>}>
          <Route path="/dashboard" element={<StaffV2HomePage />} />
          <Route path="/shifts/*" element={<StaffV2ShiftsPage />} />
          <Route path="/pay/:periodId" element={<StaffV2PayoutDetail />} />
          <Route path="/pay" element={<StaffV2PayPage />} />
          <Route path="/tip-card" element={<StaffV2TipCardPage />} />
          <Route path="/account" element={<StaffV2AccountPage />} />
          <Route path="/account/:section" element={<StaffV2AccountPage />} />
          <Route path="/events/:proposalId/beo" element={<BeoByProposalRedirect />} />
        </Route>
        {/* Print tip card — standalone (no shell chrome), shared with the public flow. */}
        <Route path="/my-tip-page/print" element={<PrintTipCard />} />
        {/* Old-path redirects — /dashboard is the portal home here, not redirected. */}
        <Route path="/events" element={<Navigate to="/shifts/mine" replace />} />
        <Route path="/schedule" element={<Navigate to="/shifts/mine" replace />} />
        <Route path="/profile" element={<Navigate to="/account/profile" replace />} />
        <Route path="/resources" element={<Navigate to="/account/documents" replace />} />
        <Route path="/my-tip-page" element={<Navigate to="/tip-card" replace />} />
        {/* Public token routes still work */}
        <Route path="/plan/:token" element={<PotionPlanningLab />} />
        <Route path="/proposal/:token" element={<ProposalView />} />
        <Route path="/compare/:token" element={<ProposalCompare />} />
        <Route path="/invoice/:token" element={<InvoicePage />} />
        <Route path="/shopping-list/:token" element={<ClientShoppingList />} />
        <Route path="/tip/:token" element={<TipPage />} />
        <Route path="/tip/:token/thanks" element={<TipPageThanks />} />
        <Route path="/feedback/:token" element={<FeedbackPage />} />
        <Route path="/verify-email/:token" element={<StaffV2EmailVerifyPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

/** staff.drbartender.com — staff portal + onboarding routes only */
function StaffSiteRoutes() {
  return (
    <Suspense fallback={SuspenseFallback}>
      <Routes>
        {/* `/` is the staff HomePage (in the RequirePortal mount below); logged-out
            visitors are bounced to /login by RequirePortal. */}
        <Route path="/login" element={<RedirectIfLoggedIn><Login /></RedirectIfLoggedIn>} />
        <Route path="/forgot-password" element={<RedirectIfLoggedIn><ForgotPassword /></RedirectIfLoggedIn>} />
        <Route path="/reset-password/:token" element={<RedirectIfLoggedIn><ResetPassword /></RedirectIfLoggedIn>} />
        {/* Onboarding flow */}
        <Route element={<RequireHired><Layout /></RequireHired>}>
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/field-guide" element={<FieldGuide />} />
          <Route path="/agreement" element={<Agreement />} />
          <Route path="/contractor-profile" element={<ContractorProfile />} />
          <Route path="/payday-protocols" element={<PaydayProtocols />} />
          <Route path="/complete" element={<Completion />} />
        </Route>
        {/* Staff portal v2 — PRODUCTION mount (cutover). Mounted at root on
            staff.drbartender.com. `/` renders HomePage; RequirePortal bounces
            logged-out users to /login, so there is no `/`→getHomePath loop. */}
        <Route element={<RequirePortal><StaffShellWithThemeWiring /></RequirePortal>}>
          <Route path="/" element={<StaffV2HomePage />} />
          <Route path="/shifts/*" element={<StaffV2ShiftsPage />} />
          <Route path="/pay/:periodId" element={<StaffV2PayoutDetail />} />
          <Route path="/pay" element={<StaffV2PayPage />} />
          <Route path="/tip-card" element={<StaffV2TipCardPage />} />
          <Route path="/account" element={<StaffV2AccountPage />} />
          <Route path="/account/:section" element={<StaffV2AccountPage />} />
          {/* Pre-cutover BEO nudge links (/events/:proposalId/beo) resolve here. */}
          <Route path="/events/:proposalId/beo" element={<BeoByProposalRedirect />} />
        </Route>
        {/* Print tip card — standalone (no shell chrome), shared with the public flow. */}
        <Route path="/my-tip-page/print" element={<PrintTipCard />} />
        {/* Old-path redirects — 30-day grace for bookmarks + in-flight links. */}
        <Route path="/dashboard" element={<Navigate to="/" replace />} />
        <Route path="/events" element={<Navigate to="/shifts/mine" replace />} />
        <Route path="/schedule" element={<Navigate to="/shifts/mine" replace />} />
        <Route path="/profile" element={<Navigate to="/account/profile" replace />} />
        <Route path="/resources" element={<Navigate to="/account/documents" replace />} />
        <Route path="/my-tip-page" element={<Navigate to="/tip-card" replace />} />
        {/* Public token routes */}
        <Route path="/plan/:token" element={<PotionPlanningLab />} />
        <Route path="/proposal/:token" element={<ProposalView />} />
        <Route path="/compare/:token" element={<ProposalCompare />} />
        <Route path="/invoice/:token" element={<InvoicePage />} />
        <Route path="/shopping-list/:token" element={<ClientShoppingList />} />
        <Route path="/tip/:token" element={<TipPage />} />
        <Route path="/tip/:token/thanks" element={<TipPageThanks />} />
        <Route path="/feedback/:token" element={<FeedbackPage />} />
        <Route path="/verify-email/:token" element={<StaffV2EmailVerifyPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

function AppRoutes() {
  const context = getSiteContext();

  // Lab Rat lives on the public domain, but we want it reachable on localhost too
  // (no subdomain in dev). Route by path before context dispatch.
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/labrat')) {
    return <PublicWebsiteRoutes />;
  }

  if (context === 'public') return <PublicWebsiteRoutes />;
  if (context === 'hiring') return <HiringRoutes />;
  if (context === 'staff') return <StaffSiteRoutes />;

  return (
    <Suspense fallback={SuspenseFallback}>
    <Routes>
      <Route path="/" element={<Navigate to="/register" replace />} />
      {/* Public pages (no auth) */}
      <Route path="/plan/:token" element={<PotionPlanningLab />} />
      <Route path="/proposal/:token" element={<ProposalView />} />
      <Route path="/compare/:token" element={<ProposalCompare />} />
      <Route path="/invoice/:token" element={<InvoicePage />} />
      <Route path="/shopping-list/:token" element={<ClientShoppingList />} />
      <Route path="/tip/:token" element={<TipPage />} />
      <Route path="/tip/:token/thanks" element={<TipPageThanks />} />
      <Route path="/feedback/:token" element={<FeedbackPage />} />
      <Route path="/verify-email/:token" element={<StaffV2EmailVerifyPage />} />
      {/* Website accessible on admin domain for preview */}
      <Route path="/website" element={<HomePage />} />
      <Route path="/services" element={<ServicesPage />} />
      <Route path="/method" element={<MethodPage />} />
      <Route path="/about" element={<AboutPage />} />
      <Route path="/quote" element={<QuotePage />} />
      <Route path="/faq" element={<FaqPage />} />
      <Route path="/classes" element={<ClassWizard />} />
      <Route path="/labnotes" element={<Blog />} />
      <Route path="/labnotes/:slug" element={<BlogPost />} />
      {/* Client portal */}
      <Route path="/client-login" element={<ClientLogin />} />
      <Route path="/my-proposals" element={<PortalHome />} />
      <Route path="/my-proposals/archive" element={<PortalHome />} />
      <Route path="/my-proposals/:token/:tab" element={<PortalHome />} />

      <Route path="/register" element={<RedirectIfLoggedIn><Register /></RedirectIfLoggedIn>} />
      {/* /onboarding intentionally has NO RedirectIfLoggedIn — the page handles
          logged-in users internally via claim-pre-hire so the URL works for both
          fresh recruits and returning ones. Mirrors the same route in HiringRoutes. */}
      <Route path="/onboarding" element={<PreHireOnboarding />} />
      <Route path="/login" element={<RedirectIfLoggedIn><Login /></RedirectIfLoggedIn>} />
      <Route path="/forgot-password" element={<RedirectIfLoggedIn><ForgotPassword /></RedirectIfLoggedIn>} />
      <Route path="/reset-password/:token" element={<RedirectIfLoggedIn><ResetPassword /></RedirectIfLoggedIn>} />

      {/* Application flow (logged in, not yet hired) */}
      <Route path="/apply" element={<ProtectedRoute><Application /></ProtectedRoute>} />
      <Route path="/application-status" element={<ProtectedRoute><ApplicationStatus /></ProtectedRoute>} />

      {/* Onboarding flow (must be hired or further along) */}
      <Route element={<RequireHired><Layout /></RequireHired>}>
        <Route path="/welcome" element={<Welcome />} />
        <Route path="/field-guide" element={<FieldGuide />} />
        <Route path="/agreement" element={<Agreement />} />
        <Route path="/contractor-profile" element={<ContractorProfile />} />
        <Route path="/payday-protocols" element={<PaydayProtocols />} />
        <Route path="/complete" element={<Completion />} />
      </Route>

      {/* Admin + Manager shell — mounted at root on admin.drbartender.com */}
      <Route element={<ProtectedRoute adminOnly><AdminLayout /></ProtectedRoute>}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/staffing" element={<AdminStaffDashboard />} />
        <Route path="/staffing/legacy" element={<AdminDashboard />} />
        <Route path="/staffing/users/:id" element={<AdminUserDetail />} />
        <Route path="/staffing/applications/:id" element={<AdminApplicationDetail />} />
        <Route path="/hiring" element={<HiringDashboard />} />
        <Route path="/drink-plans" element={<DrinkPlansDashboard />} />
        <Route path="/drink-plans/:id" element={<DrinkPlanDetail />} />
        <Route path="/cocktail-menu" element={<Navigate to="/settings" replace />} />
        <Route path="/drink-menu" element={<Navigate to="/settings" replace />} />
        <Route path="/proposals" element={<ProposalsDashboard />} />
        <Route path="/proposals/new" element={<ProposalCreate />} />
        <Route path="/proposals/:id" element={<ProposalDetail />} />
        <Route path="/change-requests" element={<ChangeRequestsDashboard />} />
        <Route path="/events" element={<EventsDashboard />} />
        <Route path="/events/:id" element={<EventDetailPage />} />
        <Route path="/events/shift/:id" element={<ShiftDetailRedirect />} />
        <Route path="/clients" element={<ClientsDashboard />} />
        <Route path="/clients/:id" element={<ClientDetail />} />
        <Route path="/messages" element={<Messages />} />
        <Route path="/financials" element={<FinancialsDashboard />} />
        <Route path="/financials/payroll" element={<PayrollPage />} />
        <Route path="/tips" element={<TipsAdmin />} />
        <Route path="/settings" element={<SettingsDashboard />} />
        <Route path="/blog" element={<BlogDashboard />} />
        <Route path="/labrat-bugs" element={<LabRatBugsPage />} />
        {/* CC-Import admin pages: path retained with `/admin` prefix per plan.
            The whole CC-import surface is admin-only on the server (audit batch
            3c-roles), so wrap each in `adminStrict` — a manager (admitted by the
            parent adminOnly shell) is redirected home instead of rendering a page
            whose every API call 403s. */}
        <Route path="/admin/cc-import/wrap-up" element={<ProtectedRoute adminStrict><CcImportWrapUpPage /></ProtectedRoute>} />
        <Route path="/admin/cc-import/review" element={<ProtectedRoute adminStrict><CcImportReviewPage /></ProtectedRoute>} />
        <Route path="/email-marketing" element={<EmailMarketingDashboard />}>
          <Route index element={<EmailLeadsDashboard />} />
          <Route path="leads" element={<EmailLeadsDashboard />} />
          <Route path="leads/:id" element={<EmailLeadDetail />} />
          <Route path="campaigns" element={<EmailCampaignsDashboard />} />
          <Route path="campaigns/new" element={<EmailCampaignCreate />} />
          <Route path="campaigns/:id" element={<EmailCampaignDetail />} />
          <Route path="analytics" element={<EmailAnalyticsDashboard />} />
          <Route path="conversations" element={<EmailConversations />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <AuthProvider>
          <UserPrefsProvider>
            <ClientAuthProvider>
              <BrowserRouter>
                <ScrollToTop />
                <SessionExpiryHandler />
                <AppRoutes />
              </BrowserRouter>
            </ClientAuthProvider>
          </UserPrefsProvider>
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}

import React, { Suspense, lazy, useEffect } from 'react';
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
const ClientDashboard = lazy(() => import('./pages/public/ClientDashboard'));

// Lazy-loaded: Lab Rat tester program (kept out of main bundle for non-tester visitors)
const LabRatLanding = lazy(() => import('./pages/labrat/LabRatLanding'));
const LabRatQuiz = lazy(() => import('./pages/labrat/LabRatQuiz'));
const LabRatMissions = lazy(() => import('./pages/labrat/LabRatMissions'));
const LabRatMission = lazy(() => import('./pages/labrat/LabRatMission'));

// Lazy-loaded: public token-gated pages (Stripe SDK stays out of main bundle)
const ProposalView = lazy(() => import('./pages/proposal/proposalView/ProposalView'));
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
const StaffLayout = lazy(() => import('./components/StaffLayout'));
const StaffDashboard = lazy(() => import('./pages/staff/StaffDashboard'));
const StaffShifts = lazy(() => import('./pages/staff/StaffShifts'));
const StaffSchedule = lazy(() => import('./pages/staff/StaffSchedule'));
const StaffEvents = lazy(() => import('./pages/staff/StaffEvents'));
const StaffResources = lazy(() => import('./pages/staff/StaffResources'));
const StaffProfile = lazy(() => import('./pages/staff/StaffProfile'));
const MyTipPage = lazy(() => import('./pages/staff/MyTipPage'));
const PrintTipCard = lazy(() => import('./pages/staff/PrintTipCard'));
// Staff portal v2 (redesign in flight — early stub mount per Task 31).
// StaffShellWithThemeWiring fetches /api/me/ui-preferences on mount and
// persists toggles via PATCH. The current StaffLayout mount stays in place
// until the Task 48 cutover.
const StaffShellWithThemeWiring = lazy(() => import('./components/StaffShellWithThemeWiring'));
const StaffPlaceholder = lazy(() => import('./components/staff/Placeholder'));
const StaffV2HomePage = lazy(() => import('./pages/staff/HomePage'));
// ShiftsPage owns the `shifts/*` splat — it internally dispatches to
// ShiftDetail when the wildcard's first segment is a numeric shift id
// (see ShiftsPage.js head). One lazy chunk loads ShiftsPage + ShiftDetail
// + DropCoverModal together, which matches the "Shifts" tab's usage pattern.
const StaffV2ShiftsPage = lazy(() => import('./pages/staff/ShiftsPage'));
const StaffV2PayoutDetail = lazy(() => import('./pages/staff/PayoutDetail'));
const StaffV2PayPage = lazy(() => import('./pages/staff/PayPage'));
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

/** Requires auth. adminOnly also allows managers (they share the dashboard). */
function ProtectedRoute({ children, adminOnly = false }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading" role="status" aria-live="polite"><div className="spinner" aria-hidden="true" />Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
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
        <Route path="/invoice/:token" element={<InvoicePage />} />
        <Route path="/shopping-list/:token" element={<ClientShoppingList />} />
        <Route path="/tip/:token" element={<TipPage />} />
        <Route path="/tip/:token/thanks" element={<TipPageThanks />} />
        <Route path="/feedback/:token" element={<FeedbackPage />} />
        <Route path="/labnotes" element={<Blog />} />
        <Route path="/labnotes/:slug" element={<BlogPost />} />
        <Route path="/login" element={<ClientLogin />} />
        <Route path="/my-proposals" element={<ClientDashboard />} />
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
        {/* Staff portal — kept here so fully-onboarded users who bookmarked hiring.drb.com don't hit a blank page */}
        <Route element={<RequirePortal><StaffLayout /></RequirePortal>}>
          <Route path="/dashboard" element={<StaffDashboard />} />
          <Route path="/shifts" element={<StaffShifts />} />
          <Route path="/schedule" element={<StaffSchedule />} />
          <Route path="/events" element={<StaffEvents />} />
          <Route path="/resources" element={<StaffResources />} />
          <Route path="/profile" element={<StaffProfile />} />
          <Route path="/my-tip-page" element={<MyTipPage />} />
          <Route path="/my-tip-page/print" element={<PrintTipCard />} />
        </Route>
        {/* Public token routes still work */}
        <Route path="/plan/:token" element={<PotionPlanningLab />} />
        <Route path="/proposal/:token" element={<ProposalView />} />
        <Route path="/invoice/:token" element={<InvoicePage />} />
        <Route path="/shopping-list/:token" element={<ClientShoppingList />} />
        <Route path="/tip/:token" element={<TipPage />} />
        <Route path="/tip/:token/thanks" element={<TipPageThanks />} />
        <Route path="/feedback/:token" element={<FeedbackPage />} />
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
        <Route path="/" element={<RedirectIfLoggedIn><Login /></RedirectIfLoggedIn>} />
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
        {/* Staff portal — mounted at root on staff.drbartender.com */}
        <Route element={<RequirePortal><StaffLayout /></RequirePortal>}>
          <Route path="/dashboard" element={<StaffDashboard />} />
          <Route path="/shifts" element={<StaffShifts />} />
          <Route path="/schedule" element={<StaffSchedule />} />
          <Route path="/events" element={<StaffEvents />} />
          <Route path="/resources" element={<StaffResources />} />
          <Route path="/profile" element={<StaffProfile />} />
          <Route path="/my-tip-page" element={<MyTipPage />} />
          <Route path="/my-tip-page/print" element={<PrintTipCard />} />
        </Route>
        {/* Staff portal v2 — early stub mount for in-flight redesign (Task 31).
            Runs in parallel with the existing StaffLayout mount until Task 48
            cuts over. Each Placeholder route swaps to a real page one at a
            time as Tasks 32-47 land. */}
        <Route path="/staff-v2/*" element={<RequirePortal><StaffShellWithThemeWiring /></RequirePortal>}>
          <Route index element={<StaffV2HomePage />} />
          <Route path="shifts/*" element={<StaffV2ShiftsPage />} />
          <Route path="pay/:periodId" element={<StaffV2PayoutDetail />} />
          <Route path="pay" element={<StaffV2PayPage />} />
          <Route path="tip-card" element={<StaffPlaceholder name="Tip Card" />} />
          <Route path="account/:section" element={<StaffPlaceholder name="Account" />} />
        </Route>
        {/* Public token routes */}
        <Route path="/plan/:token" element={<PotionPlanningLab />} />
        <Route path="/proposal/:token" element={<ProposalView />} />
        <Route path="/invoice/:token" element={<InvoicePage />} />
        <Route path="/shopping-list/:token" element={<ClientShoppingList />} />
        <Route path="/tip/:token" element={<TipPage />} />
        <Route path="/tip/:token/thanks" element={<TipPageThanks />} />
        <Route path="/feedback/:token" element={<FeedbackPage />} />
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
      <Route path="/invoice/:token" element={<InvoicePage />} />
      <Route path="/shopping-list/:token" element={<ClientShoppingList />} />
      <Route path="/tip/:token" element={<TipPage />} />
      <Route path="/tip/:token/thanks" element={<TipPageThanks />} />
      <Route path="/feedback/:token" element={<FeedbackPage />} />
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
      <Route path="/my-proposals" element={<ClientDashboard />} />

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
        {/* CC-Import admin pages: path retained with `/admin` prefix per plan;
            ProtectedRoute adminOnly is inherited from the parent <Route>. */}
        <Route path="/admin/cc-import/wrap-up" element={<CcImportWrapUpPage />} />
        <Route path="/admin/cc-import/review" element={<CcImportReviewPage />} />
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

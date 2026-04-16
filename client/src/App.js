import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import ErrorBoundary from './components/ErrorBoundary';
import Layout from './components/Layout';
import HomePage from './pages/website/HomePage';
import QuotePage from './pages/website/QuotePage';
import FaqPage from './pages/website/FaqPage';
import Register from './pages/Register';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Application from './pages/Application';
import ApplicationStatus from './pages/ApplicationStatus';
import PotionPlanningLab from './pages/plan/PotionPlanningLab';
import ClientShoppingList from './pages/public/ClientShoppingList';
import Blog from './pages/public/Blog';
import BlogPost from './pages/public/BlogPost';
import ClientLogin from './pages/public/ClientLogin';
import ClientDashboard from './pages/public/ClientDashboard';
import HiringLanding from './pages/HiringLanding';
import { ClientAuthProvider } from './context/ClientAuthContext';

// Lazy-loaded: public token-gated pages (Stripe SDK stays out of main bundle)
const ProposalView = lazy(() => import('./pages/proposal/ProposalView'));
const InvoicePage = lazy(() => import('./pages/invoice/InvoicePage'));

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
const AdminLayout = lazy(() => import('./components/AdminLayout'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const AdminUserDetail = lazy(() => import('./pages/AdminUserDetail'));
const AdminApplicationDetail = lazy(() => import('./pages/AdminApplicationDetail'));
const EventsDashboard = lazy(() => import('./pages/admin/EventsDashboard'));
const ShiftDetail = lazy(() => import('./pages/admin/ShiftDetail'));
const ClientsDashboard = lazy(() => import('./pages/admin/ClientsDashboard'));
const FinancialsDashboard = lazy(() => import('./pages/admin/FinancialsDashboard'));
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

/** Determine where a logged-in user should go based on their role and status */
function getHomePath(user) {
  if (!user) return '/login';
  // Admins and managers always land on the dashboard
  if (user.role === 'admin' || user.role === 'manager') return '/admin';
  switch (user.onboarding_status) {
    case 'applied':
    case 'interviewing':
      return '/application-status';
    // Completed onboarding → portal
    case 'submitted':
    case 'reviewed':
    case 'approved':
      return '/portal';
    // Actively going through onboarding
    case 'hired':
      return '/welcome';
    case 'in_progress':
    default:
      return user.has_application ? '/application-status' : '/apply';
  }
}

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
    <ClientAuthProvider>
      <Suspense fallback={SuspenseFallback}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/quote" element={<QuotePage />} />
          <Route path="/faq" element={<FaqPage />} />
          <Route path="/classes" element={<ClassWizard />} />
          {/* These public token-based routes work on both domains */}
          <Route path="/plan/:token" element={<PotionPlanningLab />} />
          <Route path="/proposal/:token" element={<ProposalView />} />
          <Route path="/invoice/:token" element={<InvoicePage />} />
          <Route path="/shopping-list/:token" element={<ClientShoppingList />} />
          <Route path="/labnotes" element={<Blog />} />
          <Route path="/labnotes/:slug" element={<BlogPost />} />
          <Route path="/login" element={<ClientLogin />} />
          <Route path="/my-proposals" element={<ClientDashboard />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ClientAuthProvider>
  );
}

/** hiring.drbartender.com — applicant-focused routes only */
function HiringRoutes() {
  return (
    <Suspense fallback={SuspenseFallback}>
      <Routes>
        <Route path="/" element={<RedirectIfLoggedIn><HiringLanding /></RedirectIfLoggedIn>} />
        <Route path="/register" element={<RedirectIfLoggedIn><Register /></RedirectIfLoggedIn>} />
        <Route path="/login" element={<RedirectIfLoggedIn><Login /></RedirectIfLoggedIn>} />
        <Route path="/forgot-password" element={<RedirectIfLoggedIn><ForgotPassword /></RedirectIfLoggedIn>} />
        <Route path="/reset-password/:token" element={<RedirectIfLoggedIn><ResetPassword /></RedirectIfLoggedIn>} />
        <Route path="/apply" element={<ProtectedRoute><Application /></ProtectedRoute>} />
        <Route path="/application-status" element={<ProtectedRoute><ApplicationStatus /></ProtectedRoute>} />
        {/* Public token routes still work */}
        <Route path="/plan/:token" element={<PotionPlanningLab />} />
        <Route path="/proposal/:token" element={<ProposalView />} />
        <Route path="/invoice/:token" element={<InvoicePage />} />
        <Route path="/shopping-list/:token" element={<ClientShoppingList />} />
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
        {/* Staff portal */}
        <Route path="/portal" element={<RequirePortal><StaffLayout /></RequirePortal>}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<StaffDashboard />} />
          <Route path="shifts" element={<StaffShifts />} />
          <Route path="schedule" element={<StaffSchedule />} />
          <Route path="events" element={<StaffEvents />} />
          <Route path="resources" element={<StaffResources />} />
          <Route path="profile" element={<StaffProfile />} />
        </Route>
        {/* Public token routes */}
        <Route path="/plan/:token" element={<PotionPlanningLab />} />
        <Route path="/proposal/:token" element={<ProposalView />} />
        <Route path="/invoice/:token" element={<InvoicePage />} />
        <Route path="/shopping-list/:token" element={<ClientShoppingList />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

function AppRoutes() {
  const context = getSiteContext();

  if (context === 'public') return <PublicWebsiteRoutes />;
  if (context === 'hiring') return <HiringRoutes />;
  if (context === 'staff') return <StaffSiteRoutes />;

  return (
    <ClientAuthProvider>
    <Suspense fallback={SuspenseFallback}>
    <Routes>
      <Route path="/" element={<Navigate to="/register" replace />} />
      {/* Public pages (no auth) */}
      <Route path="/plan/:token" element={<PotionPlanningLab />} />
      <Route path="/proposal/:token" element={<ProposalView />} />
      <Route path="/invoice/:token" element={<InvoicePage />} />
      <Route path="/shopping-list/:token" element={<ClientShoppingList />} />
      {/* Website accessible on admin domain for preview */}
      <Route path="/website" element={<HomePage />} />
      <Route path="/quote" element={<QuotePage />} />
      <Route path="/faq" element={<FaqPage />} />
      <Route path="/classes" element={<ClassWizard />} />
      <Route path="/labnotes" element={<Blog />} />
      <Route path="/labnotes/:slug" element={<BlogPost />} />
      {/* Client portal */}
      <Route path="/client-login" element={<ClientLogin />} />
      <Route path="/my-proposals" element={<ClientDashboard />} />

      <Route path="/register" element={<RedirectIfLoggedIn><Register /></RedirectIfLoggedIn>} />
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

      {/* Portal (onboarding completed) — sidebar layout with child routes */}
      <Route path="/portal" element={<RequirePortal><StaffLayout /></RequirePortal>}>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<StaffDashboard />} />
        <Route path="shifts" element={<StaffShifts />} />
        <Route path="schedule" element={<StaffSchedule />} />
        <Route path="events" element={<StaffEvents />} />
        <Route path="resources" element={<StaffResources />} />
        <Route path="profile" element={<StaffProfile />} />
      </Route>
      {/* Admin + Manager shell */}
      <Route path="/admin" element={<ProtectedRoute adminOnly><AdminLayout /></ProtectedRoute>}>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="staffing" element={<AdminDashboard />} />
        <Route path="staffing/users/:id" element={<AdminUserDetail />} />
        <Route path="staffing/applications/:id" element={<AdminApplicationDetail />} />
        <Route path="hiring" element={<HiringDashboard />} />
        <Route path="drink-plans" element={<DrinkPlansDashboard />} />
        <Route path="drink-plans/:id" element={<DrinkPlanDetail />} />
        <Route path="cocktail-menu" element={<Navigate to="/admin/settings" replace />} />
        <Route path="drink-menu" element={<Navigate to="/admin/settings" replace />} />
        <Route path="proposals" element={<ProposalsDashboard />} />
        <Route path="proposals/new" element={<ProposalCreate />} />
        <Route path="proposals/:id" element={<ProposalDetail />} />
        <Route path="events" element={<EventsDashboard />} />
        <Route path="events/:id" element={<ProposalDetail />} />
        <Route path="events/shift/:id" element={<ShiftDetail />} />
        <Route path="clients" element={<ClientsDashboard />} />
        <Route path="clients/:id" element={<ClientDetail />} />
        <Route path="financials" element={<FinancialsDashboard />} />
        <Route path="settings" element={<SettingsDashboard />} />
        <Route path="blog" element={<BlogDashboard />} />
        <Route path="email-marketing" element={<EmailMarketingDashboard />}>
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
    </ClientAuthProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

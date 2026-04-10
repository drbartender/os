import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import ErrorBoundary from './components/ErrorBoundary';
import Layout from './components/Layout';
import api from './utils/api';
import HomePage from './pages/website/HomePage';
import QuotePage from './pages/website/QuotePage';
import FaqPage from './pages/website/FaqPage';
import Register from './pages/Register';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Application from './pages/Application';
import ApplicationStatus from './pages/ApplicationStatus';
import Welcome from './pages/Welcome';
import FieldGuide from './pages/FieldGuide';
import Agreement from './pages/Agreement';
import ContractorProfile from './pages/ContractorProfile';
import PaydayProtocols from './pages/PaydayProtocols';
import Completion from './pages/Completion';
import StaffLayout from './components/StaffLayout';
import StaffDashboard from './pages/staff/StaffDashboard';
import StaffShifts from './pages/staff/StaffShifts';
import StaffSchedule from './pages/staff/StaffSchedule';
import StaffEvents from './pages/staff/StaffEvents';
import StaffResources from './pages/staff/StaffResources';
import StaffProfile from './pages/staff/StaffProfile';
import AdminLayout from './components/AdminLayout';
import AdminDashboard from './pages/AdminDashboard';
import AdminUserDetail from './pages/AdminUserDetail';
import AdminApplicationDetail from './pages/AdminApplicationDetail';
import EventsDashboard from './pages/admin/EventsDashboard';
import ShiftDetail from './pages/admin/ShiftDetail';
import ClientsDashboard from './pages/admin/ClientsDashboard';
import FinancialsDashboard from './pages/admin/FinancialsDashboard';
import HiringDashboard from './pages/admin/HiringDashboard';
import SettingsDashboard from './pages/admin/SettingsDashboard';
import DrinkPlansDashboard from './pages/admin/DrinkPlansDashboard';
import DrinkPlanDetail from './pages/admin/DrinkPlanDetail';

import PotionPlanningLab from './pages/plan/PotionPlanningLab';
import ProposalsDashboard from './pages/admin/ProposalsDashboard';
import ProposalCreate from './pages/admin/ProposalCreate';
import ProposalDetail from './pages/admin/ProposalDetail';
import ClientDetail from './pages/admin/ClientDetail';
import Dashboard from './pages/admin/Dashboard';
import ProposalView from './pages/proposal/ProposalView';
import ClientShoppingList from './pages/public/ClientShoppingList';
import BlogDashboard from './pages/admin/BlogDashboard';
import EmailMarketingDashboard from './pages/admin/EmailMarketingDashboard';
import EmailLeadsDashboard from './pages/admin/EmailLeadsDashboard';
import EmailLeadDetail from './pages/admin/EmailLeadDetail';
import EmailCampaignsDashboard from './pages/admin/EmailCampaignsDashboard';
import EmailCampaignCreate from './pages/admin/EmailCampaignCreate';
import EmailCampaignDetail from './pages/admin/EmailCampaignDetail';
import EmailAnalyticsDashboard from './pages/admin/EmailAnalyticsDashboard';
import EmailConversations from './pages/admin/EmailConversations';
import Blog from './pages/public/Blog';
import BlogPost from './pages/public/BlogPost';
import ClientLogin from './pages/public/ClientLogin';
import ClientDashboard from './pages/public/ClientDashboard';
import ClassWizard from './pages/website/ClassWizard';
import HiringLanding from './pages/HiringLanding';
import { ClientAuthProvider } from './context/ClientAuthContext';

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

function ApiAuthSetup({ children }) {
  const navigate = useNavigate();
  useEffect(() => {
    api.setOnUnauthorized((path) => navigate(path, { replace: true }));
    return () => api.setOnUnauthorized(null);
  }, [navigate]);
  return children;
}

function PublicWebsiteRoutes() {
  return (
    <ClientAuthProvider>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/quote" element={<QuotePage />} />
        <Route path="/faq" element={<FaqPage />} />
        <Route path="/classes" element={<ClassWizard />} />
        {/* These public token-based routes work on both domains */}
        <Route path="/plan/:token" element={<PotionPlanningLab />} />
        <Route path="/proposal/:token" element={<ProposalView />} />
        <Route path="/shopping-list/:token" element={<ClientShoppingList />} />
        <Route path="/labnotes" element={<Blog />} />
        <Route path="/labnotes/:slug" element={<BlogPost />} />
        <Route path="/login" element={<ClientLogin />} />
        <Route path="/my-proposals" element={<ClientDashboard />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ClientAuthProvider>
  );
}

/** hiring.drbartender.com — applicant-focused routes only */
function HiringRoutes() {
  return (
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
      <Route path="/shopping-list/:token" element={<ClientShoppingList />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** staff.drbartender.com — staff portal + onboarding routes only */
function StaffSiteRoutes() {
  return (
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
      <Route path="/shopping-list/:token" element={<ClientShoppingList />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function AppRoutes() {
  const context = getSiteContext();

  if (context === 'public') return <PublicWebsiteRoutes />;
  if (context === 'hiring') return <HiringRoutes />;
  if (context === 'staff') return <StaffSiteRoutes />;

  return (
    <ClientAuthProvider>
    <Routes>
      <Route path="/" element={<Navigate to="/register" replace />} />
      {/* Public pages (no auth) */}
      <Route path="/plan/:token" element={<PotionPlanningLab />} />
      <Route path="/proposal/:token" element={<ProposalView />} />
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
    </ClientAuthProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <ApiAuthSetup>
            <AppRoutes />
          </ApiAuthSetup>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

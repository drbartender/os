import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import ErrorBoundary from './components/ErrorBoundary';
import Layout from './components/Layout';
import api from './utils/api';
import Website from './pages/website/Website';
import Register from './pages/Register';
import Login from './pages/Login';
import Application from './pages/Application';
import ApplicationStatus from './pages/ApplicationStatus';
import Welcome from './pages/Welcome';
import FieldGuide from './pages/FieldGuide';
import Agreement from './pages/Agreement';
import ContractorProfile from './pages/ContractorProfile';
import PaydayProtocols from './pages/PaydayProtocols';
import Completion from './pages/Completion';
import StaffPortal from './pages/StaffPortal';
import AdminLayout from './components/AdminLayout';
import AdminDashboard from './pages/AdminDashboard';
import AdminUserDetail from './pages/AdminUserDetail';
import AdminApplicationDetail from './pages/AdminApplicationDetail';
import EventsDashboard from './pages/admin/EventsDashboard';
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

/** Check if we're on the public marketing site (drbartender.com) vs admin subdomain */
function isPublicSite() {
  const host = window.location.hostname;
  // admin.drbartender.com → admin/staff app
  if (host.startsWith('admin.')) return false;
  // localhost → show app routes (website accessible at /website)
  if (host === 'localhost' || host === '127.0.0.1') return false;
  // drbartender.com, www.drbartender.com → public website
  return true;
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
    // Completed onboarding → staff portal
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
  if (loading) return <div className="loading"><div className="spinner" />Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== 'admin' && user.role !== 'manager') {
    return <Navigate to={getHomePath(user)} replace />;
  }
  return children;
}

function RedirectIfLoggedIn({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading"><div className="spinner" />Loading...</div>;
  if (user) return <Navigate to={getHomePath(user)} replace />;
  return children;
}

/** Onboarding flow — accessible for hired staff still working through steps */
function RequireHired({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading"><div className="spinner" />Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  const allowed = ['hired', 'in_progress', 'submitted', 'reviewed', 'approved'];
  if (!allowed.includes(user.onboarding_status)) {
    return <Navigate to={getHomePath(user)} replace />;
  }
  return children;
}

/** Staff portal — requires completed onboarding (submitted / reviewed / approved) */
function RequirePortal({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading"><div className="spinner" />Loading...</div>;
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
    <Routes>
      <Route path="/" element={<Website />} />
      {/* These public token-based routes work on both domains */}
      <Route path="/plan/:token" element={<PotionPlanningLab />} />
      <Route path="/proposal/:token" element={<ProposalView />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function AppRoutes() {
  const publicSite = isPublicSite();

  // On the public domain (drbartender.com), only show the marketing site + public routes
  if (publicSite) return <PublicWebsiteRoutes />;

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/register" replace />} />
      {/* Public pages (no auth) */}
      <Route path="/plan/:token" element={<PotionPlanningLab />} />
      <Route path="/proposal/:token" element={<ProposalView />} />
      {/* Website accessible on admin domain for preview */}
      <Route path="/website" element={<Website />} />

      <Route path="/register" element={<RedirectIfLoggedIn><Register /></RedirectIfLoggedIn>} />
      <Route path="/login" element={<RedirectIfLoggedIn><Login /></RedirectIfLoggedIn>} />

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

      {/* Staff portal (onboarding completed) */}
      <Route path="/portal" element={<RequirePortal><StaffPortal /></RequirePortal>} />

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
        <Route path="clients" element={<ClientsDashboard />} />
        <Route path="clients/:id" element={<ClientDetail />} />
        <Route path="financials" element={<FinancialsDashboard />} />
        <Route path="settings" element={<SettingsDashboard />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
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

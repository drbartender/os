import React, { lazy, Suspense } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../../context/AuthContext';

// Lazy-loaded so each section ships as its own chunk — opening /account no
// longer downloads all five section forms (~3.8k lines) up front; only the
// active section's code loads, the rest on demand when its tab is tapped.
const ProfileSection = lazy(() => import('./ProfileSection'));
const PaymentMethodsSection = lazy(() => import('./PaymentMethodsSection'));
const CalendarSyncSection = lazy(() => import('./CalendarSyncSection'));
const NotificationsSection = lazy(() => import('./NotificationsSection'));
const DocumentsSection = lazy(() => import('./DocumentsSection'));

/**
 * AccountPage — staff portal v2 account hub (spec §6.9).
 *
 * A single overlay surface mounted under `/account/:section`. Renders
 * the chrome (header / sub-nav / footer) and swaps in the active sub-section
 * based on the `:section` URL param. URL-driven so the sub-nav state survives
 * a hard refresh and lights the user-pill menu items correctly when they
 * route here from elsewhere in / (StaffShellWithThemeWiring's
 * userMenu items deep-link to /account/<section>).
 *
 * Section keys are stable so future link sources can rely on them:
 *   profile        — personal info + emergency contact (Task 43)
 *   payments       — payroll route + handles on file (Task 44)
 *   calendar       — iCal subscription URLs (Task 45)
 *   notifications  — SMS / email / push prefs per topic (Task 46)
 *   documents      — W-9, contractor agreement, alcohol cert (Task 47)
 *
 * Each section component is built in Tasks 43-47; all five are now wired
 * up. The sub-nav keys remain the stable contract for any future deep-link
 * source (user-pill menu, email CTA, push payload).
 *
 * Back-nav: matches the existing / detail-page pattern
 * (ShiftDetail, PayoutDetail) — a top-left Back button that calls
 * `navigate(-1)`, returning to whichever main tab the user came from
 * (StaffShellWithThemeWiring treats /account/* as an overlay and
 * leaves the underlying tab id active, so the back jump lands on the
 * correct tab in nine cases out of ten).
 *
 * Sign-out: footer button calls `useAuth().logout()` then redirects to
 * /login (mirrors StaffShellWithThemeWiring's handleLogout). Done here
 * directly rather than via the user-pill menu so the AccountPage can stand
 * alone if a future flow surfaces it outside the shell.
 */

const SECTIONS = [
  { id: 'profile',       label: 'Edit profile',          icon: 'pen' },
  { id: 'payments',      label: 'Payment methods',       icon: 'dollar' },
  { id: 'calendar',      label: 'Calendar sync',         icon: 'calendar' },
  { id: 'notifications', label: 'Notification settings', icon: 'bell' },
  { id: 'documents',     label: 'Documents',             icon: 'book' },
];

const SECTION_IDS = SECTIONS.map((s) => s.id);

const SUPPORT_MAILTO = 'mailto:staff@drbartender.com';

// Map the role enum (admin / manager / staff) onto a human label. The staff
// portal is gated by RequirePortal so the value here is almost always 'staff',
// but admins and managers can hit the URL directly during testing; we surface
// a sensible label rather than the bare enum.
function roleLabel(role) {
  if (role === 'admin') return 'Admin';
  if (role === 'manager') return 'Manager';
  if (role === 'staff') return 'Bartender';
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
}

// Two-character uppercase initials — same logic as StaffShellWithThemeWiring's
// deriveInitials, replicated here so the AccountPage avatar can render without
// depending on the shell prop pipeline (the user-pill avatar comes from
// shellUser; this surface owns its own copy so it works when navigated to
// directly via the URL).
function deriveInitials(user) {
  if (!user) return '';
  const name = (user.preferred_name || '').trim();
  if (name) {
    const parts = name.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }
  const email = (user.email || '').trim();
  if (email) {
    const local = email.split('@')[0] || '';
    return local.slice(0, 2).toUpperCase();
  }
  return '';
}

export default function AccountPage() {
  const navigate = useNavigate();
  const { section } = useParams();
  const { user, logout } = useAuth();

  // `/account` with no section, or `:section` outside the known
  // set, redirects to the canonical profile entry. `replace` keeps the
  // history clean so Back doesn't ping-pong through the redirect.
  if (!section || !SECTION_IDS.includes(section)) {
    return <Navigate to="/account/profile" replace />;
  }

  const handleSignOut = () => {
    logout();
    navigate('/login');
  };

  // AuthContext.loading wraps the whole staff portal via RequirePortal, so by
  // the time we render `user` is always populated. Defensive guards remain for
  // the edge case where the JWT cleared between the route match and the next
  // paint (e.g. logout firing concurrently with a click).
  const initials = deriveInitials(user);
  const displayName = user?.preferred_name || user?.name || user?.email || '';
  const displayRole = roleLabel(user?.role);
  const displayEmail = user?.email || '';

  return (
    <>
      <div className="sp-detail-head">
        <button type="button" className="sp-back" onClick={() => navigate(-1)}>
          <BackIcon size={14} />
          Back
        </button>
      </div>

      <div className="sp-acc-hero">
        <div className="sp-avatar sp-acc-avatar">{initials}</div>
        <div>
          <h1 className="sp-detail-title">{displayName}</h1>
          <div className="sp-detail-sub">
            {displayRole}
            {displayRole && displayEmail ? ' · ' : ''}
            {displayEmail && <span className="sp-mono">{displayEmail}</span>}
          </div>
        </div>
      </div>

      <nav className="sp-acc-nav" aria-label="Account sections">
        {SECTIONS.map((s) => {
          const isActive = section === s.id;
          return (
            <button
              key={s.id}
              type="button"
              className={'sp-acc-navbtn' + (isActive ? ' active' : '')}
              onClick={() => navigate(`/account/${s.id}`)}
              aria-current={isActive ? 'page' : undefined}
            >
              <NavIcon name={s.icon} size={13} />
              <span>{s.label}</span>
            </button>
          );
        })}
      </nav>

      <Suspense
        fallback={
          <div className="sp-tf-sub" style={{ padding: 24 }} role="status" aria-live="polite">
            Loading…
          </div>
        }
      >
        {section === 'profile' && <ProfileSection />}
        {section === 'payments' && <PaymentMethodsSection />}
        {section === 'calendar' && <CalendarSyncSection />}
        {section === 'notifications' && <NotificationsSection />}
        {section === 'documents' && <DocumentsSection />}
      </Suspense>

      <div className="sp-acc-foot">
        <button type="button" className="sp-btn sp-btn-block" onClick={handleSignOut}>
          <LogoutIcon size={13} />
          Sign out
        </button>
        <div className="sp-acc-foot-sub">
          Questions?{' '}
          <a href={SUPPORT_MAILTO} className="sp-link">staff@drbartender.com</a>
        </div>
      </div>
    </>
  );
}

// ── Inline icons (Lucide-style strokes at 1.75, matches StaffShell) ─────

function BackIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function LogoutIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 17l-5-5 5-5M5 12h12M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" />
    </svg>
  );
}

function NavIcon({ name, size = 13 }) {
  const paths = {
    pen:      <path d="M4 20h4l10-10-4-4L4 16v4ZM14 6l4 4" />,
    dollar:   <path d="M12 3v18M16 7c0-1.7-1.8-3-4-3s-4 1.3-4 3 1.8 3 4 3 4 1.3 4 3-1.8 3-4 3-4-1.3-4-3" />,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v4M16 3v4" /></>,
    bell:     <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9Z" /><path d="M10 21a2 2 0 0 0 4 0" /></>,
    book:     <><path d="M4 4h11a4 4 0 0 1 4 4v13H8a4 4 0 0 1-4-4V4Z" /><path d="M4 4v13a4 4 0 0 1 4-4h11" /></>,
  };
  const inner = paths[name];
  if (!inner) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {inner}
    </svg>
  );
}

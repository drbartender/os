import React from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import NAV, { navBadgeCount } from '../../components/adminos/nav';
import Icon from '../../components/adminos/Icon';
import MoreSecurityRow from '../../components/mobile/MoreSecurityRow';
import { useAuth } from '../../context/AuthContext';
import { useUserPrefs } from '../../context/UserPrefsContext';
import { canInstall, onInstallAvailability, promptInstall } from '../../utils/installPrompt';

// The third tab: every admin surface that is not Events or Proposals, as tap
// rows. Until a surface gets its phone-first treatment it opens its desktop
// component inside the mobile chrome: ugly but reachable, which is the
// no-dead-ends floor (spec section 1).
const TAB_IDS = new Set(['events', 'proposals']);

// Explicit install row (spec section 7): Chrome's own banner has moods; this
// row renders whenever the captured beforeinstallprompt is in hand and the
// app is not already running standalone.
function InstallRow() {
  const [available, setAvailable] = React.useState(canInstall());
  React.useEffect(() => onInstallAvailability(setAvailable), []);
  const standalone =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(display-mode: standalone)').matches;
  if (standalone || !available) return null;
  return (
    <section>
      <h2 className="m-more-heading">App</h2>
      <ul className="m-more-list">
        <li>
          <button type="button" className="m-more-row" onClick={() => promptInstall()}>
            <Icon name="plus" size={20} />
            <span>Install app</span>
          </button>
        </li>
      </ul>
    </section>
  );
}

export default function MorePage() {
  // Same adminOnly filter as Sidebar.js and CommandPalette.js: the admin
  // shell admits managers, and nav.js's own comment says never to offer a
  // manager a link that bounces them straight back out.
  const { user } = useAuth();
  const { prefs, setPref } = useUserPrefs();
  // Badge counts arrive through the mobile chrome's Outlet context (the
  // desktop branch passes none; rows just render badge-less there).
  const outlet = useOutletContext() || {};
  const badges = outlet.badges || {};
  const visible = (i) => !i.adminOnly || user?.role === 'admin';
  return (
    <div className="m-more">
      <InstallRow />
      {NAV.map((section) => {
        const items = section.items.filter((i) => !TAB_IDS.has(i.id) && visible(i));
        if (!items.length) return null;
        return (
          <section key={section.section}>
            <h2 className="m-more-heading">{section.section}</h2>
            <ul className="m-more-list">
              {items.map((i) => {
                const count = navBadgeCount(i, badges);
                return (
                  <li key={i.id}>
                    <Link className="m-more-row" to={i.path}>
                      <Icon name={i.icon} size={20} />
                      <span>{i.label}</span>
                      {count > 0 && <span className="m-more-badge">{count}</span>}
                      <Icon name="right" size={16} />
                    </Link>
                  </li>
                );
              })}
              {section.section === 'Workspace' && user?.role === 'admin' && (
                <li>
                  {/* Deliberate phone-only row (spec section 1 no-dead-ends):
                      Payroll is a tab inside the Staff hub and has no nav.js
                      item of its own, so the phone offers it explicitly or
                      payroll is unreachable on the go. Admin-gated: the
                      payroll API is admin-only server-side, so a manager
                      tapping this would render a page of 403s. */}
                  <Link className="m-more-row" to="/staffing/payroll">
                    <Icon name="dollar" size={20} />
                    <span>Payroll</span>
                    <Icon name="right" size={16} />
                  </Link>
                </li>
              )}
            </ul>
          </section>
        );
      })}
      <MoreSecurityRow />
      {/* Benchmark composition: the Lighting section. Without it the phone
          has NO skin control (the desktop toggle lives in the sidebar footer,
          which never renders in phone chrome). Same pref model as desktop. */}
      <section>
        <h2 className="m-more-heading">Lighting</h2>
        <div className="m-seg" role="radiogroup" aria-label="Lighting">
          <button
            type="button"
            role="radio"
            aria-checked={prefs.skin === 'dark'}
            className={`m-seg-btn${prefs.skin === 'dark' ? ' active' : ''}`}
            onClick={() => prefs.skin !== 'dark' && setPref('skin', 'dark')}
          >
            After Hours
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={prefs.skin === 'light'}
            className={`m-seg-btn${prefs.skin === 'light' ? ' active' : ''}`}
            onClick={() => prefs.skin !== 'light' && setPref('skin', 'light')}
          >
            House Lights
          </button>
        </div>
        <div className="m-seg-note">follows the desktop preference &#183; saved per device</div>
      </section>
    </div>
  );
}

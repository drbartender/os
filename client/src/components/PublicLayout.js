import React, { useState, useEffect } from 'react';
import { Link, NavLink as RouterNavLink, useLocation, useNavigate } from 'react-router-dom';
import { useClientAuth } from '../context/ClientAuthContext';
import logoCharacter from '../images/logo-character.png';

export function isPublicSite() {
  const host = window.location.hostname;
  if (host.startsWith('admin.')) return false;
  if (host === 'localhost' || host === '127.0.0.1') return false;
  return true;
}

export function clientLoginPath() {
  return isPublicSite() ? '/login' : '/client-login';
}

export default function PublicLayout({ children }) {
  const [mobileNav, setMobileNav] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const clientAuth = useClientAuth();
  const isAuthed = clientAuth?.isClientAuthenticated;
  const homePath = isPublicSite() ? '/' : '/website';
  const loginPath = clientLoginPath();

  useEffect(() => {
    if (mobileNav) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [mobileNav]);

  useEffect(() => {
    if (location.hash) {
      const id = location.hash.replace('#', '');
      const timer = setTimeout(() => {
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      }, 100);
      return () => clearTimeout(timer);
    } else {
      window.scrollTo(0, 0);
    }
  }, [location.pathname, location.hash]);

  const handleHashLink = (e, hash) => {
    e.preventDefault();
    setMobileNav(false);
    const isHome = location.pathname === '/' || location.pathname === '/website';
    if (isHome) {
      const el = document.getElementById(hash);
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    } else {
      navigate(`${homePath}#${hash}`);
    }
  };
  // Kept for backward compat with any old email link / external anchor.
  // Currently unused inside this layout — top-nav links to solo routes.
  void handleHashLink;

  const closeNav = () => setMobileNav(false);

  return (
    <div className="ws-shell">
      <a href="#main-content" className="skip-nav">Skip to main content</a>

      {/* ── Utility strip ───────────────────────────────────── */}
      <div className="ws-utility">
        <div className="ws-utility-inner">
          <span className="ws-utility-tag">Mixing Science with Celebration · Est. 2024 · Chicago</span>
          <span className="ws-utility-right">
            <span className="ws-utility-booking">⚗ Now booking 2026 weddings</span>
            <Link
              to={isAuthed ? '/my-proposals' : loginPath}
              className="ws-utility-link"
              onClick={closeNav}
            >
              {isAuthed ? 'My Portal' : 'Sign in'}
            </Link>
          </span>
        </div>
      </div>

      {/* ── Main header ─────────────────────────────────────── */}
      <header className="ws-header">
        <div className="ws-header-inner">
          <button
            className="ws-menu-toggle"
            onClick={() => setMobileNav(!mobileNav)}
            aria-label={mobileNav ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileNav}
          >
            <span /><span /><span />
          </button>

          <nav className="ws-nav-left" aria-label="Primary">
            <RouterNavLink to="/services" onClick={closeNav}>Services</RouterNavLink>
            <RouterNavLink to="/packages" onClick={closeNav}>Packages</RouterNavLink>
            <RouterNavLink to="/method" onClick={closeNav}>Method</RouterNavLink>
            <RouterNavLink to="/labnotes" onClick={closeNav}>Lab Notes</RouterNavLink>
            <RouterNavLink to="/faq" onClick={closeNav}>FAQ</RouterNavLink>
          </nav>

          <Link to={homePath} className="ws-brand" onClick={closeNav}>
            <span className="brand-logo sm">
              <img src={logoCharacter} alt="" />
            </span>
            <span className="ws-brand-name">Dr. Bartender</span>
            <span className="ws-brand-sub">Apothecary &amp; Mobile Bar</span>
          </Link>

          <nav className="ws-nav-right" aria-label="Secondary">
            <RouterNavLink to="/classes" onClick={closeNav}>Cocktail Classes</RouterNavLink>
            <RouterNavLink to="/about" onClick={closeNav}>About</RouterNavLink>
            <Link to="/quote" className="ws-nav-cta" onClick={closeNav}>Instant Quote</Link>
          </nav>
        </div>

        {/* Mobile drawer — slides down beneath header */}
        <div className={`ws-mobile-drawer ${mobileNav ? 'open' : ''}`}>
          <RouterNavLink to="/services" onClick={closeNav}>Services</RouterNavLink>
          <RouterNavLink to="/packages" onClick={closeNav}>Packages</RouterNavLink>
          <RouterNavLink to="/method" onClick={closeNav}>Method</RouterNavLink>
          <RouterNavLink to="/about" onClick={closeNav}>About</RouterNavLink>
          <RouterNavLink to="/labnotes" onClick={closeNav}>Lab Notes</RouterNavLink>
          <RouterNavLink to="/faq" onClick={closeNav}>FAQ</RouterNavLink>
          <RouterNavLink to="/classes" onClick={closeNav}>Cocktail Classes</RouterNavLink>
          <Link
            to={isAuthed ? '/my-proposals' : loginPath}
            onClick={closeNav}
          >
            {isAuthed ? 'My Portal' : 'Sign in'}
          </Link>
          <Link to="/quote" className="ws-nav-cta" onClick={closeNav}>Get an Instant Quote</Link>
        </div>
      </header>

      <main className="ws-main" id="main-content">
        {children}
      </main>

      {/* ── Footer ──────────────────────────────────────────── */}
      <footer className="ws-footer">
        <div className="ws-footer-inner">
          <div className="ws-footer-grid">
            <div className="ws-footer-brand">
              <span className="brand-logo sm">
                <img src={logoCharacter} alt="" />
              </span>
              <div>
                <div className="ws-footer-brand-name">Dr. Bartender</div>
                <div className="ws-footer-brand-sub">Mobile Bar · Cocktail Lab</div>
              </div>
            </div>
            <p className="ws-footer-blurb">
              An apothecary running a contemporary cocktail program. Chicago, est. 2024.
            </p>

            <div className="ws-footer-col">
              <div className="ws-footer-col-head">Surface</div>
              <ul>
                <li><Link to="/services">Services</Link></li>
                <li><Link to="/packages">Packages</Link></li>
                <li><Link to="/method">Method</Link></li>
                <li><Link to="/about">About</Link></li>
                <li><Link to="/faq">FAQ</Link></li>
              </ul>
            </div>

            <div className="ws-footer-col">
              <div className="ws-footer-col-head">Clients</div>
              <ul>
                <li><Link to="/quote">Get a Quote</Link></li>
                <li><Link to={isAuthed ? '/my-proposals' : loginPath}>My Portal</Link></li>
                <li><Link to="/classes">Cocktail Classes</Link></li>
              </ul>
            </div>

            <div className="ws-footer-col">
              <div className="ws-footer-col-head">Lab</div>
              <ul>
                <li><Link to="/labnotes">Lab Notes</Link></li>
                <li><a href="https://hiring.drbartender.com">Hiring</a></li>
              </ul>
            </div>

            <div className="ws-footer-col">
              <div className="ws-footer-col-head">Office</div>
              <ul>
                <li><a href="mailto:contact@drbartender.com">contact@drbartender.com</a></li>
                <li>Chicago, IL</li>
                <li>IL · IN · MI</li>
                <li><a href="https://instagram.com/drbartender" target="_blank" rel="noreferrer">@drbartender</a></li>
              </ul>
            </div>
          </div>

          <div className="ws-footer-bottom">
            <span>&copy; {new Date().getFullYear()} Dr. Bartender LLC</span>
            <span className="ws-footer-bottom-right">
              <Link to="/privacy">Privacy</Link> &middot;{' '}
              <Link to="/terms">Terms</Link> &middot;{' '}
              <em>I'm the Dr. in Dr. Bartender.</em>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}

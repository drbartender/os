import React, { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import BrandLogo from './BrandLogo';
import { useClientAuth } from '../context/ClientAuthContext';

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

  // Lock body scroll when mobile nav is open
  useEffect(() => {
    if (mobileNav) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [mobileNav]);

  // Scroll to top on route change, or to hash target if present
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

  return (
    <div className="ws-shell">
      <a href="#main-content" className="skip-nav">Skip to main content</a>
      <header className="ws-header">
        <div className="ws-header-inner">
          <BrandLogo />
          <button className="ws-menu-toggle" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle menu">
            <span /><span /><span />
          </button>
          <nav className={`ws-nav ${mobileNav ? 'open' : ''}`} aria-label="Primary">
            <a href={`${homePath}#services`} onClick={e => handleHashLink(e, 'services')}>Services</a>
            <a href={`${homePath}#process`} onClick={e => handleHashLink(e, 'process')}>How It Works</a>
            <a href={`${homePath}#about`} onClick={e => handleHashLink(e, 'about')}>About</a>
            <Link to="/faq" onClick={() => setMobileNav(false)}>FAQ</Link>
            <Link to="/labnotes" onClick={() => setMobileNav(false)}>Blog</Link>
            <Link
              to={isAuthed ? '/my-proposals' : loginPath}
              onClick={() => setMobileNav(false)}
            >
              {isAuthed ? 'My Proposals' : 'Sign In'}
            </Link>
            <Link to="/quote" className="ws-nav-cta" onClick={() => setMobileNav(false)}>Get an Instant Quote</Link>
          </nav>
        </div>
      </header>

      <main className="ws-main" id="main-content">
        {children}
      </main>

      <footer className="ws-footer">
        <div className="ws-footer-inner">
          <div className="ws-footer-brand">
            <BrandLogo />
            <p>Mobile Bar &middot; Cocktail Lab</p>
          </div>
          <div className="ws-footer-links">
            <a href={`${homePath}#services`} onClick={e => handleHashLink(e, 'services')}>Services</a>
            <a href={`${homePath}#process`} onClick={e => handleHashLink(e, 'process')}>How It Works</a>
            <Link to="/faq">FAQ</Link>
            <Link to="/labnotes">Blog</Link>
            <Link to="/quote">Get an Instant Quote</Link>
          </div>
          <p className="ws-footer-email">contact@drbartender.com</p>
          <div className="ws-footer-copy">
            &copy; {new Date().getFullYear()} Dr. Bartender. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}

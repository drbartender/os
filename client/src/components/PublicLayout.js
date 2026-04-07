import React, { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import BrandLogo from './BrandLogo';
import { useClientAuth } from '../context/ClientAuthContext';

function isPublicSite() {
  const host = window.location.hostname;
  if (host.startsWith('admin.')) return false;
  if (host === 'localhost' || host === '127.0.0.1') return false;
  return true;
}

export default function PublicLayout({ children }) {
  const [mobileNav, setMobileNav] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const clientAuth = useClientAuth();
  const isAuthed = clientAuth?.isClientAuthenticated;
  const homePath = isPublicSite() ? '/' : '/website';

  // Handle hash-scroll when navigating from another page (e.g. /faq → /#services)
  useEffect(() => {
    if (location.hash) {
      const id = location.hash.replace('#', '');
      // Small delay to let the page render before scrolling
      const timer = setTimeout(() => {
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [location]);

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
      <header className="ws-header">
        <div className="ws-header-inner">
          <Link to={homePath} className="ws-brand" onClick={() => setMobileNav(false)}>
            <BrandLogo />
          </Link>
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
              to={isAuthed ? '/my-proposals' : '/login'}
              onClick={() => setMobileNav(false)}
            >
              {isAuthed ? 'My Proposals' : 'Sign In'}
            </Link>
            <Link to="/quote" className="ws-nav-cta" onClick={() => setMobileNav(false)}>Get an Instant Quote</Link>
          </nav>
        </div>
      </header>

      <main className="ws-main">
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

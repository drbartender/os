import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import BrandLogo from './BrandLogo';
import { useClientAuth } from '../context/ClientAuthContext';

export default function PublicLayout({ children }) {
  const [mobileNav, setMobileNav] = useState(false);
  const location = useLocation();
  const clientAuth = useClientAuth();
  const isAuthed = clientAuth?.isClientAuthenticated;

  const navLinks = [
    { label: 'Home', to: '/' },
    { label: 'Blog', to: '/blog' },
    { label: isAuthed ? 'My Proposals' : 'Sign In', to: isAuthed ? '/my-proposals' : '/login' },
  ];

  return (
    <div className="ws-shell">
      <header className="ws-header">
        <div className="ws-header-inner">
          <Link to="/" className="ws-brand" onClick={() => setMobileNav(false)}>
            <BrandLogo />
          </Link>
          <button className="ws-menu-toggle" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle menu">
            <span /><span /><span />
          </button>
          <nav className={`ws-nav ${mobileNav ? 'open' : ''}`} aria-label="Primary">
            {navLinks.map(link => (
              <Link
                key={link.to}
                to={link.to}
                className={location.pathname.startsWith(link.to) && link.to !== '/' ? 'active' : (location.pathname === '/' && link.to === '/' ? 'active' : '')}
                onClick={() => setMobileNav(false)}
              >
                {link.label}
              </Link>
            ))}
            <Link to="/" className="ws-nav-cta" onClick={() => setMobileNav(false)}>Get a Quote</Link>
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
            <Link to="/">Home</Link>
            <Link to="/blog">Blog</Link>
            <Link to={isAuthed ? '/my-proposals' : '/login'}>{isAuthed ? 'My Proposals' : 'Sign In'}</Link>
          </div>
          <div className="ws-footer-copy">
            &copy; {new Date().getFullYear()} Dr. Bartender. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}

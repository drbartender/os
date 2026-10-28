// BrandLogo (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React, { useState } from 'react';

export default function BrandLogo({ admin = false }) {
  const [missingLogo, setMissingLogo] = useState(false);

  return (
    <a href="https://drbartender.com" className="site-brand" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="site-logo-mark" aria-hidden={!missingLogo}>
        {!missingLogo ? (
          <img
            src="/images/logo.png"
            alt=""
            onError={() => setMissingLogo(true)}
          />
        ) : (
          'DB'
        )}
      </div>
      <div className="site-logo">
        Dr. <span>Bartender</span>
        {admin && <span className="site-admin-tag">OS</span>}
      </div>
    </a>
  );
}

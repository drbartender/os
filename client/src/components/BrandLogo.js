import React, { useState } from 'react';

export default function BrandLogo({ admin = false }) {
  const [missingLogo, setMissingLogo] = useState(false);

  return (
    <div className="site-brand">
      <div className="site-logo-mark" aria-hidden>
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
        {admin && <span className="site-admin-tag">Admin</span>}
      </div>
    </div>
  );
}

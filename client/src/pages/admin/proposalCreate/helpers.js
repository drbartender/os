// Exports Lbl. Header generated from the file's exports by migrate-headers on 2026-10-27; replace
// with what it does.

import React from 'react';

export const Lbl = ({ text, span = 1, children }) => (
  <label style={{ gridColumn: span > 1 ? `span ${span}` : undefined, minWidth: 0 }}>
    <div className="tiny mono" style={{ color: 'var(--ink-3)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 9.5 }}>
      {text}
    </div>
    {children}
  </label>
);

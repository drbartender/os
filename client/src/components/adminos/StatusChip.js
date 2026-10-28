// StatusChip (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React from 'react';

// kind ∈ { 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'violet' | 'accent' }
export default function StatusChip({ kind = 'neutral', children, dot = true }) {
  return (
    <span className={`chip ${kind}`}>
      {dot && <span className="chip-dot" />}
      {children}
    </span>
  );
}

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

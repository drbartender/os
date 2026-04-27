import React from 'react';

export default function TabButton({ active, count, children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '10px 16px',
        background: 'transparent',
        border: 0,
        borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
        marginBottom: -1,
        color: active ? 'var(--ink-1)' : 'var(--ink-3)',
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        fontSize: 13,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
      {count != null && <span className="muted" style={{ marginLeft: 4 }}>{count}</span>}
    </button>
  );
}

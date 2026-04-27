import React from 'react';

export default function Sparkbars({ values }) {
  const max = Math.max(1, ...values);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 32 }}>
      {values.map((v, i) => (
        <div
          key={i}
          style={{
            width: 7,
            height: Math.max(2, (v / max) * 32),
            background: i === values.length - 1 ? 'var(--ink-1)' : 'var(--line-2)',
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
}

import React from 'react';

export default function Sparkline({ data = [], stroke = 'var(--accent)' }) {
  if (!data.length) return null;
  const isRainbow = typeof document !== 'undefined' && document.documentElement.dataset.palette === 'rainbow';
  const max = Math.max(...data);
  const min = Math.min(...data);
  const w = 120;
  const h = 30;
  const pts = data.map((v, i) => [
    i * (w / (data.length - 1 || 1)),
    h - ((v - min) / (max - min || 1)) * (h - 4) - 2,
  ]);
  const d = pts.reduce((s, [x, y], i) => s + (i ? ` L ${x} ${y}` : `M ${x} ${y}`), '');
  const gid = 'spr' + Math.random().toString(36).slice(2, 7);
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      {isRainbow && (
        <defs>
          <linearGradient id={gid} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0"   stopColor="#e40303" />
            <stop offset="0.2" stopColor="#ff8c00" />
            <stop offset="0.4" stopColor="#ffed00" />
            <stop offset="0.6" stopColor="#008026" />
            <stop offset="0.8" stopColor="#24408e" />
            <stop offset="1"   stopColor="#732982" />
          </linearGradient>
        </defs>
      )}
      <path d={d} fill="none" stroke={isRainbow ? `url(#${gid})` : stroke} strokeWidth={isRainbow ? 2 : 1.5} />
    </svg>
  );
}

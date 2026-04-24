import React from 'react';

/**
 * Two-series SVG area chart. Ported from handoff dashboard.jsx.
 * data: array of { m: string, [key1]: number, [key2]: number, ... }
 * keys: two string keys to plot. First is "primary" (cobalt / rainbow), second is "secondary" (teal, dashed when rainbow).
 *
 * Rainbow option: when document.documentElement.dataset.palette === 'rainbow',
 * the primary stroke uses a pride-gradient.
 */
export default function AreaChart({ data = [], w = 720, h = 180, keys = ['booked', 'collected'] }) {
  if (!data.length) return null;
  const isRainbow = typeof document !== 'undefined' && document.documentElement.dataset.palette === 'rainbow';
  const max = Math.max(...data.flatMap(d => keys.map(k => d[k] || 0))) * 1.1 || 1;
  const pts = (key) => data.map((d, i) => [i * (w / (data.length - 1 || 1)), h - ((d[key] || 0) / max) * (h - 24) - 12]);
  const path = (arr) => arr.reduce((s, [x, y], i) => s + (i ? ` L ${x} ${y}` : `M ${x} ${y}`), '');
  const area = (arr) => path(arr) + ` L ${w} ${h} L 0 ${h} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="gBooked" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.4" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="gCollected" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="hsl(var(--ok-h) var(--ok-s) 52%)" stopOpacity="0.3" />
          <stop offset="1" stopColor="hsl(var(--ok-h) var(--ok-s) 52%)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="gPrideLine" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0"    stopColor="#e40303" />
          <stop offset="0.2"  stopColor="#ff8c00" />
          <stop offset="0.4"  stopColor="#ffed00" />
          <stop offset="0.6"  stopColor="#008026" />
          <stop offset="0.8"  stopColor="#24408e" />
          <stop offset="1"    stopColor="#732982" />
        </linearGradient>
        <linearGradient id="gPrideArea" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0"    stopColor="#e40303" stopOpacity="0.35" />
          <stop offset="0.2"  stopColor="#ff8c00" stopOpacity="0.35" />
          <stop offset="0.4"  stopColor="#ffed00" stopOpacity="0.35" />
          <stop offset="0.6"  stopColor="#008026" stopOpacity="0.35" />
          <stop offset="0.8"  stopColor="#24408e" stopOpacity="0.35" />
          <stop offset="1"    stopColor="#732982" stopOpacity="0.35" />
        </linearGradient>
        <linearGradient id="gPrideAreaFade" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id="gPrideMask">
          <rect width={w} height={h} fill="url(#gPrideAreaFade)" />
        </mask>
      </defs>
      {[0.25, 0.5, 0.75].map(p => (
        <line key={p} x1="0" x2={w} y1={h * p} y2={h * p} stroke="var(--line-1)" strokeDasharray="2 4" />
      ))}
      <path d={area(pts(keys[0]))} fill={isRainbow ? 'url(#gPrideArea)' : 'url(#gBooked)'} mask={isRainbow ? 'url(#gPrideMask)' : undefined} />
      <path d={path(pts(keys[0]))} fill="none" stroke={isRainbow ? 'url(#gPrideLine)' : 'var(--accent)'} strokeWidth={isRainbow ? 2.5 : 1.5} />
      <path d={area(pts(keys[1]))} fill="url(#gCollected)" />
      <path d={path(pts(keys[1]))} fill="none" stroke="hsl(var(--ok-h) var(--ok-s) 52%)" strokeWidth="1.5" strokeDasharray={isRainbow ? '4 3' : '0'} />
      {data.map((d, i) => (
        <text key={i} x={i * (w / (data.length - 1 || 1))} y={h - 2} fontSize="10" fill="var(--ink-4)" textAnchor="middle" fontFamily="var(--font-ui)">
          {d.m}
        </text>
      ))}
    </svg>
  );
}

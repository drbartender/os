// PaymentMarks.jsx — shared pieces for the bartender's printed tip sign and
// hand-out card. Moved out of PrintTipCard.layouts.jsx 2026-08-11.
//
// Uses the Dr. Bartender design system (drb-tokens.css):
//   chalkboard #12161C · paper #EDE6D6 · teal #1D8C89 · brass #B8924A
//   Apothecary Teal flask-character logo at /tip-page/logo-gold.png
//
// Sizes are at 150 DPI of the actual print dimensions (see ./sizes.js).

import React from 'react';

// The tokens import lives HERE, not on a page, because every consumer of these
// pieces needs them and one of them renders off-screen for html2canvas capture.
// PrintTipCard.jsx used to be the only importer in the entire client; when that
// file was deleted the tokens would have gone with it, and the captured sign
// would have rendered colorless and flattened toward black in the JPEG.
import '../../../styles/drb-tokens.css';

// ─ Decorative bits ──────────────────────────────────────────
export function BrassRule({ width = 80, color = 'var(--drb-brass)' }) {
  return (
    <svg width={width} height={10} viewBox="0 0 80 10" fill="none" stroke={color} strokeWidth="1">
      <path d="M0 5 L30 5 M50 5 L80 5" />
      <circle cx="40" cy="5" r="2" fill={color} stroke="none" />
      <circle cx="32" cy="5" r="0.9" fill={color} stroke="none" />
      <circle cx="48" cy="5" r="0.9" fill={color} stroke="none" />
    </svg>
  );
}

// ─ Payment method marks ────────────────────────────────────
// Generic, brand-suggestive glyphs (NOT the real wordmarks — final
// print files swap these for the brand-compliant SVGs).
export function PayMark({ kind, size = 28 }) {
  const w = size, h = size;
  const wrap = (bg, content, fg = '#fff') => (
    <div style={{
      width: w, height: h,
      background: bg, color: fg,
      borderRadius: 6,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif",
      fontWeight: 700,
      fontSize: w * 0.46,
      letterSpacing: '-0.02em',
      flex: '0 0 auto',
      boxShadow: '0 1px 0 rgba(0,0,0,0.08)',
    }}>{content}</div>
  );
  switch (kind) {
    case 'apple': return wrap('#000',
      <svg width={w * 0.6} height={h * 0.6} viewBox="0 0 24 24" fill="#fff">
        <path d="M17.5 12.6c0-2.3 1.9-3.4 2-3.4-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.8-3.5.8-.8 0-1.9-.8-3.1-.8-1.6 0-3 .9-3.8 2.4-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 3 2.3 1.2 0 1.6-.8 3-.8 1.4 0 1.8.8 3 .8 1.3 0 2.1-1.1 2.9-2.3.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.5-.9-2.6-3.8zM15.2 5.7c.6-.8 1.1-1.9 1-3-1 0-2.2.6-2.9 1.4-.6.7-1.2 1.9-1 2.9 1.1.1 2.2-.5 2.9-1.3z"/>
      </svg>);
    case 'google': return wrap('#fff',
      <svg width={w * 0.7} height={h * 0.7} viewBox="0 0 24 24">
        <path fill="#4285F4" d="M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9c-.3 1.4-1 2.6-2.2 3.4v2.8h3.6c2.1-2 3.2-4.9 3.2-8.2z"/>
        <path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.6h-3.7v2.8C3.9 20.5 7.7 23 12 23z"/>
        <path fill="#FBBC04" d="M5.8 14c-.2-.7-.4-1.4-.4-2.1s.1-1.4.4-2.1V7H2.1c-.8 1.5-1.3 3.1-1.3 4.9s.5 3.4 1.3 4.9l3.7-2.8z"/>
        <path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.6l3.2-3.2C17.4 2 14.9 1 12 1 7.7 1 3.9 3.5 2.1 7l3.7 2.8c.9-2.7 3.3-4.4 6.2-4.4z"/>
      </svg>);
    case 'venmo': return wrap('#008CFF', 'V');
    case 'cashapp': return wrap('#00D632', '$', '#013220');
    case 'paypal': return wrap('#003087',
      <svg width={w * 0.55} height={h * 0.6} viewBox="0 0 24 24" fill="#fff">
        <path d="M7.1 21l.6-3.6h2.5c4.6 0 7.6-2.3 8.4-6.6.5-2.7-.5-4.5-2.3-5.5.5 1.5.4 3.4-.2 5.2-.9 2.6-3.2 4.1-6.5 4.1H7.5l-1 6.4h.6zm-1.7-2L7 9.4h3.7c2.3 0 3.5-.9 4-2.5.4-1.4 0-2.4-1.7-2.4H8.5L5.4 19z"/>
      </svg>);
    case 'visa': return wrap('#1A1F71',
      <span style={{ fontStyle: 'italic', fontSize: w * 0.36, fontWeight: 800 }}>VISA</span>);
    case 'mc': return (
      <div style={{ width: w, height: h, background: '#fff', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', boxShadow: '0 1px 0 rgba(0,0,0,0.08)', padding: 4 }}>
        <svg width={w * 0.7} height={h * 0.7} viewBox="0 0 32 20">
          <circle cx="12" cy="10" r="8" fill="#EB001B" />
          <circle cx="20" cy="10" r="8" fill="#F79E1B" opacity="0.92" />
          <path d="M16 4.5a8 8 0 010 11" fill="none" stroke="#FF5F00" strokeWidth="0.6" />
        </svg>
      </div>);
    case 'amex': return wrap('#2E77BC',
      <span style={{ fontSize: w * 0.22, fontWeight: 800, letterSpacing: '0.02em' }}>AMEX</span>);
    default: return null;
  }
}

export function PaymentRow({
  size = 28,
  gap = 7,
  marks = ['apple', 'google', 'venmo', 'cashapp', 'paypal', 'visa', 'mc', 'amex'],
  align = 'center',
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: align,
      gap,
      flexWrap: 'wrap',
      flexShrink: 0,
    }}>
      {marks.map((k) => <PayMark key={k} kind={k} size={size} />)}
    </div>
  );
}

// ─ Print sheet (no crop ticks for production) ──────────────
export function PrintSheet({ width, height, children, style = {} }) {
  return (
    <div style={{ width, height, position: 'relative', background: '#fafafa', ...style }}>
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}

// ─ Backdrops ────────────────────────────────────────────────
export const PaperBg = ({ children, style }) => (
  <div style={{ position: 'absolute', inset: 0, background: 'var(--drb-paper)', ...style }}>
    {children}
  </div>
);

export const ChalkBg = ({ children, style }) => (
  <div style={{
    position: 'absolute', inset: 0,
    background: 'var(--drb-chalkboard)',
    color: 'var(--drb-cream-text)',
    ...style,
  }}>
    {children}
  </div>
);

// ─ Logo medallion ───────────────────────────────────────────
export function LogoMedallion({ size = 84 }) {
  // Logo already has its own gold ring + cream interior — drop straight onto bg.
  return (
    <img src="/tip-page/logo-gold.png" alt=""
      style={{ width: size, height: size, objectFit: 'contain', display: 'block' }} />
  );
}

// Shared label style for back-of-card info rows. EXPORTED (it was
// module-private in the old layouts file) because its only consumer,
// BizCardBack, now lives in a sibling module. camelCase: PascalCase on an
// exported non-component reads as a component to every reader and to the
// react/jsx-* rules.
export const labelStyle = {
  color: 'var(--drb-brass)',
  fontFamily: 'var(--drb-font-display)',
  letterSpacing: '0.2em',
  fontSize: 8,
  textTransform: 'uppercase',
};

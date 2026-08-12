// PaymentMarks.jsx — shared pieces for the bartender's printed tip sign and
// hand-out card.
//
// Uses the Dr. Bartender design system (drb-tokens.css):
//   chalkboard #12161C · paper #EDE6D6 · teal #1D8C89 · brass #B8924A
//
// Sizes are at 150 DPI of the actual print dimensions (see ./sizes.js).

import React from 'react';

// The tokens import lives HERE, not on a page, because every consumer of these
// pieces needs them and one of them renders off-screen for html2canvas capture.
// PrintTipCard.jsx used to be the only importer in the entire client; when that
// file was deleted the tokens would have gone with it, and the captured sign
// would have rendered colorless and flattened toward black in the JPEG.
import '../../../styles/drb-tokens.css';

// ─ Payment method marks ────────────────────────────────────
// Brand-suggestive reconstructions in each brand's own palette, NOT the
// official wordmarks. Recognition is the whole mechanism here: the tip-tray
// research measured a credit-card *emblem* raising tips, and initials on a
// tile carry none of that. Swap in each brand's official SVG from their press
// kit before any large print run; the tile geometry is built for it.
const SANS = {
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif",
  fontWeight: 700,
  lineHeight: 1,
  letterSpacing: '-0.02em',
};

const APPLE_D = 'M17.5 12.6c0-2.3 1.9-3.4 2-3.4-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.8-3.5.8-.8 0-1.9-.8-3.1-.8-1.6 0-3 .9-3.8 2.4-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 3 2.3 1.2 0 1.6-.8 3-.8 1.4 0 1.8.8 3 .8 1.3 0 2.1-1.1 2.9-2.3.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.5-.9-2.6-3.8zM15.2 5.7c.6-.8 1.1-1.9 1-3-1 0-2.2.6-2.9 1.4-.6.7-1.2 1.9-1 2.9 1.1.1 2.2-.5 2.9-1.3z';

const GOOGLE_PATHS = [
  ['#4285F4', 'M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9c-.3 1.4-1 2.6-2.2 3.4v2.8h3.6c2.1-2 3.2-4.9 3.2-8.2z'],
  ['#34A853', 'M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.6h-3.7v2.8C3.9 20.5 7.7 23 12 23z'],
  ['#FBBC04', 'M5.8 14c-.2-.7-.4-1.4-.4-2.1s.1-1.4.4-2.1V7H2.1c-.8 1.5-1.3 3.1-1.3 4.9s.5 3.4 1.3 4.9l3.7-2.8z'],
  ['#EA4335', 'M12 5.4c1.6 0 3.1.6 4.2 1.6l3.2-3.2C17.4 2 14.9 1 12 1 7.7 1 3.9 3.5 2.1 7l3.7 2.8c.9-2.7 3.3-4.4 6.2-4.4z'],
];

// `h` is the glyph height in px; the tile sizes itself around it.
function Glyph({ kind, h }) {
  switch (kind) {
    case 'apple':
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: h * 0.14 }}>
          <svg width={h * 0.92} height={h * 0.92} viewBox="0 0 24 24" fill="#000">
            <path d={APPLE_D} />
          </svg>
          <span style={{ ...SANS, fontSize: h * 0.78, color: '#000' }}>Pay</span>
        </span>
      );
    case 'google':
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: h * 0.16 }}>
          <svg width={h * 0.96} height={h * 0.96} viewBox="0 0 24 24">
            {GOOGLE_PATHS.map(([fill, d]) => <path key={fill} fill={fill} d={d} />)}
          </svg>
          <span style={{ ...SANS, fontSize: h * 0.78, color: '#3C4043' }}>Pay</span>
        </span>
      );
    case 'visa':
      return (
        <span style={{
          ...SANS, fontSize: h * 0.86, fontStyle: 'italic', fontWeight: 800,
          color: '#1A1F71', letterSpacing: '0.01em',
        }}>VISA</span>
      );
    case 'venmo':
      return (
        <span style={{ ...SANS, fontSize: h * 0.84, color: '#008CFF', letterSpacing: '-0.01em' }}>
          venmo
        </span>
      );
    case 'cashapp':
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: h * 0.2 }}>
          <span style={{
            ...SANS, width: h, height: h, borderRadius: h * 0.28,
            background: '#00D632', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: h * 0.66,
          }}>$</span>
          <span style={{ ...SANS, fontSize: h * 0.62, color: '#00A82D' }}>Cash App</span>
        </span>
      );
    case 'paypal':
      return (
        <span style={{ ...SANS, fontSize: h * 0.8, fontStyle: 'italic', color: '#003087' }}>
          Pay<span style={{ color: '#009CDE' }}>Pal</span>
        </span>
      );
    default:
      return null;
  }
}

// One mark on a cream tile. Cream, not white: the QR plate stays the brightest
// surface on the sheet, which is the whole point of the layout.
export function PayMark({ kind, height = 30, tileHeight = 48, radius = 8, padX = 14 }) {
  if (!kind) return null;
  return (
    <span style={{
      height: tileHeight,
      padding: `0 ${padX}px`,
      borderRadius: radius,
      background: 'var(--drb-paper)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 auto',
    }}>
      <Glyph kind={kind} h={height} />
    </span>
  );
}

export function PaymentRow({ marks = [], height = 30, tileHeight = 48, gap = 12, radius = 8, padX = 14, align = 'center' }) {
  if (!marks.length) return null;
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: align,
      flexWrap: 'wrap',
      gap,
      flexShrink: 0,
    }}>
      {marks.map((k) => (
        <PayMark key={k} kind={k} height={height} tileHeight={tileHeight} radius={radius} padX={padX} />
      ))}
    </div>
  );
}

// ─ Print sheet ─────────────────────────────────────────────
// Flat chalkboard to every edge. Load-bearing for display mode: the leftover
// bands from fitting a 2:3 sheet onto a tall phone are the same colour as the
// sheet, so they read as more sign rather than a frame.
export function PrintSheet({ width, height, children, style = {} }) {
  return (
    <div style={{
      width,
      height,
      position: 'relative',
      background: 'var(--drb-chalkboard)',
      ...style,
    }}>
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}

// A soft teal wash under the QR plate, gone long before the edge so it never
// disturbs the flat letterbox colour.
export function TealWash({ at = '50% 47%', size = 'ellipse 72% 44%' }) {
  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      background: `radial-gradient(${size} at ${at}, rgba(29,140,137,0.14) 0%, rgba(18,22,28,0) 66%)`,
      pointerEvents: 'none',
    }} />
  );
}

// ─ Logo lockup ─────────────────────────────────────────────
// Small and subordinate on purpose. It is a trust signal, not branding:
// guests hesitate to scan an unfamiliar QR, and a recognizable mark is what
// separates "a real business" from "a sticker someone put on the bar."
export function BrandLockup({ logo = 34, label = 15, gap = 10, opacity = 0.85 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap, opacity, flexShrink: 0 }}>
      <img
        src="/tip-page/logo-gold.png"
        alt=""
        style={{ width: logo, height: logo, objectFit: 'contain', display: 'block' }}
      />
      <span style={{
        fontFamily: 'var(--drb-font-display)',
        fontSize: label,
        letterSpacing: '0.28em',
        textTransform: 'uppercase',
        color: 'var(--drb-brass)',
      }}>Dr. Bartender</span>
    </div>
  );
}

// Shared label style for back-of-card info rows. camelCase: PascalCase on an
// exported non-component reads as a component to every reader.
export const labelStyle = {
  color: 'var(--drb-brass)',
  fontFamily: 'var(--drb-font-display)',
  letterSpacing: '0.2em',
  fontSize: 9,
  textTransform: 'uppercase',
};

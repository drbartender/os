// PaymentMarks.jsx — shared pieces for the printed tip sign and hand-out card.
//
// Uses the Dr. Bartender design system (drb-tokens.css):
//   chalkboard #12161C · paper #EDE6D6 · teal #1D8C89 · brass #B8924A

import React from 'react';

// The tokens import lives HERE, not on a page, because every consumer of these
// pieces needs them and one of them renders off-screen for html2canvas capture.
// PrintTipCard.jsx used to be the only importer in the entire client; when that
// file was deleted the tokens would have gone with it, and the captured sign
// would have rendered colorless and flattened toward black in the JPEG.
import '../../../styles/drb-tokens.css';

// ─ Payment method marks ────────────────────────────────────
// NO TILES. Each mark sits straight on the dark ground in its brand's own
// DARK-BACKGROUND artwork: white wordmarks, the full-colour Google G, the
// green Cash App icon. Cream chips behind them were our invention sitting
// between the guest and a mark they are supposed to recognise, and recognition
// is the entire mechanism (a credit-card emblem on a tip tray measurably
// raised tips, even from people paying cash).
//
// These are approximations of each brand's published lockup. Swap in the
// press-kit SVGs before any real print run, and do NOT recolour them.
const SANS = {
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, 'Liberation Sans', sans-serif",
  fontWeight: 700,
  lineHeight: 1,
  letterSpacing: '-0.02em',
  whiteSpace: 'nowrap',
};

// WHITE, not the sheet's cream. These are brand wordmarks reversed out on a
// dark ground, and every one of these brands publishes that reversal as pure
// white. Tinting them to match our paper is a recolour, which is the one thing
// the note above says not to do — and it is the difference between a mark a
// guest recognises instantly and one that reads as a lookalike.
const WHITE = '#FFFFFF';

const APPLE_D = 'M17.5 12.6c0-2.3 1.9-3.4 2-3.4-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.8-3.5.8-.8 0-1.9-.8-3.1-.8-1.6 0-3 .9-3.8 2.4-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 3 2.3 1.2 0 1.6-.8 3-.8 1.4 0 1.8.8 3 .8 1.3 0 2.1-1.1 2.9-2.3.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.5-.9-2.6-3.8zM15.2 5.7c.6-.8 1.1-1.9 1-3-1 0-2.2.6-2.9 1.4-.6.7-1.2 1.9-1 2.9 1.1.1 2.2-.5 2.9-1.3z';

const GOOGLE_PATHS = [
  ['#4285F4', 'M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9c-.3 1.4-1 2.6-2.2 3.4v2.8h3.6c2.1-2 3.2-4.9 3.2-8.2z'],
  ['#34A853', 'M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.6h-3.7v2.8C3.9 20.5 7.7 23 12 23z'],
  ['#FBBC04', 'M5.8 14c-.2-.7-.4-1.4-.4-2.1s.1-1.4.4-2.1V7H2.1c-.8 1.5-1.3 3.1-1.3 4.9s.5 3.4 1.3 4.9l3.7-2.8z'],
  ['#EA4335', 'M12 5.4c1.6 0 3.1.6 4.2 1.6l3.2-3.2C17.4 2 14.9 1 12 1 7.7 1 3.9 3.5 2.1 7l3.7 2.8c.9-2.7 3.3-4.4 6.2-4.4z'],
];

// `h` is the mark height in px; each lockup sizes itself around it.
export function PayMark({ kind, h = 34 }) {
  switch (kind) {
    case 'apple':
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: h * 0.14 }}>
          <svg width={h * 0.92} height={h * 0.92} viewBox="0 0 24 24" fill={WHITE}>
            <path d={APPLE_D} />
          </svg>
          <span style={{ ...SANS, fontSize: h * 0.78, color: WHITE }}>Pay</span>
        </span>
      );
    case 'google':
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: h * 0.16 }}>
          <svg width={h * 0.96} height={h * 0.96} viewBox="0 0 24 24">
            {GOOGLE_PATHS.map(([fill, d]) => <path key={fill} fill={fill} d={d} />)}
          </svg>
          <span style={{ ...SANS, fontSize: h * 0.78, color: WHITE }}>Pay</span>
        </span>
      );
    case 'visa':
      return (
        <span style={{
          ...SANS, fontSize: h * 0.86, fontStyle: 'italic', fontWeight: 800,
          color: WHITE, letterSpacing: '0.01em',
        }}>VISA</span>
      );
    case 'mc':
      // Mastercard's interlocking circles are the mark; they carry their own
      // colour on any ground, so this one is not reversed at all.
      return (
        <svg width={h * 1.6} height={h} viewBox="0 0 32 20">
          <circle cx="12" cy="10" r="9" fill="#EB001B" />
          <circle cx="20" cy="10" r="9" fill="#F79E1B" opacity="0.9" />
        </svg>
      );
    case 'amex':
      // Amex's own artwork IS a filled blue field with white lettering, so this
      // is not the tile vocabulary the note above rejects — it is the brand
      // mark. An outlined cream chip was our invention AND a recolour, and it
      // was the only bordered thing on either sheet.
      return (
        <span style={{
          ...SANS, fontSize: h * 0.5, color: WHITE,
          background: '#2E77BC',
          borderRadius: h * 0.14,
          padding: `${h * 0.16}px ${h * 0.26}px`,
          letterSpacing: '0.04em',
        }}>AMEX</span>
      );
    case 'venmo':
      return (
        <span style={{ ...SANS, fontSize: h * 0.84, color: WHITE, letterSpacing: '-0.01em' }}>
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
          <span style={{ ...SANS, fontSize: h * 0.62, color: WHITE }}>Cash App</span>
        </span>
      );
    case 'paypal':
      return (
        <span style={{ ...SANS, fontSize: h * 0.8, fontStyle: 'italic', color: WHITE }}>
          PayPal
        </span>
      );
    default:
      return null;
  }
}

// Rows come in pre-split (see splitMarkRows) so a row is never left holding a
// single orphaned mark.
export function PaymentRows({ rows = [], h = 34, gap = 36, rowGap = 22 }) {
  const real = rows.filter((r) => r.length > 0);
  if (!real.length) return null;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', gap: rowGap, flexShrink: 0,
    }}>
      {real.map((row) => (
        <div
          key={row.join('-')}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap }}
        >
          {row.map((k) => (
            <span key={k} style={{ height: h, display: 'flex', alignItems: 'center' }}>
              <PayMark kind={k} h={h} />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

// ─ Sheet + wash ────────────────────────────────────────────
// Flat chalkboard to every edge. Load-bearing for the phone display: the
// artwork and the page are the same colour, so nothing reads as a frame.
export function PrintSheet({ width, height, children, style = {} }) {
  return (
    <div style={{
      width, height, position: 'relative',
      background: 'var(--drb-chalkboard)',
      ...style,
    }}>
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}

export function TealWash({ at = '50% 47%', size = 'ellipse 72% 44%' }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `radial-gradient(${size} at ${at}, rgba(29,140,137,0.14) 0%, rgba(18,22,28,0) 66%)`,
      pointerEvents: 'none',
    }} />
  );
}

// ─ QR plate ────────────────────────────────────────────────
// The quiet zone IS the plate band: `pad` on all four sides of the code, and it
// must never be reduced below 4 modules. See sizes.js for the arithmetic.
// `glow` is off for the hand-out card: the sign and the phone are read across a
// dark room and the halo lifts the plate off the ground, but a soft cream
// gradient press-printed on a dark card is a banding and mottling risk for no
// gain in the hand.
export function QrPlate({ plate, pad, radius, glow = true, children }) {
  return (
    <div style={{
      width: plate, height: plate,
      background: 'var(--drb-paper)',
      borderRadius: radius,
      padding: pad,
      boxSizing: 'border-box',
      boxShadow: glow ? '0 0 80px rgba(240,232,214,0.14)' : 'none',
      flexShrink: 0,
    }}>
      {children}
    </div>
  );
}

// ─ Brand lockup ────────────────────────────────────────────
// Leads the sign now, at real size. Two jobs: it is a trust signal (people
// hesitate to scan an unfamiliar QR, and a recognisable mark separates a real
// business from a sticker someone stuck on the bar), and at this scale it is
// also what makes the sheet read as a designed object rather than a printout.
export function BrandLockup({ logo = 108, label = 54, gap = 22, tracking = '0.1em' }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap, flexShrink: 0,
    }}>
      <img
        src="/tip-page/logo-gold.png"
        alt=""
        style={{ width: logo, height: logo, objectFit: 'contain', display: 'block' }}
      />
      <span style={{
        fontFamily: 'var(--drb-font-display)',
        fontSize: label,
        letterSpacing: tracking,
        lineHeight: 1,
        color: 'var(--drb-brass)',
        whiteSpace: 'nowrap',
      }}>Dr. Bartender</span>
    </div>
  );
}

// PrintTipCard.layouts.jsx — print-ready frames for the bartender's QR display.
// Uses the Dr. Bartender design system (drb-tokens.css):
//   chalkboard #12161C · paper #EDE6D6 · teal #1D8C89 · brass #B8924A
//   Apothecary Teal flask-character logo at /tip-page/logo-gold.png
//
// Sizes are at 150 DPI of the actual print dimensions:
//   business card  3.5" × 2.0"  → 525 × 300
//   4 × 6 portrait               → 600 × 900
//   5 × 7 portrait               → 750 × 1050

import React from 'react';
import { QRCodeSVG } from 'qrcode.react';

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
    }}>
      {marks.map((k) => <PayMark key={k} kind={k} size={size} />)}
    </div>
  );
}

export function FlaskGlyph({ size = 36, color = 'var(--drb-brass)', glow = 'var(--drb-teal-light)' }) {
  return (
    <svg width={size} height={size * 1.15} viewBox="0 0 36 42" fill="none">
      {/* flask outline */}
      <path d="M14 4 L14 14 L7 28 Q5 34 11 36 L25 36 Q31 34 29 28 L22 14 L22 4 Z"
        stroke={color} strokeWidth="1.4" fill="none" strokeLinejoin="round" />
      <path d="M11 4 L25 4" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
      {/* liquid */}
      <path d="M9.5 22 Q12 24 14 22 Q16 20 18 22 Q20 24 22 22 Q24 20 26.5 22 L29 28 Q31 34 25 36 L11 36 Q5 34 7 28 Z"
        fill={glow} opacity="0.55" />
      {/* bubbles */}
      <circle cx="14" cy="29" r="1" fill={color} opacity="0.7" />
      <circle cx="20" cy="32" r="0.8" fill={color} opacity="0.7" />
    </svg>
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

// Headshot frame — gold ring on dark or paper
export function HeadshotFrame({ size = 130, src }) {
  return (
    <div style={{
      width: size, height: size,
      borderRadius: '50%',
      padding: 4,
      background: 'var(--drb-brass)',
      boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
    }}>
      <div style={{
        width: '100%', height: '100%',
        borderRadius: '50%',
        background: src
          ? `url(${src}) center/cover var(--drb-paper)`
          : 'var(--drb-paper)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative',
      }}>
        {!src && (
          <div style={{
            textAlign: 'center',
            fontFamily: 'var(--drb-font-display)',
            color: 'var(--drb-brass)',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            fontSize: size * 0.085,
            lineHeight: 1.3,
          }}>
            <div style={{ fontSize: size * 0.12, color: 'var(--drb-text-muted)', marginBottom: 4 }}>Your<br/>Headshot</div>
            <div style={{ fontSize: size * 0.07, fontStyle: 'italic', textTransform: 'none', color: 'var(--drb-text-muted)', letterSpacing: '0.04em' }}>upload at sign-up</div>
          </div>
        )}
      </div>
    </div>
  );
}

// Shared label style for back-of-card info rows
const LabelStyle = {
  color: 'var(--drb-brass)',
  fontFamily: 'var(--drb-font-display)',
  letterSpacing: '0.2em',
  fontSize: 8,
  textTransform: 'uppercase',
};

// ─ Business card · FRONT (Tip QR) ──────────────────────────
// 3.5" × 2"  landscape · 525 × 300 at 150dpi
const BIZ_MARKS = ['apple', 'venmo', 'cashapp', 'paypal', 'visa'];

export function BizCardFrontA({ name = 'your bartender', tipUrl = '', marks = null }) {
  // marks === null → no caller passed it: keep the original full row (back-compat).
  const shownMarks = marks == null ? BIZ_MARKS : BIZ_MARKS.filter((m) => marks.includes(m));
  return (
    <PrintSheet width={525} height={300}>
      <PaperBg />
      <div style={{
        position: 'absolute', inset: 14,
        border: '2px solid var(--drb-brass)',
        borderRadius: 8,
        display: 'grid',
        gridTemplateColumns: '1fr 156px',
        alignItems: 'center',
        padding: '0 22px',
        gap: 18,
      }}>
        <div style={{
          position: 'absolute', inset: 6,
          border: '1px solid var(--drb-brass)',
          opacity: 0.55,
          pointerEvents: 'none',
          borderRadius: 4,
        }} />
        {/* left — copy */}
        <div>
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: 9,
            letterSpacing: '0.32em',
            textTransform: 'uppercase',
            color: 'var(--drb-brass)',
            display: 'inline-flex', alignItems: 'center', gap: 8,
            marginBottom: 6,
          }}>
            <span style={{ width: 18, height: 1, background: 'var(--drb-brass)' }} />
            Dr. Bartender
            <span style={{ width: 18, height: 1, background: 'var(--drb-brass)' }} />
          </div>
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: 30,
            color: 'var(--drb-deep-brown)',
            letterSpacing: '0.02em',
            lineHeight: 1.05,
            marginBottom: 4,
          }}>Tip {name}</div>
          <div style={{
            fontFamily: 'var(--drb-font-body)',
            fontStyle: 'italic',
            fontSize: 11,
            color: 'var(--drb-text-muted)',
            marginBottom: 10,
          }}>your bartender tonight</div>
          <BrassRule width={70} />
          {shownMarks.length > 0 && (
            <>
              <div style={{
                fontFamily: 'var(--drb-font-display)',
                fontSize: 10,
                letterSpacing: '0.24em',
                textTransform: 'uppercase',
                color: 'var(--drb-warm-brown)',
                marginTop: 6,
                marginBottom: 6,
              }}>Scan to Tip</div>
              <PaymentRow size={20} gap={4} marks={shownMarks} align="flex-start" />
            </>
          )}
        </div>
        {/* right — QR plate */}
        <div style={{
          width: 138, height: 138,
          background: '#fff',
          border: '1.5px solid var(--drb-brass)',
          borderRadius: 6,
          padding: 7,
          justifySelf: 'center',
        }}>
          <QRCodeSVG value={tipUrl} size={124} bgColor="#FFFFFF" fgColor="#12161C" level="M" includeMargin={false} />
        </div>
      </div>
    </PrintSheet>
  );
}

// ─ Business card · BACK (contact info) ────────────────────
export function BizCardBackA({
  name = 'your bartender',
  title = 'Bartender',
  company = 'Dr. Bartender',
  tagline = 'Mobile Bar · Cocktail Lab',
  phone = '',
  email = '',
  web = 'drbartender.com',
  address = '',
}) {
  return (
    <PrintSheet width={525} height={300}>
      <ChalkBg />
      <div style={{
        position: 'absolute', inset: 14,
        border: '1.5px solid var(--drb-brass)',
        borderRadius: 8,
        display: 'grid',
        gridTemplateColumns: '104px 1fr',
        alignItems: 'center',
        padding: '0 20px',
        gap: 16,
        color: 'var(--drb-cream-text)',
      }}>
        <div style={{
          position: 'absolute', inset: 6,
          border: '1px solid var(--drb-brass)',
          opacity: 0.45,
          borderRadius: 4,
          pointerEvents: 'none',
        }} />
        {/* left — flask-character medallion (logo already includes gold ring) */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <LogoMedallion size={96} />
        </div>
        {/* right — info */}
        <div>
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: 8,
            letterSpacing: '0.34em',
            textTransform: 'uppercase',
            color: 'var(--drb-brass-bright)',
            marginBottom: 4,
          }}>{company}</div>
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: 22,
            letterSpacing: '0.02em',
            lineHeight: 1.05,
            color: 'var(--drb-cream-text)',
          }}>{name}</div>
          <div style={{
            fontFamily: 'var(--drb-font-body)',
            fontStyle: 'italic',
            fontSize: 11,
            color: 'var(--drb-teal-light)',
            marginBottom: 8,
          }}>{title}</div>
          <div style={{
            height: 1, width: 50,
            background: 'var(--drb-brass)',
            opacity: 0.55,
            margin: '0 0 8px',
          }} />
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            columnGap: 10,
            rowGap: 2,
            fontFamily: 'var(--drb-font-body)',
            fontSize: 10,
            lineHeight: 1.45,
            color: 'rgba(240,232,214,0.92)',
          }}>
            <span style={LabelStyle}>WEB</span>   <span>{web}</span>
            {phone && <><span style={LabelStyle}>TEL</span>   <span>{phone}</span></>}
            {email && <><span style={LabelStyle}>EMAIL</span> <span>{email}</span></>}
            {address && <><span style={LabelStyle}>BASE</span>  <span>{address}</span></>}
          </div>
          <div style={{
            fontFamily: 'var(--drb-font-body)',
            fontStyle: 'italic',
            fontSize: 9,
            color: 'rgba(240,232,214,0.55)',
            letterSpacing: '0.06em',
            marginTop: 8,
          }}>{tagline}</div>
        </div>
      </div>
    </PrintSheet>
  );
}

// ─ 4 × 6 portrait — single-sided tip collection ────────────
// 600 × 900 at 150dpi
const FEATURE_ROW_MARKS = ['apple', 'google', 'venmo', 'cashapp', 'paypal'];
const FEATURE_NET_MARKS = ['visa', 'mc', 'amex'];

export function FourBySixA({ name = 'your bartender', tipUrl = '', marks = null }) {
  const rowMarks = marks == null ? FEATURE_ROW_MARKS : FEATURE_ROW_MARKS.filter((m) => marks.includes(m));
  const netMarks = marks == null ? FEATURE_NET_MARKS : FEATURE_NET_MARKS.filter((m) => marks.includes(m));
  const showPayCard = rowMarks.length > 0 || netMarks.length > 0;
  return (
    <PrintSheet width={600} height={900}>
      <PaperBg />
      <ChalkBg style={{
        bottom: 'auto', height: 240,
        borderBottom: '2px solid var(--drb-brass)',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '0 32px',
          textAlign: 'center',
        }}>
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: 11,
            letterSpacing: '0.4em',
            textTransform: 'uppercase',
            color: 'var(--drb-brass-bright)',
            display: 'inline-flex', alignItems: 'center', gap: 14,
            marginBottom: 14,
          }}>
            <span style={{ width: 26, height: 1, background: 'var(--drb-brass)', opacity: 0.7 }} />
            Dr. Bartender
            <span style={{ width: 26, height: 1, background: 'var(--drb-brass)', opacity: 0.7 }} />
          </div>
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: 40,
            letterSpacing: '0.025em',
            lineHeight: 1.05,
            color: 'var(--drb-cream-text)',
            marginBottom: 6,
          }}>Cheers from<br/>Behind the Bar</div>
        </div>
      </ChalkBg>

      {/* headshot overlap */}
      <div style={{
        position: 'absolute',
        top: 240 - 56, left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2,
      }}>
        <HeadshotFrame size={112} />
      </div>

      <div style={{
        position: 'absolute',
        top: 240, left: 0, right: 0, bottom: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center',
        padding: '70px 36px 32px',
        textAlign: 'center',
      }}>
        <div style={{
          fontFamily: 'var(--drb-font-display)',
          fontSize: 32,
          color: 'var(--drb-deep-brown)',
          letterSpacing: '0.03em',
          marginBottom: 4,
        }}>Tip {name}</div>
        <div style={{
          fontFamily: 'var(--drb-font-body)',
          fontStyle: 'italic',
          fontSize: 14,
          color: 'var(--drb-text-muted)',
          marginBottom: 18,
        }}>your bartender tonight</div>
        <BrassRule width={150} />
        <div style={{
          marginTop: 24,
          width: 290, height: 290,
          background: '#fff',
          border: '2px solid var(--drb-brass)',
          borderRadius: 10,
          padding: 14,
          boxShadow: '0 6px 20px rgba(0,0,0,0.08)',
        }}>
          <QRCodeSVG value={tipUrl} size={262} bgColor="#FFFFFF" fgColor="#12161C" level="M" includeMargin={false} />
        </div>
        <div style={{
          marginTop: 22,
          fontFamily: 'var(--drb-font-display)',
          fontSize: 14,
          letterSpacing: '0.32em',
          textTransform: 'uppercase',
          color: 'var(--drb-warm-brown)',
          marginBottom: 14,
        }}>Scan to Tip</div>

        {/* Payment methods — feature row (only the methods this bartender has) */}
        {showPayCard && (
          <div style={{
            background: 'var(--drb-card-bg)',
            border: '1.5px solid var(--drb-brass)',
            borderRadius: 10,
            padding: '12px 16px',
            width: '100%',
          }}>
            <div style={{
              fontFamily: 'var(--drb-font-display)',
              fontSize: 8,
              letterSpacing: '0.28em',
              textTransform: 'uppercase',
              color: 'var(--drb-brass)',
              textAlign: 'center',
              marginBottom: 8,
            }}>Pay any way you like</div>
            {rowMarks.length > 0 && <PaymentRow size={32} gap={8} marks={rowMarks} />}
            {rowMarks.length > 0 && netMarks.length > 0 && <div style={{ height: 8 }} />}
            {netMarks.length > 0 && <PaymentRow size={26} gap={8} marks={netMarks} />}
          </div>
        )}

        <div style={{ flex: 1 }} />
        <div style={{
          fontFamily: 'var(--drb-font-body)',
          fontSize: 10,
          color: 'var(--drb-text-muted)',
          opacity: 0.7,
          letterSpacing: '0.06em',
          fontStyle: 'italic',
        }}>drbartender.com · Mobile Bar · Cocktail Lab</div>
      </div>
    </PrintSheet>
  );
}

// ─ 5 × 7 portrait — single-sided tip collection ────────────
// 750 × 1050 at 150dpi
export function FiveBySevenA({ name = 'your bartender', tipUrl = '', marks = null }) {
  const rowMarks = marks == null ? FEATURE_ROW_MARKS : FEATURE_ROW_MARKS.filter((m) => marks.includes(m));
  const netMarks = marks == null ? FEATURE_NET_MARKS : FEATURE_NET_MARKS.filter((m) => marks.includes(m));
  const showPayCard = rowMarks.length > 0 || netMarks.length > 0;
  return (
    <PrintSheet width={750} height={1050}>
      <PaperBg />
      <ChalkBg style={{
        bottom: 'auto', height: 220,
        borderBottom: '2px solid var(--drb-brass)',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '0 32px',
          textAlign: 'center',
        }}>
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: 11,
            letterSpacing: '0.4em',
            textTransform: 'uppercase',
            color: 'var(--drb-brass-bright)',
            marginBottom: 12,
          }}>Dr. Bartender</div>
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: 34,
            letterSpacing: '0.025em',
            lineHeight: 1.1,
            color: 'var(--drb-cream-text)',
          }}>Cheers from Behind the Bar</div>
        </div>
      </ChalkBg>

      {/* headshot overlap */}
      <div style={{
        position: 'absolute',
        top: 220 - 70, left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2,
      }}>
        <HeadshotFrame size={140} />
      </div>

      <div style={{
        position: 'absolute',
        top: 220, left: 0, right: 0, bottom: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center',
        padding: '82px 40px 32px',
        textAlign: 'center',
      }}>
        <div style={{
          fontFamily: 'var(--drb-font-display)',
          fontSize: 38,
          color: 'var(--drb-deep-brown)',
          letterSpacing: '0.03em',
          marginBottom: 4,
        }}>Tip {name}</div>
        <div style={{
          fontFamily: 'var(--drb-font-body)',
          fontStyle: 'italic',
          fontSize: 16,
          color: 'var(--drb-text-muted)',
          marginBottom: 18,
        }}>your bartender tonight</div>
        <BrassRule width={170} />

        <div style={{
          marginTop: 28,
          width: 380, height: 380,
          background: '#fff',
          border: '2px solid var(--drb-brass)',
          borderRadius: 12,
          padding: 16,
          boxShadow: '0 8px 24px rgba(0,0,0,0.10)',
        }}>
          <QRCodeSVG value={tipUrl} size={346} bgColor="#FFFFFF" fgColor="#12161C" level="M" includeMargin={false} />
        </div>

        <div style={{
          marginTop: 26,
          fontFamily: 'var(--drb-font-display)',
          fontSize: 16,
          letterSpacing: '0.36em',
          textTransform: 'uppercase',
          color: 'var(--drb-warm-brown)',
          marginBottom: 16,
        }}>Scan to Tip</div>

        {/* Payment methods — feature card (only the methods this bartender has) */}
        {showPayCard && (
          <div style={{
            background: 'var(--drb-card-bg)',
            border: '1.5px solid var(--drb-brass)',
            borderRadius: 10,
            padding: '14px 18px',
            width: '100%',
          }}>
            <div style={{
              fontFamily: 'var(--drb-font-display)',
              fontSize: 9,
              letterSpacing: '0.32em',
              textTransform: 'uppercase',
              color: 'var(--drb-brass)',
              textAlign: 'center',
              marginBottom: 10,
            }}>Pay any way you like</div>
            {rowMarks.length > 0 && <PaymentRow size={38} gap={10} marks={rowMarks} />}
            {rowMarks.length > 0 && netMarks.length > 0 && <div style={{ height: 8 }} />}
            {netMarks.length > 0 && <PaymentRow size={28} gap={10} marks={netMarks} />}
          </div>
        )}

        <div style={{ flex: 1 }} />
        <div style={{
          fontFamily: 'var(--drb-font-body)',
          fontSize: 10,
          color: 'var(--drb-text-muted)',
          opacity: 0.7,
          letterSpacing: '0.06em',
          fontStyle: 'italic',
        }}>drbartender.com · Mobile Bar · Cocktail Lab</div>
      </div>
    </PrintSheet>
  );
}

// BizCardLayout.jsx — the two-sided hand-out card. Moved verbatim out of
// PrintTipCard.layouts.jsx 2026-08-11 (BizCardFrontA / BizCardBackA), with the
// QR swapped from SVG to canvas for html2canvas fidelity and the literal
// 525x300 replaced by CARD_SIZE.
//
// This is a different object from the bar sign: it goes to a print shop as a
// PDF (front and back on pages 1 and 2), never to a photo counter as an image.

import React from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { CARD_SIZE } from './sizes';
import {
  PrintSheet, PaperBg, ChalkBg, BrassRule, PaymentRow, LogoMedallion, labelStyle,
} from './PaymentMarks';

// ─ Business card · FRONT (Tip QR) ──────────────────────────
// 3.5" × 2"  landscape · 525 × 300 at 150dpi
const BIZ_MARKS = ['apple', 'venmo', 'cashapp', 'paypal', 'visa'];

export function BizCardFront({ name = 'your bartender', tipUrl = '', marks = null }) {
  // marks === null → no caller passed it: keep the original full row (back-compat).
  const shownMarks = marks == null ? BIZ_MARKS : BIZ_MARKS.filter((m) => marks.includes(m));
  return (
    <PrintSheet width={CARD_SIZE.w} height={CARD_SIZE.h}>
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
          {/* 2x backing store, 1x display — see the note in SignLayout.jsx. */}
          <QRCodeCanvas
            value={tipUrl}
            size={248}
            style={{ width: 124, height: 124 }}
            bgColor="#FFFFFF" fgColor="#12161C" level="M"
          />
        </div>
      </div>
    </PrintSheet>
  );
}

// ─ Business card · BACK (contact info) ────────────────────
export function BizCardBack({
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
    <PrintSheet width={CARD_SIZE.w} height={CARD_SIZE.h}>
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
            <span style={labelStyle}>WEB</span>   <span>{web}</span>
            {phone && <><span style={labelStyle}>TEL</span>   <span>{phone}</span></>}
            {email && <><span style={labelStyle}>EMAIL</span> <span>{email}</span></>}
            {address && <><span style={labelStyle}>BASE</span>  <span>{address}</span></>}
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

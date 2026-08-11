// SignLayout.jsx — the bar sign a bartender downloads and prints at a photo
// counter, and the same artwork display mode scales onto a phone or tablet.
//
// One component covers both sizes. The old FourBySixA / FiveBySevenA were
// near-duplicates differing only in numbers, so the numbers live in METRICS.

import React from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { SIGN_SIZES } from './sizes';
import { PrintSheet, PaperBg, ChalkBg, BrassRule, PaymentRow } from './PaymentMarks';

const METRICS = {
  '4x6': {
    bandHeight: 240, eyebrow: 11, headline: 40, rule: 150,
    name: 32, sub: 14, qrPlate: 290, qr: 262, cta: 14,
    padTop: 44, padX: 36, rowSize: 32, netSize: 26, gap: 8,
    headlineBreak: true,
  },
  '5x7': {
    bandHeight: 220, eyebrow: 11, headline: 34, rule: 170,
    name: 38, sub: 16, qrPlate: 380, qr: 346, cta: 16,
    padTop: 52, padX: 40, rowSize: 38, netSize: 28, gap: 10,
    // The 5x7's wider band fits the headline on one line; the 4x6's does not.
    // Collapsing the two components hardcoded the 4x6's break onto both.
    headlineBreak: false,
  },
};

const ROW_MARKS = ['apple', 'google', 'venmo', 'cashapp', 'paypal'];
const NET_MARKS = ['visa', 'mc', 'amex'];

export default function SignLayout({
  size = '4x6',
  name = 'your bartender',
  tipUrl = '',
  marks = null,
}) {
  const S = SIGN_SIZES[size] || SIGN_SIZES['4x6'];
  const M = METRICS[size] || METRICS['4x6'];
  // marks === null → no caller passed it: keep the full row (back-compat).
  const rowMarks = marks == null ? ROW_MARKS : ROW_MARKS.filter((m) => marks.includes(m));
  const netMarks = marks == null ? NET_MARKS : NET_MARKS.filter((m) => marks.includes(m));
  const showMarks = rowMarks.length > 0 || netMarks.length > 0;

  return (
    <PrintSheet width={S.w} height={S.h}>
      <PaperBg />
      <ChalkBg style={{
        bottom: 'auto', height: M.bandHeight,
        borderBottom: '2px solid var(--drb-brass)',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '0 32px',
          textAlign: 'center',
        }}>
          {/* The eyebrow's two flanking hairlines are the spec's "second
              decorative rule" and are cut. The 5x7 never had them. */}
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: M.eyebrow,
            letterSpacing: '0.4em',
            textTransform: 'uppercase',
            color: 'var(--drb-brass-bright)',
            marginBottom: 14,
          }}>Dr. Bartender</div>
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: M.headline,
            letterSpacing: '0.025em',
            lineHeight: 1.05,
            color: 'var(--drb-cream-text)',
          }}>
            {M.headlineBreak ? <>Cheers from<br/>Behind the Bar</> : 'Cheers from Behind the Bar'}
          </div>
        </div>
      </ChalkBg>

      {/* No headshot. It rendered a placeholder reading "Your Headshot, upload
          at sign-up" on a card a guest holds. padTop dropped from 70/82 to
          44/52 because that padding existed only to clear its overhang. */}
      <div style={{
        position: 'absolute',
        top: M.bandHeight, left: 0, right: 0, bottom: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center',
        padding: `${M.padTop}px ${M.padX}px 32px`,
        textAlign: 'center',
      }}>
        <div style={{
          fontFamily: 'var(--drb-font-display)',
          fontSize: M.name,
          color: 'var(--drb-deep-brown)',
          letterSpacing: '0.03em',
          marginBottom: 4,
          flexShrink: 0,
        }}>Tip {name}</div>
        <div style={{
          fontFamily: 'var(--drb-font-body)',
          fontStyle: 'italic',
          fontSize: M.sub,
          color: 'var(--drb-text-muted)',
          marginBottom: 18,
          flexShrink: 0,
        }}>your bartender tonight</div>

        {/* flexShrink wrapper: BrassRule takes no style prop, and inside a flex
            column an svg with no flex-shrink guard collapses to zero height,
            which is why this divider rendered as nothing. */}
        <div style={{ flexShrink: 0, lineHeight: 0 }}>
          <BrassRule width={M.rule} />
        </div>

        <div style={{
          marginTop: 24,
          width: M.qrPlate, height: M.qrPlate,
          background: '#fff',
          border: '2px solid var(--drb-brass)',
          borderRadius: 10,
          padding: 14,
          boxShadow: '0 6px 20px rgba(0,0,0,0.08)',
          flexShrink: 0,
        }}>
          {/* Canvas, not SVG: html2canvas is far more reliable with a canvas,
              and a QR that renders on screen but fails on paper is a defect
              that reaches a bartender before it reaches us. */}
          {/* Rendered at 2x and displayed at 1x. qrcode.react sizes the canvas
              backing store to `size * devicePixelRatio` (qrcode.react/lib
              index.js:1016), so on a 1x display a `size={M.qr}` QR is a 262px
              bitmap that html2canvas then UPSCALES 2x — the one element in the
              sign carrying 150 DPI inside a 300 DPI file, and silently
              dependent on which monitor the bartender used. A caller `style`
              wins over the library's own (index.js:1051), so this keeps the
              layout identical while making the capture a 1:1 pixel copy. */}
          <QRCodeCanvas
            value={tipUrl}
            size={M.qr * 2}
            style={{ width: M.qr, height: M.qr }}
            bgColor="#FFFFFF"
            fgColor="#12161C"
            level="M"
          />
        </div>

        <div style={{
          marginTop: 22,
          fontFamily: 'var(--drb-font-display)',
          fontSize: M.cta,
          letterSpacing: '0.32em',
          textTransform: 'uppercase',
          color: 'var(--drb-warm-brown)',
          marginBottom: 14,
          flexShrink: 0,
        }}>Scan to Tip</div>

        {/* Marks only, no bordered "Pay any way you like" panel: it competed
            with the QR, which is the one thing the sign exists to point at. */}
        {showMarks && (
          <>
            {rowMarks.length > 0 && (
              <PaymentRow size={M.rowSize} gap={M.gap} marks={rowMarks} />
            )}
            {rowMarks.length > 0 && netMarks.length > 0 && (
              <div style={{ height: 8, flexShrink: 0 }} />
            )}
            {netMarks.length > 0 && (
              <PaymentRow size={M.netSize} gap={M.gap} marks={netMarks} />
            )}
          </>
        )}

        <div style={{ flex: 1 }} />
        <div style={{
          fontFamily: 'var(--drb-font-body)',
          fontSize: 10,
          color: 'var(--drb-text-muted)',
          opacity: 0.7,
          letterSpacing: '0.06em',
          fontStyle: 'italic',
          flexShrink: 0,
        }}>drbartender.com · Mobile Bar · Cocktail Lab</div>
      </div>
    </PrintSheet>
  );
}

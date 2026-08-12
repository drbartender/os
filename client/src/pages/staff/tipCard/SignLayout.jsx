// SignLayout.jsx — the bar sign a bartender downloads and prints at a photo
// counter, and the same artwork display mode scales onto a phone or tablet.
//
// Dark chalkboard with a large white QR plate. The plate is the brightest
// thing on the sheet so the eye and the phone camera both land on it in dim
// bar light, and the sheet is flat chalkboard to every edge so display mode's
// letterbox bands read as more sign rather than a frame.

import React, { useEffect, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { SIGN_SIZES } from './sizes';
import { PrintSheet, TealWash, PaymentRow, BrandLockup } from './PaymentMarks';

const METRICS = {
  '5x7': {
    nameSteps: [82, 70, 58],
    nameMaxW: 622,
    qrPlate: 520, qrPad: 20, qrRadius: 12,
    cta: 30, reason: 21, reasonMaxW: 560,
    markHeight: 30, markTile: 48, markGap: 12,
    pad: 64,
  },
};

// One shared measuring context; creating a canvas per render is wasteful and
// the font string is all that varies.
const NAME_LETTER_SPACING = '0.015em';

let measureCtx = null;
function fitFontSize(text, steps, maxWidth) {
  if (typeof document === 'undefined') return { size: steps[0], wrap: 'nowrap' };
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  for (const size of steps) {
    // The font stack and the letter-spacing must match what actually renders.
    // Measuring without the tracking under-reports by ~3.2%, so a name that
    // "fits" 622px renders past 640 and spills into the print margin.
    measureCtx.font = `400 ${size}px "IM Fell English SC", "IM Fell English", Georgia, serif`;
    measureCtx.letterSpacing = NAME_LETTER_SPACING;
    if (measureCtx.measureText(text).width <= maxWidth) return { size, wrap: 'nowrap' };
  }
  // Longer than the smallest step: let it wrap rather than overflow the sheet.
  return { size: steps[steps.length - 1], wrap: 'normal' };
}

export default function SignLayout({
  size = '5x7',
  name = 'your bartender',
  tipUrl = '',
  marks = null,
}) {
  const S = SIGN_SIZES[size] || SIGN_SIZES['5x7'];
  const M = METRICS[size] || METRICS['5x7'];

  // Re-measure once the display face actually loads. Measuring against the
  // Georgia fallback picks a size that is wrong for IM Fell, and the capture
  // path waits for fonts before it shoots, so the render must too.
  // The state value itself is never read; bumping it is purely the re-render
  // signal that makes the measurement run again against the real font.
  const [, remeasure] = useState(0);
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts?.ready) return undefined;
    let cancelled = false;
    document.fonts.ready.then(() => { if (!cancelled) remeasure((t) => t + 1); });
    return () => { cancelled = true; };
  }, []);

  // Not memoized: two measureText calls per render is cheaper than the memo
  // bookkeeping, and it re-runs naturally when the font-ready bump lands.
  const nameFit = fitFontSize(name, M.nameSteps, M.nameMaxW);

  const shown = marks == null ? [] : marks;

  return (
    <PrintSheet width={S.w} height={S.h}>
      <TealWash />
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: M.pad,
        textAlign: 'center',
      }}>
        <div style={{
          fontFamily: 'var(--drb-font-display)',
          fontSize: nameFit.size,
          lineHeight: 1.04,
          letterSpacing: NAME_LETTER_SPACING,
          color: 'var(--drb-cream-text)',
          whiteSpace: nameFit.wrap,
          // A single long token has no space to break at, so whiteSpace alone
          // lets it run off both edges and get clipped mid-word by the sheet.
          overflowWrap: 'anywhere',
          maxWidth: M.nameMaxW,
          flexShrink: 0,
        }}>{name}</div>

        <div style={{
          marginTop: 28,
          width: M.qrPlate, height: M.qrPlate,
          background: '#FFFFFF',
          borderRadius: M.qrRadius,
          padding: M.qrPad,
          boxShadow: '0 0 80px rgba(240,232,214,0.16)',
          flexShrink: 0,
        }}>
          {/* Level Q, not M: standard for signage, and this object gets picked
              up, handled, and set down in wet places.
              marginSize 4 is the quiet zone. qrcode.react defaults it to ZERO,
              so without this the plate padding is the only clear space and the
              code sits tighter than the spec allows.
              Rendered at 2x and displayed at 1x: qrcode.react sizes the canvas
              backing store to size * devicePixelRatio, so on a 1x display a
              1x QR is a bitmap html2canvas then UPSCALES, putting 150 DPI of
              real information inside a 300 DPI file. */}
          <QRCodeCanvas
            value={tipUrl}
            size={(M.qrPlate - M.qrPad * 2) * 2}
            style={{ width: M.qrPlate - M.qrPad * 2, height: M.qrPlate - M.qrPad * 2 }}
            bgColor="#FFFFFF"
            fgColor="#12161C"
            level="Q"
            marginSize={4}
          />
        </div>

        <div style={{
          marginTop: 24,
          fontFamily: 'var(--drb-font-display)',
          fontSize: M.cta,
          letterSpacing: '0.03em',
          color: 'var(--drb-cream-text)',
          flexShrink: 0,
        }}>Tip your bartender</div>

        {/* The reason, not just the instruction. Tested tipping research finds
            a reason to tip raises the amount where a bare instruction does
            not, and this one is tense-neutral so it reads correctly to a guest
            who has not been served yet. Dr. Bartender takes no cut. */}
        <div style={{
          marginTop: 8,
          fontFamily: 'var(--drb-font-body)',
          fontSize: M.reason,
          lineHeight: 1.4,
          color: 'rgba(240,232,214,0.8)',
          maxWidth: M.reasonMaxW,
          flexShrink: 0,
        }}>Every scan goes straight to me.</div>

        {shown.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <PaymentRow
              marks={shown}
              height={M.markHeight}
              tileHeight={M.markTile}
              gap={M.markGap}
            />
          </div>
        )}

        <div style={{ marginTop: 18 }}>
          <BrandLockup />
        </div>
      </div>
    </PrintSheet>
  );
}

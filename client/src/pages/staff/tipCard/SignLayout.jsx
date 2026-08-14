// SignLayout.jsx — the 5 x 7 bar sign a bartender downloads and prints at a
// photo counter.
//
// Exactly 5 x 7 with the content inset from the trim edge, NOT a bleed
// artboard: a photo counter prints an image at a named size and never trims to
// marks, so an oversized sheet comes back cropped or letterboxed. The inset is
// what gives an acrylic frame lip something to overlap.
//
// The brand lockup leads at real size, the plate is the brightest thing on the
// sheet, and the marks sit straight on the ground with no chips behind them.

import React from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { SIGN_SIZES, SIGN_INSET, SIGN_QR } from './sizes';
import { PrintSheet, TealWash, QrPlate, PaymentRows, BrandLockup } from './PaymentMarks';
import { splitMarkRows } from '../../../utils/tipCardMarks';
import { useFontsReady, fitFontSize, DISPLAY_TRACKING } from './typeFit';

const NAME_STEPS = [82, 70, 58];

export default function SignLayout({
  size = '5x7',
  name = 'your bartender',
  tipUrl = '',
  marks = null,
}) {
  const S = SIGN_SIZES[size] || SIGN_SIZES['5x7'];
  useFontsReady();

  // The content box, derived — NOT a hand-carried constant. The design's 622
  // was 16px wider than the 606 the inset actually leaves, so a name landing in
  // that window measured as fitting and then rendered into the frame-lip
  // margin the inset exists to protect.
  const nameMaxW = S.w - SIGN_INSET.x * 2;
  const nameFit = fitFontSize(name, NAME_STEPS, nameMaxW);
  const code = SIGN_QR.plate - SIGN_QR.pad * 2;
  const rows = splitMarkRows(marks || [], 5);

  return (
    <PrintSheet width={S.w} height={S.h}>
      <TealWash />
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: `${SIGN_INSET.y}px ${SIGN_INSET.x}px`,
        textAlign: 'center',
      }}>
        <BrandLockup />

        <div style={{
          marginTop: 40,
          fontFamily: 'var(--drb-font-display)',
          fontSize: nameFit.size,
          lineHeight: 1.04,
          letterSpacing: DISPLAY_TRACKING,
          color: 'var(--drb-cream-text)',
          whiteSpace: nameFit.wrap,
          // A single long token has no space to break at, so whiteSpace alone
          // lets it run off both edges and get clipped by the sheet.
          overflowWrap: 'anywhere',
          maxWidth: nameMaxW,
          flexShrink: 0,
        }}>{name}</div>

        <div style={{ marginTop: 24 }}>
          <QrPlate plate={SIGN_QR.plate} pad={SIGN_QR.pad} radius={SIGN_QR.radius}>
            {/* Level Q for signage. marginSize 0 because the quiet zone is the
                plate band (sizes.js sizes it to 4 modules); adding the SVG
                margin on top would double it and shrink the code.
                Rendered at 2x and displayed at 1x: qrcode.react sizes the
                canvas backing store to size * devicePixelRatio, so a 1x QR on
                a 1x display is a bitmap html2canvas then UPSCALES, putting 150
                DPI of real information inside a 300 DPI file. */}
            <QRCodeCanvas
              value={tipUrl}
              size={code * 2}
              style={{ width: code, height: code, display: 'block' }}
              bgColor="#EDE6D6"
              fgColor="#12161C"
              level="Q"
              marginSize={0}
            />
          </QrPlate>
        </div>

        {/* Answers the objection that actually stops someone, rather than
            instructing them. Tense-neutral on purpose: a sign sits out all
            night and is read by people who have not been served yet, and
            pre-service tip asks measurably lower both tips and ratings. */}
        <div style={{
          marginTop: 48,
          fontFamily: 'var(--drb-font-display)',
          fontSize: 40,
          letterSpacing: '0.03em',
          lineHeight: 1,
          color: 'var(--drb-brass)',
          flexShrink: 0,
        }}>No cash? No problem.</div>

        <div style={{
          marginTop: 8,
          fontFamily: 'var(--drb-font-body)',
          fontSize: 22,
          lineHeight: 1.4,
          color: 'rgba(240,232,214,0.78)',
          flexShrink: 0,
        }}>Every scan goes straight to me.</div>

        {/* gap 30, not the design's 36. The widest real rail is the bartender
            running all three P2P handles (Apple, Google, venmo, Cash App,
            PayPal): 476.8px of marks, which at 36 needs 620.8px and overflows
            the 606px the inset leaves. 30 lands it at 596.8 with ~9px to
            spare, and every narrower combination gains margin. The marks
            themselves keep their designed height. */}
        {rows.length > 0 && (
          <div style={{ marginTop: 64 }}>
            <PaymentRows rows={rows} h={34} gap={30} />
          </div>
        )}
      </div>
    </PrintSheet>
  );
}

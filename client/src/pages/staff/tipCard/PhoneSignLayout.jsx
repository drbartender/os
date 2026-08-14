// PhoneSignLayout.jsx — the tip sign laid out for a propped-up phone or
// tablet, at that device's own proportions.
//
// NOT the 5 x 7 scaled down. Fitting a 5:7 sheet onto a 9:19.5 phone letterboxes
// away most of the screen and shrinks the QR, which is backwards: a QR on a
// stranger's phone is exactly where the code needs to be biggest and the brand
// mark needs to be most legible.
//
// The cost of the split is real and worth naming: this and SignLayout are now
// two layouts carrying the same message, so a copy change has to land in both.
// They deliberately share the mark vocabulary, the plate, and the lockup from
// PaymentMarks so only the composition differs.

import React, { useEffect, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { TealWash, PaymentRows, BrandLockup } from './PaymentMarks';
import { splitMarkRows } from '../../../utils/tipCardMarks';
import { useFontsReady, fitFontSize } from './typeFit';

// The plate scales with the viewport rather than sitting at a fixed pixel size,
// so a tablet gets a genuinely larger code instead of a phone-sized one
// floating in the middle. The quiet zone is the plate band and stays
// proportional: 11% of the plate is comfortably past the 4 modules a 37-module
// code needs.
const PLATE = 'min(72vw, 42vh, 380px)';
const PLATE_PAD = 'min(8vw, 4.6vh, 42px)';

// The name steps down like the printed sign's rather than riding a raw `vw`
// size. A propped tablet is read from across a bar, so a long name that wraps
// to two lines both shrinks the plate's share of the screen and shifts the
// whole stack; stepping the type down holds the composition instead.
const NAME_VW = 0.11;
const NAME_MAX_PX = 44;
const NAME_STEP = 0.86;

// The stack's own horizontal padding, in ONE place, because the name box is
// derived from it rather than hand-carried. A hardcoded 86vw is wider than the
// container below ~375pt (320pt leaves 268, not 275.2), which is exactly the
// measured-wider-than-it-renders bug the sign just shed by deriving its box
// from the print inset.
const STACK_PAD_X = 26;

function useViewportWidth() {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 390 : window.innerWidth));
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    // A propped device gets rotated; iOS Safari fires orientationchange before
    // innerWidth settles, so resize is the one that lands, and this is only a
    // belt-and-braces second trigger.
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return w;
}

export default function PhoneSignLayout({ name = 'your bartender', tipUrl = '', marks = null }) {
  const rows = splitMarkRows(marks || [], 5);
  useFontsReady();
  const vw = useViewportWidth();

  const base = Math.min(vw * NAME_VW, NAME_MAX_PX);
  const steps = [base, base * NAME_STEP, base * NAME_STEP * NAME_STEP];
  // Measured at ZERO tracking because this surface renders at zero tracking:
  // the sign's name is tracked, the phone's is not. Measuring with the sign's
  // value here would over-report and step the name down a size early.
  const nameBoxW = vw - STACK_PAD_X * 2;
  const nameFit = fitFontSize(name, steps, nameBoxW, '0px');

  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      textAlign: 'center',
      padding: `max(26px, 4vh) ${STACK_PAD_X}px`,
      boxSizing: 'border-box',
      overflow: 'hidden',
    }}>
      <TealWash at="50% 40%" size="ellipse 90% 38%" />

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <BrandLockup logo={58} label={29} gap={12} tracking="0.08em" />

        <div style={{
          marginTop: 24,
          fontFamily: 'var(--drb-font-display)',
          fontSize: nameFit.size,
          lineHeight: 1.05,
          color: 'var(--drb-cream-text)',
          maxWidth: nameBoxW,
          whiteSpace: nameFit.wrap,
          overflowWrap: 'anywhere',
        }}>{name}</div>

        <div style={{
          marginTop: 18,
          width: PLATE,
          height: PLATE,
          background: 'var(--drb-paper)',
          borderRadius: 12,
          padding: PLATE_PAD,
          boxSizing: 'border-box',
          boxShadow: '0 0 50px rgba(240,232,214,0.14)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {/* level Q, and marginSize 0 because the plate band IS the quiet
              zone. `size` is a generous fixed backing store scaled down by CSS
              to whatever the viewport gives it, so the code stays crisp on a
              high-DPR screen instead of being upscaled. */}
          <QRCodeCanvas
            value={tipUrl}
            size={720}
            style={{ width: '100%', height: '100%', display: 'block' }}
            bgColor="#EDE6D6"
            fgColor="#12161C"
            level="Q"
            marginSize={0}
          />
        </div>

        <div style={{
          marginTop: 36,
          fontFamily: 'var(--drb-font-display)',
          fontSize: 'min(6.2vw, 24px)',
          letterSpacing: '0.02em',
          lineHeight: 1,
          color: 'var(--drb-brass)',
        }}>No cash? No problem.</div>

        <div style={{
          marginTop: 6,
          fontFamily: 'var(--drb-font-body)',
          fontSize: 'min(3.7vw, 14px)',
          lineHeight: 1.4,
          color: 'rgba(240,232,214,0.78)',
        }}>Every scan goes straight to me.</div>

        {/* The rail scales with the viewport for the same reason the plate
            does. At a fixed h 18 / gap 14 the five-mark rail is ~308px wide,
            which fits a 390pt phone but overflows a 320pt one inside the 26px
            padding. These ratios reproduce 18/14 exactly at 390 and shrink
            below it. */}
        {rows.length > 0 && (
          <div style={{ marginTop: 46 }}>
            <PaymentRows
              rows={rows}
              h={Math.min(18, vw * 0.046)}
              gap={Math.min(14, vw * 0.036)}
              rowGap={14}
            />
          </div>
        )}
      </div>
    </div>
  );
}

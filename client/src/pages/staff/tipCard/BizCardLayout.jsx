// BizCardLayout.jsx — the two-sided hand-out card.
//
// PORTRAIT 2 x 3.5in, authored at NATIVE 300 DPI (600 x 1050 trim) on a
// 675 x 1125 bleed artboard. Unlike the sign, this one really does go to a
// press that trims to marks, which is exactly where bleed belongs. Only the
// background enters the bleed; every element sits inside the 37.5px safe zone.
//
// Handed over AFTER service, so it can carry warmth the sign cannot: a sign
// sits out all night and is read by people who have not been served yet, and
// pre-service tip asks measurably lower both tips and ratings.
//
// Elements are absolutely positioned on purpose. A bartender missing a rail
// must not recentre the whole stack: every other element keeps its baseline so
// two cards printed a month apart still look like the same card.

import React from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { CARD_SIZE, CARD_QR } from './sizes';
import { PrintSheet, QrPlate, PaymentRows } from './PaymentMarks';
import { splitMarkRows } from '../../../utils/tipCardMarks';
import { useFontsReady, measureContext, DISPLAY_STACK } from './typeFit';
import { COMPANY_PHONE } from '../../../utils/constants';

const CREAM = 'var(--drb-cream-text)';
const BRASS = 'var(--drb-brass)';

// Faux small caps per the print spec: first letter full size, the rest
// uppercase at 73%. Steps down in 4px decrements until it fits, so the name
// keeps its baseline and does not wrap.
//
// 480 wide, not 440: nothing aligns to 440 (the QR plate above is 420, i.e.
// 90px insets), and the box width is the cheapest lever on how many lines a
// long name takes, which is what the height budget below is bounded by. 480
// still clears the 37.5px bleed by 22.5px on each side.
const NAME_MAX_W = 480;
const NAME_FLOOR = 28;

// Once wrapping starts, the name grows UPWARD from its baseline (see the front
// face), so it is the reason line above that it eventually reaches. There is
// 97px of clear space between them, and the budget below leaves a margin of it.
//
// The budget is on HEIGHT, not on a line count, because only height converges.
// `display_name` is VARCHAR(255) with no length check on either side of the
// wire, so a fixed line cap plus a fixed size floor is a pair of constraints
// that can both be violated at once, which is what a 255-character value did:
// it bottomed out at the floor still 12 lines tall and printed through the
// reason line. Height always has a solution, because lines grow linearly with
// the type size while total height grows with its square, so shrinking always
// wins eventually. NAME_MIN is a loop guard, not the mechanism.
const NAME_BUDGET_H = 90;
const NAME_FILL = 0.88;
const NAME_MIN = 8;

function fauxFit(name, base) {
  const fallback = { s1: base, s2: Math.round(base * 0.73), wrap: 'nowrap' };
  // Zero tracking: the sign is tracked and this surface is not. The 1px per
  // character this face renders with is accounted for in the loop below.
  const ctx = measureContext('0px');
  if (!ctx) return fallback;
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return fallback;

  const widthAt = (s1) => {
    const s2 = Math.round(s1 * 0.73);
    let w = 0;
    words.forEach((word, i) => {
      ctx.font = `400 ${s1}px ${DISPLAY_STACK}`;
      w += ctx.measureText(word[0].toUpperCase()).width + 1;
      ctx.font = `400 ${s2}px ${DISPLAY_STACK}`;
      w += ctx.measureText(word.slice(1).toUpperCase()).width
        + Math.max(0, word.length - 1);
      if (i < words.length - 1) w += s1 * 0.28;
    });
    return w;
  };

  for (let s1 = base; ; s1 -= 4) {
    const s2 = Math.round(s1 * 0.73);
    const w = widthAt(s1);
    if (w <= NAME_MAX_W) return { s1, s2, wrap: 'nowrap' };
    // Past the floor a name MUST be allowed to wrap: held on one line it runs
    // past the 600px trim into the bleed, which is the part the press cuts
    // off, and the card prints with the name clipped at both ends.
    const lines = Math.max(1, Math.ceil(w / (NAME_MAX_W * NAME_FILL)));
    if (s1 <= NAME_FLOOR && (lines * s1 <= NAME_BUDGET_H || s1 <= NAME_MIN)) {
      return { s1, s2, wrap: 'normal' };
    }
  }
}

function FauxSmallCaps({ name, fit }) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  return (
    <>
      {words.map((word, i) => (
        <React.Fragment key={`${word}-${i}`}>
          {/* The words are margin-separated spans, not text with spaces, so
              without this there is NO break opportunity between them and a
              name at the size floor breaks mid-word ("Fernand / ez"). A <wbr>
              is a real soft-wrap opportunity of zero width, and the spec only
              lets overflow-wrap break arbitrarily once none is available, so
              this also keeps the anywhere-break as the last resort it is meant
              to be. */}
          {i > 0 && <wbr />}
          <span style={{ marginRight: i < words.length - 1 ? Math.round(fit.s1 * 0.28) : 0 }}>
            <span style={{ fontSize: fit.s1 }}>{word[0].toUpperCase()}</span>
            <span style={{ fontSize: fit.s2 }}>{word.slice(1).toUpperCase()}</span>
          </span>
        </React.Fragment>
      ))}
    </>
  );
}

// Shared by both faces. Full trim width with symmetric padding rather than a
// maxWidth, so the box stays centred on the card while the TEXT is still
// capped at NAME_MAX_W — a maxWidth would shrink the box against left:0 and
// pull the name off centre.
const NAME_PAD = (CARD_SIZE.w - NAME_MAX_W) / 2;
const nameStyle = (fit) => ({
  width: CARD_SIZE.w,
  boxSizing: 'border-box',
  paddingLeft: NAME_PAD,
  paddingRight: NAME_PAD,
  textAlign: 'center',
  fontFamily: 'var(--drb-font-display)',
  letterSpacing: 1,
  color: CREAM,
  whiteSpace: fit.wrap,
  // A single unbroken token has no space to break at, so whiteSpace alone
  // still lets it run off both edges.
  overflowWrap: 'anywhere',
});

// The trim area inside the bleed artboard. Absolute coordinates below are
// relative to this box.
function CardTrim({ children }) {
  return (
    <div style={{
      position: 'absolute',
      left: CARD_SIZE.bleed,
      top: CARD_SIZE.bleed,
      width: CARD_SIZE.w,
      height: CARD_SIZE.h,
    }}>
      {children}
    </div>
  );
}

const centered = (top) => ({
  position: 'absolute', left: 0, top, width: CARD_SIZE.w,
  textAlign: 'center', lineHeight: 1,
});

// Where the front name's baseline block bottoms out, inside the trim.
const NAME_BASELINE = 692;

// ─ Tip side ─────────────────────────────────────────────────
export function BizCardFront({ name = 'your bartender', tipUrl = '', marks = null }) {
  useFontsReady();
  const fit = fauxFit(name, 64);
  const code = CARD_QR.plate - CARD_QR.pad * 2;
  const rows = splitMarkRows(marks || [], 4);
  const plateLeft = (CARD_SIZE.w - CARD_QR.plate) / 2;

  return (
    <PrintSheet width={CARD_SIZE.wBleed} height={CARD_SIZE.hBleed}>
      <CardTrim>
        <div style={{ position: 'absolute', left: plateLeft, top: 105 }}>
          <QrPlate plate={CARD_QR.plate} pad={CARD_QR.pad} radius={CARD_QR.radius} glow={false}>
            {/* Native 300 DPI artboard, so the QR is authored at final size and
                captured at scale 1. Still rendered at 2x internally and shown
                at 1x, because qrcode.react sizes its backing store by
                devicePixelRatio and a 1x display would otherwise hand the
                capture an upscaled bitmap. */}
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

        <div style={{ ...centered(569), fontSize: 26, color: 'rgba(240,232,214,0.78)' }}>
          Every scan goes straight to me.
        </div>

        {/* Bottom-anchored, not top-anchored. At one line this is pixel-identical
            to a top of 692 - 0.8·s1; when a floor-length name wraps it grows UP
            into the gap under the reason line instead of down through
            "Bartender". */}
        <div style={{
          position: 'absolute', left: 0,
          bottom: CARD_SIZE.h - (NAME_BASELINE + Math.round(fit.s1 * 0.2)),
          lineHeight: 1,
          ...nameStyle(fit),
        }}>
          <FauxSmallCaps name={name} fit={fit} />
        </div>

        <div style={{
          ...centered(712),
          fontFamily: 'var(--drb-font-body)',
          fontSize: 27, fontStyle: 'italic', color: 'var(--drb-teal-light)',
        }}>Bartender</div>

        {rows.length > 0 && (
          <div style={{
            position: 'absolute', left: 0, top: 734,
            width: CARD_SIZE.w, height: 236,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <PaymentRows rows={rows} h={30} gap={36} rowGap={22} />
          </div>
        )}

        <div style={{
          ...centered(970),
          fontFamily: 'var(--drb-font-display)',
          fontSize: 25, letterSpacing: 5, textIndent: 5, color: BRASS,
        }}>DRBARTENDER.COM</div>
      </CardTrim>
    </PrintSheet>
  );
}

// ─ Card side ────────────────────────────────────────────────
export function BizCardBack({
  name = 'your bartender',
  title = 'Bartender',
  // COMPANY_PHONE, never a literal: the 224-…-0082 that used to sit here is
  // Zul's VA voice line, not the business line a guest should call.
  phone = COMPANY_PHONE,
  email = 'contact@drbartender.com',
  tagline = 'Mobile Bar · Cocktail Lab',
}) {
  useFontsReady();
  const fit = fauxFit(name, 72);
  const rule = { width: 300, height: 3, background: 'rgba(184,146,74,0.7)' };

  return (
    <PrintSheet width={CARD_SIZE.wBleed} height={CARD_SIZE.hBleed}>
      <CardTrim>
        <img
          src="/tip-page/logo-gold.png"
          alt=""
          style={{
            position: 'absolute', left: 150, top: 95,
            width: 300, height: 300, objectFit: 'contain', display: 'block',
          }}
        />

        <div style={{
          ...centered(443),
          fontFamily: 'var(--drb-font-display)',
          fontSize: 28, letterSpacing: 5, textIndent: 5, color: BRASS,
        }}>DRBARTENDER.COM</div>

        <div style={{
          position: 'absolute', left: 0, top: 471,
          width: CARD_SIZE.w, height: 369,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 18,
        }}>
          <div style={rule} />
          <div style={{ lineHeight: 0.9, ...nameStyle(fit) }}>
            <FauxSmallCaps name={name} fit={fit} />
          </div>
          <div style={{
            fontFamily: 'var(--drb-font-body)',
            fontSize: 30, fontStyle: 'italic', lineHeight: 1,
            color: 'var(--drb-teal-light)',
          }}>{title}</div>
          <div style={rule} />
        </div>

        <div style={{
          position: 'absolute', left: 0, top: 713,
          width: CARD_SIZE.w, height: 258,
          boxSizing: 'border-box', paddingBottom: 48,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'flex-end', gap: 27,
          fontFamily: 'var(--drb-font-body)',
          fontSize: 28, lineHeight: 1, color: CREAM,
        }}>
          <div>{phone}</div>
          <div>{email}</div>
        </div>

        <div style={{
          ...centered(971),
          fontFamily: 'var(--drb-font-body)',
          fontSize: 24, fontStyle: 'italic', color: 'rgba(240,232,214,0.55)',
        }}>{tagline}</div>
      </CardTrim>
    </PrintSheet>
  );
}

// BizCardLayout.jsx — the two-sided hand-out card.
//
// A different object from the bar sign: it is handed over AFTER service, so it
// carries a past-tense thank-you the sign cannot (a sign sits out all night and
// is read by people who have not been served yet, and pre-service tip asks
// measurably lower both tips and ratings). It goes to a print shop as a PDF,
// front and back on pages 1 and 2, never to a photo counter as an image.

import React from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { CARD_SIZE } from './sizes';
import { PrintSheet, TealWash, PaymentRow, BrandLockup, labelStyle } from './PaymentMarks';

const QR_PLATE = 186;
const QR_PAD = 8;

export function BizCardFront({ name = 'your bartender', tipUrl = '', marks = null }) {
  const shown = marks == null ? [] : marks;
  return (
    <PrintSheet width={CARD_SIZE.w} height={CARD_SIZE.h}>
      <TealWash at="74% 44%" size="ellipse 58% 72%" />
      <div style={{
        position: 'absolute', inset: 0,
        display: 'grid',
        gridTemplateColumns: `1fr ${QR_PLATE}px`,
        gridTemplateRows: '1fr auto',
        columnGap: 20,
        rowGap: 14,
        padding: '26px 28px',
      }}>
        <div style={{
          display: 'flex', flexDirection: 'column',
          alignItems: 'flex-start', justifyContent: 'center',
        }}>
          <div style={{ marginBottom: 8 }}>
            <BrandLockup logo={22} label={9} gap={7} opacity={1} />
          </div>
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: 40,
            lineHeight: 1.04,
            color: 'var(--drb-cream-text)',
            maxWidth: 245,
          }}>{name}</div>
          {/* Past tense is correct here and only here: the card is handed over
              after the drink, so the thank-you has already been earned. */}
          <div style={{
            marginTop: 9,
            fontFamily: 'var(--drb-font-body)',
            fontSize: 13,
            lineHeight: 1.4,
            color: 'rgba(240,232,214,0.82)',
            maxWidth: 238,
          }}>Thanks for tonight. Every scan goes straight to me.</div>
        </div>

        <div style={{
          width: QR_PLATE, height: QR_PLATE,
          background: '#FFFFFF',
          borderRadius: 8,
          padding: QR_PAD,
          boxShadow: '0 0 40px rgba(240,232,214,0.14)',
          alignSelf: 'center',
        }}>
          {/* Level Q + a 4-module quiet zone, 2x backing store displayed at 1x.
              See the note in SignLayout.jsx. */}
          <QRCodeCanvas
            value={tipUrl}
            size={(QR_PLATE - QR_PAD * 2) * 2}
            style={{ width: QR_PLATE - QR_PAD * 2, height: QR_PLATE - QR_PAD * 2 }}
            bgColor="#FFFFFF"
            fgColor="#12161C"
            level="Q"
            marginSize={4}
          />
        </div>

        <div style={{
          gridColumn: '1 / -1',
          display: 'flex', alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}>
          <PaymentRow
            marks={shown}
            height={16}
            tileHeight={26}
            gap={7}
            radius={5}
            padX={8}
            align="flex-start"
          />
          {/* One instruction on the card, not two: the sign carries the ask, the
              card carries the thank-you above. */}
          <span style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: 11,
            letterSpacing: '0.03em',
            color: 'rgba(240,232,214,0.9)',
            whiteSpace: 'nowrap',
          }}>Point your camera here</span>
        </div>
      </div>
    </PrintSheet>
  );
}

export function BizCardBack({
  name = 'your bartender',
  title = 'Bartender',
  company = 'Dr. Bartender',
  tagline = 'Mobile Bar · Cocktail Lab',
  phone = '(224) 222-0082',
  email = 'contact@drbartender.com',
  web = 'drbartender.com',
  address = '',
}) {
  return (
    <PrintSheet width={CARD_SIZE.w} height={CARD_SIZE.h}>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'grid',
        gridTemplateColumns: '104px 1fr',
        alignItems: 'center',
        gap: 24,
        padding: '28px 32px',
      }}>
        <img
          src="/tip-page/logo-gold.png"
          alt=""
          style={{ width: 104, height: 104, objectFit: 'contain', display: 'block' }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: 10,
            letterSpacing: '0.34em',
            textTransform: 'uppercase',
            color: 'var(--drb-brass-bright)',
          }}>{company}</div>
          <div style={{
            fontFamily: 'var(--drb-font-display)',
            fontSize: 26,
            lineHeight: 1.1,
            color: 'var(--drb-cream-text)',
            marginTop: 4,
          }}>{name}</div>
          <div style={{
            fontFamily: 'var(--drb-font-body)',
            fontSize: 14,
            fontStyle: 'italic',
            color: 'var(--drb-teal-light)',
            marginTop: 2,
          }}>{title}</div>
          <div style={{
            width: 56, height: 1,
            background: 'var(--drb-brass)',
            opacity: 0.55,
            margin: '12px 0',
          }} />
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            columnGap: 12,
            rowGap: 3,
            fontFamily: 'var(--drb-font-body)',
            fontSize: 13,
            lineHeight: 1.45,
            color: 'rgba(240,232,214,0.92)',
          }}>
            <span style={{ ...labelStyle, alignSelf: 'center' }}>Web</span>
            <span>{web}</span>
            {phone && <><span style={{ ...labelStyle, alignSelf: 'center' }}>Tel</span><span>{phone}</span></>}
            {email && <><span style={{ ...labelStyle, alignSelf: 'center' }}>Email</span><span>{email}</span></>}
            {address && <><span style={{ ...labelStyle, alignSelf: 'center' }}>Base</span><span>{address}</span></>}
          </div>
          <div style={{
            marginTop: 12,
            fontFamily: 'var(--drb-font-body)',
            fontSize: 12,
            fontStyle: 'italic',
            letterSpacing: '0.06em',
            color: 'rgba(240,232,214,0.55)',
          }}>{tagline}</div>
        </div>
      </div>
    </PrintSheet>
  );
}

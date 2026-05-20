import React, { useEffect, useRef, useState } from 'react';
import { extractMenuSections } from '../data/menuSections';

/* Standard Menu, Dark Ink direction. Single canonical visual used in two
   variants: 'screen' (responsive, scaled-down preview shown to the client on
   MenuDesignStep) and 'print' (exact 768x960 at 96 DPI screen scale, fed to
   html2canvas by the admin PNG export at scale:3 to produce a 2304x2880 PNG).

   Inline-style React (no CSS classes) matches the ClientShoppingList.js
   pattern. All sizes are in print-px on the 768x960 canvas. */

const PRINT = {
  W: 768,
  H: 960,
  bg: '#12161C',
  cream: '#F0E8D6',
  brass: '#B8924A',
  brassBright: '#D6AE65',
  rule: '1px solid #B8924A',
  fontDisplay: "'IM Fell English SC', Georgia, serif",
  fontBody: "'IM Fell English', Georgia, serif",
  fontTitle: "'Pirata One', 'IM Fell English SC', Georgia, serif",
};

const DRB_LOGO_SRC = process.env.PUBLIC_URL + '/images/menu-logo-gold.png';

/* Public component (default export). Dispatches by variant. */
export default function MenuPreview(props) {
  const { variant = 'screen' } = props;
  if (variant === 'print') {
    return <MenuCard {...props} />;
  }
  return <ResponsiveScreenWrapper {...props} />;
}

/* ResponsiveScreenWrapper. Scales the 768x960 card to fit
   the parent container's width while preserving the 4:5
   aspect ratio. Uses ResizeObserver so the preview always
   fits MenuDesignStep's card width, on any viewport. */
function ResponsiveScreenWrapper(props) {
  const containerRef = useRef(null);
  const [scale, setScale] = useState(0.521);

  useEffect(() => {
    if (!containerRef.current) return;
    const update = () => {
      const w = containerRef.current?.offsetWidth || PRINT.W;
      setScale(Math.min(w / PRINT.W, 1));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        maxWidth: 400,
        aspectRatio: '4 / 5',
        position: 'relative',
        overflow: 'hidden',
        margin: '18px 0 4px',
      }}
    >
      <div
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      >
        <MenuCard {...props} />
      </div>
    </div>
  );
}

/* MenuCard. The canonical render at 768x960. */
function MenuCard({
  selections = {},
  activeModules = {},
  cocktails = [],
  mocktails = [],
  companyLogo = '',
}) {
  const { sections, isEmpty } = extractMenuSections(selections, activeModules, cocktails, mocktails);

  return (
    <div
      style={{
        width: PRINT.W,
        height: PRINT.H,
        background: PRINT.bg,
        color: PRINT.cream,
        fontFamily: PRINT.fontBody,
        position: 'relative',
        overflow: 'hidden',
      }}
      role="img"
      aria-label="Standard menu preview"
    >
      {/* Content area. Page margins 48px (36pt). */}
      <div
        style={{
          position: 'absolute',
          top: 48,
          left: 48,
          right: 48,
          bottom: 107, // footer band height
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <TitleCrest text="The Bar Menu" />
        {isEmpty ? <EmptyBody /> : <Body sections={sections} />}
      </div>

      {/* Footer band. Absolute, full-width. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 107,
          borderTop: PRINT.rule,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 48,
          paddingRight: 48,
          gap: 24,
        }}
      >
        <DrbLockup />
        <div style={{ flex: 1 }} />
        {companyLogo && (
          <>
            <div style={{ width: 1, height: 64, background: PRINT.brass }} />
            <img
              src={companyLogo}
              alt=""
              style={{
                maxWidth: 160,
                maxHeight: 72,
                width: 'auto',
                height: 'auto',
                objectFit: 'contain',
                display: 'block',
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

/* TitleCrest. Anchor of the menu. Pirata One at 72px,
   flanked by brass hairlines + diamond ornaments. */
function TitleCrest({ text }) {
  return (
    <div style={{ textAlign: 'center', marginBottom: 38 }}>
      <CrestHRule />
      <h1
        style={{
          margin: '14px 0',
          fontFamily: PRINT.fontTitle,
          fontWeight: 400,
          fontSize: 72,
          lineHeight: 1,
          letterSpacing: '0.02em',
          color: PRINT.cream,
        }}
      >
        {text}
      </h1>
      <CrestHRule />
    </div>
  );
}

function CrestHRule() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
      }}
    >
      <span style={{ flex: 1, maxWidth: 160, height: 1, background: PRINT.brass }} />
      <span
        style={{
          color: PRINT.brass,
          fontSize: 14,
          lineHeight: 1,
          transform: 'translateY(-1px)',
        }}
      >
        {'◆'}
      </span>
      <span style={{ flex: 1, maxWidth: 160, height: 1, background: PRINT.brass }} />
    </div>
  );
}

/* Body. Sections stacked vertically in spec order. */
function Body({ sections }) {
  const isOnly = sections.length === 1;
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 30,
      }}
    >
      {sections.map((section) => (
        <StackedSection key={section.kind} section={section} isOnly={isOnly} />
      ))}
    </div>
  );
}

function StackedSection({ section, isOnly }) {
  // Beer & Wine inline when it accompanies other sections; stacked like a
  // drink list when it is the only section on the menu.
  const inline = section.kind === 'beer-wine' && !isOnly;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <SectionLabel>{section.title}</SectionLabel>
      <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 0 }}>
        {inline ? (
          <div
            style={{
              fontFamily: PRINT.fontDisplay,
              fontSize: 21,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: PRINT.cream,
              textAlign: 'center',
            }}
          >
            {section.items.join(' · ')}
          </div>
        ) : (
          section.items.map((name, i) => (
            <DrinkName key={`${section.kind}-${i}`}>{name}</DrinkName>
          ))
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ paddingBottom: 12, borderBottom: PRINT.rule }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          fontFamily: PRINT.fontDisplay,
          fontSize: 17,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: PRINT.brassBright,
          lineHeight: 1,
        }}
      >
        <span style={{ color: PRINT.brass, fontSize: 11, lineHeight: 1, transform: 'translateY(-1px)' }}>
          {'◆'}
        </span>
        <span>{children}</span>
        <span style={{ color: PRINT.brass, fontSize: 11, lineHeight: 1, transform: 'translateY(-1px)' }}>
          {'◆'}
        </span>
      </div>
    </div>
  );
}

function DrinkName({ children }) {
  return (
    <div
      style={{
        fontFamily: PRINT.fontDisplay,
        fontSize: 35,
        lineHeight: 1.4,
        letterSpacing: '0.04em',
        color: PRINT.cream,
        textAlign: 'center',
      }}
    >
      {children}
    </div>
  );
}

function EmptyBody() {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 48px',
      }}
    >
      <p
        style={{
          fontFamily: PRINT.fontBody,
          fontStyle: 'italic',
          fontSize: 22,
          color: 'rgba(240,232,214,0.65)',
          textAlign: 'center',
          lineHeight: 1.5,
          margin: 0,
        }}
      >
        No drinks selected yet. <br />
        Go back and pick something to serve.
      </p>
    </div>
  );
}

function DrbLockup() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <img
        src={DRB_LOGO_SRC}
        alt="Dr. Bartender"
        style={{
          width: 64,
          height: 64,
          objectFit: 'contain',
          display: 'block',
          flexShrink: 0,
        }}
      />
      <div
        style={{
          fontFamily: PRINT.fontDisplay,
          fontSize: 19,
          letterSpacing: '0.32em',
          lineHeight: 1,
          textTransform: 'uppercase',
          color: PRINT.cream,
        }}
      >
        Dr.&nbsp;Bartender
      </div>
    </div>
  );
}

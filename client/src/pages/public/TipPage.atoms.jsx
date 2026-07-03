import React, { useState, useCallback } from 'react';

// Inline SVG marks (placeholders that read like the real platforms)
export const VenmoMark = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path fill="#fff" d="M19.4 3c.7 1.1 1 2.3 1 3.7 0 4.5-3.8 10.3-6.9 14.4H6.4L3.6 4.5l6.2-.6 1.5 11.9c1.4-2.3 3.1-5.8 3.1-8.3 0-1.3-.2-2.2-.6-3l5.6-1.5z"/>
  </svg>
);

export const CashAppMark = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path fill="#00261A" d="M14.7 8.4c-.3.3-.7.4-1.1.4-.7 0-1.4-.4-2.2-.4-.5 0-.9.2-.9.6 0 1.3 4.7.7 4.7 4 0 1.7-1.3 2.9-3.3 3.2l-.2 1.4c0 .2-.2.3-.3.3h-1.3c-.2 0-.3-.2-.3-.4l.2-1.4c-.9-.2-1.7-.6-2.3-1.1-.1-.1-.1-.3 0-.4l.9-.9c.1-.1.3-.1.4 0 .7.6 1.5.9 2.4.9.7 0 1.2-.3 1.2-.8 0-1.4-4.6-.8-4.6-3.9 0-1.6 1.2-2.8 3.2-3.1l.2-1.4c0-.2.2-.3.3-.3h1.3c.2 0 .3.2.3.4l-.2 1.4c.7.2 1.4.5 1.9.9.1.1.2.3 0 .4l-.9 1z"/>
  </svg>
);

export const PaypalMark = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path fill="#fff" d="M8.4 20.4H5.7c-.3 0-.5-.3-.4-.6L7.7 4.4c.1-.4.4-.7.8-.7h5.4c2.6 0 4.3 1.3 4.3 3.7 0 3.5-2.7 5.6-6.1 5.6h-2c-.3 0-.6.2-.7.6l-.6 4c-.1.4-.4.6-.7.6z"/>
    <path fill="#9CB6E0" d="M11.5 9.7h-1c-.2 0-.4.1-.4.4l-.5 3.4c0 .2.1.3.3.3h1.6c2.2 0 3.7-1.4 3.9-3.4.1-1.4-.7-2.1-2.5-2.1-.5 0-1 0-1.4.1l.3-1.4c0-.1-.1-.2-.2-.2-.7 0-1.2.5-1.3 1.1l-.6 4.1c0 .2.1.3.3.3h1c.2 0 .4-.1.4-.3l.1-.7"/>
  </svg>
);

// Zelle brand mark — a stylized "Z" inside the brand purple, drawn in the same
// 22x22 SVG box as the other platform marks so it sits identically in the
// .pay-mark slot.
export const ZelleMark = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path fill="#fff" d="M16.8 6.6V4.8h-3.2V3h-3.2v1.8H7.2v3.6h5.3l-5.6 8.4v1.8h3.2v1.6h3.2v-1.6h3.5v-3.6h-5.5l5.5-8.4z"/>
  </svg>
);

// Card-network row used inside the Credit Card button
export const CardNetworkRow = () => (
  <svg viewBox="0 0 88 22" width="74" height="20" aria-hidden="true">
    {/* Visa */}
    <rect x="0" y="0" width="20" height="22" rx="3" fill="#1A1F71"/>
    <text x="10" y="15" fontSize="8" fontFamily="Arial,sans-serif" fontWeight="700"
      textAnchor="middle" fill="#fff" letterSpacing="-0.5">VISA</text>
    {/* MC */}
    <rect x="22" y="0" width="20" height="22" rx="3" fill="#fff"/>
    <circle cx="29" cy="11" r="5.6" fill="#EB001B"/>
    <circle cx="35" cy="11" r="5.6" fill="#F79E1B" fillOpacity="0.95"/>
    <path d="M32 6.4a6 6 0 0 0 0 9.2 6 6 0 0 0 0-9.2z" fill="#FF5F00"/>
    {/* Amex */}
    <rect x="44" y="0" width="20" height="22" rx="3" fill="#2E77BB"/>
    <text x="54" y="14" fontSize="5.6" fontFamily="Arial,sans-serif" fontWeight="700"
      textAnchor="middle" fill="#fff">AMEX</text>
    {/* Discover */}
    <rect x="66" y="0" width="20" height="22" rx="3" fill="#fff"/>
    <rect x="66" y="0" width="20" height="22" rx="3" fill="#fff" stroke="#ddd" strokeWidth="0.5"/>
    <path d="M66 14h20v5a3 3 0 0 1-3 3H66z" fill="#FF6B1A"/>
    <text x="76" y="11" fontSize="4.6" fontFamily="Arial,sans-serif" fontWeight="700"
      textAnchor="middle" fill="#231F20" letterSpacing="0.3">DISCOVER</text>
  </svg>
);

export const Chevron = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);

export const StarIcon = ({ filled }) => (
  <svg viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
    <polygon points="12 2.6 14.9 8.7 21.6 9.6 16.7 14.3 17.9 21 12 17.7 6.1 21 7.3 14.3 2.4 9.6 9.1 8.7"/>
  </svg>
);

export const Sparkle = ({ x, y, size = 14, color = '#C17D3C', rot = 0 }) => (
  <svg className="sparkle" style={{ left: x, top: y, width: size, height: size, transform: `rotate(${rot}deg)` }}
       viewBox="0 0 24 24" aria-hidden="true">
    <path fill={color} d="M12 0c.6 5.4 6 10.8 12 12-6 1.2-11.4 6.6-12 12-.6-5.4-6-10.8-12-12C6 10.8 11.4 5.4 12 0z"/>
  </svg>
);

export const HeroDecor = ({ compressed }) => (
  <>
    <Sparkle x="14%" y={compressed ? '32%' : '34%'} size={10} color="#D4954A" />
    <Sparkle x="82%" y={compressed ? '26%' : '22%'} size={13} color="#D4954A" />
    <Sparkle x="88%" y={compressed ? '62%' : '58%'} size={8} color="#F5EDE0" />
    <Sparkle x="8%" y={compressed ? '66%' : '62%'} size={9} color="#F5EDE0" />
    <svg style={{ position: 'absolute', right: '18px', top: '14px', opacity: 0.4 }} width="16" height="18" viewBox="0 0 24 26" aria-hidden="true">
      <path fill="none" stroke="#D4954A" strokeWidth="1.2" d="M9 2h6v6l5 12a2 2 0 0 1-2 3H6a2 2 0 0 1-2-3l5-12V2z"/>
      <path fill="#D4954A" d="M6.5 16h11l1.5 4a2 2 0 0 1-2 3H7a2 2 0 0 1-2-3l1.5-4z" opacity="0.5"/>
    </svg>
  </>
);

export const PayButton = ({ kind, label, sub, href }) => {
  const Mark = kind === 'venmo' ? VenmoMark
    : kind === 'cashapp' ? CashAppMark
    : kind === 'paypal' ? PaypalMark
    : null;
  return (
    <a className={`pay-btn ${kind}`} href={href} target="_blank" rel="noopener noreferrer">
      <span className="pay-mark">
        {kind === 'card' ? <CardNetworkRow /> : (Mark ? <Mark /> : null)}
      </span>
      <span className="pay-label">
        {label}
        {sub && <small>{sub}</small>}
      </span>
      <span className="pay-chev"><Chevron /></span>
    </a>
  );
};

// Zelle row — visually consistent with PayButton, but renders as a <button>
// because Zelle has no universal deep link. Tapping copies the handle to the
// clipboard and briefly flips the trailing affordance to "Copied". Helper
// text under the label tells the customer to paste in their banking app.
//
// Accessibility: a real <button> with an aria-label that includes the handle
// so screen readers announce what's being copied. The "Copied" state lives in
// an aria-live region so the announcement reaches non-sighted users too.
export const ZellePayButton = ({ handle }) => {
  const [copied, setCopied] = useState(false);

  const onClick = useCallback(async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(handle);
      } else {
        // Fallback for older mobile browsers without async clipboard API.
        const ta = document.createElement('textarea');
        ta.value = handle;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard write failed (denied permission, insecure context). Still
      // flip to "Copied" briefly so the affordance feels alive — the handle
      // is visible on the row, customer can long-press to copy.
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }, [handle]);

  return (
    <button
      type="button"
      className="pay-btn zelle"
      onClick={onClick}
      aria-label={`Copy Zelle handle ${handle} to clipboard`}
    >
      <span className="pay-mark"><ZelleMark /></span>
      <span className="pay-label">
        Zelle
        <small>{copied ? 'Copied. Paste in your banking app' : `Tap to copy ${handle}`}</small>
      </span>
      <span className="pay-chev" aria-live="polite">
        {copied ? <span style={{ fontSize: '0.66rem', letterSpacing: '0.08em' }}>COPIED</span> : <Chevron />}
      </span>
    </button>
  );
};

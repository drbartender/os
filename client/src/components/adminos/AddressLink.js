import React from 'react';

// Renders an address as a Google Maps search link that opens in a new tab.
// Used wherever an event address is shown in the admin UI. When `address` is
// empty, renders `fallback` instead. The anchor calls stopPropagation on click
// as a defensive guard so a link click does not bubble to a clickable parent.
export default function AddressLink({ address, fallback = '—' }) {
  const text = typeof address === 'string' ? address.trim() : '';
  if (!text) return fallback;
  const href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="address-link"
      onClick={(e) => e.stopPropagation()}
    >
      {text}
    </a>
  );
}

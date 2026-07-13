import React from 'react';

// Renders an address as a Google Maps search link that opens in a new tab.
// Used wherever an event address is shown in the admin UI. When `address` is
// empty, renders `fallback` instead. The anchor calls stopPropagation on click
// as a defensive guard so a link click does not bubble to a clickable parent.
//
// `address` is the human-readable text shown in the link (usually the full
// composed location, venue name included). `mapQuery`, when provided, is the
// string actually geocoded by Google Maps — pass an address-only query (see
// venueMapQuery) so the venue name does not pollute the search. Falls back to
// `address` when no mapQuery is given (legacy free-text locations).
export default function AddressLink({ address, mapQuery, fallback = '—' }) {
  const text = typeof address === 'string' ? address.trim() : '';
  if (!text) return fallback;
  const query = (typeof mapQuery === 'string' && mapQuery.trim()) ? mapQuery.trim() : text;
  const href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
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

import React from 'react';

// Lucide-style inline SVG icons used across Admin OS. Stroke 1.75, 24×24 viewbox.
const ICONS = {
  home: <><path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1V9.5Z"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></>,
  clipboard: <><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12h6M9 16h4"/></>,
  users: <><circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M15 20c0-2.5 1.5-4.5 4-5"/></>,
  userplus: <><circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M19 7v6M22 10h-6"/></>,
  dollar: <><path d="M12 3v18M16 7c0-1.7-1.8-3-4-3s-4 1.3-4 3 1.8 3 4 3 4 1.3 4 3-1.8 3-4 3-4-1.3-4-3"/></>,
  pen: <><path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="M14 6l4 4"/></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></>,
  gear: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  bell: <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9Z"/><path d="M10 21a2 2 0 0 0 4 0"/></>,
  filter: <><path d="M3 5h18l-7 9v5l-4 2v-7L3 5Z"/></>,
  sort: <><path d="M7 4v16M4 17l3 3 3-3M17 20V4M14 7l3-3 3 3"/></>,
  down: <><polyline points="6 9 12 15 18 9"/></>,
  right: <><polyline points="9 6 15 12 9 18"/></>,
  left: <><polyline points="15 6 9 12 15 18"/></>,
  up: <><polyline points="18 15 12 9 6 15"/></>,
  x: <><path d="M6 6l12 12M18 6 6 18"/></>,
  check: <><polyline points="5 12 10 17 19 7"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  pin: <><path d="M12 21v-6"/><path d="M8 3h8l-1 5 4 4H5l4-4-1-5Z"/></>,
  location: <><path d="M12 22s7-6 7-12a7 7 0 1 0-14 0c0 6 7 12 7 12Z"/><circle cx="12" cy="10" r="2.5"/></>,
  phone: <><path d="M5 4c0 9 6 15 15 15l1-4-5-2-2 2c-2-1-4-3-5-5l2-2-2-5-4 1Z"/></>,
  external: <><path d="M10 5H5v14h14v-5M14 4h6v6M20 4l-9 9"/></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></>,
  trend_up: <><polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/></>,
  trend_down: <><polyline points="3 7 9 13 13 9 21 17"/><polyline points="14 17 21 17 21 10"/></>,
  alert: <><path d="M12 3 2 21h20L12 3Z"/><path d="M12 10v5M12 18v.5"/></>,
  sparkles: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></>,
  chevrons: <><polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/></>,
  grip: <><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></>,
  kebab: <><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></>,
  logout: <><path d="M10 17l-5-5 5-5M5 12h12M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"/></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
  flask: <><path d="M9 3h6M10 3v6L5 20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1l-5-11V3"/><path d="M7 14h10"/></>,
  book: <><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z"/><path d="M4 19a2 2 0 0 0 2 2h13"/></>,
  list: <><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></>,
  card: <><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 11h18"/></>,
  panel: <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></>,
  arrow_right: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
  send: <><path d="M4 12 21 4l-7 17-3-7-7-2Z"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></>,
  moon: <><path d="M20 15.5A8 8 0 0 1 8.5 4a8 8 0 1 0 11.5 11.5Z"/></>,
  chart: <><rect x="3" y="12" width="4" height="8"/><rect x="10" y="7" width="4" height="13"/><rect x="17" y="3" width="4" height="17"/></>,
};

export default function Icon({ name, size = 14, ...rest }) {
  const paths = ICONS[name];
  if (!paths) return null;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {paths}
    </svg>
  );
}

export { ICONS };

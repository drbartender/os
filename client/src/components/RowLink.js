import React from 'react';
import { Link } from 'react-router-dom';

// Primary-cell link that looks like plain row text but behaves as a real
// anchor: ctrl/cmd/shift/middle-click open a new tab natively, while a plain
// left-click is in-app (SPA) navigation. Designed to sit inside a ClickableRow's
// identifying cell. ClickableRow's onMouseUp and onAuxClick both bail on
// interactive children (its INTERACTIVE_SELECTOR includes `a`), so this link
// never double-fires the row handler.
export default function RowLink({ to, className = '', children, ...rest }) {
  return (
    <Link to={to} className={`row-link${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </Link>
  );
}

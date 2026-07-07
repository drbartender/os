import React from 'react';
import { Link } from 'react-router-dom';

// Inline reference to another entity (a name in a card header, a roster row,
// a timeline item, a drawer body): a real anchor, so cmd/ctrl/middle-click
// open a new tab natively. Visual stays quiet (inherits color, hover
// underline) so admin surfaces don't sprout blue links. Nullish `to` (legacy
// rows with no id) renders the children unlinked instead of a dead anchor.
export default function EntityLink({ to, className = '', children, ...rest }) {
  if (!to) return <>{children}</>;
  return (
    <Link to={to} className={`entity-link${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </Link>
  );
}

import React from 'react';

/**
 * Trivial placeholder used by the early Task 31 /staff-v2 stub mount.
 * Each page (Home, Shifts, Pay, Tip Card, Account) renders this until its
 * real implementation lands in later tasks (32-47), at which point the
 * routes swap their `element` prop one at a time.
 */
export default function Placeholder({ name }) {
  return <div className="sp-placeholder">{name} coming soon</div>;
}

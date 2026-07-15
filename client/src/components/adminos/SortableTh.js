import React from 'react';
import Icon from './Icon';

// Clickable sortable table header. Presentational only: the parent owns the sort
// state (`sort` = { key, dir } or null) and the toggle logic; this renders the
// header cell, its aria-sort, and the direction glyph, and calls onSort(sortKey)
// on click / Enter / Space. Shared by ProposalsDashboard (server-side sort) and
// EventsDashboard (client-side sort). `className` passes through for `num` etc.
export default function SortableTh({ label, sortKey, sort, onSort, className = '' }) {
  const active = sort?.key === sortKey;
  const dir = active ? sort.dir : null;
  const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const activate = () => onSort(sortKey);
  return (
    <th
      className={`sortable${className ? ` ${className}` : ''}`}
      aria-sort={ariaSort}
      tabIndex={0}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
    >
      <span className="th-sort-inner">
        {label}
        <Icon name={active ? (dir === 'asc' ? 'up' : 'down') : 'sort'} size={11} />
      </span>
    </th>
  );
}

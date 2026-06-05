import React from 'react';
import { Link } from 'react-router-dom';
import { formatDollars } from './money';
import { getEventTypeLabel } from '../../../utils/eventTypes';
export default function ArchiveList({ archive }) {
  if (!archive || archive.length === 0) return null;
  return (<div className="cp-archive-list">{archive.map(e => (
    <Link key={e.token} to={`/my-proposals/${e.token}/overview`} className="cp-archive-row">
      <span className="cp-archive-title">{getEventTypeLabel({ event_type: e.event_type, event_type_custom: e.event_type_custom })}</span>
      <span className="cp-archive-date">{e.event_date ? new Date(e.event_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : ''}</span>
      <span className="cp-archive-total">{formatDollars(e.total_price)}</span>
    </Link>))}</div>);
}

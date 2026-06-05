import React from 'react';
import { Link, useParams } from 'react-router-dom';
import OverviewTab from './tabs/OverviewTab';
import PrescriptionTab from './tabs/PrescriptionTab';
import PotionTab from './tabs/PotionTab';
import ReceiptsTab from './tabs/ReceiptsTab';
import { getEventTypeLabel } from '../../../utils/eventTypes';
const TABS = [['overview','Overview'],['prescription','The Prescription'],['potion','The Potion Plan'],['receipts','Receipts']];
export default function EventCommandCenter({ focus, upcomingCount }) {
  const { tab = 'overview' } = useParams();
  const base = `/my-proposals/${focus.token}`;
  return (<div className="cp-command">
    <header className="cp-case-hero">
      <div className="drb-kicker">{getEventTypeLabel({ event_type: focus.event_type, event_type_custom: focus.event_type_custom })}</div>
      {upcomingCount > 1 && <div className="cp-multi-note">You also have another upcoming event.</div>}
    </header>
    <nav className="cp-tabs" role="tablist">{TABS.map(([k, label]) => (
      <Link key={k} role="tab" aria-selected={tab === k} className={`cp-tab${tab === k ? ' active' : ''}`} to={`${base}/${k}`}>{label}</Link>))}</nav>
    <section className="cp-tab-body">
      {tab === 'overview' && <OverviewTab focus={focus} />}
      {tab === 'prescription' && <PrescriptionTab focus={focus} />}
      {tab === 'potion' && <PotionTab focus={focus} />}
      {tab === 'receipts' && <ReceiptsTab focus={focus} />}
    </section>
  </div>);
}

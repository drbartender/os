import React, { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { useAuth } from '../../context/AuthContext';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { interpolatePackageIncludes } from '../../utils/packageIncludes';
import { formatPhone } from '../../utils/formatPhone';
import useDrawerParam, { drawerHref } from '../../hooks/useDrawerParam';
import EntityLink from '../../components/EntityLink';
import { getPackageItems } from '../../data/packages';
import { SYRUPS } from '../../data/syrups';
import PricingBreakdown from '../../components/PricingBreakdown';
import DrinkPlanCard from '../../components/DrinkPlanCard';
import MessageLogCard from './eventDetail/MessageLogCard';
import EventDetailPlanLogo from './EventDetailPlanLogo';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import ShiftDrawer from '../../components/adminos/drawers/ShiftDrawer';
import { fmtDate, fmtDateFull, fmtTime24, relDay } from '../../components/adminos/format';
import { parsePositionsCount, approvedCount, remainingByRole } from '../../components/adminos/shifts';
import { parsePositionsNeeded, rosterCounts, isEventFullyStaffed } from '../../utils/staffingRoles';
import ProposalDetailPaymentPanel from './ProposalDetailPaymentPanel';
import EventEditForm from './EventEditForm';
import CancelEventDialog from './CancelEventDialog';
import BackButton from '../../components/adminos/BackButton';
import AddressLink from '../../components/adminos/AddressLink';
import { venueMapQuery } from '../../components/VenueAddressFields';
import { STAFF_URL } from '../../utils/constants';

const MenuPNG = lazy(() => import('../../components/MenuPNG/MenuPNG'));

// "18:00" + 5 → "18:00–23:00 (5 hrs)". Tolerates a 12-hour stored value
// ("6:00 PM") and falls back to whatever we have if the time can't be parsed.
function fmtTimeRange(start, durationHours) {
  if (!start) return null;
  const dur = Number(durationHours);
  const durLabel = Number.isFinite(dur) && dur > 0
    ? ` (${dur} ${dur === 1 ? 'hr' : 'hrs'})`
    : '';
  const m = String(start).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return durLabel ? `${start}${durLabel}` : String(start);
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3] && m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  const pad = (n) => String(n).padStart(2, '0');
  const startMin = h * 60 + min;
  const startStr = `${pad(Math.floor(startMin / 60) % 24)}:${pad(startMin % 60)}`;
  if (!Number.isFinite(dur) || dur <= 0) return startStr;
  const endTotal = startMin + Math.round(dur * 60);
  const endStr = `${pad(Math.floor(endTotal / 60) % 24)}:${pad(endTotal % 60)}`;
  return `${startStr}–${endStr}${durLabel}`;
}

export default function EventDetailPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const { user: viewer } = useAuth();
  const toast = useToast();
  const drawer = useDrawerParam();
  const [proposal, setProposal] = useState(null);
  const [shifts, setShifts] = useState([]);
  const [drinkPlan, setDrinkPlan] = useState(null);
  const [drinkPlanLoading, setDrinkPlanLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);

  // Proposal + shifts refetch — passed to the payment panel `onUpdate` and run
  // after an event edit (date/time/location/contact changes re-sync the linked
  // shift server-side, so shifts must be re-pulled too).
  const reload = useCallback(() => {
    return Promise.all([
      api.get(`/proposals/${id}`).then(r => r.data),
      api.get(`/shifts/by-proposal/${id}`).then(r => Array.isArray(r.data) ? r.data : []).catch(() => []),
    ])
      .then(([pd, sd]) => { setProposal(pd); setShifts(sd); })
      .catch(e => {
        setErr(e?.message || 'Failed to load event');
        toast.error('Failed to load event.');
      });
  }, [id, toast]);

  // Proposal-only refetch — payment-panel mutations never touch shifts.
  const loadProposal = useCallback(() => {
    return api.get(`/proposals/${id}`)
      .then(r => setProposal(r.data))
      .catch(e => {
        setErr(e?.message || 'Failed to load event');
        toast.error('Failed to load event.');
      });
  }, [id, toast]);

  // Shifts-only refetch — passed to ShiftDrawer.onUpdate so assigning/approving
  // staff in the drawer reflects on the Staffing card without a page reload.
  const reloadShifts = useCallback(() => {
    return api.get(`/shifts/by-proposal/${id}`)
      .then(r => setShifts(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.get(`/proposals/${id}`).then(r => r.data),
      api.get(`/shifts/by-proposal/${id}`).then(r => Array.isArray(r.data) ? r.data : []).catch(() => []),
    ])
      .then(([pd, sd]) => {
        if (cancelled) return;
        setProposal(pd);
        setShifts(sd);
      })
      .catch(e => {
        if (cancelled) return;
        setErr(e?.message || 'Failed to load event');
        toast.error('Failed to load event.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, toast]);

  useEffect(() => {
    if (!id) return;
    setDrinkPlan(null);
    setDrinkPlanLoading(true);
    let cancelled = false;
    api.get(`/drink-plans/by-proposal/${id}`)
      .then(res => { if (!cancelled) setDrinkPlan(res.data); })
      .catch(() => { if (!cancelled) setDrinkPlan(null); })
      .finally(() => { if (!cancelled) setDrinkPlanLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  // Derived view-model. Memoized on [proposal] so it doesn't recompute on
  // every drawer open/close, drink-plan load, or unrelated state change —
  // this page hosts shifts + drink plan + payment panel + edit form.
  const derived = useMemo(() => {
    if (!proposal) return null;
    const eventTypeLabel = getEventTypeLabel({
      event_type: proposal.event_type,
      event_type_custom: proposal.event_type_custom,
    });
    const snapshot = proposal.pricing_snapshot;
    const bartenders = snapshot?.staffing?.actual;
    const durationHours = snapshot?.inputs?.durationHours;
    const includes = interpolatePackageIncludes(proposal.package_includes, { durationHours, bartenders });
    const packageStructured = getPackageItems(proposal.package_slug);
    const timeRange = fmtTimeRange(proposal.event_start_time, proposal.event_duration_hours);
    const contactBits = [
      proposal.client_phone && formatPhone(proposal.client_phone),
      proposal.client_email,
      proposal.client_source,
    ].filter(Boolean);
    return { eventTypeLabel, snapshot, includes, packageStructured, timeRange, contactBits };
  }, [proposal]);

  if (loading) return <div className="page"><div className="muted">Loading event…</div></div>;
  if (err || !proposal) {
    return (
      <div className="page">
        <div className="hstack" style={{ marginBottom: 8 }}>
        <BackButton fallback="/events" />
        </div>
        <div className="chip danger">{err || 'Event not found'}</div>
      </div>
    );
  }

  const {
    eventTypeLabel, snapshot,
    includes, packageStructured, timeRange, contactBits,
  } = derived;

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <div className="hstack" style={{ marginBottom: 8 }}>
        <BackButton fallback="/events" />
      </div>

      {/* Identity bar */}
      <div className="card" style={{ padding: '1.5rem 1.75rem', marginBottom: 'var(--gap)' }}>
        <div className="hstack" style={{ gap: 18, alignItems: 'flex-start' }}>
          <div style={{
            width: 56, height: 56, display: 'grid', placeItems: 'center',
            background: 'var(--bg-2)', border: '1px solid var(--line-1)',
            borderRadius: 4, flexShrink: 0,
          }}>
            <Icon name="calendar" size={22} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, marginBottom: 4 }}>
              Event · <EntityLink to={`/proposals/${proposal.id}`}>{String(proposal.id).toUpperCase()}</EntityLink>
            </div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 500, margin: '0 0 6px', lineHeight: 1.15 }}>
              <EntityLink
                to={proposal.client_id ? `/clients/${proposal.client_id}` : null}
                className="event-client-link"
                title="Open client"
              >
                {proposal.client_name || 'Event'}
              </EntityLink>
              {` · ${eventTypeLabel}`}
            </h1>
            {proposal.last_minute_hold && (
              <span className="lm-hold-badge" title="Booked ≤72h out, verify staff availability before the event">
                ⚠ Last-minute: verify staffing
              </span>
            )}
            {proposal.tip_jar === false && (
              <span className="lm-hold-badge" title="The client paid to skip the tip jar. Staff must not set one out.">
                ⚠ No tip jar (client paid to skip it)
              </span>
            )}
            <div className="muted" style={{ fontSize: 13 }}>
              {fmtDateFull(proposal.event_date && String(proposal.event_date).slice(0, 10))}
              {timeRange && ` · ${timeRange}`}
              {/* Back-of-house setup time (server-derived; never on public surfaces) */}
              {proposal.setup_time_display && ` · setup ${proposal.setup_time_display}`}
              {proposal.event_location && <>{' · '}<AddressLink address={proposal.event_location} mapQuery={venueMapQuery(proposal)} /></>}
            </div>
            {contactBits.length > 0 && (
              <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                {contactBits.join(' · ')}
              </div>
            )}
          </div>
          <div className="page-actions" style={{ flexShrink: 0 }}>
            {!editing && (
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>
                <Icon name="pen" size={12} />Edit
              </button>
            )}
            {/* Booked events are where portal use matters most, so the invite
                lives here as well as on ProposalDetail (same endpoint, same id). */}
            {!editing && proposal.client_email && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={inviting}
                onClick={async () => {
                  const who = proposal.client_name || 'the client';
                  if (!window.confirm(`Email ${who} an invite to their client portal?`)) return;
                  setInviting(true);
                  try {
                    await api.post(`/proposals/${proposal.id}/portal-invite`);
                    toast.success('Portal invite sent.');
                  } catch (e) {
                    toast.error(e.message || 'Failed to send portal invite.');
                  } finally {
                    setInviting(false);
                  }
                }}
              >
                <Icon name="send" size={12} />{inviting ? 'Inviting…' : 'Invite to portal'}
              </button>
            )}
            {/* cc-imported proposals miss the normal post-conversion nudge schedule
                (the import happens after T-21). If a drink plan EXISTS, admins
                can re-enroll the nudges here. The endpoint is idempotent. */}
            {viewer?.role === 'admin' && proposal.cc_id && drinkPlan && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={async () => {
                  try {
                    await api.post(`/admin/proposals/${proposal.id}/reenroll-drink-plan-nudge`);
                    toast.success('Drink-plan nudges scheduled.');
                  } catch (e) {
                    toast.error(`Failed to schedule: ${e?.response?.data?.error || e.message}`);
                  }
                }}
              >
                Schedule drink-plan nudges
              </button>
            )}
            {!editing && ['deposit_paid', 'balance_paid', 'confirmed'].includes(proposal.status) && (
              <button type="button" className="btn btn-ghost" onClick={() => setShowCancelDialog(true)}>
                <Icon name="x" size={12} />Cancel event
              </button>
            )}
          </div>
        </div>
      </div>

      {showCancelDialog && (
        <CancelEventDialog
          proposalId={id}
          clientName={proposal.client_name}
          onClose={() => setShowCancelDialog(false)}
          onCancelled={() => { loadProposal(); reloadShifts(); }}
        />
      )}

      <div className="event-detail-grid">
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          {editing ? (
            <EventEditForm
              proposal={proposal}
              onSaved={() => {
                setEditing(false);
                setLoading(true);
                reload().finally(() => setLoading(false));
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              <div className="card" id="event-staffing-card">
                <div className="card-head">
                  <h3>Staffing</h3>
                </div>
                <div className="card-body">
                  {shifts.length === 0 && (
                    <div className="muted tiny">No shifts created for this event yet.</div>
                  )}
                  {shifts.map(s => {
                    const needed = parsePositionsCount(s);
                    const filled = approvedCount(s);
                    const requestCount = Number(s.request_count || 0);
                    const staff = Array.isArray(s.approved_staff) ? s.approved_staff : [];
                    // Per-role fill: "Bartender 2/2 · Banquet Server 0/1".
                    const roster = parsePositionsNeeded(s.positions_needed);
                    const neededByRole = rosterCounts(roster);
                    const remaining = remainingByRole(s);
                    const roleSummary = Object.keys(neededByRole).map(role => {
                      const need = neededByRole[role];
                      const have = need - Math.max(0, remaining[role] || 0);
                      return `${role} ${have}/${need}`;
                    });
                    const fullyStaffed = roster.length > 0 && isEventFullyStaffed(remaining);
                    const openSlots = Object.values(remaining).reduce((sum, n) => sum + Math.max(0, n), 0);
                    // Per-role-capped coverage: a mixed-roster over-fill (a full role
                    // masking an empty one) must never read "fully staffed". needed
                    // minus open slots is the true filled-role count. Legacy rows with
                    // no roster fall back to the flat approved/needed counts.
                    const displayFilled = roster.length > 0 ? needed - openSlots : filled;
                    const chipOk = roster.length > 0 ? fullyStaffed : filled >= needed;
                    // Pending requests beyond the open slots are effectively a waitlist;
                    // unknown on a roster-less legacy row, so do not over-report it.
                    const waitlistCount = roster.length > 0
                      ? Math.max(0, requestCount - filled - openSlots)
                      : 0;
                    const openShift = () => drawer.open('shift', s.id);
                    return (
                      /* Row is a div, NOT an anchor: the roster below renders
                         EntityLinks, and anchors cannot nest. The date/time
                         header is the row's real anchor (cmd-click opens the
                         drawer URL in a new tab); a plain click anywhere else
                         on the row still opens the drawer, yielding to
                         interactive children. */
                      <div
                        key={s.id}
                        className="event-shift-row"
                        style={{ marginBottom: 10, cursor: 'pointer', padding: '8px 10px', margin: '0 -10px 4px', borderRadius: 4 }}
                        onClick={(ev) => { if (ev.target.closest('a, button')) return; openShift(); }}
                      >
                        <div className="hstack" style={{ marginBottom: roleSummary.length > 1 ? 4 : 6, flexWrap: 'wrap' }}>
                          <Link
                            to={drawerHref(searchParams, 'shift', s.id)}
                            title="Manage shift"
                            className="hstack"
                            style={{ gap: 8, color: 'inherit', textDecoration: 'none' }}
                          >
                            <strong>{s.event_date ? fmtDate(String(s.event_date).slice(0, 10)) : '—'}</strong>
                            <span className="tiny muted">{fmtTime24(s.start_time)}{s.end_time ? ` – ${fmtTime24(s.end_time)}` : ''}</span>
                          </Link>
                          <div className="spacer" />
                          <StatusChip kind={chipOk ? 'ok' : displayFilled > 0 ? 'warn' : 'danger'}>
                            {displayFilled}/{needed} staffed
                          </StatusChip>
                          {waitlistCount > 0 && (
                            <StatusChip kind="neutral">{waitlistCount} on waitlist</StatusChip>
                          )}
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={(ev) => { ev.stopPropagation(); openShift(); }}
                          >
                            <Icon name="userplus" size={11} />Manage
                          </button>
                        </div>
                        {roleSummary.length > 1 && (
                          <div className="tiny muted" style={{ marginBottom: 6 }}>
                            {roleSummary.join(' · ')}
                          </div>
                        )}
                        {staff.length > 0 ? (
                          <ul className="tiny" style={{ margin: 0, paddingLeft: 16, marginBottom: requestCount > 0 ? 4 : 0 }}>
                            {staff.map((member, idx) => {
                              // Defensive: tolerate the older string-shape if the
                              // GET endpoint hasn't redeployed yet (Task 27).
                              if (typeof member === 'string') {
                                return <li key={`s-${idx}`}>{member}</li>;
                              }
                              const label = member?.name || member?.email || 'Staff member';
                              const ackAt = member?.beo_acknowledged_at;
                              return (
                                <li key={member?.user_id || `${label}-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                  <EntityLink to={member?.user_id ? `/staffing/users/${member.user_id}` : null}>{label}</EntityLink>
                                  <StatusChip kind={ackAt ? 'ok' : 'neutral'}>
                                    {ackAt ? `Confirmed ${new Date(ackAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}` : 'Not opened'}
                                  </StatusChip>
                                </li>
                              );
                            })}
                          </ul>
                        ) : (
                          <div className="tiny muted" style={{ marginBottom: requestCount > 0 ? 4 : 0 }}>
                            No staff assigned yet.
                          </div>
                        )}
                        {requestCount > 0 && (
                          <div className="tiny muted">
                            {requestCount} {requestCount === 1 ? 'request' : 'requests'} on file
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {snapshot?.breakdown && (
                <div className="card">
                  <div className="card-head">
                    <h3>{proposal.package_name || 'Pricing'}</h3>
                    {proposal.guest_count != null && proposal.event_duration_hours != null && (
                      <span className="k">
                        {proposal.guest_count} guests · {Number(proposal.event_duration_hours)}hr
                      </span>
                    )}
                  </div>
                  <div className="card-body">
                    <PricingBreakdown snapshot={snapshot} />

                    {snapshot?.syrups?.selections?.length > 0 && (
                      <div className="tiny muted" style={{ marginTop: 10 }}>
                        <strong>Syrups: </strong>
                        {snapshot.syrups.selections.map(idVal => SYRUPS.find(s => s.id === idVal)?.name || idVal).join(', ')}
                      </div>
                    )}

                    {(packageStructured || includes.length > 0) && (
                      <details style={{ marginTop: 12 }}>
                        <summary className="meta-k" style={{ cursor: 'pointer' }}>Package details</summary>
                        <div style={{ marginTop: 8, fontSize: 12.5 }}>
                          {packageStructured ? (
                            packageStructured.map((section, si) => (
                              <div key={si} style={{ marginBottom: 8 }}>
                                <div style={{ fontWeight: 600, marginBottom: 2 }}>{section.heading}</div>
                                <ul style={{ margin: 0, paddingLeft: 18 }}>
                                  {section.items.map((item, i) => <li key={i}>{item}</li>)}
                                </ul>
                              </div>
                            ))
                          ) : (
                            <ul style={{ margin: 0, paddingLeft: 18 }}>
                              {includes.map((item, i) => <li key={i}>{item}</li>)}
                            </ul>
                          )}
                        </div>
                      </details>
                    )}
                  </div>
                </div>
              )}

              {Array.isArray(proposal.activity) && proposal.activity.length > 0 && (
                <div className="card">
                  <div className="card-head"><h3>Activity</h3><span className="k">{proposal.activity.length}</span></div>
                  <div className="card-body">
                    <div className="vstack" style={{ gap: 10, fontSize: 12.5 }}>
                      {proposal.activity.slice(0, 12).map((a, i) => (
                        <div key={i} className="hstack" style={{ alignItems: 'flex-start' }}>
                          <div className="queue-icon info" style={{ flexShrink: 0 }}>
                            <Icon name={
                              a.action === 'payment' ? 'dollar' :
                              a.action === 'sent' ? 'send' :
                              a.action === 'viewed' ? 'eye' :
                              a.action === 'signed' ? 'check' :
                              'pen'
                            } size={12} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div>{a.action || a.event_type || 'Update'}</div>
                            {a.metadata && typeof a.metadata === 'object' && (
                              <div className="tiny muted">{a.metadata.note || a.metadata.message || ''}</div>
                            )}
                          </div>
                          <div className="tiny muted">{a.created_at ? relDay(String(a.created_at).slice(0, 10)) : ''}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <ProposalDetailPaymentPanel proposal={proposal} onUpdate={loadProposal} />

          <DrinkPlanCard
            proposalId={proposal.id}
            drinkPlan={drinkPlan}
            setDrinkPlan={setDrinkPlan}
            loading={drinkPlanLoading}
            fullControls
            guestCount={proposal.guest_count}
            reload={loadProposal}
          />
          {drinkPlan?.finalized_at && (
            <a
              href={`${STAFF_URL}/events/${proposal.id}/beo`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary btn-sm"
              style={{ justifyContent: 'center' }}
            >
              <Icon name="external" size={11} />View BEO
            </a>
          )}
          {drinkPlan && (
            <EventDetailPlanLogo
              planId={drinkPlan.id}
              companyLogo={drinkPlan.selections?.companyLogo || ''}
              onChange={(updatedSelections) => {
                // Local update of the in-memory drinkPlan so the thumbnail reflects
                // the new state immediately. The server has already persisted via the
                // admin upload/delete route (atomic JSONB merge, no race).
                setDrinkPlan((prev) => prev ? { ...prev, selections: updatedSelections } : prev);
              }}
            />
          )}
          {drinkPlan?.selections?.menuStyle === 'house' && (
            <Suspense fallback={<button className="btn btn-primary" disabled>Loading...</button>}>
              <MenuPNG plan={drinkPlan} />
            </Suspense>
          )}

          <MessageLogCard messages={proposal.messageLog} />
        </div>
      </div>

      <ShiftDrawer
        open={drawer.kind === 'shift' && !!drawer.id}
        shiftId={drawer.id ? Number(drawer.id) : null}
        onClose={drawer.close}
        onUpdate={reloadShifts}
      />
    </div>
  );
}

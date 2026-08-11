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
import PricingBreakdown, { matchCancelTargets } from '../../components/PricingBreakdown';
import CancelLineDialog from './CancelLineDialog';
import DrinkPlanCard from '../../components/DrinkPlanCard';
import AdminMenuPrintBlock from '../../components/AdminMenuPrintBlock';
import MessageLogCard from './eventDetail/MessageLogCard';
import EventDetailPlanLogo from './EventDetailPlanLogo';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import ServiceExtensionPanel from '../../components/adminos/ServiceExtensionPanel';
import ShiftDrawer from '../../components/adminos/drawers/ShiftDrawer';
import { fmtDate, fmtDateFull, fmtTime24, fmtTimeRange24, relDay } from '../../components/adminos/format';
import { parsePositionsCount, approvedCount, remainingByRole } from '../../components/adminos/shifts';
import { parsePositionsNeeded, rosterCounts, isEventFullyStaffed } from '../../utils/staffingRoles';
import ProposalDetailPaymentPanel from './ProposalDetailPaymentPanel';
import ProposalEditorForm from './proposalEditor/ProposalEditorForm';
import CancelEventDialog from './CancelEventDialog';
import BackButton from '../../components/adminos/BackButton';
import AddressLink from '../../components/adminos/AddressLink';
import { venueMapQuery } from '../../components/VenueAddressFields';
import { STAFF_URL } from '../../utils/constants';
import SendModal, { describeSendResult } from '../../components/SendModal';
import OutOfAreaKnob from './OutOfAreaKnob';

const MenuPNG = lazy(() => import('../../components/MenuPNG/MenuPNG'));

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
  // Which compose-and-send modal is open ('invite' | 'reenroll' | null).
  const [sendModal, setSendModal] = useState(null);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  // Cancel-line: per-line removal targets + the open dialog's target entry.
  const [cancelTargets, setCancelTargets] = useState(null);
  const [cancelLineEntry, setCancelLineEntry] = useState(null);

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

  // Cancellable-line targets (server-enumerated). Silently absent on error or
  // ineligible status; the breakdown just renders without the affordance.
  // Admin-gated in the UI too: preview/execute are adminOnly server-side, so a
  // manager must never see a remove button they cannot use.
  const proposalStatus = proposal?.status;
  const isAdmin = viewer?.role === 'admin';
  // Mirrors the server's requireStaffing guard on PATCH /shifts/:id/out-of-area:
  // admins plus can_staff managers (Dallas decision 2026-08-06).
  const canStaffShifts = isAdmin || (viewer?.role === 'manager' && !!viewer?.can_staff);
  const loadCancelTargets = useCallback(() => {
    if (!isAdmin || !proposalStatus || ['archived', 'completed'].includes(proposalStatus)) {
      setCancelTargets(null);
      return;
    }
    api.get(`/proposals/${id}/cancel-line/targets`)
      .then(r => setCancelTargets(r.data.eligible ? r.data.targets : null))
      .catch(() => setCancelTargets(null));
  }, [id, proposalStatus, isAdmin]);
  useEffect(() => { loadCancelTargets(); }, [loadCancelTargets]);

  // Package row hands off to the existing cancel-event flow; every other
  // target opens the cancel-line dialog.
  const onCancelLine = useCallback((entry) => {
    if (entry.target === 'package') setShowCancelDialog(true);
    else setCancelLineEntry(entry);
  }, []);

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
    const timeRange = fmtTimeRange24(proposal.event_start_time, null, proposal.event_duration_hours, { durStyle: 'paren' });
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
              {/* Back-of-house setup time (server-derived; never on public surfaces) */}
              {proposal.setup_time_display && ` · setup ${proposal.setup_time_display}`}
              {timeRange && ` · service ${timeRange}`}
              {/* Guest count belongs above the fold: it drives staffing, ice, and
                  glassware calls. The pricing card also shows it, but only when
                  event_duration_hours is set too, so it can vanish entirely. */}
              {proposal.guest_count != null && ` · ${proposal.guest_count} guests`}
            </div>
            {proposal.event_location && (
              <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                <AddressLink address={proposal.event_location} mapQuery={venueMapQuery(proposal)} />
              </div>
            )}
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
                disabled={sendModal === 'invite'}
                onClick={() => setSendModal('invite')}
              >
                <Icon name="send" size={12} />Invite to portal
              </button>
            )}
            {/* cc-imported proposals miss the normal post-conversion nudge schedule
                (the import happens after T-21). If a drink plan EXISTS, admins
                can re-enroll the nudges here. The compose flow re-arms the schedule
                AND sends one nudge now; the endpoint is idempotent. */}
            {viewer?.role === 'admin' && proposal.cc_id && drinkPlan && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={sendModal === 'reenroll'}
                onClick={() => setSendModal('reenroll')}
              >
                Re-enroll nudges
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

      {/* Cancel-line dialog: one-motion line-item removal + refund. A staffing
          removal re-syncs shifts server-side, so shifts reload too. */}
      {cancelLineEntry && (
        <CancelLineDialog
          proposalId={id}
          entry={cancelLineEntry}
          clientEmail={proposal.client_email}
          clientName={proposal.client_name}
          onClose={() => setCancelLineEntry(null)}
          onDone={() => { loadProposal(); reloadShifts(); loadCancelTargets(); }}
        />
      )}

      {/* Compose-and-send flows (portal invite + drink-plan nudge re-enroll).
          SendModal previews the server-resolved recipient/channels; onComplete
          reports the honest per-channel result via the existing toast. */}
      {sendModal === 'invite' && (
        <SendModal
          action="portal_invite"
          entityId={proposal.id}
          title="Send Portal Invite"
          confirmLabel="Send Invite"
          onClose={() => setSendModal(null)}
          onComplete={(results) => {
            const { hadFailure, message } = describeSendResult(results);
            if (hadFailure) toast.error(message);
            else toast.success(message);
          }}
        />
      )}
      {sendModal === 'reenroll' && (
        <SendModal
          action="drink_plan_nudge_reenroll"
          entityId={proposal.id}
          title="Re-enroll nudges and send one now"
          confirmLabel="Re-enroll & Send"
          onClose={() => setSendModal(null)}
          onComplete={(results) => {
            const { hadFailure, message } = describeSendResult(results);
            const full = `Nudges re-enrolled. ${message}`;
            if (hadFailure) toast.error(full);
            else toast.success(full);
          }}
        />
      )}

      <div className="event-detail-grid">
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          {editing ? (
            <ProposalEditorForm
              proposal={proposal}
              showStaffNotifyToggles
              title="Edit event"
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
                    // Out-of-area context: distances are DERIVED server-side
                    // (a staffer's home address never rides the payload) and
                    // are visible to admins and can_staff managers alike.
                    const requesters = Array.isArray(s.requesters) ? s.requesters : [];
                    const distanceByUser = new Map(requesters.map(r => [r.user_id, r.home_distance_miles]));
                    const pendingRequesters = requesters.filter(r => r.status === 'pending');
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
                                  {distanceByUser.get(member?.user_id) != null && (
                                    <span className="tiny muted">home: {distanceByUser.get(member.user_id)} mi</span>
                                  )}
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
                        {pendingRequesters.length > 0 && (
                          <div className="hstack" style={{ flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                            {pendingRequesters.map(r => (
                              <span key={r.request_id} className="chip tiny">
                                {r.name}
                                {r.home_distance_miles != null
                                  ? ` · home: ${r.home_distance_miles} mi`
                                  : ' · home: no address on file'}
                              </span>
                            ))}
                          </div>
                        )}
                        {canStaffShifts && <OutOfAreaKnob shift={s} onSaved={reloadShifts} />}
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
                    <PricingBreakdown snapshot={snapshot} cancelTargets={cancelTargets} onCancelLine={onCancelLine} />

                    {/* Cancellable targets with no matching breakdown row (per-syrup
                        targets; label drift on an old snapshot) stay reachable here. */}
                    {cancelTargets && matchCancelTargets(snapshot, cancelTargets).unmatched.length > 0 && (
                      <div className="hstack" style={{ flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                        <span className="tiny muted">Other removable items:</span>
                        {matchCancelTargets(snapshot, cancelTargets).unmatched.map((e) => (
                          <button key={e.target} type="button" className="btn btn-ghost btn-sm"
                            onClick={() => onCancelLine(e)}>
                            ✕ {e.label}
                          </button>
                        ))}
                      </div>
                    )}

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

              <MessageLogCard messages={proposal.messageLog} />
            </>
          )}
        </div>

        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <ProposalDetailPaymentPanel proposal={proposal} onUpdate={loadProposal} />

          {/* Self-loading; renders nothing when the event has no extension
              requests, so most events never show the card. */}
          <ServiceExtensionPanel proposalId={proposal.id} />

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
              <Icon name="external" size={11} />View event details
            </a>
          )}
          <AdminMenuPrintBlock
            proposalId={proposal.id}
            menuPrintKey={proposal.menu_print_key}
            menuNotRequired={proposal.menu_not_required}
            onChange={loadProposal}
          />
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

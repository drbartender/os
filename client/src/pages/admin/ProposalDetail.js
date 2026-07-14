import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { interpolatePackageIncludes } from '../../utils/packageIncludes';
import { PUBLIC_SITE_URL } from '../../utils/constants';
import { formatPhone } from '../../utils/formatPhone';
import { getPackageItems } from '../../data/packages';
import { SYRUPS } from '../../data/syrups';
import PricingBreakdown from '../../components/PricingBreakdown';
import DrinkPlanCard from '../../components/DrinkPlanCard';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import { fmtDateFull } from '../../components/adminos/format';
import ProposalDetailEditForm from './ProposalDetailEditForm';
import ProposalChangeRequestCard from './ProposalChangeRequestCard';
import AlternativesPanel from './AlternativesPanel';
import ProposalDetailPaymentPanel from './ProposalDetailPaymentPanel';
import CancelEventDialog from './CancelEventDialog';
import BackButton from '../../components/adminos/BackButton';
import AddressLink from '../../components/adminos/AddressLink';
import { venueMapQuery } from '../../components/VenueAddressFields';
import EntityLink from '../../components/EntityLink';
import { proposalStatusMeta } from '../../utils/proposalStatusMap';

function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatTime12(t) {
  if (!t) return '?';
  const [h, m] = t.split(':').map(Number);
  const hour12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${hour12}:${String(m).padStart(2, '0')} ${ampm}`;
}

export default function ProposalDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(true);
  // Honor ?edit=1 deep-link from EventsDashboard kebab "Edit Event" action.
  const [editing, setEditing] = useState(searchParams.get('edit') === '1');

  // Notes
  const [notes, setNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);

  // Public link copy
  const [linkCopied, setLinkCopied] = useState(false);
  const [resending, setResending] = useState(false);
  const [inviting, setInviting] = useState(false);

  // Drink plan — state stays here because autoAddedMap/cocktailNameById on the
  // Pricing card read drinkPlan.selections.addOns. The card itself is extracted
  // into a shared component (consumed via prop).
  const [drinkPlan, setDrinkPlan] = useState(null);
  const [drinkPlanLoading, setDrinkPlanLoading] = useState(false);
  const [planCocktails, setPlanCocktails] = useState([]);

  // Activity modal
  const [showActivityPopup, setShowActivityPopup] = useState(false);

  // Archive modal: openSiblings = the client's OTHER open, unpaid proposals
  // (loose alternatives or formal group members), fetched when the modal opens
  // so the scope choice can say how many the whole-set option covers.
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [openSiblings, setOpenSiblings] = useState([]);
  // Cancel-event dialog (booked proposals only; fix #7).
  const [showCancelDialog, setShowCancelDialog] = useState(false);

  // Change-request review state. openCr = any pending request (drives the
  // direct-edit warning). pendingCr = the request being applied via the deep-link.
  // appliedCrId is captured ONCE at mount: the cleanup effect below strips
  // change_request_id from the URL, so re-deriving pendingCr from the live param
  // would clear it out from under the editor's Save. Capturing at mount keeps it stable.
  const [openCr, setOpenCr] = useState(null);
  const [pendingCr, setPendingCr] = useState(null);
  const [appliedCrId] = useState(() => searchParams.get('change_request_id'));

  const loadProposal = useCallback(() => {
    return api.get(`/proposals/${id}`).then(res => {
      setProposal(res.data);
      setNotes(res.data.admin_notes || '');
    }).catch(err => {
      if (err.status === 404) {
        toast.error('Proposal not found.');
        navigate('/proposals');
      } else {
        toast.error(err.message || 'Failed to load proposal. Try refreshing.');
      }
    }).finally(() => setLoading(false));
  }, [id, navigate, toast]);

  useEffect(() => { loadProposal(); }, [loadProposal]);

  // Option-group state for the Alternatives panel. Falls back to solo on any
  // error so the normal Send flow is never blocked by group-fetch trouble.
  const [group, setGroup] = useState(null);
  const loadGroup = useCallback(() => {
    api.get(`/proposals/${id}/group`)
      .then(r => setGroup(r.data))
      .catch(() => setGroup({ grouped: false }));
  }, [id]);
  useEffect(() => { loadGroup(); }, [loadGroup]);

  useEffect(() => {
    api.get(`/proposals/${id}/change-requests`)
      .then(r => {
        const rows = r.data.requests || [];
        setOpenCr(rows.find(x => x.status === 'pending') || null);
        setPendingCr(appliedCrId ? (rows.find(x => String(x.id) === String(appliedCrId)) || null) : null);
      })
      .catch(() => {});
  }, [id, appliedCrId]);

  // After honoring ?edit=1, strip the query param so the URL stays clean
  // (and a future reload doesn't auto-reopen edit if the user has navigated away).
  useEffect(() => {
    if (searchParams.get('edit') === '1') {
      const next = new URLSearchParams(searchParams);
      next.delete('edit');
      next.delete('change_request_id');
      setSearchParams(next, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load drink plan first. The cocktail catalog (large response, used only to
  // resolve auto-added upgrade names) is fetched lazily in a second effect
  // below — only when there's actually an auto-added upgrade to label.
  useEffect(() => {
    if (!id) return;
    // Clear stale data when navigating between proposals so the previous
    // proposal's drink plan can't briefly flash before the new one resolves.
    setDrinkPlan(null);
    setPlanCocktails([]);
    setDrinkPlanLoading(true);
    let cancelled = false;
    api.get(`/drink-plans/by-proposal/${id}`)
      .then(planRes => { if (!cancelled) setDrinkPlan(planRes.data); })
      .catch(() => { if (!cancelled) setDrinkPlan(null); })
      .finally(() => { if (!cancelled) setDrinkPlanLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  // Auto-added specialty upgrades (badges)
  const autoAddedMap = useMemo(() => {
    const sel = drinkPlan?.selections || {};
    const out = {};
    for (const [slug, meta] of Object.entries(sel.addOns || {})) {
      if (meta?.autoAdded && Array.isArray(meta.triggeredBy) && meta.triggeredBy.length > 0) {
        out[slug] = { triggeredBy: meta.triggeredBy };
      }
    }
    return out;
  }, [drinkPlan]);

  // Lazy-load the cocktail catalog only when we actually need to resolve
  // auto-added upgrade names. Most proposals don't have any, so this skips
  // a sizable response on every detail-page navigation.
  useEffect(() => {
    if (Object.keys(autoAddedMap).length === 0) return;
    if (planCocktails.length > 0) return;
    api.get('/cocktails')
      .then(res => setPlanCocktails(res.data.cocktails || []))
      .catch(() => { /* badges fall back to raw IDs — not fatal */ });
  }, [autoAddedMap, planCocktails.length]);

  // Activity modal: Esc-to-close so behavior matches drawers and the assign-event modal.
  useEffect(() => {
    if (!showActivityPopup) return;
    const onKey = (e) => { if (e.key === 'Escape') setShowActivityPopup(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showActivityPopup]);

  const cocktailNameById = useMemo(() => {
    const map = {};
    for (const c of (planCocktails || [])) map[c.id] = c.name;
    return map;
  }, [planCocktails]);

  const copyPublicLink = () => {
    const url = `${PUBLIC_SITE_URL}/proposal/${proposal.token}`;
    navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  };

  const previewAsClient = () => {
    if (!proposal?.token) return;
    window.open(`${PUBLIC_SITE_URL}/proposal/${proposal.token}`, '_blank', 'noopener,noreferrer');
  };

  const resendProposal = async () => {
    const who = proposal.client_name || 'the client';
    if (!window.confirm(`Resend this proposal to ${who} by email and text?`)) return;
    setResending(true);
    try {
      await api.post(`/proposals/${id}/resend`);
      toast.success('Proposal resent.');
    } catch (err) {
      toast.error(err.message || 'Failed to resend proposal.');
    } finally {
      setResending(false);
    }
  };

  const invitePortal = async () => {
    const who = proposal.client_name || 'the client';
    if (!window.confirm(`Email ${who} an invite to their client portal?`)) return;
    setInviting(true);
    try {
      await api.post(`/proposals/${id}/portal-invite`);
      toast.success('Portal invite sent.');
    } catch (err) {
      toast.error(err.message || 'Failed to send portal invite.');
    } finally {
      setInviting(false);
    }
  };

  const saveNotes = async () => {
    setSavingNotes(true);
    try {
      await api.patch(`/proposals/${id}/notes`, { admin_notes: notes });
      toast.success('Notes saved.');
    } catch (err) {
      toast.error(err.message || 'Failed to save notes.');
    } finally {
      setSavingNotes(false);
    }
  };

  const updateStatus = async (status) => {
    if (status === 'sent' && !proposal.client_email) {
      const proceed = window.confirm('No email on file. Send via SMS only?');
      if (!proceed) return;
    }
    if (status === 'accepted') {
      const proceed = window.confirm('Mark this proposal accepted? This is normally automatic when the client signs and pays. Continue only for a manual or offline booking.');
      if (!proceed) return;
    }
    try {
      const res = await api.patch(`/proposals/${id}/status`, { status });
      setProposal(prev => ({ ...prev, status: res.data.status }));
      if (status === 'sent') toast.success('Proposal sent to client.');
      else if (status === 'accepted') toast.success('Marked as accepted.');
      else toast.success(`Status updated to ${status}.`);
    } catch (err) {
      toast.error(err.message || 'Failed to update status.');
    }
  };

  // Archive flow. The scope popup only appears when the client actually has
  // other open, unpaid proposals; otherwise a plain confirm suffices.
  const ARCHIVABLE_STATUSES = ['draft', 'sent', 'viewed', 'modified', 'accepted'];
  const openArchiveModal = async () => {
    let siblings = [];
    if (proposal.client_id) {
      try {
        const res = await api.get(`/clients/${proposal.client_id}`);
        siblings = (res.data.proposals || []).filter((p) =>
          Number(p.id) !== Number(id)
          && ARCHIVABLE_STATUSES.includes(p.status)
          && !(Number(p.amount_paid) > 0));
      } catch {
        siblings = []; // sibling fetch is best-effort; single-archive still works
      }
    }
    if (siblings.length === 0) {
      const ok = window.confirm('Archive this proposal? It moves to the Archived shelf and can be recovered later.');
      if (ok) await doArchive('one');
      return;
    }
    setOpenSiblings(siblings);
    setShowArchiveModal(true);
  };

  const doArchive = async (scope) => {
    setArchiving(true);
    try {
      const res = await api.post(`/proposals/${id}/archive`, { scope });
      const n = (res.data.archived_ids || []).length;
      toast.success(n > 1 ? `${n} proposals archived.` : 'Proposal archived.');
      setShowArchiveModal(false);
      loadProposal();
    } catch (err) {
      toast.error(err?.response?.data?.error || err.message || 'Failed to archive.');
    } finally {
      setArchiving(false);
    }
  };

  if (loading) return <div className="page"><div className="muted">Loading proposal…</div></div>;
  if (!proposal) return null;

  const statusInfo = proposalStatusMeta(proposal.status);
  const eventTypeLabel = getEventTypeLabel({
    event_type: proposal.event_type,
    event_type_custom: proposal.event_type_custom,
  });
  const snapshot = proposal.pricing_snapshot;
  const bartenders = snapshot?.staffing?.actual;
  const durationHours = snapshot?.inputs?.durationHours;
  const includes = interpolatePackageIncludes(proposal.package_includes, { durationHours, bartenders });
  const packageStructured = getPackageItems(proposal.package_slug);
  const recentActivity = (proposal.activity || []).slice(0, 5);
  const canSend = ['draft', 'modified'].includes(proposal.status);
  const canMarkAccepted = ['sent', 'viewed', 'modified'].includes(proposal.status);
  // Resend only in the active, sent-not-yet-paid window (modified uses "Send to
  // client"); archived and paid/confirmed/completed are excluded here and server-side.
  const canResend = ['sent', 'viewed', 'accepted'].includes(proposal.status);
  // Over-budget badge (Thumbtack stated budget vs computed total): pre-acceptance
  // only. budget_max null = no cap known ("not sure" / "More than $X"), never flags.
  const overBudget = proposal.budget_max != null
    && Number(proposal.total_price) > Number(proposal.budget_max)
    && ['draft', 'sent'].includes(proposal.status);
  const budgetRangeLabel = overBudget
    ? (Number(proposal.budget_min) > 0
        ? `$${proposal.budget_min}-$${proposal.budget_max}`
        : `under $${proposal.budget_max}`)
    : null;

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <div className="hstack" style={{ marginBottom: 8 }}>
        <BackButton fallback="/proposals" />
      </div>

      {/* Identity bar */}
      <div className="card" style={{ padding: '1.5rem 1.75rem', marginBottom: 'var(--gap)' }}>
        <div className="hstack" style={{ gap: 18, alignItems: 'flex-start' }}>
          <div style={{
            width: 56, height: 56, display: 'grid', placeItems: 'center',
            background: 'var(--bg-2)', border: '1px solid var(--line-1)',
            borderRadius: 4, flexShrink: 0,
          }}>
            <Icon name="clipboard" size={22} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, marginBottom: 4 }}>
              Proposal · #{proposal.id}
            </div>
            <div className="hstack" style={{ gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 500, margin: 0, lineHeight: 1.15 }}>
                <EntityLink
                  to={proposal.client_id ? `/clients/${proposal.client_id}` : null}
                  className="event-client-link"
                  title={proposal.client_id ? 'Open client' : undefined}
                >
                  {proposal.client_name || `Proposal #${proposal.id}`}
                </EntityLink>
              </h1>
              <StatusChip kind={statusInfo.kind}>{statusInfo.label}</StatusChip>
              {proposal.last_minute_hold && (
                <span className="lm-hold-badge" title="Booked ≤72h out, verify staff availability before the event">
                  ⚠ Last-minute: verify staffing
                </span>
              )}
              {overBudget && (
                <span
                  className="budget-over-badge"
                  title="Thumbtack lead stated this budget. Consider a discount or trimmed scope to win the job."
                >
                  ⚠ Over stated budget: ${Math.round(Number(proposal.total_price))} vs {budgetRangeLabel}
                </span>
              )}
              {proposal.package_name && <span className="tag">{proposal.package_name}</span>}
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {eventTypeLabel}
              {proposal.event_date && ` · ${fmtDateFull(String(proposal.event_date).slice(0, 10))}`}
              {proposal.event_start_time && ` · ${formatTime12(proposal.event_start_time)}`}
              {proposal.event_location && ` · ${proposal.event_location}`}
              {proposal.guest_count != null && ` · ${proposal.guest_count} guests`}
            </div>
          </div>
          <div className="page-actions" style={{ flexShrink: 0 }}>
            <button type="button" className="btn btn-ghost" onClick={copyPublicLink}>
              <Icon name="copy" size={12} />{linkCopied ? 'Copied!' : 'Copy link'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={previewAsClient}>
              <Icon name="external" size={12} />Preview as client
            </button>
            {!editing && (
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>
                <Icon name="pen" size={12} />Edit
              </button>
            )}
            {/* Grouped options send together via the Alternatives panel ("Send
                options" = one compare email); the solo send would 409 USE_GROUP_SEND. */}
            {!editing && canSend && group && !group.grouped && (
              <button type="button" className="btn btn-primary" onClick={() => updateStatus('sent')}>
                <Icon name="send" size={12} />Send to client
              </button>
            )}
            {!editing && canResend && (
              <button type="button" className="btn btn-secondary" onClick={resendProposal} disabled={resending}>
                <Icon name="send" size={12} />{resending ? 'Resending…' : 'Resend'}
              </button>
            )}
            {!editing && proposal.client_email && (
              <button type="button" className="btn btn-ghost" onClick={invitePortal} disabled={inviting}>
                <Icon name="send" size={12} />{inviting ? 'Inviting…' : 'Invite to portal'}
              </button>
            )}
            {!editing && canMarkAccepted && (
              <button type="button" className="btn btn-primary" onClick={() => updateStatus('accepted')}>
                <Icon name="check" size={12} />Mark accepted
              </button>
            )}
            {!editing && ARCHIVABLE_STATUSES.includes(proposal.status) && (
              <button type="button" className="btn btn-ghost" onClick={openArchiveModal} disabled={archiving}>
                <Icon name="x" size={12} />{archiving ? 'Archiving…' : 'Archive'}
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 'var(--gap)' }}>
        {/* Left column */}
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          {editing ? (
            <>
              {openCr && !pendingCr && (
                <div className="client-alert client-alert-warning" role="status">
                  Heads up: this proposal has a pending change request from the client. Saving a
                  direct edit will supersede it (the request is auto-cancelled on save). To apply
                  the client's request instead, cancel out and use "Apply in editor" on the
                  change-request card.
                </div>
              )}
              <ProposalDetailEditForm
                proposal={proposal}
                changeRequest={pendingCr}
                onSaved={() => {
                  setEditing(false);
                  setPendingCr(null);
                  setLoading(true);
                  loadProposal();
                }}
                onCancel={() => setEditing(false)}
              />
            </>
          ) : (
            <>
              <ProposalChangeRequestCard
                proposalId={id}
                onChanged={loadProposal}
                onApply={(cr) => { setPendingCr(cr); setEditing(true); }}
              />
              <AlternativesPanel
                proposalId={id}
                proposal={proposal}
                group={group}
                onChanged={() => { loadGroup(); loadProposal(); }}
              />
              {/* Client */}
              <div className="card">
                <div className="card-head">
                  <h3>Client</h3>
                  {proposal.client_id && (
                    <EntityLink to={`/clients/${proposal.client_id}`} className="btn btn-ghost btn-sm">
                      <Icon name="external" size={11} />Open client
                    </EntityLink>
                  )}
                </div>
                <div className="card-body">
                  <dl className="dl">
                    <dt>Name</dt><dd>{proposal.client_name || '—'}</dd>
                    <dt>Email</dt>
                    <dd>{proposal.client_email
                      ? <a href={`mailto:${proposal.client_email}`}>{proposal.client_email}</a>
                      : '—'}</dd>
                    <dt>Phone</dt>
                    <dd>{proposal.client_phone
                      ? <a href={`tel:${proposal.client_phone}`}>{formatPhone(proposal.client_phone)}</a>
                      : '—'}</dd>
                    <dt>Source</dt><dd className="muted">{proposal.client_source || '—'}</dd>
                  </dl>
                </div>
              </div>

              {/* Event */}
              <div className="card">
                <div className="card-head"><h3>Event</h3></div>
                <div className="card-body">
                  <dl className="dl">
                    <dt>Type</dt><dd>{eventTypeLabel}</dd>
                    <dt>Date</dt>
                    <dd>{proposal.event_date ? fmtDateFull(String(proposal.event_date).slice(0, 10)) : '—'}</dd>
                    <dt>Time</dt>
                    <dd>
                      {proposal.event_start_time ? formatTime12(proposal.event_start_time) : '—'}
                      {proposal.event_duration_hours
                        ? ` · ${proposal.event_duration_hours} ${Number(proposal.event_duration_hours) === 1 ? 'hour' : 'hours'}`
                        : ''}
                    </dd>
                    <dt>Location</dt><dd><AddressLink address={proposal.event_location} mapQuery={venueMapQuery(proposal)} /></dd>
                    <dt>Guests</dt><dd className="num">{proposal.guest_count || '—'}</dd>
                    {proposal.num_bars > 0 && <><dt>Portable bars</dt><dd className="num">{proposal.num_bars}</dd></>}
                    {proposal.client_provides_glassware && (
                      <><dt>Glassware</dt><dd>Client provides own glassware</dd></>
                    )}
                  </dl>
                </div>
              </div>

              {/* Signature / acceptance */}
              {proposal.client_signed_at && (
                <div className="card">
                  <div className="card-head"><h3>Signature</h3></div>
                  <div className="card-body">
                    <dl className="dl">
                      <dt>Signed by</dt><dd>{proposal.client_signed_name || '—'}</dd>
                      <dt>Signed on</dt>
                      <dd>{fmtDateFull(String(proposal.client_signed_at).slice(0, 10))}</dd>
                      <dt>Agreement version</dt>
                      <dd className="muted">{proposal.client_signature_document_version || '—'}</dd>
                    </dl>
                  </div>
                </div>
              )}

              {/* Class options (whiskey/tequila tasting wizard) */}
              {proposal.class_options && (proposal.class_options.spirit_category || proposal.class_options.top_shelf_requested) && (
                <div className="card">
                  <div className="card-head"><h3>Class details</h3></div>
                  <div className="card-body">
                    {proposal.class_options.top_shelf_requested && (
                      <div className="chip warn" style={{ marginBottom: 10 }}>
                        Top shelf requested. Set a custom total before sending
                      </div>
                    )}
                    {proposal.class_options.spirit_category && (
                      <dl className="dl">
                        <dt>Tasting</dt>
                        <dd>{
                          proposal.class_options.spirit_category === 'whiskey_bourbon' ? 'Whiskey & Bourbon' :
                          proposal.class_options.spirit_category === 'tequila_mezcal' ? 'Tequila & Mezcal' :
                          proposal.class_options.spirit_category
                        }</dd>
                      </dl>
                    )}
                  </div>
                </div>
              )}

              {/* Pricing */}
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

                  {/* Auto-added specialty upgrades */}
                  {Object.keys(autoAddedMap).length > 0 && (
                    <div className="hstack" style={{ flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                      {Object.entries(autoAddedMap).map(([slug, { triggeredBy }]) => {
                        const drinkNames = triggeredBy.map(idVal => cocktailNameById[idVal] || idVal).join(', ');
                        return (
                          <span key={slug} className="tag" title={`Auto-added from: ${drinkNames}`}>
                            {slug}: from {drinkNames}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {/* Syrups */}
                  {snapshot?.syrups?.selections?.length > 0 && (
                    <div className="tiny muted" style={{ marginTop: 10 }}>
                      <strong>Syrups: </strong>
                      {snapshot.syrups.selections.map(idVal => SYRUPS.find(s => s.id === idVal)?.name || idVal).join(', ')}
                    </div>
                  )}

                  {/* Package details (optional, structured if present) */}
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

              {/* Admin notes */}
              <div className="card">
                <div className="card-head"><h3>Admin notes</h3></div>
                <div className="card-body">
                  <textarea
                    className="input"
                    rows={4}
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    placeholder="Internal notes about this proposal…"
                    style={{ width: '100%', resize: 'vertical', minHeight: 80, padding: 8 }} />
                  <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 8 }}
                    onClick={saveNotes} disabled={savingNotes}>
                    {savingNotes ? 'Saving…' : 'Save notes'}
                  </button>
                </div>
              </div>

              {/* Activity rail */}
              {proposal.activity && proposal.activity.length > 0 && (
                <div className="card">
                  <div className="card-head">
                    <h3>Activity</h3>
                    <span className="k">{proposal.activity.length}</span>
                  </div>
                  <div className="card-body">
                    <div className="vstack" style={{ gap: 10, fontSize: 12.5 }}>
                      {recentActivity.map((entry, i) => (
                        <div key={i} className="hstack" style={{ alignItems: 'flex-start' }}>
                          <div className="queue-icon info" style={{ flexShrink: 0 }}>
                            <Icon name={
                              /payment|paid|deposit/i.test(entry.action || '') ? 'dollar' :
                              /sent/i.test(entry.action || '') ? 'send' :
                              /view/i.test(entry.action || '') ? 'eye' :
                              /accept|sign|confirm/i.test(entry.action || '') ? 'check' :
                              'pen'
                            } size={11} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div>{entry.action}</div>
                            <div className="tiny muted">
                              {entry.actor_type} · {formatDateTime(entry.created_at)}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {proposal.activity.length > recentActivity.length && (
                      <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 10 }}
                        onClick={() => setShowActivityPopup(true)}>
                        View all ({proposal.activity.length})
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right rail */}
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <ProposalDetailPaymentPanel proposal={proposal} onUpdate={loadProposal} />

          <DrinkPlanCard
            proposalId={proposal.id}
            drinkPlan={drinkPlan}
            setDrinkPlan={setDrinkPlan}
            loading={drinkPlanLoading}
          />

          {/* Event shortcut once booking is confirmed */}
          {['deposit_paid', 'balance_paid', 'confirmed', 'completed'].includes(proposal.status) && (
            <div className="card">
              <div className="card-head"><h3>Event</h3></div>
              <div className="card-body">
                <div className="muted tiny" style={{ marginBottom: 8 }}>
                  Staffing, equipment, and shifts live on the event page.
                </div>
                <EntityLink to={`/events/${proposal.id}`} className="btn btn-secondary btn-sm" style={{ justifyContent: 'center' }}>
                  <Icon name="calendar" size={11} />Open event
                </EntityLink>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Cancel-event dialog (booked proposals; fix #7). */}
      {showCancelDialog && (
        <CancelEventDialog
          proposalId={id}
          clientName={proposal.client_name}
          onClose={() => setShowCancelDialog(false)}
          onCancelled={() => { loadProposal(); }}
        />
      )}

      {/* Archive scope modal: only shown when the client has other open,
          unpaid proposals (loose alternatives or a formal comparison). */}
      {showArchiveModal && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
          onClick={() => !archiving && setShowArchiveModal(false)}>
          <div className="card" style={{ width: '100%', maxWidth: 460 }}
            onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <h3>Archive proposal</h3>
              <button type="button" className="btn btn-ghost btn-sm" disabled={archiving}
                onClick={() => setShowArchiveModal(false)}>
                <Icon name="x" size={11} />Cancel
              </button>
            </div>
            <div className="card-body">
              <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
                {proposal.client_name || 'This client'} has {openSiblings.length} other open
                {' '}proposal{openSiblings.length === 1 ? '' : 's'}. Archive just this one, or the whole set?
                Archived proposals move to the Archived shelf and can be recovered later.
              </div>
              {/* Peek links open in a new tab so the archive decision is not lost. */}
              <div className="vstack" style={{ gap: 2, marginBottom: 12 }}>
                {openSiblings.map(s => (
                  <EntityLink key={s.id} to={`/proposals/${s.id}`} target="_blank" rel="noopener noreferrer" className="tiny">
                    #{s.id} · {getEventTypeLabel({ event_type: s.event_type, event_type_custom: s.event_type_custom })}
                    {s.event_date ? ` · ${String(s.event_date).slice(0, 10)}` : ''}
                  </EntityLink>
                ))}
              </div>
              <div className="vstack" style={{ gap: 8 }}>
                <button type="button" className="btn btn-secondary" disabled={archiving}
                  onClick={() => doArchive('one')}>
                  Just this proposal
                </button>
                <button type="button" className="btn btn-primary" disabled={archiving}
                  onClick={() => doArchive('set')}>
                  {archiving ? 'Archiving…' : `This one + ${openSiblings.length} other${openSiblings.length === 1 ? '' : 's'} (whole set)`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Full activity log modal */}
      {showActivityPopup && proposal.activity && proposal.activity.length > 0 && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
          onClick={() => setShowActivityPopup(false)}>
          <div className="card" style={{ width: '100%', maxWidth: 640, maxHeight: '80vh', overflow: 'auto' }}
            onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <h3>Activity log</h3>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowActivityPopup(false)}>
                <Icon name="x" size={11} />Close
              </button>
            </div>
            <div className="card-body">
              <div className="vstack" style={{ gap: 12 }}>
                {proposal.activity.map((entry, i) => {
                  const details = entry.details || {};
                  return (
                    <div key={i} style={{ paddingBottom: 10, borderBottom: '1px solid var(--line-1)' }}>
                      <div className="hstack" style={{ alignItems: 'flex-start' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 500, fontSize: 13 }}>{entry.action}</div>
                          <div className="tiny muted" style={{ marginTop: 2 }}>
                            <span style={{ textTransform: 'capitalize' }}>{entry.actor_type}</span>
                            {' · '}
                            {entry.actor_type === 'client' ? 'Proposal page' :
                              entry.actor_type === 'admin' ? 'Admin panel' : 'System'}
                          </div>
                        </div>
                        <div className="tiny muted" style={{ whiteSpace: 'nowrap' }}>
                          {formatDateTime(entry.created_at)}
                        </div>
                      </div>
                      {(details.ip || details.location) && (
                        <div className="tiny muted" style={{ marginTop: 4 }}>
                          {details.location && <span>{details.location}</span>}
                          {details.ip && (
                            <span style={{ marginLeft: details.location ? 8 : 0, fontFamily: 'monospace' }}>
                              {details.ip}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

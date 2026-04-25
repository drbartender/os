import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { PUBLIC_SITE_URL } from '../../utils/constants';
import { formatPhone } from '../../utils/formatPhone';
import { getPackageItems } from '../../data/packages';
import { SYRUPS } from '../../data/syrups';
import PricingBreakdown from '../../components/PricingBreakdown';
import ShoppingListButton from '../../components/ShoppingList/ShoppingListButton';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import { fmtDateFull } from '../../components/adminos/format';
import ProposalDetailEditForm from './ProposalDetailEditForm';
import ProposalDetailPaymentPanel from './ProposalDetailPaymentPanel';

const STATUS = {
  draft: { label: 'Draft', kind: 'neutral' },
  sent: { label: 'Sent', kind: 'info' },
  viewed: { label: 'Viewed', kind: 'accent' },
  modified: { label: 'Modified', kind: 'violet' },
  accepted: { label: 'Accepted', kind: 'ok' },
  deposit_paid: { label: 'Deposit paid', kind: 'ok' },
  balance_paid: { label: 'Paid in full', kind: 'ok' },
  confirmed: { label: 'Confirmed', kind: 'ok' },
  completed: { label: 'Completed', kind: 'ok' },
  declined: { label: 'Declined', kind: 'danger' },
};

const DRINK_PLAN_STATUS = {
  pending: { label: 'Pending', kind: 'neutral' },
  draft: { label: 'Draft', kind: 'neutral' },
  submitted: { label: 'Submitted', kind: 'info' },
  reviewed: { label: 'Reviewed', kind: 'ok' },
};

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

  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  // Notes
  const [notes, setNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);

  // Public link copy
  const [linkCopied, setLinkCopied] = useState(false);

  // Drink plan
  const [drinkPlan, setDrinkPlan] = useState(null);
  const [drinkPlanLoading, setDrinkPlanLoading] = useState(false);
  const [drinkPlanCopied, setDrinkPlanCopied] = useState(false);
  const [planCocktails, setPlanCocktails] = useState([]);

  // Activity modal
  const [showActivityPopup, setShowActivityPopup] = useState(false);

  const loadProposal = () => {
    return api.get(`/proposals/${id}`).then(res => {
      setProposal(res.data);
      setNotes(res.data.admin_notes || '');
    }).catch(err => {
      if (err.status === 404) {
        toast.error('Proposal not found.');
        navigate('/admin/proposals');
      } else {
        toast.error(err.message || 'Failed to load proposal. Try refreshing.');
      }
    }).finally(() => setLoading(false));
  };

  useEffect(() => { loadProposal(); }, [id]); // eslint-disable-line

  // Load drink plan + cocktails (used to resolve auto-added upgrade names)
  useEffect(() => {
    if (!id) return;
    setDrinkPlanLoading(true);
    Promise.all([
      api.get(`/drink-plans/by-proposal/${id}`),
      api.get('/cocktails'),
    ])
      .then(([planRes, cocktailsRes]) => {
        setDrinkPlan(planRes.data);
        setPlanCocktails(cocktailsRes.data.cocktails || []);
      })
      .catch(() => setDrinkPlan(null))
      .finally(() => setDrinkPlanLoading(false));
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

  const generateDrinkPlan = async () => {
    try {
      const res = await api.post(`/drink-plans/for-proposal/${id}`);
      setDrinkPlan(res.data);
      toast.success('Drink plan link generated.');
    } catch (err) {
      toast.error(err.message || 'Failed to generate drink plan.');
    }
  };

  const markDrinkPlanReviewed = async () => {
    try {
      const res = await api.patch(`/drink-plans/${drinkPlan.id}/status`, { status: 'reviewed' });
      setDrinkPlan(prev => ({ ...prev, status: res.data.status }));
      toast.success('Drink plan marked as reviewed.');
    } catch (err) {
      toast.error(err.message || 'Failed to update status.');
    }
  };

  const copyDrinkPlanLink = () => {
    const url = `${PUBLIC_SITE_URL}/plan/${drinkPlan.token}`;
    navigator.clipboard.writeText(url).then(() => {
      setDrinkPlanCopied(true);
      setTimeout(() => setDrinkPlanCopied(false), 2000);
    });
  };

  if (loading) return <div className="page"><div className="muted">Loading proposal…</div></div>;
  if (!proposal) return null;

  const statusInfo = STATUS[proposal.status] || { label: proposal.status, kind: 'neutral' };
  const eventTypeLabel = getEventTypeLabel({
    event_type: proposal.event_type,
    event_type_custom: proposal.event_type_custom,
  });
  const snapshot = proposal.pricing_snapshot;
  const bartenders = snapshot?.staffing?.actual;
  const durationHours = snapshot?.inputs?.durationHours;
  const includes = (proposal.package_includes || []).map(item => {
    let text = item;
    if (durationHours != null) text = text.replace(/\{hours\}/g, durationHours);
    if (bartenders != null) {
      text = text.replace(/\{bartenders\}/g, bartenders);
      text = text.replace(/\{bartenders_s\}/g, bartenders !== 1 ? 's' : '');
    }
    return text;
  });
  const packageStructured = getPackageItems(proposal.package_slug);
  const recentActivity = (proposal.activity || []).slice(0, 5);
  const canSend = ['draft', 'modified'].includes(proposal.status);
  const canMarkAccepted = ['sent', 'viewed', 'modified'].includes(proposal.status);

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <div className="hstack" style={{ marginBottom: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/proposals')}>
          <Icon name="left" size={11} />Proposals
        </button>
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
                {proposal.client_name || `Proposal #${proposal.id}`}
              </h1>
              <StatusChip kind={statusInfo.kind}>{statusInfo.label}</StatusChip>
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
            {!editing && canSend && (
              <button type="button" className="btn btn-primary" onClick={() => updateStatus('sent')}>
                <Icon name="send" size={12} />Send to client
              </button>
            )}
            {!editing && canMarkAccepted && (
              <button type="button" className="btn btn-primary" onClick={() => updateStatus('accepted')}>
                <Icon name="check" size={12} />Mark accepted
              </button>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 'var(--gap)' }}>
        {/* Left column */}
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          {editing ? (
            <ProposalDetailEditForm
              proposal={proposal}
              onSaved={() => {
                setEditing(false);
                setLoading(true);
                loadProposal();
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              {/* Client */}
              <div className="card">
                <div className="card-head">
                  <h3>Client</h3>
                  {proposal.client_id && (
                    <button type="button" className="btn btn-ghost btn-sm"
                      onClick={() => navigate(`/admin/clients/${proposal.client_id}`)}>
                      <Icon name="external" size={11} />Open client
                    </button>
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
                    <dt>Location</dt><dd>{proposal.event_location || '—'}</dd>
                    <dt>Guests</dt><dd className="num">{proposal.guest_count || '—'}</dd>
                    {proposal.num_bars > 0 && <><dt>Portable bars</dt><dd className="num">{proposal.num_bars}</dd></>}
                  </dl>
                </div>
              </div>

              {/* Class options (whiskey/tequila tasting wizard) */}
              {proposal.class_options && (proposal.class_options.spirit_category || proposal.class_options.top_shelf_requested) && (
                <div className="card">
                  <div className="card-head"><h3>Class details</h3></div>
                  <div className="card-body">
                    {proposal.class_options.top_shelf_requested && (
                      <div className="chip warn" style={{ marginBottom: 10 }}>
                        Top shelf requested — set a custom total before sending
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

          {/* Drink plan */}
          <div className="card">
            <div className="card-head">
              <h3>Drink plan</h3>
              {drinkPlan && (
                <StatusChip kind={(DRINK_PLAN_STATUS[drinkPlan.status] || {}).kind || 'neutral'}>
                  {(DRINK_PLAN_STATUS[drinkPlan.status] || {}).label || drinkPlan.status}
                </StatusChip>
              )}
            </div>
            <div className="card-body">
              {drinkPlanLoading ? (
                <div className="muted tiny">Loading…</div>
              ) : drinkPlan ? (
                <>
                  <dl className="dl" style={{ gridTemplateColumns: '120px 1fr', margin: 0 }}>
                    {drinkPlan.submitted_at && (
                      <>
                        <dt>Submitted</dt>
                        <dd>{formatDateTime(drinkPlan.submitted_at)}</dd>
                      </>
                    )}
                    {drinkPlan.serving_type && (
                      <>
                        <dt>Serving</dt>
                        <dd>{drinkPlan.serving_type.replace(/_/g, ' ')}</dd>
                      </>
                    )}
                  </dl>
                  <div className="vstack" style={{ gap: 6, marginTop: 12 }}>
                    <button type="button" className="btn btn-secondary btn-sm" style={{ justifyContent: 'center' }}
                      onClick={() => navigate(`/admin/drink-plans/${drinkPlan.id}`)}>
                      <Icon name="external" size={11} />View details
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" style={{ justifyContent: 'center' }}
                      onClick={copyDrinkPlanLink}>
                      <Icon name="copy" size={11} />{drinkPlanCopied ? 'Copied!' : 'Copy client link'}
                    </button>
                    {(drinkPlan.status === 'submitted' || drinkPlan.status === 'reviewed') && (
                      <ShoppingListButton planId={drinkPlan.id} planToken={drinkPlan.token} />
                    )}
                    {drinkPlan.status === 'submitted' && (
                      <button type="button" className="btn btn-primary btn-sm" style={{ justifyContent: 'center' }}
                        onClick={markDrinkPlanReviewed}>
                        <Icon name="check" size={11} />Mark reviewed
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="muted tiny" style={{ marginBottom: 8 }}>No drink plan yet.</div>
                  <button type="button" className="btn btn-primary btn-sm" onClick={generateDrinkPlan}>
                    <Icon name="plus" size={11} />Generate plan link
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Event shortcut once booking is confirmed */}
          {['deposit_paid', 'balance_paid', 'confirmed', 'completed'].includes(proposal.status) && (
            <div className="card">
              <div className="card-head"><h3>Event</h3></div>
              <div className="card-body">
                <div className="muted tiny" style={{ marginBottom: 8 }}>
                  Staffing, equipment, and shifts live on the event page.
                </div>
                <button type="button" className="btn btn-secondary btn-sm" style={{ justifyContent: 'center' }}
                  onClick={() => navigate(`/admin/events/${proposal.id}`)}>
                  <Icon name="calendar" size={11} />Open event
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

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

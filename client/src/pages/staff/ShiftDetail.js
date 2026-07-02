import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import api from '../../utils/api';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { formatSetupTime } from '../../utils/setupTime';
import TeamRosterCard from '../../components/staff/TeamRosterCard';
import DropCoverModal from '../../components/staff/DropCoverModal';
import {
  SignatureCocktailsCard,
  MocktailsCard,
  AddonsCard,
  LogisticsCard,
  GratuityTipsCard,
  CustomMenuCard,
  NotesCard,
  ConsultCard,
  ShoppingListCard,
} from '../../components/staff/BeoSections';

/**
 * ShiftDetail — staff portal v2, embedded BEO viewer (spec §6.4).
 *
 * URL: /shifts/:shiftId
 *
 * proposalId resolution path (deliberately layered to keep the page reachable
 * from any entry point — direct deep-link, push tap, browser back, etc.):
 *   1. If react-router navigation state carries `proposal_id`, use it. Most
 *      callers (HomePage Next-shift, ShiftsPage Mine, ShiftsPage Available)
 *      pass `state: { proposal_id, shift }` so the BEO load happens in
 *      one round-trip.
 *   2. Otherwise, fetch /api/shifts/user/:userId/events (extended in this
 *      task to include `s.proposal_id`) and look up the row by shift_id.
 *      Covers a logged-in staffer hitting a deep-link cold.
 *   3. If the lookup misses (staffer not approved on this shift), fall
 *      back to fetching /api/shifts (open list) for the same lookup.
 *      Open shifts can be deep-linked too (someone shares the URL).
 *
 * BEO fetch: GET /api/beo/:proposalId. Returns proposal + client + package
 * + drink_plan + addons + shift_requests + team_roster + viewer. The
 * server enforces auth (admin/manager always, staff with an approved
 * non-cancelled shift_request on the proposal). A 403 here lands us in
 * the "Not yours to view" empty-state — the staffer may have dropped or
 * been removed.
 *
 * Drop / Cover hoursToEvent computation: the spec authors mode at hour
 * boundaries (>= 336, [72, 336), < 72). This page parses `event_date +
 * start_time` and computes hours-to-event in local time. The server
 * re-validates the threshold on every drop/cover endpoint, so a client
 * mistake here only affects which button is rendered, never which path
 * the server takes.
 */
export default function ShiftDetail() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const { user } = useAuth();
  const toast = useToast();

  // Route is mounted under `/shifts/*` so the dynamic segment
  // arrives as params['*'] (the whole wildcard tail) or params.shiftId
  // when the page is mounted at a literal `:shiftId` route. Read both
  // so the page works regardless of which mount path nests it.
  const rawShiftId = params.shiftId || (params['*'] || '').split('/')[0];
  const shiftId = parseInt(rawShiftId, 10);
  const navState = location.state || null;

  const [proposalId, setProposalId] = useState(
    Number.isFinite(navState?.proposal_id) ? navState.proposal_id : null
  );
  const [shiftRow, setShiftRow] = useState(navState?.shift || null);
  const [beo, setBeo] = useState(null);
  const [drinkCatalogs, setDrinkCatalogs] = useState({ cocktails: [], mocktails: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [acknowledging, setAcknowledging] = useState(false);
  const [dropMode, setDropMode] = useState(null);
  const [dropBusy, setDropBusy] = useState(false);
  const [dropResult, setDropResult] = useState(null);

  // ── proposalId + shift-row resolver ──────────────────────────────────
  //
  // Runs once on mount for any shift that didn't arrive via nav state.
  // We use the user-events endpoint first (most navigations into
  // ShiftDetail come from /shifts/mine where the staffer IS on the
  // roster); the open-shifts fallback covers the "shared deep link" case.
  const resolveProposal = useCallback(async () => {
    if (proposalId && shiftRow) return; // already hydrated from nav state
    if (!Number.isFinite(shiftId)) return;

    try {
      // user-events first — covers the staffer's own approved shifts.
      if (user?.id) {
        const r = await api.get(`/shifts/user/${user.id}/events`);
        const all = [...(r.data?.upcoming || []), ...(r.data?.past || [])];
        const found = all.find((row) => row.id === shiftId);
        if (found) {
          setProposalId(found.proposal_id || null);
          setShiftRow(found);
          return;
        }
      }
      // Open-shifts fallback — staffer is browsing a shift they don't own.
      const openRes = await api.get('/shifts');
      const openList = Array.isArray(openRes.data) ? openRes.data : [];
      const openFound = openList.find((row) => row.id === shiftId);
      if (openFound) {
        setProposalId(openFound.proposal_id || null);
        setShiftRow(openFound);
        return;
      }
      // Couldn't find this shift in either list. Surface a friendly error
      // — likely a stale URL after the shift was cancelled or the staffer
      // was unassigned.
      throw new Error('Shift not found, it may have been cancelled.');
    } catch (err) {
      setError(err?.message || 'Could not find this shift.');
      setLoading(false);
    }
  }, [shiftId, proposalId, shiftRow, user?.id]);

  const fetchBeo = useCallback(async () => {
    if (!Number.isFinite(proposalId)) return;
    setLoading(true);
    setError(null);
    try {
      // BEO + drink catalogs in parallel so the page hydrates in one
      // round-trip. Drink catalog failures are non-fatal: render the
      // page with a "drinks loading" placeholder and let the user see
      // the team roster + key info while the catalog request retries
      // on next visit.
      const [beoRes, cocktailsRes, mocktailsRes] = await Promise.all([
        api.get(`/beo/${proposalId}`),
        api.get('/cocktails').catch(() => ({ data: { cocktails: [] } })),
        api.get('/mocktails').catch(() => ({ data: { mocktails: [] } })),
      ]);
      setBeo(beoRes.data);
      setDrinkCatalogs({
        cocktails: cocktailsRes.data?.cocktails || [],
        mocktails: mocktailsRes.data?.mocktails || [],
      });
    } catch (err) {
      const code = err?.status;
      if (code === 403) {
        setError('You are not on the roster for this event.');
      } else if (code === 404) {
        setError('Event not found.');
      } else {
        setError(err?.message || 'Could not load this event.');
      }
    } finally {
      setLoading(false);
    }
  }, [proposalId]);

  useEffect(() => { resolveProposal(); }, [resolveProposal]);
  useEffect(() => { if (proposalId) fetchBeo(); }, [proposalId, fetchBeo]);

  // ── Derived view state ───────────────────────────────────────────────

  const proposal = beo?.proposal || null;
  const client = beo?.client || null;
  const pkg = beo?.package || null;
  const drinkPlan = beo?.drink_plan || null;
  const addons = Array.isArray(beo?.addons) ? beo.addons : [];
  const teamRoster = Array.isArray(beo?.team_roster) ? beo.team_roster : [];
  const viewer = beo?.viewer || { is_admin: false, is_acknowledged: false };
  const selections = drinkPlan?.selections || {};
  const consultSelections = drinkPlan?.consult_selections || null;
  const isDrinkPlanFinalized = !!drinkPlan?.finalized_at;
  const isMyShiftApproved =
    shiftRow?.request_status === 'approved' || shiftRow?.my_request_status === 'approved';

  const hoursToEvent = useMemo(() => {
    if (!shiftRow?.event_date) return null;
    const dt = parseShiftDateTime(shiftRow.event_date, shiftRow.start_time);
    if (!dt) return null;
    return (dt.getTime() - Date.now()) / 3600000;
  }, [shiftRow?.event_date, shiftRow?.start_time]);

  // Mode is null when this isn't the staffer's shift, or when the shift
  // is already past. The card just doesn't render in those cases.
  const dropDefaultMode = useMemo(() => {
    if (!Number.isFinite(hoursToEvent)) return null;
    if (hoursToEvent < 0) return null; // past event
    if (hoursToEvent >= 336) return 'drop';
    if (hoursToEvent >= 72) return 'cover';
    return 'emergency';
  }, [hoursToEvent]);

  const setupTimeDisplay = useMemo(() => {
    if (!shiftRow?.start_time) return null;
    const minutes = Number.isFinite(shiftRow?.setup_minutes_before)
      ? shiftRow.setup_minutes_before
      : Number.isFinite(proposal?.setup_minutes_before)
      ? proposal.setup_minutes_before
      : null;
    return formatSetupTime(shiftRow.start_time, minutes);
  }, [shiftRow?.start_time, shiftRow?.setup_minutes_before, proposal?.setup_minutes_before]);

  const cocktails = useMemo(
    () => resolveDrinks(selections.signatureDrinks, drinkCatalogs.cocktails),
    [selections.signatureDrinks, drinkCatalogs.cocktails]
  );
  const mocktails = useMemo(
    () => resolveDrinks(selections.mocktails, drinkCatalogs.mocktails),
    [selections.mocktails, drinkCatalogs.mocktails]
  );
  const customCocktails = Array.isArray(selections.customCocktails) ? selections.customCocktails : [];
  const logistics = selections.logistics || null;
  const menuStyle = selections.menuStyle || null;
  const eventLabel = getEventTypeLabel({
    event_type: proposal?.event_type || shiftRow?.event_type,
    event_type_custom: proposal?.event_type_custom || shiftRow?.event_type_custom,
  });

  // ── Confirm BEO action ───────────────────────────────────────────────

  async function confirmBeo() {
    if (!proposalId) return;
    if (!isDrinkPlanFinalized) return; // shouldn't be clickable, double-guard
    setAcknowledging(true);
    try {
      const res = await api.post(`/beo/${proposalId}/acknowledge`);
      if (res.data?.acknowledged) {
        // Optimistically mark viewer + bump timestamp so the bar flips.
        const stamp = res.data?.beo_acknowledged_at || new Date().toISOString();
        setBeo((prev) =>
          prev
            ? {
                ...prev,
                viewer: { ...(prev.viewer || {}), is_acknowledged: true },
                shift_requests: (prev.shift_requests || []).map((sr) =>
                  user?.id && sr.user_id === user.id
                    ? { ...sr, beo_acknowledged_at: stamp }
                    : sr
                ),
              }
            : prev
        );
        toast?.success?.('BEO confirmed. The lead has been notified.');
      } else {
        // Admin/manager case — no-op, surface a friendly note.
        toast?.info?.('Admin viewers don’t need to confirm.');
      }
    } catch (err) {
      toast?.error?.(err?.message || 'Could not confirm the BEO.');
    } finally {
      setAcknowledging(false);
    }
  }

  // ── Drop / Cover submit ──────────────────────────────────────────────

  async function submitDropCover({ mode, reason }) {
    // request_id resolution: prefer the row from the shift fetch; fall
    // back to the BEO endpoint's shift_requests projection for the
    // viewer's own row.
    const myRequestId =
      shiftRow?.my_request_id ||
      shiftRow?.request_id ||
      (beo?.shift_requests || []).find((sr) => user?.id && sr.user_id === user.id)?.request_id ||
      null;
    if (mode !== 'emergency' && !myRequestId) {
      // claim-cover is the only one that takes shiftId; the rest need
      // the staffer's own request id.
      toast?.error?.('Could not find your request for this shift.');
      return;
    }
    setDropBusy(true);
    try {
      let endpoint = '';
      let payload = {};
      if (mode === 'drop') {
        endpoint = `/shifts/requests/${myRequestId}/drop`;
      } else if (mode === 'cover') {
        endpoint = `/shifts/requests/${myRequestId}/request-cover`;
        payload = { reason: reason || '' };
      } else {
        endpoint = `/shifts/requests/${myRequestId}/emergency-drop`;
        payload = { reason: reason || '' };
      }
      await api.post(endpoint, payload);
      setDropResult({ mode });
      setDropMode(null);
      toast?.success?.(
        mode === 'drop'
          ? 'Shift dropped.'
          : mode === 'cover'
          ? 'Cover request broadcast.'
          : 'Management notified by SMS.'
      );
    } catch (err) {
      const code = err?.code;
      const msg =
        code === 'pay_period_processing'
          ? 'Pay period is currently being processed. Try again after payroll runs.'
          : code === 'wrong_mode'
          ? 'That option isn’t available for this shift right now.'
          : err?.message || 'Could not submit. Please try again.';
      toast?.error?.(msg);
    } finally {
      setDropBusy(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────

  if (loading && !beo) {
    return (
      <>
        <DetailHead onBack={() => navigate(-1)} />
        <Skeleton />
      </>
    );
  }
  if (error && !beo) {
    return (
      <>
        <DetailHead onBack={() => navigate(-1)} />
        <div className="sp-error-card" style={{ marginTop: '0.6rem' }}>
          <div className="sp-error-card-msg">
            <strong>Couldn’t load this shift.</strong>
            <div className="sp-error-card-sub">{error}</div>
          </div>
          <button
            type="button"
            className="sp-btn sp-btn-sm"
            onClick={() => {
              setError(null);
              if (proposalId) fetchBeo();
              else resolveProposal();
            }}
          >
            Retry
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <DetailHead onBack={() => navigate(-1)} />

      <div>
        <div className="sp-detail-title">{client?.name || shiftRow?.client_name || 'Event'}</div>
        <div className="sp-detail-sub">
          {eventLabel}
          {pkg?.name ? ` · ${pkg.name}` : ''}
        </div>
      </div>

      {/* Paid "No Tip Jar Displayed" choice: unmissable, above the fold.
          Strict === false so legacy/null rows never show it. */}
      {proposal?.tip_jar === false && (
        <div className="sp-nojar-banner" role="alert">
          <strong>NO TIP JAR</strong> The client paid to skip it. Do not set one out.
        </div>
      )}

      {/* Quick-status chips */}
      <div className="sp-row" style={{ flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.6rem' }}>
        {viewer.is_admin ? (
          <span className="sp-chip info">
            <span className="sp-chip-dot" />
            Admin view
          </span>
        ) : viewer.is_acknowledged ? (
          <span className="sp-chip ok">
            <span className="sp-chip-dot" />
            BEO confirmed
          </span>
        ) : isDrinkPlanFinalized ? (
          <span className="sp-chip warn">
            <span className="sp-chip-dot" />
            BEO awaiting confirm
          </span>
        ) : (
          <span className="sp-chip neutral">
            <span className="sp-chip-dot" />
            BEO not finalized yet
          </span>
        )}
        {shiftRow?.position && (
          <span className="sp-chip neutral">
            <span className="sp-chip-dot" />
            {shiftRow.position}
          </span>
        )}
        {isMyShiftApproved && (
          <span className="sp-chip ok">
            <span className="sp-chip-dot" />
            Shift approved
          </span>
        )}
      </div>

      {/* Pre-finalize banner per spec §6.4 / BEO spec */}
      {!isDrinkPlanFinalized && !viewer.is_admin && (
        <div className="sp-error-card" style={{ background: 'var(--sp-bg-2)', borderColor: 'var(--sp-line-2)', marginTop: '0.6rem' }}>
          <div className="sp-error-card-msg">
            <strong>Plan still being finalized.</strong>
            <div className="sp-error-card-sub">
              You’ll be asked to confirm the BEO once the lead finalizes it.
            </div>
          </div>
        </div>
      )}

      {/* Key info grid */}
      <div className="sp-meta-grid">
        <div className="sp-meta">
          <div className="sp-meta-k">Date</div>
          <div className="sp-meta-v">
            {fmtLongDate(shiftRow?.event_date)}{' '}
            <span style={{ color: 'var(--sp-ink-3)' }}>· {relDayLabel(shiftRow?.event_date)}</span>
          </div>
        </div>
        {(shiftRow?.start_time || shiftRow?.end_time) && (
          <div className="sp-meta">
            <div className="sp-meta-k">Service time</div>
            <div className="sp-meta-v num">
              {shiftRow?.start_time}
              {shiftRow?.end_time ? ` – ${shiftRow.end_time}` : ''}
            </div>
          </div>
        )}
        {setupTimeDisplay && (
          <div className="sp-meta">
            <div className="sp-meta-k">Be there by</div>
            <div className="sp-meta-v num">{setupTimeDisplay}</div>
          </div>
        )}
        {(proposal?.guest_count || shiftRow?.guest_count) && (
          <div className="sp-meta">
            <div className="sp-meta-k">Guests</div>
            <div className="sp-meta-v num">{proposal?.guest_count || shiftRow?.guest_count}</div>
          </div>
        )}
        {(proposal?.event_location || shiftRow?.location) && (
          <div className="sp-meta" style={{ gridColumn: '1 / -1' }}>
            <div className="sp-meta-k">Location</div>
            <div className="sp-meta-v">{proposal?.event_location || shiftRow?.location}</div>
          </div>
        )}
        {selections.dressCode && (
          <div className="sp-meta" style={{ gridColumn: '1 / -1' }}>
            <div className="sp-meta-k">Dress code</div>
            <div className="sp-meta-v">{selections.dressCode}</div>
          </div>
        )}
        {selections.loadInNotes && (
          <div className="sp-meta" style={{ gridColumn: '1 / -1' }}>
            <div className="sp-meta-k">Load-in</div>
            <div className="sp-meta-v">{selections.loadInNotes}</div>
          </div>
        )}
      </div>

      {/* Action row */}
      <div className="sp-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        {(proposal?.event_location || shiftRow?.location) && (
          <a
            className="sp-btn sp-btn-sm"
            href={mapsHref(proposal?.event_location || shiftRow?.location)}
            target="_blank"
            rel="noreferrer"
          >
            <LocationIcon size={12} />
            Get directions
          </a>
        )}
        {client?.phone && (
          <a className="sp-btn sp-btn-sm" href={`tel:${client.phone}`}>
            <PhoneIcon size={12} />
            Call client
          </a>
        )}
      </div>

      {/* Banquet Event Order section heading */}
      <div className="sp-section-title">Banquet Event Order</div>

      {/* Team roster */}
      <TeamRosterCard teamRoster={teamRoster} />

      {/* Drinks: signature cocktails + custom + mocktails */}
      <SignatureCocktailsCard cocktails={cocktails} customCocktails={customCocktails} />
      <MocktailsCard mocktails={mocktails} />

      {/* Addons */}
      <AddonsCard addons={addons} />

      {/* Logistics */}
      <LogisticsCard logistics={logistics} />

      {/* Gratuity & tip jar (spec §9) */}
      <GratuityTipsCard
        tipJar={proposal?.tip_jar}
        gratuityPrepaid={proposal?.gratuity_prepaid}
        staffNoun={proposal?.staff_noun}
      />

      {/* Custom menu (only when selections.menuStyle is custom or house) */}
      <CustomMenuCard
        menuStyle={menuStyle}
        drinkPlan={drinkPlan}
        selections={selections}
        logoSrc={drinkPlan?.has_logo ? `${api.defaults.baseURL}/beo/${proposalId}/logo` : null}
      />

      {/* Notes from the lead */}
      <NotesCard title="Notes from the lead" body={drinkPlan?.admin_notes} />

      {/* From the client (client notes inside selections) */}
      <NotesCard title="From the client" body={selections.notes} />

      {/* Consult selections (read-only display of any consult answers) */}
      <ConsultCard consultSelections={consultSelections} />

      {/* Shopping list link (when ready) */}
      <ShoppingListCard
        status={beo?.shopping_list_status}
        drinkPlanId={drinkPlan?.id}
        onOpen={(id) => navigate(`/drink-plans/${id}`)}
      />

      {/* Drop / Cover card */}
      {!viewer.is_admin && isMyShiftApproved && dropDefaultMode && !dropResult && (
        <div
          className={
            'sp-drop-card' +
            (dropDefaultMode === 'cover' ? ' sp-drop-warn' : '') +
            (dropDefaultMode === 'emergency' ? ' sp-drop-danger' : '')
          }
        >
          <div className="sp-drop-l">
            <div className="sp-drop-title">{dropTitle(dropDefaultMode)}</div>
            <div className="sp-drop-sub">{dropSub(dropDefaultMode)}</div>
          </div>
          <button
            type="button"
            className={
              'sp-btn sp-btn-sm' + (dropDefaultMode === 'emergency' ? ' sp-btn-danger' : '')
            }
            onClick={() => setDropMode(dropDefaultMode)}
          >
            {dropCta(dropDefaultMode)}
          </button>
        </div>
      )}

      {dropResult && (
        <div className="sp-drop-result">
          <CheckIcon size={14} />
          <span>
            {dropResult.mode === 'drop' && (
              <>
                <strong>Shift dropped.</strong> Management notified.
              </>
            )}
            {dropResult.mode === 'cover' && (
              <>
                <strong>Cover request broadcast.</strong> You’re still on the roster until someone picks it up.
              </>
            )}
            {dropResult.mode === 'emergency' && (
              <>
                <strong>Management notified by SMS.</strong> They’ll be in touch.
              </>
            )}
          </span>
        </div>
      )}

      {/* Sticky Confirm bar */}
      {!viewer.is_admin && (
        <div className="sp-confirm-bar">
          {viewer.is_acknowledged ? (
            <>
              <div className="sp-confirm-bar-msg">
                <strong>Confirmed.</strong> Thanks. The lead has been notified.
              </div>
            </>
          ) : isDrinkPlanFinalized ? (
            <>
              <div className="sp-confirm-bar-msg">
                <strong>Confirm you’ve read the BEO.</strong> The lead will see this on the roster.
              </div>
              <button
                type="button"
                className="sp-btn sp-btn-lg sp-btn-primary"
                onClick={confirmBeo}
                disabled={acknowledging}
              >
                {acknowledging ? (
                  'Confirming…'
                ) : (
                  <>
                    <CheckIcon size={14} />
                    Confirm BEO
                  </>
                )}
              </button>
            </>
          ) : (
            <div className="sp-confirm-bar-msg">
              <strong>Awaiting finalization.</strong> The confirm button lights up once the lead finalizes the plan.
            </div>
          )}
        </div>
      )}
      {viewer.is_admin && (
        <div className="sp-confirm-bar">
          <div className="sp-confirm-bar-msg">
            Admin view, confirm is a per-bartender action so this button is hidden for you.
          </div>
        </div>
      )}

      <DropCoverModal
        open={!!dropMode}
        mode={dropMode}
        busy={dropBusy}
        onClose={() => (dropBusy ? null : setDropMode(null))}
        onSubmit={submitDropCover}
      />
    </>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function DetailHead({ onBack }) {
  return (
    <div className="sp-detail-head">
      <button type="button" className="sp-back" onClick={onBack}>
        <BackIcon size={14} />
        Back
      </button>
    </div>
  );
}

function Skeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }} aria-hidden="true">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 120,
            borderRadius: 10,
            background: 'var(--sp-bg-2)',
            border: '1px solid var(--sp-line-1)',
            opacity: 0.6,
          }}
        />
      ))}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Map an array of drink ids to the full cocktail / mocktail rows from
 * the catalog endpoint. Filters out IDs that don't resolve so a stale
 * drink_plan referencing a deleted cocktail doesn't crash the page.
 */
function resolveDrinks(ids, catalog) {
  if (!Array.isArray(ids) || !Array.isArray(catalog)) return [];
  const byId = new Map(catalog.map((d) => [d.id, d]));
  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((d) => ({
      id: d.id,
      name: d.name,
      emoji: d.emoji,
      method: d.method,
      glass: d.glass,
      base_spirit: d.base_spirit || d.baseSpirit,
      ingredients: d.ingredients || [],
      garnish: d.garnish,
    }));
}

/**
 * Parse a shift's local date + start_time into a JS Date in the browser's
 * local timezone. Mirrors the server-side parseShiftDateTime: treats the
 * input as wall-clock local time. The shifts table stores start_time as
 * VARCHAR (e.g. "5:00 PM" or "17:00") per CLAUDE.md "no global timezone
 * normalization."
 */
function parseShiftDateTime(eventDate, startTime) {
  if (!eventDate) return null;
  const dateStr = String(eventDate).slice(0, 10);
  const d = new Date(dateStr + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return null;
  if (!startTime) return d;
  const m = String(startTime).trim().toUpperCase().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  if (!m) return d;
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  const ap = m[3];
  if (ap === 'PM' && hh < 12) hh += 12;
  if (ap === 'AM' && hh === 12) hh = 0;
  d.setHours(hh, mm, 0, 0);
  return d;
}

function dropTitle(mode) {
  if (mode === 'drop') return 'Drop this shift';
  if (mode === 'cover') return 'Need a cover';
  return 'Emergency, can’t make it';
}

function dropSub(mode) {
  if (mode === 'drop')
    return '14+ days out, simple swap. Slot goes back to the open pool.';
  if (mode === 'cover')
    return 'Under 14 days. Cover broadcasts to qualified bartenders; you stay on the roster until someone picks it up.';
  return 'Under 72 hours. Late-drops bypass cover broadcast and ping management by SMS.';
}

function dropCta(mode) {
  if (mode === 'drop') return 'Drop shift';
  if (mode === 'cover') return 'Need a cover';
  return 'Emergency, can’t make it';
}

function fmtLongDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function relDayLabel(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff > 0) return `In ${diff}d`;
  if (diff === -1) return 'Yesterday';
  return `${-diff}d ago`;
}

function mapsHref(location) {
  if (!location) return '#';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}

// ── Inline icons ────────────────────────────────────────────────────────

function BackIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function CheckIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function LocationIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function PhoneIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />
    </svg>
  );
}


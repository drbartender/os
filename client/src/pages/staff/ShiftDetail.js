import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import api from '../../utils/api';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { formatSetupTime } from '../../utils/setupTime';
import { venueMapQuery } from '../../components/VenueAddressFields';
import TeamRosterCard from '../../components/staff/TeamRosterCard';
import DropCoverModal from '../../components/staff/DropCoverModal';
import RequestSheet from '../../components/staff/RequestSheet';
import EventActionArea from '../../components/staff/EventActionArea';
import {
  parsePositionsNeeded,
  computeRemaining,
  classifyRequest,
  isEventFullyStaffed,
} from '../../utils/staffingRoles';
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
  EquipmentCard,
  RolesCard,
  BarMenuCard,
  EventMetaGrid,
} from '../../components/staff/BeoSections';

const RequestMoreTime = React.lazy(() => import('./RequestMoreTime'));

/**
 * The cocktail and mocktail catalogs are global reference data, but
 * fetchDetails re-runs on every shift navigation and ShiftsPage keeps ONE
 * instance of this page across those hops, so an un-memoized pair of GETs cost
 * two extra round trips for every shift a staffer opened. Memoize the
 * PROMISES at module scope: one fetch per page load, shared by every
 * navigation and by a second mount.
 *
 * A rejection drops its slot so the next visit retries. Caching the failure
 * would pin an empty drink menu for the rest of the session, which on this
 * page means a staffer reading the brief sees no signature cocktails at all.
 */
const catalogPromises = { cocktails: null, mocktails: null };

function fetchDrinkCatalog(kind) {
  if (!catalogPromises[kind]) {
    catalogPromises[kind] = api.get(`/${kind}`).then(
      (res) => res.data?.[kind] || [],
      () => {
        catalogPromises[kind] = null;
        return [];
      }
    );
  }
  return catalogPromises[kind];
}

/**
 * ShiftDetail — the staff Event Details page (spec 2026-07-22).
 *
 * URL: /shifts/:shiftId
 *
 * This page used to be assigned-staff-only and hydrated from
 * GET /api/beo/:proposalId, which 403s anyone without an approved shift. A
 * staffer deciding whether to REQUEST a shift therefore got an error card and
 * nothing else, while the list they came from showed more than the detail page
 * did. Both halves of that are fixed here:
 *
 *   - ONE fetch, shift-keyed: GET /api/shifts/:shiftId/event-details. The old
 *     three-layer proposalId resolver (nav state, then the user-events feed,
 *     then the open-shifts feed) is gone; a cold deep link now works.
 *   - TWO tiers. The brief renders for EVERY staffer: date, be-there-by, venue,
 *     guests, roles + fill, equipment + supply run, gratuity and tip jar, the
 *     drink menu, logistics and notes. Assigned-only extras layer on top:
 *     client contact, teammate phone numbers, the shopping list, the bar-menu
 *     print file, drop / cover, and the confirm bar.
 *
 * Redaction is server-side (contact fields arrive null for a non-assigned
 * viewer), so this page never has to decide what to hide, only what to render.
 *
 * Drop / Cover hoursToEvent: the spec authors mode at hour boundaries (>= 336,
 * [72, 336), < 72). The server re-validates the threshold on every drop/cover
 * endpoint, so a client mistake here only affects which button renders, never
 * which path the server takes.
 */
export default function ShiftDetail() {
  const navigate = useNavigate();
  const params = useParams();
  const { user } = useAuth();
  const toast = useToast();

  // Route is mounted under `/shifts/*` so the dynamic segment
  // arrives as params['*'] (the whole wildcard tail) or params.shiftId
  // when the page is mounted at a literal `:shiftId` route. Read both
  // so the page works regardless of which mount path nests it.
  const rawShiftId = params.shiftId || (params['*'] || '').split('/')[0];
  const shiftId = parseInt(rawShiftId, 10);

  const [details, setDetails] = useState(null);
  // Mirror of `details` for reads inside stale closures (fetchDetails's catch).
  const detailsRef = useRef(null);
  useEffect(() => { detailsRef.current = details; }, [details]);
  const [drinkCatalogs, setDrinkCatalogs] = useState({ cocktails: [], mocktails: [] });
  const [logoUrl, setLogoUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [acknowledging, setAcknowledging] = useState(false);
  const [dropMode, setDropMode] = useState(null);
  const [dropBusy, setDropBusy] = useState(false);
  const [dropResult, setDropResult] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [showExtend, setShowExtend] = useState(false);

  // ShiftsPage keeps ONE instance of this component across numeric URL
  // changes, so per-shift action state must reset when the shift does or a
  // banner earned on shift A ("You dropped this shift") shadows shift B's
  // request CTA after a back/forward hop.
  useEffect(() => {
    setDropMode(null);
    setDropResult(null);
    setRequestOpen(false);
    setShowExtend(false);
  }, [shiftId]);

  // Monotonic fetch token: a response only lands if no newer fetch has started
  // since it left. Rapid A→B navigation (or an action refetch racing a nav)
  // could otherwise paint an older, slower response over the current shift.
  const fetchSeqRef = useRef(0);

  // One shift-keyed fetch. The drink catalogs ride along because the menu cards
  // resolve drink ids against them, but they come from the module memo above,
  // not the wire, on every visit after the first. Event-details itself is never
  // cached: it carries this shift's live staffing and confirm state.
  // A catalog failure is non-fatal, so the brief still renders.
  const fetchDetails = useCallback(async () => {
    if (!Number.isFinite(shiftId)) {
      setError('Shift not found.');
      setLoading(false);
      return;
    }
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const [detailsRes, cocktails, mocktails] = await Promise.all([
        api.get(`/shifts/${shiftId}/event-details`),
        fetchDrinkCatalog('cocktails'),
        fetchDrinkCatalog('mocktails'),
      ]);
      if (seq !== fetchSeqRef.current) return;
      setDetails(detailsRes.data);
      setDrinkCatalogs({ cocktails, mocktails });
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      const msg =
        err?.status === 404
          ? 'Shift not found, it may have been cancelled.'
          : err?.message || 'Could not load this event.';
      // The error CARD only renders on a cold load (error && !details). On a
      // refetch after an action, a silent failure would leave stale data on
      // screen and the staffer guessing whether their action landed, so those
      // surface as a toast instead. Read presence through the ref: this
      // callback is memoized on [shiftId], so the `details` it closed over is
      // permanently the cold-load null.
      if (detailsRef.current) toast?.error?.(msg);
      else setError(msg);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shiftId]);

  useEffect(() => { fetchDetails(); }, [fetchDetails]);

  // ── Derived view state ───────────────────────────────────────────────

  const proposal = details?.proposal || null;
  const client = details?.client || null;
  const pkg = details?.package || null;
  const drinkPlan = details?.drink_plan || null;
  const addons = Array.isArray(details?.addons) ? details.addons : [];
  const teamRoster = Array.isArray(details?.team_roster) ? details.team_roster : [];
  const viewer = details?.viewer || { is_admin: false, is_assigned: false, is_acknowledged: false };
  const selections = drinkPlan?.selections || {};
  const consultSelections = drinkPlan?.consult_selections || null;
  const isDrinkPlanFinalized = !!drinkPlan?.finalized_at;
  const proposalId = proposal?.id || null;

  // The custom-menu logo used to be handed to the card as a bare API URL. A
  // browser <img> request carries no Authorization header and GET
  // /beo/:proposalId/logo sits behind auth + requireOnboarded, so it 401'd on
  // every staff BEO and the logo was always blank. Fetch it through api (which
  // attaches the token) and hand the card an object URL instead — the same
  // shape BarMenuCard already uses for the menu print file. Revoke on cleanup:
  // ShiftsPage keeps one instance of this page across shift navigations, so a
  // leaked object URL per shift opened would pin the whole image in memory for
  // the rest of the session.
  const hasLogo = !!drinkPlan?.has_logo;
  useEffect(() => {
    if (!hasLogo || !proposalId) {
      setLogoUrl(null);
      return undefined;
    }
    let objectUrl = null;
    let cancelled = false;
    api
      .get(`/beo/${proposalId}/logo`, { responseType: 'blob' })
      .then((res) => {
        if (cancelled || !res?.data) return;
        objectUrl = URL.createObjectURL(res.data);
        setLogoUrl(objectUrl);
      })
      .catch(() => {
        // A missing or temporarily unavailable logo is cosmetic; the rest of
        // the brief still renders and the card simply omits the image.
        if (!cancelled) setLogoUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hasLogo, proposalId]);

  // The shift this page addresses, out of every non-cancelled shift on the
  // event. Replaces the old nav-state/list-lookup shiftRow entirely.
  const myShift = useMemo(
    () => (Array.isArray(details?.shifts) ? details.shifts.find((x) => x.id === shiftId) : null) || null,
    [details, shiftId]
  );

  // Per-role fill for THIS shift, shared by the roles card, the request sheet,
  // and the waitlist-vs-pending classification so all three agree.
  const remaining = useMemo(
    () => computeRemaining(
      parsePositionsNeeded(myShift?.positions_needed),
      myShift?.approved_by_role && typeof myShift.approved_by_role === 'object'
        ? myShift.approved_by_role
        : {}
    ),
    [myShift]
  );
  const fullyStaffed = useMemo(
    () => parsePositionsNeeded(myShift?.positions_needed).length > 0 && isEventFullyStaffed(remaining),
    [myShift, remaining]
  );
  const coverNeeded = !!myShift?.cover_requested_at;

  /**
   * What this viewer can DO here. 'admin' is an admin, or a manager who is only
   * viewing — a manager who is actually STAFFED is a worker and gets the normal
   * assigned experience (the server computes is_admin with that carve-out).
   *
   * Scoped to the ADDRESSED shift via my_request_status, never the
   * proposal-wide viewer.is_assigned: on a multi-shift event, a worker
   * approved on shift A who opens shift B must get B's request CTA, not A's
   * drop/confirm controls (a drop from here would target their shift-A
   * request). viewer.is_assigned stays the DISPLAY gate (roster, assigned
   * extras), which is proposal-wide on purpose.
   */
  const viewerState = useMemo(() => {
    if (viewer.is_admin) return 'admin';
    if (myShift?.my_request_status === 'approved') return 'assigned';
    if (myShift?.my_request_status === 'pending') {
      const ranked = parsePositionsNeeded(myShift?.my_requested_positions);
      const waitlisted =
        ranked.length > 0 && classifyRequest(ranked, remaining).state === 'waitlisted';
      return waitlisted ? 'waitlisted' : 'pending';
    }
    // A dropped request never surfaces in my_request_* (the payload filters
    // dropped rows), so post-drop lands in 'browsing'; EventActionArea's
    // dropResult gate renders the dropped banner there.
    return 'browsing';
  }, [viewer.is_admin, myShift, remaining]);

  const hoursToEvent = useMemo(() => {
    if (!myShift?.event_date) return null;
    const dt = parseShiftDateTime(myShift.event_date, myShift.start_time);
    if (!dt) return null;
    return (dt.getTime() - Date.now()) / 3600000;
  }, [myShift]);

  // Mode is null when the shift is already past; the card just doesn't render.
  const dropDefaultMode = useMemo(() => {
    if (!Number.isFinite(hoursToEvent)) return null;
    if (hoursToEvent < 0) return null; // past event
    if (hoursToEvent >= 336) return 'drop';
    if (hoursToEvent >= 72) return 'cover';
    return 'emergency';
  }, [hoursToEvent]);

  const setupTimeDisplay = useMemo(() => {
    if (!myShift?.start_time) return null;
    const minutes = Number.isFinite(myShift?.setup_minutes_before)
      ? myShift.setup_minutes_before
      : Number.isFinite(proposal?.setup_minutes_before)
      ? proposal.setup_minutes_before
      : null;
    return formatSetupTime(myShift.start_time, minutes);
  }, [myShift, proposal?.setup_minutes_before]);

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
    event_type: proposal?.event_type || myShift?.event_type,
    event_type_custom: proposal?.event_type_custom || myShift?.event_type_custom,
  });

  // A row shaped like an open-shifts feed row, for RequestSheet. It reads
  // positions/equipment/supply-run off the shift, the hosted flag off the
  // package, and the bar flag off the PROPOSAL (num_bars — same derivation as
  // the feed's bar_required and the server's transport gate; this page is
  // single-proposal so the top-level value applies to every shift row).
  const requestSheetShift = useMemo(() => {
    if (!myShift) return null;
    return {
      id: myShift.id,
      positions_needed: myShift.positions_needed,
      approved_by_role: myShift.approved_by_role,
      equipment_required: myShift.equipment_required,
      supply_run_required: myShift.supply_run_required,
      bar_required: proposal?.bar_required === true,
      my_requested_positions: myShift.my_requested_positions,
      package_pricing_type: pkg?.pricing_type || null,
    };
  }, [myShift, pkg?.pricing_type, proposal?.bar_required]);

  // ── Confirm action ───────────────────────────────────────────────────

  async function confirmDetails() {
    if (!proposalId) return;
    if (!isDrinkPlanFinalized) return; // shouldn't be clickable, double-guard
    setAcknowledging(true);
    try {
      // Endpoint and payload unchanged; only the words staff read changed.
      const res = await api.post(`/beo/${proposalId}/acknowledge`);
      if (res.data?.acknowledged) {
        const stamp = res.data?.beo_acknowledged_at || new Date().toISOString();
        setDetails((prev) =>
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
        toast?.success?.('Event details confirmed. The lead has been notified.');
      } else {
        toast?.info?.('Admin viewers don’t need to confirm.');
      }
    } catch (err) {
      toast?.error?.(err?.message || 'Could not confirm the event details.');
    } finally {
      setAcknowledging(false);
    }
  }

  // ── Request / withdraw / cover (new: act where you read) ──────────────

  async function withdrawRequest() {
    const requestId = myShift?.my_request_id;
    if (!requestId) return;
    setActionBusy(true);
    try {
      await api.delete(`/shifts/requests/${requestId}`);
      toast?.success?.(viewerState === 'waitlisted' ? 'Left the waitlist.' : 'Request withdrawn.');
      await fetchDetails();
    } catch (err) {
      toast?.error?.(
        err?.code === 'already_approved'
          ? 'This request is already approved. Use Drop, Cover, or Emergency drop instead.'
          : err?.message || 'Could not withdraw your request.'
      );
    } finally {
      setActionBusy(false);
    }
  }

  async function claimCover() {
    if (!Number.isFinite(shiftId)) return;
    setActionBusy(true);
    try {
      await api.post(`/shifts/requests/${shiftId}/claim-cover`);
      toast?.success?.('Cover request sent to management.');
      await fetchDetails();
    } catch (err) {
      const code = err?.code;
      toast?.error?.(
        code === 'no_active_cover_request'
          ? 'This shift is no longer requesting cover.'
          : code === 'already_covered'
          ? 'Someone else already picked up this cover.'
          : err?.message || 'Could not claim this cover.'
      );
    } finally {
      setActionBusy(false);
    }
  }

  async function onRequestSubmitted() {
    setRequestOpen(false);
    toast?.success?.('Request sent.');
    // Busy stays held across the refetch so the Request button cannot be
    // tapped a second time while the page still shows the browsing state.
    setActionBusy(true);
    try {
      await fetchDetails();
    } finally {
      setActionBusy(false);
    }
  }

  // ── Drop / Cover submit ──────────────────────────────────────────────

  async function submitDropCover({ mode, reason }) {
    // Strictly the viewer's request on THE ADDRESSED SHIFT. No proposal-wide
    // fallback: on a multi-shift event that fallback resolved to their request
    // on a DIFFERENT shift and dropped the wrong one. All three endpoints act
    // on a request id, so a missing row is a hard stop for every mode
    // (emergency included: /requests/null/emergency-drop is not a request).
    const myRequestId = myShift?.my_request_id || null;
    if (!myRequestId) {
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
      // Refresh so the page stops showing the assigned view (roster, menu,
      // confirm bar) underneath a "Shift dropped" banner.
      await fetchDetails();
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

  if (loading && !details) {
    return (
      <>
        <DetailHead onBack={() => navigate(-1)} />
        <Skeleton />
      </>
    );
  }
  if (error && !details) {
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
            onClick={() => { setError(null); fetchDetails(); }}
          >
            Retry
          </button>
        </div>
      </>
    );
  }

  // The addressed shift is gone from the payload, which means it was cancelled
  // (shifts[] carries only non-cancelled shifts). Without this the page renders
  // a blank-dated brief AND viewerState falls through to 'browsing', inviting
  // the staffer to request a shift that no longer exists.
  if (details && !myShift) {
    return (
      <>
        <DetailHead onBack={() => navigate(-1)} />
        <div className="sp-error-card" style={{ marginTop: '0.6rem' }}>
          <div className="sp-error-card-msg">
            <strong>This shift is no longer on the schedule.</strong>
            <div className="sp-error-card-sub">It may have been cancelled.</div>
          </div>
          <button type="button" className="sp-btn sp-btn-sm" onClick={() => navigate('/shifts/mine')}>
            My shifts
          </button>
        </div>
      </>
    );
  }

  // Two assignment scopes, deliberately distinct. isEventStaffer is
  // proposal-wide (server truth, drives display entitlements: roster, extras,
  // call-client — a worker on ANY shift of this event gets those). isAssignedHere
  // is scoped to the addressed shift (drives actions and this shift's
  // confirm-state chips).
  const isEventStaffer = viewer.is_assigned;
  const isAssignedHere = viewerState === 'assigned';
  const venueForMap = venueMapQuery(proposal) || proposal?.event_location || myShift?.location;

  return (
    <>
      <DetailHead onBack={() => navigate(-1)} />

      <div>
        <div className="sp-detail-title">
          {client?.name || myShift?.client_name || 'Event'}
        </div>
        <div className="sp-detail-sub">
          {eventLabel}
          {pkg?.name ? ` · ${pkg.name}` : ''}
        </div>
      </div>

      {/* Paid "No Tip Jar" choice: unmissable, above the fold. Strict === false
          so legacy/null rows never show it. */}
      {proposal?.tip_jar === false && (
        <div className="sp-nojar-banner" role="alert">
          <strong>NO TIP JAR</strong> The client paid to skip it. Do not set one out.
        </div>
      )}

      {/* Quick-status chips */}
      <div className="sp-row" style={{ flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.6rem' }}>
        {viewerState === 'admin' ? (
          <span className="sp-chip info">
            <span className="sp-chip-dot" />
            Admin view
          </span>
        ) : isAssignedHere && viewer.is_acknowledged ? (
          <span className="sp-chip ok">
            <span className="sp-chip-dot" />
            Details confirmed
          </span>
        ) : isAssignedHere && isDrinkPlanFinalized ? (
          <span className="sp-chip warn">
            <span className="sp-chip-dot" />
            Awaiting your confirm
          </span>
        ) : isAssignedHere ? (
          <span className="sp-chip neutral">
            <span className="sp-chip-dot" />
            Details not finalized yet
          </span>
        ) : null}
        {isAssignedHere && myShift?.my_position && (
          <span className="sp-chip neutral">
            <span className="sp-chip-dot" />
            {myShift.my_position}
          </span>
        )}
        {isEventStaffer && (
          <span className="sp-chip ok">
            <span className="sp-chip-dot" />
            You’re on this event
          </span>
        )}
        {coverNeeded && (
          <span className="sp-chip warn">
            <span className="sp-chip-dot" />
            Cover needed
          </span>
        )}
      </div>

      {/* ── The brief: every staffer sees this, assigned or not ───────── */}

      <EventMetaGrid
        shift={myShift}
        proposal={proposal}
        setupTimeDisplay={setupTimeDisplay}
        selections={selections}
      />

      {/* Directions are useful to anyone deciding whether they can get there.
          Calling the client is not: that stays assigned-only, and the server
          sends a null phone to everyone else regardless. */}
      <div className="sp-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        {venueForMap && (
          <a className="sp-btn sp-btn-sm" href={mapsHref(venueForMap)} target="_blank" rel="noreferrer">
            <LocationIcon size={12} />
            Get directions
          </a>
        )}
        {isEventStaffer && client?.phone && (
          <a className="sp-btn sp-btn-sm" href={`tel:${client.phone}`}>
            <PhoneIcon size={12} />
            Call client
          </a>
        )}
      </div>

      <div className="sp-section-title">Event details</div>

      <EquipmentCard
        equipment={myShift?.equipment_required}
        supplyRun={myShift?.supply_run_required === true}
        barRequired={proposal?.bar_required === true}
      />
      <RolesCard
        positionsNeeded={myShift?.positions_needed}
        approvedByRole={myShift?.approved_by_role}
      />

      {/* Gratuity + tip jar sit in the brief on purpose: they are earnings
          information, and a staffer weighing a request should have them. */}
      {proposal && (
        <GratuityTipsCard
          tipJar={proposal.tip_jar}
          gratuityPrepaid={proposal.gratuity_prepaid}
          staffNoun={proposal.staff_noun || 'bartender'}
        />
      )}

      {!isDrinkPlanFinalized && viewerState !== 'admin' && proposal && (
        <div
          className="sp-error-card"
          style={{ background: 'var(--sp-bg-2)', borderColor: 'var(--sp-line-2)' }}
        >
          <div className="sp-error-card-msg">
            <strong>Plan still being finalized.</strong>
            <div className="sp-error-card-sub">
              Drinks and notes can still change before the event.
            </div>
          </div>
        </div>
      )}

      {(isEventStaffer || viewerState === 'admin') && <TeamRosterCard teamRoster={teamRoster} />}

      <SignatureCocktailsCard cocktails={cocktails} customCocktails={customCocktails} />
      <MocktailsCard mocktails={mocktails} />
      <AddonsCard addons={addons} />
      <LogisticsCard logistics={logistics} />
      <CustomMenuCard
        menuStyle={menuStyle}
        drinkPlan={drinkPlan}
        selections={selections}
        logoSrc={logoUrl}
      />
      <NotesCard title="Notes from the lead" body={drinkPlan?.admin_notes} />
      <NotesCard title="From the client" body={selections.notes} />
      <ConsultCard consultSelections={consultSelections} />

      {/* ── Assigned-only extras ──────────────────────────────────────── */}

      {isEventStaffer && <BarMenuCard menuPrint={details?.menu_print} shiftId={shiftId} />}
      {(isEventStaffer || viewerState === 'admin') && (
        <ShoppingListCard
          status={details?.shopping_list_status}
          drinkPlanId={drinkPlan?.id}
          onOpen={(id) => navigate(`/drink-plans/${id}`)}
        />
      )}

      {showExtend && (
        <React.Suspense fallback={<div className="sp-skeleton" style={{ height: '4rem' }} />}>
          <RequestMoreTime shiftId={shiftId} onClose={() => setShowExtend(false)} />
        </React.Suspense>
      )}

      <EventActionArea
        viewerState={viewerState}
        isDrinkPlanFinalized={isDrinkPlanFinalized}
        hasProposal={!!proposal}
        confirmed={viewer.is_acknowledged}
        acknowledging={acknowledging}
        onConfirm={confirmDetails}
        dropMode={dropDefaultMode}
        dropResult={dropResult}
        onOpenDrop={(mode) => setDropMode(mode)}
        coverNeeded={coverNeeded}
        coverForInitial={myShift?.cover_for_first_initial || null}
        fullyStaffed={fullyStaffed}
        busy={actionBusy}
        onRequest={() => setRequestOpen(true)}
        onClaimCover={claimCover}
        onWithdraw={withdrawRequest}
        onExtend={() => setShowExtend(true)}
      />

      <DropCoverModal
        open={!!dropMode}
        mode={dropMode}
        busy={dropBusy}
        onClose={() => (dropBusy ? null : setDropMode(null))}
        onSubmit={submitDropCover}
      />

      <RequestSheet
        open={requestOpen}
        shift={requestSheetShift}
        onClose={() => setRequestOpen(false)}
        onSubmitted={onRequestSubmitted}
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


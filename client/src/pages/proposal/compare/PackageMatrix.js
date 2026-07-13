import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { API_BASE_URL as BASE_URL } from '../../../utils/api';
import { getPackageBySlug } from '../../../data/packages';
import { fmt, formatDateShort, DEPOSIT_DOLLARS } from '../proposalView/helpers';

// Aligned package-compare matrix (P8, fix #3 Phase B). Two callers, two pricing
// modes:
//   • ProposalCompare (option-group mode) passes pricing="stored": each column
//     is an admin-curated OPTION whose stored total_price already includes
//     addons, adjustments, overrides, and its own num_bars — that number is
//     what the client actually pays after choosing, so the matrix renders it
//     verbatim and makes NO pricing calls. The minimum note comes from the
//     option's stored pricing_snapshot floor fields (omitted when absent —
//     never price-computed).
//   • ExplorePackagesSection (explore mode) uses the default pricing="live":
//     columns are bare catalog packages with no stored total, so each is
//     priced via POST /api/proposals/public/calculate (parallel,
//     Promise.allSettled; per-column error state renders "Price unavailable").
// Both render one aligned CSS grid on desktop + stacked cards under 640px.
// Public token pages use raw axios + BASE_URL (no JWT), matching ProposalView.

// Catalog section headings vary per package ("Beer & Wine" combined in some,
// "Beer" / "Wine" / "Beer & Seltzer" separate in others). Map every heading to
// a fixed, ordered bucket so the matrix rows stay aligned across columns.
const SECTION_ORDER = ['Spirits', 'Beer & Wine', 'Mixers & Extras', 'Non-Alcoholic'];
function bucketFor(heading) {
  const h = (heading || '').toLowerCase();
  if (h.includes('spirit')) return 'Spirits';
  if (h.includes('beer') || h.includes('wine') || h.includes('seltzer')) return 'Beer & Wine';
  if (h.includes('non') && h.includes('alc')) return 'Non-Alcoholic';
  return 'Mixers & Extras'; // "Mixers & Modifiers" + any unexpected heading
}

// Catalog items carry witty descriptions after an en-dash separator
// ("Tito's Vodka – ..."). Show just the names so tiers scan cleanly.
function itemName(item) {
  return item.split(' – ')[0];
}

// Build { bucket: [names...] } for a column from its catalog detail (or null).
function bucketsForSlug(slug) {
  const detail = getPackageBySlug(slug);
  if (!detail) return null;
  const out = {};
  for (const section of detail.sections) {
    const key = bucketFor(section.heading);
    const names = section.items.map(itemName);
    out[key] = (out[key] || []).concat(names);
  }
  return out;
}

function badgeFor(col) {
  return col.category === 'hosted' || col.pricing_type === 'per_guest' ? 'Hosted Bar' : 'BYOB';
}

// Full payment is required inside the 14-day window (server bookingWindow rule);
// cosmetic mirror only, the sign/pay page is authoritative.
function fullPaymentLikely(eventDate) {
  if (!eventDate) return false;
  const days = (new Date(eventDate) - new Date()) / 86400000;
  return days <= 14;
}

function priceText(info) {
  if (info.status === 'loading') return 'Pricing...';
  if (info.status === 'error') return 'Price unavailable';
  return fmt(Number(info.total || 0));
}

function depositText(col, eventDate) {
  if (fullPaymentLikely(eventDate)) return 'Full at booking';
  const deposit = col.deposit != null ? Number(col.deposit) : DEPOSIT_DOLLARS;
  return `${fmt(deposit)} deposit`;
}

// Minimum-note cell: reads the P4 floor fields off the normalized price info
// (stored snapshot fields in group mode, live calculate response in explore
// mode), falling back to the plain floor_applied flag when floor_reason is
// absent (pre-P4 snapshots/responses).
function noteText(info) {
  if (info.status !== 'ok') return null;
  if (info.floor_reason === 'guest_min') return `Billed as ${info.billed_guests} guests`;
  if (info.floor_reason === 'dollar_min') return '$550 minimum applied';
  if (info.floor_applied) return 'Minimum applied';
  return null;
}

const EMPTY_CELL = <span className="pkg-matrix-muted">&middot;</span>;

export default function PackageMatrix({
  eventHeader = {}, columns = [], onChoose, chooseLabel = 'Choose this one', pricing = 'live',
}) {
  const { guest_count, duration_hours, event_date, num_bars } = eventHeader;
  const live = pricing === 'live';
  const [priced, setPriced] = useState(() => columns.map(() => ({ status: 'loading' })));
  const reqRef = useRef(0);

  // Live mode only: price every column via public/calculate. Keyed on a stable
  // signature so a new array identity with the same data does not refetch.
  const pricingKey = JSON.stringify([live, columns.map((c) => c.package_id), guest_count, duration_hours, num_bars]);
  useEffect(() => {
    if (!live) return;
    const seq = ++reqRef.current;
    setPriced(columns.map(() => ({ status: 'loading' })));
    Promise.allSettled(
      columns.map((col) => axios.post(`${BASE_URL}/proposals/public/calculate`, {
        package_id: col.package_id,
        guest_count: guest_count || 50,
        duration_hours: duration_hours || 4,
        num_bars: num_bars ?? 0,
      }))
    ).then((results) => {
      if (seq !== reqRef.current) return; // a newer request superseded this one
      setPriced(results.map((r) => (
        r.status === 'fulfilled'
          ? { status: 'ok', snapshot: r.value.data }
          : { status: 'error' }
      )));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricingKey]);

  if (columns.length === 0) return null;

  // Normalize each column's price info regardless of mode:
  // { status, total, floor_reason, billed_guests, floor_applied }.
  const infoFor = (col, i) => {
    if (!live) {
      if (col.total == null) return { status: 'error' };
      return {
        status: 'ok',
        total: Number(col.total),
        floor_reason: col.floor_reason || null,
        billed_guests: col.billed_guests,
        floor_applied: !!col.floor_applied,
      };
    }
    const p = priced[i] || { status: 'loading' };
    if (p.status !== 'ok') return p;
    const s = p.snapshot || {};
    return {
      status: 'ok',
      total: Number(s.total || 0),
      floor_reason: s.floor_reason || null,
      billed_guests: s.billed_guests,
      floor_applied: !!s.floor_applied,
    };
  };

  // Combine each column with its price info + catalog buckets. Key by option
  // token when present (group mode: two options CAN share a package), falling
  // back to package_id (explore mode: unique per column).
  const cols = columns.map((col, i) => ({
    ...col,
    info: infoFor(col, i),
    buckets: bucketsForSlug(col.slug),
    colKey: col.token || col.package_id,
  }));

  // Only render a minimum row / a section row when at least one column has
  // content for it — keeps the matrix compact while staying aligned.
  const showNoteRow = cols.some((c) => noteText(c.info));
  const activeSections = SECTION_ORDER.filter((s) => cols.some((c) => c.buckets && (c.buckets[s] || []).length > 0));

  const sectionText = (c, section) => {
    const items = c.buckets && c.buckets[section];
    return items && items.length ? items.join(', ') : null;
  };

  const caption = [
    guest_count != null ? `${guest_count} guests` : null,
    duration_hours != null ? `${duration_hours} hours` : null,
    event_date ? formatDateShort(event_date) : null,
  ].filter(Boolean).join(' · ');

  const chooseButton = (c) => {
    if (c.chosen) {
      return <button type="button" className="pkg-matrix-choose" disabled>Current package</button>;
    }
    return (
      <button type="button" className="pkg-matrix-choose" onClick={() => onChoose && onChoose(c)}>
        {chooseLabel}
      </button>
    );
  };

  return (
    <div className="pkg-matrix-wrap">
      {caption && <p className="pkg-matrix-caption">Priced for your event · {caption}</p>}

      {/* Desktop: one aligned grid, horizontal scroll when many columns. */}
      <div className="pkg-matrix-scroll">
        <div className="pkg-matrix" style={{ '--pm-cols': cols.length }}>
          {/* Header row */}
          <div className="pkg-matrix-cell pkg-matrix-head pkg-matrix-rowlabel" />
          {cols.map((c) => (
            <div key={`h-${c.colKey}`} className="pkg-matrix-cell pkg-matrix-head">
              <span className="pkg-matrix-badge">{badgeFor(c)}</span>
              <div className="pkg-matrix-name">{c.name}</div>
              {c.chosen && <span className="pkg-matrix-current">Current</span>}
            </div>
          ))}

          {/* Price row */}
          <div className="pkg-matrix-cell pkg-matrix-rowlabel">Price for your event</div>
          {cols.map((c) => (
            <div key={`p-${c.colKey}`} className="pkg-matrix-cell">
              <span className={`pkg-matrix-price${c.info.status !== 'ok' ? ' pkg-matrix-muted' : ''}`}>{priceText(c.info)}</span>
            </div>
          ))}

          {/* Deposit row */}
          <div className="pkg-matrix-cell pkg-matrix-rowlabel">Deposit</div>
          {cols.map((c) => (
            <div key={`d-${c.colKey}`} className="pkg-matrix-cell">{depositText(c, event_date)}</div>
          ))}

          {/* Minimum note row (only if any column has one) */}
          {showNoteRow && (
            <>
              <div className="pkg-matrix-cell pkg-matrix-rowlabel">Minimum</div>
              {cols.map((c) => (
                <div key={`m-${c.colKey}`} className="pkg-matrix-cell">
                  {noteText(c.info)
                    ? <span className="pkg-matrix-note">{noteText(c.info)}</span>
                    : EMPTY_CELL}
                </div>
              ))}
            </>
          )}

          {/* Catalog section rows */}
          {activeSections.map((section) => (
            <React.Fragment key={`sec-${section}`}>
              <div className="pkg-matrix-cell pkg-matrix-rowlabel">{section}</div>
              {cols.map((c) => (
                <div key={`${section}-${c.colKey}`} className="pkg-matrix-cell">
                  {sectionText(c, section) || EMPTY_CELL}
                </div>
              ))}
            </React.Fragment>
          ))}

          {/* Choose row */}
          <div className="pkg-matrix-cell pkg-matrix-rowlabel" />
          {cols.map((c) => (
            <div key={`c-${c.colKey}`} className="pkg-matrix-cell pkg-matrix-choosecell">{chooseButton(c)}</div>
          ))}
        </div>
      </div>

      {/* Mobile: each column becomes a self-contained card. */}
      <div className="pkg-matrix-cards">
        {cols.map((c) => (
          <div key={`card-${c.colKey}`} className="pkg-matrix-card">
            <div className="pkg-matrix-card-head">
              <span className="pkg-matrix-badge">{badgeFor(c)}</span>
              <div className="pkg-matrix-name">{c.name}{c.chosen && <span className="pkg-matrix-current">Current</span>}</div>
            </div>
            <div className="pkg-matrix-card-row">
              <span>Price for your event</span>
              <span className={`pkg-matrix-price${c.info.status !== 'ok' ? ' pkg-matrix-muted' : ''}`}>{priceText(c.info)}</span>
            </div>
            <div className="pkg-matrix-card-row"><span>Deposit</span><span>{depositText(c, event_date)}</span></div>
            {noteText(c.info) && (
              <div className="pkg-matrix-card-row"><span>Minimum</span><span className="pkg-matrix-note">{noteText(c.info)}</span></div>
            )}
            {activeSections.map((section) => (
              <div key={`cs-${section}-${c.colKey}`} className="pkg-matrix-card-row pkg-matrix-card-section">
                <span>{section}</span>
                <span>{sectionText(c, section) || '·'}</span>
              </div>
            ))}
            <div className="pkg-matrix-card-choose">{chooseButton(c)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Explore mode (rendered inside ProposalView) ──────────────────
//
// Kept in this file (not a standalone module) so the ProposalView seam is a
// single import + one JSX line — P1 also edits ProposalView.js, so the merge
// surface stays minimal. Pre-booking only, and ProposalView additionally gates
// it off for option-group members (a curated comparison already exists there;
// ProposalView owns that gate because it holds the resolver result).
// "I want this one" never self-swaps a sent proposal; it opens a prefilled
// email, so any package change is a human hand-off, not a silent rewrite
// (deliberate v1: no in-app message thread exists on this surface).
export function ExplorePackagesSection({ proposal }) {
  const [open, setOpen] = useState(false);
  // Once opened, the panel stays MOUNTED (hidden via the `hidden` attribute on
  // close) so the priced matrix is cached — reopening costs zero requests.
  // publicReadLimiter is generous (100/15min) but not free; never re-spend it
  // on a toggle.
  const [everOpened, setEverOpened] = useState(false);
  const [packages, setPackages] = useState(null);
  const [loadErr, setLoadErr] = useState(false);

  const eligible = !!proposal && ['sent', 'viewed', 'accepted'].includes(proposal.status);

  useEffect(() => {
    if (!everOpened || packages) return;
    let cancelled = false;
    axios.get(`${BASE_URL}/proposals/public/packages`)
      .then((res) => { if (!cancelled) setPackages(res.data || []); })
      .catch(() => { if (!cancelled) setLoadErr(true); });
    return () => { cancelled = true; };
  }, [everOpened, packages]);

  if (!eligible) return null;

  const columns = (packages || [])
    .filter((p) => p.bar_type !== 'class')
    .map((p) => ({
      package_id: p.id,
      slug: p.slug,
      name: p.name,
      category: p.category,
      pricing_type: p.pricing_type,
      chosen: p.id === proposal.package_id,
    }));

  const handleInterest = (col) => {
    const subject = `Interested in switching to ${col.name}`;
    const body = `Hi, I'd like to switch my event bar to the ${col.name} package.\n\n`
      + `Client: ${proposal.client_name || ''}\n`
      + `Proposal: ${window.location.href.split('?')[0]}\n`;
    window.location.href = `mailto:contact@drbartender.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  return (
    <div className="pkg-explore">
      <button
        type="button"
        className="pkg-explore-toggle"
        onClick={() => { setOpen((o) => !o); setEverOpened(true); }}
        aria-expanded={open}
      >
        {open ? 'Hide package comparison' : 'Compare packages for your event'}
      </button>
      {everOpened && (
        <div className="pkg-explore-panel" hidden={!open}>
          {loadErr && <p className="pkg-matrix-caption">We could not load the package list. Please refresh and try again.</p>}
          {!loadErr && !packages && <p className="pkg-matrix-caption">Loading packages...</p>}
          {!loadErr && packages && columns.length > 0 && (
            <PackageMatrix
              eventHeader={{
                guest_count: proposal.guest_count,
                duration_hours: proposal.event_duration_hours,
                event_date: proposal.event_date,
                num_bars: proposal.num_bars,
              }}
              columns={columns}
              chooseLabel="I want this one"
              onChoose={handleInterest}
            />
          )}
        </div>
      )}
    </div>
  );
}

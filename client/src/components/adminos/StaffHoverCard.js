import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { canonicalizeRole } from '../../utils/staffingRoles';

// StaffHoverCard: wraps an anchor (the staffing ratio in the events list) and,
// while the pointer is over it, shows who is confirmed on the event.
//
// Portaled to document.body, like KebabMenu, because the events table sits in
// .tbl-wrap { overflow-x: auto } inside .card { overflow: hidden }: a card
// positioned inside the cell is clipped at the wrapper edge and shoved into a
// scrollbar.
//
// Positioned FIXED, in viewport coordinates, and flipped above the cell when
// there is no room below. KebabMenu can use absolute + scroll offsets because
// its menu survives scrolling; this one closes on mouseleave, so it only ever
// has to be right for the current viewport. Absolute positioning was tried
// first and failed the one case that matters: hovering the last row of a long
// list put the card 42px below the fold, and reaching it meant moving the
// pointer off the anchor, which closes it. Measured in a browser 2026-08-25.
//
// Inert on purpose (pointer-events: none in CSS). Mousing onto a portaled card
// leaves the anchor, which closes it anyway, so an interactive card gains
// nothing; an inert one can never stick open and never swallows the mouseup
// that ClickableRow uses to navigate.
//
// Hover only. Nothing in the cell is focusable, and a tab stop on every row
// would be noise; keyboard and touch users have the drawer and the event page.
//
// Confirmed people only. The cell deliberately hides the waitlist on a full
// roster (see StaffingCell.js), and this card must not put it back.
const ROW_HEIGHT_PX = 24;
const CARD_PADDING_PX = 12;
const GAP_PX = 4;

export default function StaffHoverCard({ staff, children }) {
  const anchorRef = useRef(null);
  const [anchor, setAnchor] = useState(null);
  const list = Array.isArray(staff) ? staff : [];

  if (list.length === 0) return children;

  // Height is estimated rather than measured: one line per person plus the
  // card's padding. A few pixels of error only ever decides a flip that had
  // room to spare either way, and it keeps this to a single render pass.
  const show = () => {
    if (!anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const estHeight = list.length * ROW_HEIGHT_PX + CARD_PADDING_PX;
    const roomBelow = window.innerHeight - r.bottom - GAP_PX;
    setAnchor(roomBelow >= estHeight
      ? { top: r.bottom + GAP_PX, left: r.left }
      : { bottom: window.innerHeight - r.top + GAP_PX, left: r.left });
  };
  const hide = () => setAnchor(null);

  return (
    <>
      <div ref={anchorRef} className="staff-hover-anchor" onMouseEnter={show} onMouseLeave={hide}>
        {children}
      </div>
      {anchor && createPortal(
        <div className="staff-hover-card" role="tooltip" style={anchor}>
          {list.map((p, i) => (
            <div key={p.user_id ?? i} className="staff-hover-row">
              <span className="staff-hover-name">{p.name}</span>
              {/* Canonicalized for display, like the drawer's slot-role: the CHECK on
                  shift_requests.position is case-INsensitive, so a legacy row can
                  hold 'bartender' and read lowercase here while the drawer opened
                  from the same row reads 'Bartender'. Falls back to the raw string
                  so an unrecognized role still shows something. */}
              {p.position && (
                <span className="staff-hover-pos">{canonicalizeRole(p.position) || p.position}</span>
              )}
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

import React from 'react';
import api from '../../utils/api';
import {
  parsePositionsNeeded,
  rosterCounts,
  CANONICAL_LABELS,
} from '../../utils/staffingRoles';
// Deliberately the admin editor's own option list, not a staff-side copy: it is
// the single place equipment tokens and their labels are defined, and a second
// copy is how the two sides start disagreeing about what "portable_bar" reads as.
import { SHIFT_EQUIPMENT_OPTIONS } from '../adminos/shifts';

/**
 * Body blocks for the staff Event Details page (spec 2026-07-22, which retired
 * the "BEO" wording everywhere staff can read it). Extracted from
 * ShiftDetail.js so the page itself stays focused on data orchestration.
 *
 * Two tiers, decided by the caller:
 *   - the brief, visible to EVERY staffer so they can judge a shift before
 *     requesting it: EquipmentCard, RolesCard, GratuityTipsCard, drinks,
 *     addons, logistics, menu, notes, consult.
 *   - assigned-only extras: BarMenuCard, ShoppingListCard (the roster card and
 *     the client-contact button live in the page itself).
 *
 * Each sub-component is purely presentational and no-ops (returns null) when
 * its data is empty, so the caller can render them unconditionally.
 */

/**
 * shifts.equipment_required is TEXT holding a JSON array (default '[]'), so it
 * arrives as a string over the wire. LogisticsTag has a private parser; this is
 * the same job for a different shape, kept local rather than exported from
 * there to avoid coupling two unrelated components.
 */
function safeParseArray(raw) {
  if (Array.isArray(raw)) return raw.filter((t) => typeof t === 'string' && t.trim());
  if (typeof raw !== 'string') return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((t) => typeof t === 'string' && t.trim()) : [];
  } catch {
    return [];
  }
}

/**
 * The at-a-glance facts every staffer needs: when, when to arrive, how many
 * guests, where, dress code, load-in. Extracted from the page body to keep
 * ShiftDetail focused on orchestration rather than layout.
 */
export function EventMetaGrid({ shift, proposal, setupTimeDisplay, selections }) {
  const guests = proposal?.guest_count || shift?.guest_count;
  const location = proposal?.event_location || shift?.location;
  return (
    <div className="sp-meta-grid">
      <div className="sp-meta">
        <div className="sp-meta-k">Date</div>
        <div className="sp-meta-v">
          {fmtLongDate(shift?.event_date)}{' '}
          <span style={{ color: 'var(--sp-ink-3)' }}>· {relDayLabel(shift?.event_date)}</span>
        </div>
      </div>
      {(shift?.start_time || shift?.end_time) && (
        <div className="sp-meta">
          <div className="sp-meta-k">Service time</div>
          <div className="sp-meta-v num">
            {shift?.start_time}
            {shift?.end_time ? ` – ${shift.end_time}` : ''}
          </div>
        </div>
      )}
      {setupTimeDisplay && (
        <div className="sp-meta">
          <div className="sp-meta-k">Be there by</div>
          <div className="sp-meta-v num">{setupTimeDisplay}</div>
        </div>
      )}
      {guests && (
        <div className="sp-meta">
          <div className="sp-meta-k">Guests</div>
          <div className="sp-meta-v num">{guests}</div>
        </div>
      )}
      {location && (
        <div className="sp-meta" style={{ gridColumn: '1 / -1' }}>
          <div className="sp-meta-k">Location</div>
          <div className="sp-meta-v">{location}</div>
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
  );
}

/** YYYY-MM-DD to "Saturday, May 30, 2026" */
function fmtLongDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

/** YYYY-MM-DD to Today / Tomorrow / In Nd / Nd ago */
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

export function SignatureCocktailsCard({ cocktails, customCocktails }) {
  const total = cocktails.length + customCocktails.length;
  if (total === 0) return null;
  return (
    <div className="sp-card tight">
      <div className="sp-card-head">
        <div className="sp-card-title">Signature cocktails</div>
        <span className="sp-roster-count">
          {total} drink{total !== 1 ? 's' : ''}
        </span>
      </div>
      {cocktails.map((d) => (
        <BeoDrinkRow key={d.id} drink={d} />
      ))}
      {customCocktails.map((name, i) => (
        <div key={`custom-${i}`} className="sp-drink-row">
          <div className="sp-drink-emoji">✨</div>
          <div className="sp-drink-l">
            <div className="sp-drink-name">{name}</div>
            <div className="sp-drink-spec">Custom request</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function MocktailsCard({ mocktails }) {
  if (!mocktails.length) return null;
  return (
    <div className="sp-card tight">
      <div className="sp-card-head">
        <div className="sp-card-title">Mocktails</div>
      </div>
      {mocktails.map((d) => (
        <BeoDrinkRow key={d.id} drink={d} />
      ))}
    </div>
  );
}

// Gratuity & tip-jar status for the crew (spec §9). Always rendered (not gated)
// so the team knows whether to set out a jar and whether gratuity is pre-paid.
export function GratuityTipsCard({ tipJar, gratuityPrepaid, staffNoun }) {
  const row = { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '0.35rem 0' };
  return (
    <div className="sp-card tight">
      <div className="sp-card-head">
        <div className="sp-card-title">Gratuity &amp; tips</div>
      </div>
      <div style={row}>
        <span style={{ opacity: 0.7 }}>Tip jar</span>
        {tipJar === false ? (
          <span className="sp-nojar-text">NO TIP JAR, do not set one out</span>
        ) : (
          <span>Yes, set out a tip jar</span>
        )}
      </div>
      <div style={row}>
        <span style={{ opacity: 0.7 }}>Pre-paid gratuity</span>
        <span>{gratuityPrepaid ? `Yes, pre-paid for the ${staffNoun}s` : 'None'}</span>
      </div>
    </div>
  );
}

/**
 * What to bring and whether a supply run is attached. Part of the brief: a
 * staffer needs this BEFORE requesting, because it decides whether they can
 * physically do the job (and it is what the request sheet makes them ack).
 */
// Token -> human label, from the SAME list the admin editor writes with, so a
// new equipment option can never be human-readable on one side and snake_case
// on the other. Unknown tokens fall back to a de-underscored form rather than
// vanishing: a staffer seeing "weird thing" beats a staffer seeing nothing.
const EQUIPMENT_LABELS = new Map(SHIFT_EQUIPMENT_OPTIONS);
const equipmentLabel = (token) =>
  EQUIPMENT_LABELS.get(token) || String(token).replace(/_/g, ' ');

export function EquipmentCard({ equipment, supplyRun, barRequired }) {
  const list = safeParseArray(equipment);
  if (list.length === 0 && !supplyRun && !barRequired) return null;
  return (
    <div className="sp-card tight">
      <div className="sp-card-head">
        <div className="sp-card-title">Equipment &amp; supplies</div>
      </div>
      {/* Derived from the booking (proposals.num_bars), not from the hand-set
          equipment list — the same fact that pays the bar duty (bar_rental on
          BYOB, hosted_supplies on hosted; see dutyLines.js). Shifts used to
          show nothing here while paying the duty (fix list 2026-08-13). */}
      {barRequired && (
        <div
          className="sp-row"
          style={{ padding: '0.4rem 0', fontSize: 13, borderBottom: '1px solid var(--sp-line-1)', fontWeight: 600 }}
        >
          Portable bar — DRB bar pickup at the Pilsen storage unit, or bring your own
        </div>
      )}
      {/* When the derived bar row renders, drop a hand-set portable_bar token
          so the card never shows the bar twice. */}
      {list.filter((item) => !(barRequired && item === 'portable_bar')).map((item, i) => (
        <div
          key={`${item}-${i}`}
          className="sp-row"
          style={{ padding: '0.4rem 0', fontSize: 13, borderBottom: '1px solid var(--sp-line-1)' }}
        >
          {equipmentLabel(item)}
        </div>
      ))}
      {supplyRun && (
        <div className="sp-row" style={{ padding: '0.4rem 0', fontSize: 13 }}>
          Supply run required for this event.
        </div>
      )}
      {/* "Brought empty" is load-bearing copy (Dallas 2026-08-13): the old
          phrasing read as if beer and ice came WITH the kit. The case/bag
          figures describe what the cooler can HOLD, not what you bring. */}
      <div style={{ fontSize: 12, color: 'var(--sp-ink-3)', marginTop: 6, lineHeight: 1.55 }}>
        Your standard bar kit includes a small handled cooler, brought empty — ice and beer
        are not part of the kit. It should be big enough to hold about 3 cases of beer plus
        ice, or two 20 lb ice bags. Bar mats, ice bins, and the tip jar ride inside it.
        Bring it even when the client has coolers of their own.
      </div>
    </div>
  );
}

/**
 * Per-role fill for the shift ("Bartender 1/2"). This shipped on the list cards
 * but never on the detail page, which is a chunk of why the page read as having
 * less information than the screen staff requested from.
 */
export function RolesCard({ positionsNeeded, approvedByRole }) {
  const needed = parsePositionsNeeded(positionsNeeded);
  if (needed.length === 0) return null;
  const counts = rosterCounts(needed);
  const approved = approvedByRole && typeof approvedByRole === 'object' ? approvedByRole : {};
  const ordered = CANONICAL_LABELS.filter((role) => counts[role] > 0);
  if (ordered.length === 0) return null;
  return (
    <div className="sp-card tight">
      <div className="sp-card-head">
        <div className="sp-card-title">Roles on this event</div>
      </div>
      <div className="sp-shift-roster-fill">
        {ordered.map((role, i) => {
          const total = counts[role] || 0;
          const filled = Math.min(Number(approved[role]) || 0, total);
          return (
            <span key={role} className={'sp-roster-pill' + (filled >= total ? ' full' : '')}>
              {role} {filled}/{total}
              {i < ordered.length - 1 ? ' ·' : ''}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The bar menu print file. Assigned-only: this is the deliverable a working
 * staffer prints and carries, not something a browser needs.
 */
export function BarMenuCard({ menuPrint, shiftId }) {
  const [downloading, setDownloading] = React.useState(false);
  const [error, setError] = React.useState(null);
  if (!menuPrint) return null;

  async function download() {
    setDownloading(true);
    setError(null);
    try {
      const res = await api.get(`/shifts/${shiftId}/menu-print`, { responseType: 'blob' });
      // Honor the server's filename so a PNG or JPG menu is not saved as .pdf.
      const cd = (res.headers && res.headers['content-disposition']) || '';
      const m = cd.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = m ? m[1] : 'bar-menu.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Deferred: revoking in the same task cancels the in-flight download in
      // Firefox and some Safari versions, silently and with nothing to catch.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err?.message || 'Could not download the menu file.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="sp-card tight">
      <div className="sp-card-head">
        <div className="sp-card-title">Bar menu</div>
      </div>
      {menuPrint.status === 'ready' && (
        <>
          <button
            type="button"
            className="sp-btn sp-btn-sm"
            onClick={download}
            disabled={downloading}
          >
            {downloading ? 'Downloading…' : 'Download print file'}
          </button>
          {error && <div className="sp-modal-error" style={{ marginTop: 6 }}>{error}</div>}
          <div style={{ fontSize: 12.5, color: 'var(--sp-ink-2)', marginTop: 8, lineHeight: 1.55 }}>
            Print this and bring it in a frame (we stock frames at the Pilsen storage unit if
            you need one). The print stays with the client, and so does a Dr. Bartender frame;
            your own frame goes home with you. You get a flat $5 for the print. A tablet or
            iPad on a stand works instead if it is clean and a decent size. We plan around
            8x10 for framed menus.
          </div>
        </>
      )}
      {menuPrint.status === 'not_required' && (
        <div style={{ fontSize: 13, color: 'var(--sp-ink-2)' }}>
          No printed menu for this event.
        </div>
      )}
      {menuPrint.status === 'pending' && (
        <div style={{ fontSize: 13, color: 'var(--sp-ink-3)' }}>
          Print file not posted yet. Check back closer to the event.
        </div>
      )}
    </div>
  );
}

export function AddonsCard({ addons }) {
  if (!addons.length) return null;
  return (
    <div className="sp-card tight">
      <div className="sp-card-head">
        <div className="sp-card-title">Addons / upgrades</div>
      </div>
      {addons.map((a) => (
        <div
          key={a.addon_id || a.addon_name}
          className="sp-row"
          style={{ padding: '0.45rem 0', borderBottom: '1px solid var(--sp-line-1)' }}
        >
          <SparklesIcon size={14} />
          <span style={{ flex: 1, fontSize: 13 }}>{a.addon_name}</span>
          {Number.isFinite(a.quantity) && a.quantity > 1 && (
            <span style={{ fontSize: 11.5, color: 'var(--sp-ink-3)' }} className="sp-mono">
              ×{a.quantity}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function LogisticsCard({ logistics }) {
  if (!logistics) return null;
  const has = logistics.tables || logistics.linens || logistics.iceBins || logistics.notes;
  if (!has) return null;
  return (
    <div className="sp-card tight">
      <div className="sp-card-head">
        <div className="sp-card-title">Logistics</div>
      </div>
      {logistics.tables && (
        <div style={{ fontSize: 13, color: 'var(--sp-ink-2)' }}>
          Tables: <strong>{logistics.tables}</strong>
        </div>
      )}
      {logistics.linens && (
        <div style={{ fontSize: 13, color: 'var(--sp-ink-2)' }}>
          Linens: <strong>{logistics.linens}</strong>
        </div>
      )}
      {logistics.iceBins && (
        <div style={{ fontSize: 13, color: 'var(--sp-ink-2)' }}>
          Ice: <strong>{logistics.iceBins}</strong>
        </div>
      )}
      {logistics.notes && (
        <div style={{ fontSize: 12.5, color: 'var(--sp-ink-3)', marginTop: 4, lineHeight: 1.55 }}>
          {logistics.notes}
        </div>
      )}
    </div>
  );
}

export function CustomMenuCard({ menuStyle, drinkPlan, logoSrc, selections }) {
  if (menuStyle !== 'custom' && menuStyle !== 'house') return null;
  return (
    <div className="sp-card tight">
      <div className="sp-card-head">
        <div className="sp-card-title">Custom menu</div>
        <span className="sp-roster-count">{menuStyle}</span>
      </div>
      {drinkPlan?.has_logo && logoSrc && (
        <img
          src={logoSrc}
          alt="Custom menu logo"
          style={{ maxWidth: 200, height: 'auto', margin: '0.4rem 0' }}
        />
      )}
      {selections?.menuTitle && (
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--sp-ink-1)' }}>
          {selections.menuTitle}
        </div>
      )}
      {selections?.menuNotes && (
        <div style={{ fontSize: 12.5, color: 'var(--sp-ink-3)', marginTop: 4, lineHeight: 1.55 }}>
          {selections.menuNotes}
        </div>
      )}
    </div>
  );
}

export function NotesCard({ title, body }) {
  if (!body) return null;
  return (
    <div className="sp-card tight">
      <div className="sp-card-head">
        <div className="sp-card-title">{title}</div>
      </div>
      <div style={{ fontSize: 13, color: 'var(--sp-ink-2)', lineHeight: 1.55 }}>{body}</div>
    </div>
  );
}

export function ConsultCard({ consultSelections }) {
  if (!consultSelections || Object.keys(consultSelections).length === 0) return null;
  return (
    <div className="sp-card tight">
      <div className="sp-card-head">
        <div className="sp-card-title">Consult</div>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--sp-ink-3)', lineHeight: 1.55 }}>
        {Object.entries(consultSelections)
          .filter(([, v]) => v !== null && v !== undefined && v !== '')
          .map(([k, v]) => (
            <div key={k} style={{ padding: '4px 0' }}>
              <strong style={{ color: 'var(--sp-ink-2)' }}>{k}:</strong>{' '}
              {Array.isArray(v) ? v.join(', ') : String(v)}
            </div>
          ))}
      </div>
    </div>
  );
}

export function ShoppingListCard({ status, drinkPlanId, onOpen }) {
  if (status !== 'ready') return null;
  return (
    <div className="sp-card tight">
      <div className="sp-card-head">
        <div className="sp-card-title">Shopping list</div>
      </div>
      <button
        type="button"
        className="sp-btn sp-btn-sm"
        onClick={() => drinkPlanId && onOpen(drinkPlanId)}
      >
        View shopping list
      </button>
    </div>
  );
}

// ── Internal ────────────────────────────────────────────────────────────

// cocktails/mocktails.ingredients is JSONB holding OBJECTS
// ({ingredient, amount, unit, note?}), so stringifying a row rendered a literal
// "[object Object]" at the bar. Legacy and hand-entered rows can still be plain
// strings, so both shapes render here — the server generator makes the same
// allowance (see mergeSignatureRecipes in server/utils/shoppingList.js).
// Returns {qty, name} or null for an unusable row.
function ingredientParts(line) {
  if (line && typeof line === 'object') {
    const name = String(line.ingredient || '').trim();
    if (!name) return null;
    const amount = line.amount == null || line.amount === '' ? '' : String(line.amount);
    const unit = String(line.unit || '').trim();
    // "2 each Strawberries" reads wrong on a spec card; "2 Strawberries" doesn't.
    const qty = !amount ? '' : (unit && unit !== 'each' ? `${amount} ${unit}` : amount);
    const note = String(line.note || '').trim();
    return { qty, name: note ? `${name} (${note})` : name };
  }
  const s = String(line || '').trim();
  if (!s) return null;
  const m = s.match(/^([\d./]+\s*\S+)\s+(.+)$/);
  return m ? { qty: m[1], name: m[2] } : { qty: '', name: s };
}

function BeoDrinkRow({ drink }) {
  const ings = (Array.isArray(drink.ingredients) ? drink.ingredients : [])
    .map(ingredientParts)
    .filter(Boolean);
  return (
    <div className="sp-drink-row">
      <div className="sp-drink-emoji">{drink.emoji || '🍸'}</div>
      <div className="sp-drink-l">
        <div className="sp-drink-name">{drink.name}</div>
        <div className="sp-drink-spec">
          {drink.method || '—'} · {drink.glass || '—'}
          {drink.base_spirit ? ` · ${drink.base_spirit}` : ''}
        </div>
        {ings.length > 0 && (
          <div className="sp-drink-ings">
            {ings.map((ing, i) => (
              <div key={i} className="sp-drink-ings-row">
                <span className="sp-drink-ings-qty">{ing.qty}</span>
                <span>{ing.name}</span>
              </div>
            ))}
          </div>
        )}
        {drink.garnish && <div className="sp-drink-garnish">Garnish: {drink.garnish}</div>}
      </div>
    </div>
  );
}

function SparklesIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
      <path d="M5 18l.75 2.25L8 21l-2.25.75L5 24l-.75-2.25L2 21l2.25-.75L5 18z" />
    </svg>
  );
}

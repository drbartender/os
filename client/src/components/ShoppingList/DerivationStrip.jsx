import React, { useState } from 'react';
import { describeClientLine, specialtyNote, PADDING_SENTENCE } from '../../pages/public/ClientShoppingList';

// Two review instruments for the shopping-list modal, split out to keep
// ShoppingListModal.jsx lean (pp2-quantity-review):
//
//   DerivationStrip, the admin-only "how we got here" strip. Reads the
//     `_derivation` metadata block the generator attaches when the plan
//     answered the v2 crowd question (drinkers × hours × pace -> pours, the
//     gently-nudged category split, the per-role buffer policy). Metadata
//     only: it explains the numbers, it does not set them. Absent for every
//     legacy/consult plan, in which case the modal renders nothing here.
//
//   ClientPreview, the Client-view render, using the SAME plain-language
//     formatter the public /shopping-list/:token page uses, so the copy the
//     admin previews is 1:1 with what the client will read.
//
// Buffer/split colors mirror the approved Quantity Review canvas. No em dashes
// anywhere in copy (client-facing rule; the strip is admin-facing but the rule
// is applied uniformly here).

const CAT_COLORS = {
  cocktails: 'var(--accent)',
  beer: 'hsl(var(--info-h) var(--info-s) 52%)',
  wine: 'hsl(var(--violet-h) var(--violet-s) 55%)',
};
const CAT_ORDER = ['cocktails', 'beer', 'wine'];
const CAT_LABEL = { cocktails: 'Cocktails', beer: 'Beer', wine: 'Wine' };
const BUFFER_ORDER = ['spirits', 'mixers', 'garnish', 'supplies'];
const BUFFER_LABEL = { spirits: 'Spirits', mixers: 'Mixers', garnish: 'Garnish', supplies: 'Supplies' };

const labelStyle = {
  fontSize: 'var(--fs-micro)',
  textTransform: 'uppercase',
  letterSpacing: 'var(--tracking-label)',
  color: 'var(--ink-4)',
  fontWeight: 600,
  marginBottom: 5,
};
const subStyle = { fontSize: '10.5px', color: 'var(--ink-4)', marginTop: 4 };

function fmtBuffer(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `×${n.toFixed(2)}` : '';
}

export default function DerivationStrip({ derivation }) {
  const [open, setOpen] = useState(false);
  if (!derivation || typeof derivation !== 'object') return null;

  const { drinkers, estimated, hours, pace, pours, splitPct = {}, perCategory = [], buffers = {} } = derivation;
  const hoursText = Number(hours || 0).toFixed(1);
  const paceText = Number(pace || 0).toFixed(1);

  return (
    <div style={{
      padding: '0.75rem 1.25rem',
      borderBottom: '1px solid var(--line-2)',
      background: 'var(--bg-1)',
      display: 'flex',
      gap: '1.75rem',
      alignItems: 'flex-start',
      flexWrap: 'wrap',
    }}>
      {/* Expected demand */}
      <div style={{ minWidth: 250 }}>
        <div style={labelStyle}>Expected demand</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px', color: 'var(--ink-2)' }}>
          {drinkers} drinkers × {hoursText} hrs × {paceText} pours/hr{' '}
          <span style={{ color: 'var(--ink-4)' }}>≈</span>{' '}
          <span style={{ color: 'var(--ink-1)', fontWeight: 700 }}>{pours} pours</span>
        </div>
        <div style={subStyle}>
          {estimated
            ? 'Drinker count estimated at 75% of guests · pace constant set in Settings'
            : 'From the crowd questions · pace constant set in Settings'}
        </div>
      </div>

      {/* Category split */}
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={labelStyle}>Category split</div>
        <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
          {CAT_ORDER.map(cat => (
            <div key={cat} style={{ width: `${splitPct[cat] || 0}%`, background: CAT_COLORS[cat] }} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-2)' }}>
          {CAT_ORDER.map(cat => {
            const row = perCategory.find(p => p.category === cat) || {};
            return (
              <span key={cat} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: CAT_COLORS[cat] }} />
                {CAT_LABEL[cat]} {splitPct[cat] || 0}% ≈ {row.pours != null ? row.pours : 0}
              </span>
            );
          })}
        </div>
        <div style={subStyle}>Nudged by the guest-profile answer · within a category, drinks split evenly</div>
      </div>

      {/* Buffers */}
      <div>
        <div style={labelStyle}>Buffers</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {BUFFER_ORDER.filter(role => buffers[role] != null).map(role => (
            <span key={role} className="chip neutral" style={{ height: 22 }}>
              {BUFFER_LABEL[role]}&nbsp;<span style={{ fontFamily: 'var(--font-mono)' }}>{fmtBuffer(buffers[role])}</span>
            </span>
          ))}
        </div>
        <div style={subStyle}>Defaults live in Settings → Potions</div>
      </div>

      {/* Expandable per-category math */}
      {perCategory.length > 0 && (
        <div style={{ flexBasis: '100%' }}>
          <button
            onClick={() => setOpen(o => !o)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0',
              color: 'var(--ink-3)', fontSize: '11px',
            }}
          >
            {open ? '▾ Hide the math' : '▸ Show the math'}
          </button>
          {open && (
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--ink-2)',
              background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 'var(--radius-sm)',
              padding: '0.4rem 0.6rem', marginTop: 4,
            }}>
              {perCategory.map(p => (
                <div key={p.category} style={{ padding: '1px 0' }}>{p.text}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Client-view preview ─────────────────────────────────────────────────────
// Parchment "document" render of exactly the copy the client reads. Styling is
// an approximation (the public page ships its own final styling), but the plain
// -language lines and padding sentence are 1:1 via the shared formatter.

const parchInk = '#1a1a1a';
const parchMuted = '#7a7468';
const parchLine = '#f0ece0';

function PreviewSection({ title, items }) {
  if (!items || items.length === 0) return null;
  return (
    <>
      <div style={{
        fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em',
        color: parchMuted, fontWeight: 600, margin: '1.1rem 0 4px',
      }}>{title}</div>
      {items.map((item, i) => {
        const { main, note } = describeClientLine(item);
        const spec = specialtyNote(item);
        const right = [note, spec].filter(Boolean).join(' · ');
        return (
          <div key={`${item.item}-${item.size}-${i}`} style={{
            display: 'flex', justifyContent: 'space-between', gap: '1rem',
            padding: '0.32rem 0', borderBottom: `1px solid ${parchLine}`, fontSize: '13.5px',
          }}>
            <span>{main}</span>
            {right && <span style={{ color: parchMuted, fontSize: 12, fontStyle: 'italic', textAlign: 'right' }}>{right}</span>}
          </div>
        );
      })}
    </>
  );
}

export function ClientPreview({ list, clientName, guestCount, eventDate, approved }) {
  const cocktailNames = Array.isArray(list.signatureCocktailNames) ? list.signatureCocktailNames : [];
  const dateText = eventDate
    ? new Date(eventDate).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })
    : '';
  const metaParts = [clientName, dateText, guestCount ? `${guestCount} guests` : ''].filter(Boolean);

  return (
    <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', alignItems: 'center' }}>
      <div style={{ width: '100%', maxWidth: 660, display: 'flex', gap: '0.6rem', alignItems: 'center', fontSize: 12, color: 'var(--ink-2)' }}>
        <span className={`chip ${approved ? 'ok' : 'warn'}`}><span className="chip-dot" />{approved ? 'Live' : 'Not yet visible'}</span>
        <span>
          {approved
            ? 'The client sees exactly this at the shopping-list link.'
            : 'Until you approve, the client sees the being-reviewed screen. Approving publishes this.'}
        </span>
      </div>

      <div style={{
        width: '100%', maxWidth: 660, background: '#fcfaf4', color: parchInk,
        border: '1px solid #e1dbcc', borderRadius: 8, padding: '2rem 2.25rem', boxShadow: 'var(--shadow-soft)',
      }}>
        <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 21, letterSpacing: '0.01em' }}>Your Shopping List</div>
        {metaParts.length > 0 && (
          <div style={{ fontSize: 12, color: parchMuted, marginTop: 3 }}>{metaParts.join(' · ')}</div>
        )}
        <div style={{
          fontStyle: 'italic', color: '#3d3a33', fontSize: 13,
          borderTop: '1px solid #e1dbcc', borderBottom: '1px solid #e1dbcc',
          padding: '0.6rem 0', margin: '0.9rem 0 1rem',
        }}>{PADDING_SENTENCE}</div>

        <PreviewSection title="Liquor · Beer · Wine" items={list.liquorBeerWine} />
        <PreviewSection title="Everything Else" items={list.everythingElse} />

        {cocktailNames.length > 0 && (
          <div style={{ fontSize: 12, color: parchMuted, marginTop: '1rem' }}>
            Your signature cocktails, {cocktailNames.join(', ')}, are covered by the quantities above.
          </div>
        )}
      </div>

      <div style={{ width: '100%', maxWidth: 660, fontSize: '10.5px', color: 'var(--ink-4)' }}>
        Copy and quantities are 1:1 with the client page. Final styling ships from the public site.
      </div>
    </div>
  );
}

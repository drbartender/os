import React from 'react';

/**
 * BeoSections — read-only BEO body blocks rendered on the staff ShiftDetail
 * page (spec §6.4). Extracted from ShiftDetail.js to keep the page itself
 * focused on data orchestration (resolve proposalId → fetch BEO → render).
 *
 * Each exported sub-component is purely presentational:
 *   - SignatureCocktailsCard
 *   - MocktailsCard
 *   - AddonsCard
 *   - LogisticsCard
 *   - CustomMenuCard
 *   - NotesCard / ConsultCard / ShoppingListCard
 *
 * Components no-op (return null) when their relevant data is empty, so the
 * caller can render them unconditionally for a clean parent render path.
 */

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
        {tipJar ? (
          <span>Yes, set out a tip jar</span>
        ) : (
          <span className="sp-nojar-text">NO TIP JAR, do not set one out</span>
        )}
      </div>
      <div style={row}>
        <span style={{ opacity: 0.7 }}>Pre-paid gratuity</span>
        <span>{gratuityPrepaid ? `Yes, pre-paid for the ${staffNoun}s` : 'None'}</span>
      </div>
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

function BeoDrinkRow({ drink }) {
  const ings = Array.isArray(drink.ingredients) ? drink.ingredients : [];
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
            {ings.map((line, i) => {
              const s = String(line || '').trim();
              const m = s.match(/^([\d./]+\s*\S+)\s+(.+)$/);
              if (m) {
                return (
                  <div key={i} className="sp-drink-ings-row">
                    <span className="sp-drink-ings-qty">{m[1]}</span>
                    <span>{m[2]}</span>
                  </div>
                );
              }
              return <div key={i}>· {s}</div>;
            })}
          </div>
        )}
        {drink.garnish && <div className="sp-drink-garnish">Garnish — {drink.garnish}</div>}
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

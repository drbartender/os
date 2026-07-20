import React from 'react';

/**
 * BalanceBanner — the lab's balance-due context strip (three states: nothing
 * owed renders nothing, due soon nudges gently, past due is firmer). Links
 * nowhere: payment stays on the invoice email, the lab never takes money.
 *
 * AdditionsLedger — "Your additions": running list + total of everything the
 * client has tapped, with the invoice-only promise line and save status.
 */

// Whole dollars stay clean ($1,900); fractional amounts always carry two
// decimals so $1,900.50 never renders as "$1,900.5".
const money = (n) => {
  const v = Number(n || 0);
  return `$${v.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(v) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
};

export function BalanceBanner({ balance }) {
  if (!balance || !(balance.due > 0)) return null;
  // Local-noon construction: a date-only ISO string parsed raw is UTC
  // midnight, which renders as the PRIOR day in Chicago.
  const dueDate = balance.due_date
    ? new Date(`${String(balance.due_date).slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
    : null;
  if (balance.past_due) {
    return (
      <div className="pp2-lab-balance past-due">
        <strong>Balance past due.</strong> Your balance of {money(balance.due)} was due
        {dueDate ? ` ${dueDate}` : ''}. Please settle it on your invoice so we can lock in your event.
      </div>
    );
  }
  return (
    <div className="pp2-lab-balance">
      While you're at it: your remaining balance of {money(balance.due)}
      {dueDate ? ` is due ${dueDate}` : ''} and can be paid on your invoice whenever you're ready.
    </div>
  );
}

export function AdditionsLedger({ lab, additions, priceOf, saveState, serverBreakdown }) {
  const addonBySlug = new Map((lab.addon_pricing || []).map((a) => [a.slug, a]));
  const drinkById = new Map((lab.drinks || []).map((d) => [d.id, d]));

  const lines = [];
  for (const [slug, meta] of Object.entries(additions.addOns)) {
    const addon = addonBySlug.get(slug);
    if (!addon) continue;
    const detail = (meta?.drinks || []).join(', ');
    lines.push({ key: `addon-${slug}`, label: addon.name + (detail ? ` (${detail})` : ''), amount: priceOf(slug) });
  }
  // All housemade syrups collapse into ONE line, exactly like the invoice's
  // single "Hand-Crafted Syrups" line: shared flavors bill once and multiple
  // flavors earn the 3-pack bottle discount, so the only honest amount is the
  // server-priced set figure. Client fallback (fresh taps, pre-save): sum of
  // unique flavors' standalone prices — a momentary upper bound, never under.
  const flavors = new Map();
  const syrupDrinks = [];
  for (const [drinkId, syrupIds] of Object.entries(additions.labSyrupSelections)) {
    const drink = drinkById.get(drinkId);
    if (!drink || !drink.syrup || !Array.isArray(syrupIds) || syrupIds.length === 0) continue;
    flavors.set(drink.syrup.id, drink.syrup);
    syrupDrinks.push(`${drink.syrup.name} for ${drink.name}`);
  }
  if (flavors.size > 0) {
    const fallback = [...flavors.values()].reduce((sum, s) => sum + (Number(s.price) || 0), 0);
    lines.push({
      key: 'syrups',
      label: `Housemade syrups (${syrupDrinks.join(', ')})`,
      amount: serverBreakdown ? serverBreakdown.syrupCents / 100 : fallback,
    });
  }
  const clientTotal = lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  const total = serverBreakdown ? serverBreakdown.totalCents / 100 : clientTotal;

  return (
    <section className="pp2-lab-section pp2-lab-ledger">
      <h2>Your additions</h2>
      {lines.length === 0 ? (
        <div className="pp2-lab-empty">Nothing yet. Browse the shelves above, nothing is ever added for you.</div>
      ) : (
        <>
          <ul>
            {lines.map((l) => (
              <li key={l.key}>
                <span>{l.label}</span>
                <span className="pp2-lab-line-amount">{money(l.amount)}</span>
              </li>
            ))}
          </ul>
          <div className="pp2-lab-total">
            <span>Running total</span>
            <span className="pp2-lab-line-amount">{money(total)}</span>
          </div>
          <p className="pp2-lab-ledger-note">Everything here is added to your event balance. No payment now.</p>
        </>
      )}
      <div className={`pp2-lab-savestate ${saveState}`}>
        {saveState === 'saving' && 'Saving…'}
        {saveState === 'saved' && 'Saved to your event'}
        {saveState === 'error' && "Couldn't save. Check your connection and try again."}
      </div>
    </section>
  );
}

import React, { useState, useEffect } from 'react';

// "The Full Prescription" (spec §3.1): the recap reads like a checkable
// document. Honest "Not answered" rows, Edit links back into the flow, the
// required-chips gate, the catch-all notes box, and File My Formulas. No
// payment section, ever.
const PROFILE_LABELS = {
  cocktail_forward: 'Cocktail-forward crowd', wine: 'Wine crowd', beer: 'Beer crowd',
  even: 'An even mix', help: 'Help me decide',
};
const MENU_LABELS = { custom: 'Custom menu card', house: 'Standard menu card', none: 'No printed menu' };
const PLACEMENT_LABELS = { indoors: 'Indoors', outdoors: 'Outdoors', unsure: 'Not sure yet' };
const POWER_LABELS = { yes: 'Outlet within 50 feet', no: 'No, or probably not', unsure: 'Not sure yet' };
const QUICK_PICK_LABELS = {
  full_bar: 'Full Bar Experience', sig_beer_wine: 'Signature Drinks + Beer & Wine',
  beer_wine: 'Beer & Wine Only', mocktails: 'Mocktails Only',
};

function Row({ label, value }) {
  return (
    <div className="conf-leader">
      <span>{label}</span>
      <span className={value ? '' : 'pp2-unanswered'}>{value || 'Not answered'}</span>
    </div>
  );
}

function Section({ title, step, goToStep, children }) {
  return (
    <div className="card mb-2">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <span className="potion-kicker">{title}</span>
        {step && <button className="btn btn-secondary btn-sm" onClick={() => goToStep(step)}>Edit</button>}
      </div>
      {children}
    </div>
  );
}

export default function ReviewV2({ plan, selections, updateSelections, catalog, quickPick, queue, goToStep, gaps, onSubmit, submitting }) {
  const isHosted = plan.package_category === 'hosted';
  const nameOf = (table, id) => (table === 'cocktails' ? catalog.cocktails : catalog.mocktails).find((d) => d.id === id)?.name;
  const drinkNames = [
    ...(selections.signatureDrinks || []).map((id) => nameOf('cocktails', id)),
    ...(selections.customCocktails || []),
  ].filter(Boolean);
  const mocktailNames = (selections.mocktails || []).map((id) => nameOf('mocktails', id)).filter(Boolean);
  const logistics = selections.logistics || {};
  const contact = logistics.dayOfContact || {};
  const crowd = selections.crowd || {};
  const hasDrinksStep = queue.includes('drinks') || queue.includes('hostedDrinks');
  const drinksStep = queue.includes('hostedDrinks') ? 'hostedDrinks' : 'drinks';

  // Local notes draft committed on blur so typing doesn't re-render the recap.
  const [notes, setNotes] = useState(selections.additionalNotes || '');
  useEffect(() => { setNotes(selections.additionalNotes || ''); }, [selections.additionalNotes]);

  const beer = selections.beerFromFullBar?.length ? selections.beerFromFullBar : selections.beerFromBeerWine;
  const wine = selections.wineFromFullBar?.length ? selections.wineFromFullBar : selections.wineFromBeerWine;

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>The Full Prescription</h2>
        <p className="text-muted">Read it like a document. Everything can still change before you submit.</p>
      </div>

      <Section title="Your drinks" step={hasDrinksStep ? drinksStep : null} goToStep={goToStep}>
        {!isHosted && <Row label="Bar style" value={QUICK_PICK_LABELS[quickPick]} />}
        {isHosted && <Row label="Package" value={plan.package_name} />}
        {hasDrinksStep && <Row label="Drinks" value={drinkNames.join(', ')} />}
        {hasDrinksStep && mocktailNames.length > 0 && <Row label="Mocktails" value={mocktailNames.join(', ')} />}
      </Section>

      {(queue.includes('spirits') || queue.includes('beerWine')) && (
        <Section title="Bar stocking" step={queue.includes('spirits') ? 'spirits' : 'beerWine'} goToStep={goToStep}>
          {queue.includes('spirits') && (
            <>
              <Row label="Spirits" value={(selections.spirits || []).join(', ') + (selections.spiritsOther ? `, ${selections.spiritsOther}` : '')} />
              <Row
                label="Mixers"
                value={selections.mixersForSpirits === true ? 'Yes, include mixers'
                  : selections.mixersForSpirits === false ? 'No mixers needed'
                    : selections.mixersForSpirits === 'undecided' ? 'Not sure yet, we will figure it out together' : ''}
              />
            </>
          )}
          {queue.includes('beerWine') && (
            <>
              <Row label="Beer" value={(beer || []).join(', ')} />
              <Row label="Wine" value={(wine || []).join(', ') + (selections.wineOtherFullBar || selections.wineOtherBeerWine ? ` (${selections.wineOtherFullBar || selections.wineOtherBeerWine})` : '')} />
            </>
          )}
        </Section>
      )}

      {queue.includes('crowd') && (
        <Section title="Your crowd" step="crowd" goToStep={goToStep}>
          <Row label="Guests who drink" value={crowd.drinkers !== null && crowd.drinkers !== undefined ? String(crowd.drinkers) : (crowd.unsure ? 'Not sure yet' : '')} />
          <Row label="Crowd speed" value={PROFILE_LABELS[crowd.profile] || ''} />
        </Section>
      )}

      <Section title="Menu card" step="menu" goToStep={goToStep}>
        <Row label="Menu" value={MENU_LABELS[selections.menuStyle] || ''} />
        {selections.menuStyle === 'custom' && selections.menuTheme && <Row label="Theme" value={selections.menuTheme} />}
      </Section>

      <Section title="Day-of details" step="dayof" goToStep={goToStep}>
        <Row label="Day-of contact" value={contact.name ? `${contact.name}${contact.phone ? ` (${contact.phone})` : ''}` : ''} />
        <Row label="Parking" value={logistics.parking ? String(logistics.parking).replace(/_/g, ' ') : ''} />
        <Row label="Bar placement" value={PLACEMENT_LABELS[selections.barPlacement] || ''} />
        <Row label="Power at the bar" value={POWER_LABELS[selections.powerAtBar] || ''} />
        {logistics.accessNotes && <Row label="Access notes" value={logistics.accessNotes} />}
      </Section>

      <div className="card mb-2">
        <span className="potion-kicker">Anything else?</span>
        <textarea
          className="form-textarea"
          rows={3}
          style={{ marginTop: '0.5rem' }}
          placeholder="Anything we didn't ask that we should know?"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => { if (notes !== (selections.additionalNotes || '')) updateSelections('additionalNotes', notes); }}
        />
      </div>

      {gaps.length > 0 && (
        <div className="pp2-gaps" role="status">
          <span className="pp2-gaps-label">Still needed before you submit:</span>
          {gaps.map((g) => (
            <button key={g.key} className="pp2-gap-chip" onClick={() => goToStep(g.step)}>{g.label}</button>
          ))}
        </div>
      )}

      <div style={{ textAlign: 'center', marginTop: '1rem' }}>
        <button
          className="btn btn-success pp2-submit"
          onClick={onSubmit}
          disabled={submitting || gaps.length > 0}
        >
          {submitting ? 'Filing…' : 'File My Formulas'}
        </button>
        <p className="text-muted text-small" style={{ marginTop: '0.5rem', fontStyle: 'italic' }}>
          A confirmation email with every selection follows right away.
        </p>
      </div>
    </div>
  );
}

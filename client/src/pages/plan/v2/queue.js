// Planner v2 step queues + required-field gate (spec 2026-07-18 §3.1/§3.2).
// BYOB flows run up to 8 steps; hosted flows run 5 (far fewer questions: the
// package already answered them). Mocktail-only skips the crowd screen (its
// quantities key off guest count alone).

export const STEP_LABELS = {
  quickPick: 'Quick Pick',
  drinks: 'Drink Picking',
  hostedDrinks: 'Your Drinks',
  spirits: 'Spirits & Mixers',
  beerWine: 'Beer & Wine',
  crowd: 'The Crowd',
  menu: 'Menu Design',
  dayof: 'Day-Of Details',
  review: 'Review & Submit',
};

export function buildQueue({ isHosted, hostedShape, quickPick }) {
  if (isHosted && hostedShape) {
    // slots / coverage / display all share one drinks step whose body differs.
    return ['hostedDrinks', 'crowd', 'menu', 'dayof', 'review'];
  }
  if (isHosted) {
    // Content-readiness fallback: hosted package without entered contents.
    // The legacy wizard handles this plan (PlannerRouter renders it for v1;
    // for a v2 token we run the closest BYOB-shaped flow minus stocking).
    return ['drinks', 'crowd', 'menu', 'dayof', 'review'];
  }
  switch (quickPick) {
    case 'full_bar':
      return ['quickPick', 'drinks', 'spirits', 'beerWine', 'crowd', 'menu', 'dayof', 'review'];
    case 'sig_beer_wine':
      return ['quickPick', 'drinks', 'beerWine', 'crowd', 'menu', 'dayof', 'review'];
    case 'beer_wine':
      return ['quickPick', 'beerWine', 'crowd', 'menu', 'dayof', 'review'];
    case 'mocktails':
      return ['quickPick', 'drinks', 'menu', 'dayof', 'review'];
    default:
      return ['quickPick'];
  }
}

// Required to submit (spec §3.1): at least one drink where the flow ACTUALLY
// picks drinks, the crowd answers where asked, parking, and a day-of contact.
// Returns [{key, label, step}] for the review chips; empty = submittable.
// Fleet fix (2026-07-18): the hosted 'display' shape is a confirmation, not a
// quiz — it offers no picks, so it must never gate on them; a 'slots' shape
// whose pickable pool is empty (content not flagged yet) counts as an
// explicit none rather than trapping the client.
export function requiredGaps({ queue, selections, quickPick, hostedShape, hostedPickableCount }) {
  const gaps = [];
  const hasDrinksStep = queue.includes('drinks') || queue.includes('hostedDrinks');
  const drinksPickable = hostedShape === 'display' ? false
    : hostedShape === 'slots' ? (hostedPickableCount || 0) > 0
      : hasDrinksStep;
  if (hasDrinksStep && drinksPickable) {
    const count = (selections.signatureDrinks || []).length
      + (selections.mocktails || []).length
      + (selections.customCocktails || []).length;
    if (count === 0 && quickPick !== 'beer_wine') {
      gaps.push({ key: 'drinks', label: 'Pick your drinks', step: queue.includes('hostedDrinks') ? 'hostedDrinks' : 'drinks' });
    }
  }
  if (queue.includes('crowd')) {
    const crowd = selections.crowd || {};
    const answered = crowd.profile || crowd.drinkers !== null || crowd.unsure === true;
    if (!answered) gaps.push({ key: 'crowd', label: 'Crowd questions', step: 'crowd' });
  }
  const logistics = selections.logistics || {};
  if (!logistics.parking) gaps.push({ key: 'parking', label: 'Parking', step: 'dayof' });
  const contact = logistics.dayOfContact || {};
  if (!contact.name || !contact.phone) gaps.push({ key: 'contact', label: 'Day-of contact', step: 'dayof' });
  return gaps;
}

import { fmtDate, ctDay } from '../adminos/format';

// Which of a drink plan's two answer sets the shopping-list modal's answers
// panel offers, and which it opens on (spec 2026-10-06, decisions 3 to 5).
// The consult counts from its last save (consult_filled_at is stamped on every
// save); the planner counts from its submit. The planner opens first only when
// both stamps are known and the planner's is strictly later: an unsubmitted
// draft never beats a consult, and a tie or a missing stamp goes to the consult.

// Mirrors the drink answers DrinkPlanSelections renders in listOnly mode, so the
// panel never offers a set whose body would be blank. Not counted on their own:
// the Package line (the quick pick is a default, not an answer) and the
// full-bar "mixers for spirits" flag, which no list builder reads. New-format answers count only under
// the activeModules flag that shows them (a client who switches quick picks
// keeps the old module's keys, which the card hides); the legacy v1 format
// (no activeModules) has its own keys. A planner holding only a logo
// (companyLogo / _logoFilename, merged in by the upload), menu-design or
// logistics answers, or the planner's own defaults, is no answer set.
const nonEmpty = (v) => Array.isArray(v) && v.length > 0;
const filled = (v) => typeof v === 'string' && v.trim().length > 0;
const hasKeys = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;

function hasCrowdAnswer(c) {
  if (!c || typeof c !== 'object') return false;
  return (c.drinkers !== null && c.drinkers !== undefined) || Boolean(c.profile);
}

function hasSyrups(s) {
  if (Array.isArray(s)) return s.length > 0;
  return Boolean(s) && typeof s === 'object' && Object.values(s).some(nonEmpty);
}

export function hasPlannerAnswers(sel) {
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) return false;
  const am = sel.activeModules;
  if (am && typeof am === 'object') {
    return Boolean(
      (am.signatureDrinks && (nonEmpty(sel.signatureDrinks) || nonEmpty(sel.customCocktails)))
      || (am.mocktails && (nonEmpty(sel.mocktails) || filled(sel.mocktailNotes)))
      || (am.fullBar && (nonEmpty(sel.spirits) || nonEmpty(sel.beerFromFullBar)
        || nonEmpty(sel.wineFromFullBar) || filled(sel.beerWineBalanceFullBar)))
      || (am.beerWineOnly && !am.fullBar && (nonEmpty(sel.beerFromBeerWine)
        || nonEmpty(sel.wineFromBeerWine) || filled(sel.beerWineBalanceBeerWine)))
      || filled(sel.additionalNotes)
      || hasCrowdAnswer(sel.crowd)
      || hasKeys(sel.guestPreferences)
      || hasSyrups(sel.syrupSelections)
      || nonEmpty(sel.syrupSelfProvided)
      || hasKeys(sel.addOns)
    );
  }
  // Legacy v1: the keys LegacySelections renders.
  return Boolean(
    nonEmpty(sel.signatureCocktails) || nonEmpty(sel.spirits) || filled(sel.barFocus)
    || nonEmpty(sel.wineStyles) || nonEmpty(sel.beerStyles) || filled(sel.beerWineBalance)
    || filled(sel.beerWineNotes) || filled(sel.fullBarNotes) || filled(sel.mocktailNotes)
  );
}

const SUBMITTED_STATUSES = new Set(['submitted', 'reviewed']);

// hasConsult: the consult GET returned non-empty recap lines (a consult saved
// with nothing to say is no set at all).
export function pickAnswerSets(plan, hasConsult) {
  const sets = [];
  if (!plan) return { sets, initial: null };
  if (hasConsult) {
    sets.push({ key: 'consult', at: plan.consult_filled_at || null, submitted: true });
  }
  if (hasPlannerAnswers(plan.selections)) {
    const submitted = Boolean(plan.submitted_at) || SUBMITTED_STATUSES.has(plan.status);
    sets.push({ key: 'planner', at: plan.submitted_at || null, submitted });
  }
  if (sets.length === 0) return { sets, initial: null };
  if (sets.length === 1) return { sets, initial: sets[0].key };
  const [consult, planner] = sets;
  const plannerLater = planner.submitted && Boolean(planner.at) && Boolean(consult.at)
    && new Date(planner.at).getTime() > new Date(consult.at).getTime();
  return { sets, initial: plannerLater ? 'planner' : 'consult' };
}

const day = (ts) => fmtDate(ctDay(ts));

// "From the consult, Oct 2" / "From the planner, submitted Sep 25" /
// "From the planner, not submitted"; a missing stamp drops the date.
export function sourceLine(set) {
  if (!set) return '';
  if (set.key === 'consult') return set.at ? `From the consult, ${day(set.at)}` : 'From the consult';
  if (!set.submitted) return 'From the planner, not submitted';
  return set.at ? `From the planner, submitted ${day(set.at)}` : 'From the planner, submitted';
}

// The switch's own label for each side.
export function switchLabel(set) {
  if (set.key === 'consult') return set.at ? `Consult · ${day(set.at)}` : 'Consult';
  if (!set.submitted) return 'Planner · not submitted';
  return set.at ? `Planner · ${day(set.at)}` : 'Planner · submitted';
}

// One line naming the set the list was built from, when the panel is showing
// the other one, or when the set that built it holds no drink answers.
export function listNote(shownKey, listSource, offeredKeys = []) {
  if (listSource !== 'consult' && listSource !== 'planner') return null;
  if (!offeredKeys.includes(listSource)) {
    // "no answers to show here", not "no answers": the set may be empty, a
    // row the recap cannot read, or planner answers stored without the
    // activeModules flags the card needs to show them.
    return `This list was built from the ${listSource}, which has no answers to show here.`;
  }
  if (shownKey && shownKey !== listSource) return `This list was built from the ${listSource}.`;
  return null;
}

import { hasPlannerAnswers, pickAnswerSets, sourceLine, switchLabel, listNote } from './answerSets';

const SEL = { activeModules: { signatureDrinks: true }, signatureDrinks: ['margarita'] };
const plan = (o = {}) => ({ selections: SEL, status: 'draft', submitted_at: null, consult_filled_at: null, ...o });

describe('hasPlannerAnswers', () => {
  test('only answers the list-only card shows count', () => {
    expect(hasPlannerAnswers(SEL)).toBe(true);
    expect(hasPlannerAnswers({ activeModules: {}, crowd: { drinkers: 50, profile: null } })).toBe(true);
    expect(hasPlannerAnswers({ activeModules: {}, additionalNotes: 'More tequila' })).toBe(true);
    expect(hasPlannerAnswers({ activeModules: {}, addOns: { 'house-made-ginger-beer': { enabled: true } } })).toBe(true);
    expect(hasPlannerAnswers({ beerStyles: ['IPA'] })).toBe(true); // legacy v1
  });

  test('a stale answer under a module the client switched off is no set', () => {
    // Switched from a full bar to beer and wine only: the spirits stay stored, the card hides them.
    expect(hasPlannerAnswers({ activeModules: { beerWineOnly: true }, spirits: ['Vodka'] })).toBe(false);
    expect(hasPlannerAnswers({ activeModules: { fullBar: true }, signatureDrinks: ['margarita'] })).toBe(false);
    expect(hasPlannerAnswers({ activeModules: { beerWineOnly: true, fullBar: true }, beerFromBeerWine: ['IPA'] })).toBe(false);
  });

  test('a logo, menu design, logistics, planner defaults or nothing at all is no set', () => {
    expect(hasPlannerAnswers({ companyLogo: 'x.png', _logoFilename: 'x.png' })).toBe(false);
    expect(hasPlannerAnswers({ activeModules: { fullBar: true }, menuStyle: 'custom', menuTheme: 'Gatsby' })).toBe(false);
    expect(hasPlannerAnswers({ logistics: { parking: 'street' }, barPlacement: 'outdoors' })).toBe(false);
    expect(hasPlannerAnswers({ activeModules: {}, crowd: { drinkers: null, unsure: true, profile: null }, guestPreferences: {}, addOns: {} })).toBe(false);
    expect(hasPlannerAnswers({ activeModules: { fullBar: true }, spirits: [], additionalNotes: '  ' })).toBe(false);
    expect(hasPlannerAnswers({})).toBe(false);
    expect(hasPlannerAnswers([])).toBe(false);
    expect(hasPlannerAnswers(null)).toBe(false);
  });
});

describe('pickAnswerSets', () => {
  test('consult saved after the planner submit opens on the consult', () => {
    const r = pickAnswerSets(plan({ status: 'submitted', submitted_at: '2026-09-20T15:00:00Z', consult_filled_at: '2026-10-02T15:00:00Z' }), true);
    expect(r.sets.map((s) => s.key)).toEqual(['consult', 'planner']);
    expect(r.initial).toBe('consult');
  });

  test('a planner submitted after the consult opens on the planner', () => {
    const r = pickAnswerSets(plan({ status: 'submitted', submitted_at: '2026-09-25T15:00:00Z', consult_filled_at: '2026-09-20T15:00:00Z' }), true);
    expect(r.initial).toBe('planner');
  });

  test('an unsubmitted planner never beats a consult', () => {
    const r = pickAnswerSets(plan({ consult_filled_at: '2026-01-01T15:00:00Z' }), true);
    expect(r.initial).toBe('consult');
    expect(r.sets[1]).toEqual({ key: 'planner', at: null, submitted: false });
  });

  test('a tie, or a missing stamp on either side, goes to the consult', () => {
    const at = '2026-09-25T15:00:00Z';
    expect(pickAnswerSets(plan({ status: 'submitted', submitted_at: at, consult_filled_at: at }), true).initial).toBe('consult');
    expect(pickAnswerSets(plan({ status: 'submitted', submitted_at: at, consult_filled_at: null }), true).initial).toBe('consult');
  });

  test('a submitted status with no stamp counts as submitted, with no date', () => {
    const r = pickAnswerSets(plan({ status: 'reviewed', submitted_at: null, consult_filled_at: '2026-10-02T15:00:00Z' }), true);
    expect(r.sets[1]).toEqual({ key: 'planner', at: null, submitted: true });
    expect(r.initial).toBe('consult');
  });

  test('one set alone opens on itself; neither is the empty case', () => {
    expect(pickAnswerSets(plan(), false)).toEqual({ sets: [{ key: 'planner', at: null, submitted: false }], initial: 'planner' });
    expect(pickAnswerSets(plan({ selections: null }), true).initial).toBe('consult');
    expect(pickAnswerSets(plan({ selections: { companyLogo: 'x' } }), false)).toEqual({ sets: [], initial: null });
    expect(pickAnswerSets(null, true)).toEqual({ sets: [], initial: null });
  });
});

describe('copy', () => {
  test('source lines and switch labels carry the Chicago day', () => {
    expect(sourceLine({ key: 'consult', at: '2026-10-02T15:00:00Z', submitted: true })).toBe('From the consult, Oct 2');
    expect(sourceLine({ key: 'planner', at: '2026-09-25T15:00:00Z', submitted: true })).toBe('From the planner, submitted Sep 25');
    expect(sourceLine({ key: 'planner', at: null, submitted: false })).toBe('From the planner, not submitted');
    expect(switchLabel({ key: 'consult', at: '2026-10-02T15:00:00Z', submitted: true })).toBe('Consult · Oct 2');
    expect(switchLabel({ key: 'planner', at: '2026-09-25T15:00:00Z', submitted: true })).toBe('Planner · Sep 25');
    expect(switchLabel({ key: 'planner', at: null, submitted: false })).toBe('Planner · not submitted');
  });

  test('a missing stamp drops the date, never prints a placeholder', () => {
    expect(sourceLine({ key: 'consult', at: null, submitted: true })).toBe('From the consult');
    expect(sourceLine({ key: 'planner', at: null, submitted: true })).toBe('From the planner, submitted');
    expect(switchLabel({ key: 'consult', at: null, submitted: true })).toBe('Consult');
    expect(switchLabel({ key: 'planner', at: null, submitted: true })).toBe('Planner · submitted');
  });

  test('an evening stamp reads as its Chicago day, not the UTC day', () => {
    // 2026-10-03T02:30Z is 9:30 PM on Oct 2 in Chicago.
    expect(sourceLine({ key: 'consult', at: '2026-10-03T02:30:00Z', submitted: true })).toBe('From the consult, Oct 2');
  });

  test('the list note names the set that built the list, or says it had no answers', () => {
    const both = ['consult', 'planner'];
    expect(listNote('planner', 'consult', both)).toBe('This list was built from the consult.');
    expect(listNote('consult', 'planner', both)).toBe('This list was built from the planner.');
    expect(listNote('consult', 'consult', both)).toBeNull();
    expect(listNote('planner', null, both)).toBeNull();
    expect(listNote('planner', 'something-else', both)).toBeNull();
    expect(listNote('planner', 'consult', ['planner'])).toBe('This list was built from the consult, which has no answers to show here.');
    expect(listNote(null, 'planner', [])).toBe('This list was built from the planner, which has no answers to show here.');
  });
});

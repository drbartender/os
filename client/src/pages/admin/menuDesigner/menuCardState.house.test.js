import menuCardState from './menuCardState';

// The house card's words in the card state, the editor's banners and its empty
// card (spec 2026-10-19 sections 9 and 23; lane menu-house-card). A house draft
// lists drink names only, beside fixed bar sections, so its Too long state
// names the card, never one description, and the remedy is to hide a drink,
// shorten a name or switch the look. A custom draft's copy is unchanged.
const NOW = new Date('2026-10-16T17:00:00Z').getTime();

const drink = (key, name, over = {}) => ({ key, display_name: name, group: 'sig', hidden: false, has_art: true, ...over });
const piece = (key, status = 'done') => ({
  piece_key: key, status, error: null, has_image: status === 'done', image_rev: status === 'done' ? `rev-${key}` : null,
});

function base() {
  return {
    draft: {
      id: 1, version: 3, art_version: 4, read_only: false,
      inputs: { planner_image_role: 'logo', reference_source: 'none', has_reference: false },
      content: {
        words_status: 'done', title: 'Bar Menu',
        drinks: [drink('cocktail:1', 'Paloma'), drink('cocktail:2', 'Old Fashioned'), drink('mocktail:3', 'Coral Crush', { group: 'mock' })],
      },
    },
    pieces: [piece('background'), piece('cocktail:1'), piece('cocktail:2'), piece('mocktail:3')],
    brief: { theme: '', naming: '', notes: '', has_planner_image: false },
    diff: { added: [], dropped: [], brief_edited: [], image_changed: false, dismissed: false },
    print: { state: 'none', approved_at: null, approved_by_name: null, print_key: null, approved_file_in_use: false },
    cap: { used: 4, limit: 60, remaining: 56, resets_at: null },
    configured: { openai: true, gemini: false },
    plan: { id: 7, menu_style: 'custom', drink_count: 3, drinks: [], bar_summary: { beer_wine: 0, spirits: 0, na: 0 } },
  };
}
const P = (mut) => { const p = base(); if (mut) mut(p); return p; };
const run = (payload, local = {}) => menuCardState({ payload, local: { now: NOW, ...local } });
const banner = (s, id) => s.banners.find((b) => b.id === id);

// A house draft as the job fills it: the drinks by name, no art.
const houseDraft = (touch = 'plain') => (p) => {
  p.draft.inputs = { ...p.draft.inputs, look: 'house' };
  p.draft.content = {
    words_status: 'done', title: 'The Bar Menu', look: 'house', touch_key: touch, house_bottom_corners: false,
    drinks: [drink('cocktail:1', 'Paloma', { has_art: false }), drink('cocktail:2', 'Old Fashioned', { has_art: false })],
    house_sections: [{ kind: 'beer-wine', title: 'Beer & Wine', items: ['Beer', 'Red'] }],
  };
  p.pieces = touch === 'plain' ? [] : [piece('background')];
  p.plan.house_plain = touch === 'plain';
};

describe('Too long on a house draft', () => {
  const HOUSE_LONG = 'The house card runs past the page. Hide a drink or shorten a name, or switch the look to Custom design on the Brief tab.';

  test('the banner says the card runs past the page and what to do; Approve asks to make the card fit', () => {
    // The house card reports its own key when no name is past the footer (HouseCard.js).
    const s = run(P(houseDraft()), { tooLong: ['house_card'] });
    expect(banner(s, 'too-long')).toEqual({ id: 'too-long', tone: 'danger', title: 'Text too long to fit.', text: HOUSE_LONG, buttons: [] });
    expect(s.approve).toEqual({ label: 'Approve', disabled: true, why: 'Make the card fit first' });
    expect(JSON.stringify(s)).not.toContain('description');
  });

  test('a name really past the footer reads the same, never one drink as the whole cause', () => {
    const s = run(P(houseDraft('balloons')), { tooLong: ['drinks.cocktail:2.display_name'] });
    expect(banner(s, 'too-long').text).toBe(HOUSE_LONG);
    expect(s.approve.why).toBe('Make the card fit first');
  });

  test("a custom draft's Too long copy is unchanged", () => {
    const s = run(P(), { tooLong: ['drinks.cocktail:2.description'] });
    expect(banner(s, 'too-long').text).toBe('Old Fashioned description runs past the page. Shorten it to approve.');
    expect(s.approve.why).toBe('Shorten the long description first');
  });
});

// Before a draft, the look the page will post (lookOf) decides the words: the
// house card when a Standard Menu client or one with no instructions, as
// Generate decides it, unless the admin holds a custom look in the editor.
describe('before a draft, the words follow the look Generate will post', () => {
  const house = (plain) => (p) => { p.draft = null; p.pieces = []; p.diff = null; p.plan.house_plain = plain; };
  const SUB = 'Generate drafts our house card. For a custom design, switch the look in the editor.';

  test('Not started on a house look names the house card, whatever the client chose', () => {
    let s = run(P(house(true)));
    expect([s.id, s.message, s.sub, s.primary.style]).toEqual(['never', 'Draft the house card.', SUB, 'primary']);
    s = run(P((p) => { house(false)(p); p.plan.menu_style = 'house'; }));
    expect([s.message, s.sub, s.primary.style]).toEqual(['The client chose the house menu.', SUB, 'ghost']);
    s = run(P((p) => { house(true)(p); p.plan.menu_style = 'none'; }));
    expect([s.message, s.sub, s.primary.style]).toEqual(['The client asked for no menu.', SUB, 'ghost']);
  });

  test('a held custom look keeps the custom words', () => {
    const custom = { heldInputs: { look: 'custom' } };
    let s = run(P(house(true)), custom);
    expect([s.message, s.sub]).toEqual(['Draft a custom 8×10 menu.', "From the drink plan and the client's menu notes."]);
    s = run(P((p) => { house(true)(p); p.plan.menu_style = 'house'; }), custom);
    expect([s.message, s.sub]).toEqual(['The client chose the house menu.', 'Draft a custom one anyway, or use the house menu below.']);
    expect(run(P(house(true)), custom).empty.text)
      .toBe('Generate drafts the words in seconds, then paints the background and each drink. About 2 minutes.');
  });

  test('the empty editor card says what a house Generate makes: no images when plain, else its background', () => {
    expect(run(P(house(true))).empty).toEqual({ id: 'never', title: 'No draft yet',
      text: 'Generate drafts the house card from the drink plan in seconds. No images.',
      button: { id: 'generate', label: 'Generate', style: 'primary' } });
    expect(run(P(house(false))).empty.text)
      .toBe('Generate drafts the house card from the drink plan, then draws its background. About a minute.');
  });
});

describe('a house draft at work says what a house run does', () => {
  test('drafting: Drafting the house card..., and no two-minute line', () => {
    let s = run(P((p) => {
      houseDraft('balloons')(p);
      p.draft.content = { words_status: 'pending', look: 'house', touch_key: 'balloons' };
      p.pieces = [piece('background', 'pending')];
    }));
    expect([s.chip.text, s.message, s.sub]).toEqual(['Drafting', 'Drafting the house card...', 'Keep working.']);
    s = run(P((p) => { houseDraft('balloons')(p); p.pieces = [piece('background', 'working')]; }));
    expect([s.message, s.sub]).toEqual(['Painting 1 of 1', 'Keep working.']);
  });

  test('plan changed: Update draft adds the drinks to the card and paints nothing', () => {
    const added = (names) => names.map((name, i) => ({ key: `custom:x${i}`, name }));
    let s = run(P((p) => { houseDraft()(p); p.diff.added = added(['Cucumber Mule']); }));
    expect(banner(s, 'plan-changed').text).toBe('Cucumber Mule was added. Updating adds it to the card. No images.');
    s = run(P((p) => { houseDraft()(p); p.diff.added = added(['Cucumber Mule', 'Rum Punch']); p.diff.dropped = [{ key: 'cocktail:2', name: 'Old Fashioned' }]; }));
    expect(banner(s, 'plan-changed').text)
      .toBe('Cucumber Mule was added. Rum Punch was added. Old Fashioned was dropped. Updating adds them to the card. No images.');
    s = run(P((p) => { houseDraft()(p); p.diff.dropped = [{ key: 'cocktail:2', name: 'Old Fashioned' }]; }));
    expect(banner(s, 'plan-changed').text).toBe('Old Fashioned was dropped.');
    expect(JSON.stringify(s.banners)).not.toContain('paints');
  });
});

// The plan-changed card's sub says what Update draft does. A house card has
// no "Also at the bar" lines: its bar sections are what Update draft
// refreshes. The drink sentences stay as they are; a custom draft is unchanged.
describe("the plan-changed card's sub on a house draft whose bar changed", () => {
  const changed = (mut) => P((p) => { houseDraft()(p); p.diff.bar_changed = true; if (mut) mut(p); });
  const SECTIONS = "refreshes the card's bar sections.";

  test('the bar alone, or beside a drink added, several, or one dropped', () => {
    expect(run(changed()).sub).toBe(`Update draft ${SECTIONS}`);
    expect(run(changed((p) => { p.diff.added = [{ key: 'custom:mule', name: 'Cucumber Mule' }]; })).sub)
      .toBe(`Update draft adds the drink and ${SECTIONS}`);
    expect(run(changed((p) => { p.diff.added = [{ key: 'custom:a', name: 'A' }, { key: 'custom:b', name: 'B' }]; })).sub)
      .toBe(`Update draft updates the drinks and ${SECTIONS}`);
    expect(run(changed((p) => { p.diff.dropped = [{ key: 'cocktail:2', name: 'Old Fashioned' }]; })).sub)
      .toBe(`Update draft removes the drink and ${SECTIONS}`);
    expect(JSON.stringify(run(changed()))).not.toContain('Also at the bar');
  });

  test('a custom draft keeps its "Also at the bar" wording', () => {
    const s = run(P((p) => { p.diff.bar_changed = true; }));
    expect(s.sub).toBe('Update draft refreshes the changed "Also at the bar" lines.');
  });
});

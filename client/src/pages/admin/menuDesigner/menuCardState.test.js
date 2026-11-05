import menuCardState, { resumeTime, savedAgo, shortDate } from './menuCardState';

// Spec 2026-10-01 section 11.1: table C and its precedence, tables B and E.
const NOW = new Date('2026-10-16T17:00:00Z').getTime();
const APPROVED_AT = '2026-10-09T17:00:00Z';
const OCT_9 = shortDate(APPROVED_AT);
const at = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const drink = (key, name, over = {}) => ({ key, display_name: name, group: 'sig', hidden: false, has_art: true, ...over });
const piece = (key, status = 'done', over = {}) => ({
  piece_key: key, status, error: null, has_image: status === 'done', image_rev: status === 'done' ? `rev-${key}` : null, ...over,
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
const noDraft = (p) => { p.draft = null; p.pieces = []; p.diff = null; };
const approved = (p) => {
  p.print = { state: 'approved', approved_at: APPROVED_AT, approved_by_name: 'Dallas', print_key: 'menu-print/1/a.jpg', approved_file_in_use: true };
};
const run = (payload, local = {}) => menuCardState({ payload, local: { now: NOW, ...local } });
const lines = (s) => [s.chip && s.chip.kind, s.chip && s.chip.text, s.message, s.sub];
const ids = (s) => [s.primary && s.primary.id, s.secondary && s.secondary.id];

describe('table C, one row each', () => {
  test('Loading: no chip, a skeleton, no actions', () => {
    const s = run(null, { loading: true });
    expect(s.id).toBe('loading');
    expect(s.chip).toBeNull();
    expect(ids(s)).toEqual([null, null]);
    expect(s.empty).toEqual({ id: 'loading' });
  });

  test("Couldn't load: the reason, and Retry in place", () => {
    const s = run(null, { loadError: 'Network error. Check your connection.' });
    expect(lines(s)).toEqual(['danger', 'Error', "Couldn't load the menu draft.", 'Network error. Check your connection.']);
    expect(s.primary).toEqual({ id: 'reload', label: 'Retry', style: 'primary' });
    expect(s.secondary).toBeNull();
  });

  test('Not set up, No plan and No drinks: no actions', () => {
    let s = run(P((p) => { noDraft(p); p.configured.openai = false; }));
    expect(lines(s)).toEqual(['neutral', 'Not set up', "Menu art isn't set up.", "The AI key isn't on the server yet."]);
    expect(ids(s)).toEqual([null, null]);
    s = run(P((p) => { noDraft(p); p.plan = null; p.brief = null; }));
    expect(lines(s)).toEqual(['neutral', 'No plan', 'No drink plan yet.', 'Menus are built from the drink plan.']);
    expect(ids(s)).toEqual([null, null]);
    s = run(P((p) => { noDraft(p); p.plan.drink_count = 0; }));
    expect(lines(s)).toEqual(['neutral', 'No drinks', 'Nothing to put on a menu yet.', 'Drafts are built from the drink plan.']);
    expect(ids(s)).toEqual([null, null]);
  });

  test('Never generated: Generate and a ghost Open editor; ghost Generate for house and no-menu events', () => {
    let s = run(P(noDraft));
    expect(lines(s)).toEqual(['neutral', 'Not started', 'Draft a custom 8×10 menu.', "From the drink plan and the client's menu notes."]);
    expect(s.primary).toEqual({ id: 'generate', label: 'Generate', style: 'primary' });
    expect(s.secondary).toMatchObject({ id: 'open-editor', label: 'Open editor', style: 'ghost', editor: {} });
    expect(s.thumb).toBe(false);
    s = run(P((p) => { noDraft(p); p.plan.menu_style = 'house'; }));
    expect([s.message, s.sub, s.primary.style]).toEqual(['The client chose the house menu.', 'Draft a custom one anyway, or use the house menu below.', 'ghost']);
    s = run(P((p) => { noDraft(p); p.plan.menu_style = 'none'; }));
    expect([s.message, s.sub, s.primary.style]).toEqual(['The client asked for no menu.', "From the drink plan and the client's menu notes.", 'ghost']);
  });

  test('Generating: the words, then the pieces, with a ghost Watch and no ghost View', () => {
    let s = run(P((p) => { p.draft.content = { words_status: 'pending' }; p.pieces = p.pieces.map((x) => piece(x.piece_key, 'pending')); }));
    expect(lines(s)).toEqual(['info', 'Drafting', 'Writing the words...', 'About 2 min. Keep working.']);
    expect(s.primary).toBeNull();
    expect(s.secondary).toMatchObject({ id: 'watch', label: 'Watch', style: 'ghost', editor: {} });
    expect(s.progress).toBe(0);
    s = run(P((p) => { p.pieces[2] = piece('cocktail:2', 'working'); p.pieces[3] = piece('mocktail:3', 'pending'); }));
    expect(s.message).toBe('Painting 3 of 4');
    expect(s.progress).toBe(60);
    // A single re-roll: the hook saw only that piece open.
    s = run(P((p) => { p.pieces[1] = piece('cocktail:1', 'working'); }), { activityKeys: ['cocktail:1'] });
    expect(s.message).toBe('Painting 1 of 1');
  });

  test('Draft ready: View; Saved, Saved <relative time>, or Saving...', () => {
    let s = run(P());
    expect(lines(s)).toEqual(['warn', 'Draft', 'Ready to review.', 'Saved']);
    // The hook's savedAt is null until a PATCH this visit (never the epoch).
    expect(run(P(), { savedAt: null }).sub).toBe('Saved');
    expect(s.primary).toMatchObject({ id: 'view', label: 'View', style: 'primary', editor: {} });
    expect(s.secondary).toBeNull();
    expect(s.thumb).toBe(true);
    expect(run(P(), { savedAt: NOW - 10000 }).sub).toBe('Saved just now');
    expect(run(P(), { savedAt: NOW - 5 * 60000 }).sub).toBe('Saved 5 min ago');
    s = run(P(), { saving: true });
    expect(lines(s)).toEqual(['warn', 'Draft', 'Ready to review.', 'Saving...']);
  });

  test('Drawing failed: Fix opens the Drinks tab on the first failed drink; hidden drinks never count', () => {
    let s = run(P((p) => { p.pieces[2] = piece('cocktail:2', 'failed', { error: 'interrupted' }); }));
    expect(lines(s)).toEqual(['danger', '1 drawing failed', "Old Fashioned didn't draw.", 'Re-roll it in the editor.']);
    expect(s.primary).toMatchObject({ id: 'fix', label: 'Fix', editor: { tab: 'drinks', select: 'cocktail:2' } });
    expect(s.secondary).toMatchObject({ id: 'view', style: 'ghost' });
    s = run(P((p) => { p.pieces[1] = piece('cocktail:1', 'failed'); p.pieces[2] = piece('cocktail:2', 'failed'); }));
    expect([s.chip.text, s.message]).toEqual(['2 drawings failed', "2 drawings didn't come through."]);
    s = run(P((p) => { p.pieces[2] = piece('cocktail:2', 'failed'); p.draft.content.drinks[1].hidden = true; }));
    expect(s.id).toBe('draft');
    s = run(P((p) => { p.pieces[0] = piece('background', 'failed'); }));
    expect([s.message, s.primary.editor]).toEqual(["The background didn't draw.", { tab: 'design' }]);
  });

  test('Words failed: Retry in place, no thumbnail and no ghost View', () => {
    const s = run(P((p) => {
      p.draft.content = { words_status: 'failed', words_error: 'interrupted' };
      p.pieces = p.pieces.map((x) => piece(x.piece_key, 'failed', { error: 'not attempted' }));
    }));
    expect(lines(s)).toEqual(['danger', 'Words failed', "Couldn't write the menu text.", 'No images were used.']);
    expect(ids(s)).toEqual(['retry-words', null]);
    expect(s.thumb).toBe(false);
  });

  test('Plan changed: Update draft and a ghost Dismiss; one added, one dropped, or several', () => {
    let s = run(P((p) => { p.diff.added = [{ key: 'custom:mule', name: 'Cucumber Mule' }]; }));
    expect(lines(s)).toEqual(['info', 'Plan changed', 'Cucumber Mule was added to the plan.', 'Update the draft to include it.']);
    expect(s.primary).toEqual({ id: 'update', label: 'Update draft', style: 'primary' });
    expect(s.secondary).toEqual({ id: 'dismiss', label: 'Dismiss', style: 'ghost' });
    s = run(P((p) => { p.diff.dropped = [{ key: 'cocktail:2', name: 'Old Fashioned' }]; }));
    expect([s.message, s.sub]).toEqual(['Old Fashioned was dropped from the plan.', 'Update the draft to remove it.']);
    s = run(P((p) => { p.diff.added = [{ key: 'a', name: 'A' }]; p.diff.dropped = [{ key: 'b', name: 'B' }]; }));
    expect(s.message).toBe('2 drinks changed on the plan.');
    expect(run(P((p) => { p.diff.added = [{ key: 'a', name: 'A' }]; p.diff.dismissed = true; })).id).toBe('draft');
  });

  test('Notes edited: Review opens the Brief tab; the client image changing says so', () => {
    let s = run(P((p) => { p.diff.brief_edited = ['notes']; }));
    expect(lines(s)).toEqual(['info', 'Notes edited', 'Client edited their menu notes.', 'Review before approving.']);
    expect(s.primary).toMatchObject({ id: 'review', label: 'Review', editor: { tab: 'brief' } });
    expect(s.secondary).toMatchObject({ id: 'view', style: 'ghost' });
    s = run(P((p) => { p.diff.image_changed = true; }));
    expect(s.message).toBe('The client image changed.');
  });

  test('Save failed: Retry with a ghost View', () => {
    const s = run(P(), { saveFailed: true });
    expect(lines(s)).toEqual(['danger', 'Not saved', "Last change didn't save.", 'Edits are kept until you retry.']);
    expect(ids(s)).toEqual(['retry-save', 'view']);
  });

  test('Approving: no sub and no actions, not even View', () => {
    const s = run(P(), { approving: true });
    expect(lines(s)).toEqual(['info', 'Approving', 'Saving the print file...', null]);
    expect(ids(s)).toEqual([null, null]);
  });

  test('the print states, in section 8 order', () => {
    let s = run(P(approved));
    expect(lines(s)).toEqual(['ok', 'Approved', 'Print file ready for staff.', `Approved ${OCT_9} by Dallas`]);
    expect(s.primary).toMatchObject({ id: 'view', style: 'secondary' });
    expect(s.secondary).toBeNull();
    s = run(P((p) => { approved(p); p.print.state = 'edited_since_approval'; }));
    expect(lines(s)).toEqual(['warn', 'Edited since approval', `Staff still get the ${OCT_9} version.`, 'Approve again to update it.']);
    expect(ids(s)).toEqual(['review-approve', 'view']);
    s = run(P((p) => { p.print = { state: 'replaced', print_key: 'menu-print/1/up.pdf', approved_file_in_use: false }; }));
    expect(lines(s)).toEqual(['neutral', 'Not in use', 'Print file is a manual upload.', "This draft isn't what staff print."]);
    expect(s.primary).toMatchObject({ id: 'view', style: 'secondary' });
    s = run(P((p) => { p.print = { state: 'removed', approved_at: APPROVED_AT, print_key: null, approved_file_in_use: false }; }));
    expect(lines(s)).toEqual(['warn', 'No print file', 'Print file was removed.', 'Staff have nothing to print.']);
    expect(ids(s)).toEqual(['review-approve', 'view']);
  });

  test('No menu needed: a ghost Undo, with or without a draft', () => {
    let s = run(P((p) => { noDraft(p); p.print.state = 'not_required'; }));
    expect(lines(s)).toEqual(['neutral', 'No menu needed', 'Marked no menu needed.', null]);
    expect(s.primary).toBeNull();
    expect(s.secondary).toEqual({ id: 'undo', label: 'Undo', style: 'ghost' });
    s = run(P((p) => { p.print.state = 'not_required'; }));
    expect(s.sub).toBe('A draft exists; approving it posts a print file.');
    expect(ids(s)).toEqual([null, 'undo']);
  });
});

describe('the precedence', () => {
  test('approved plus plan changed, and approved plus notes edited: the later state, staff still get the approved file', () => {
    let s = run(P((p) => { approved(p); p.diff.added = [{ key: 'custom:mule', name: 'Cucumber Mule' }]; }));
    expect([s.id, s.message, s.sub]).toEqual(['plan-changed', 'Cucumber Mule was added to the plan.', `Staff still get the ${OCT_9} version.`]);
    s = run(P((p) => { approved(p); p.diff.brief_edited = ['theme']; }));
    expect([s.id, s.sub]).toEqual(['notes-edited', `Staff still get the ${OCT_9} version.`]);
    // A manual upload is in use: no such line.
    s = run(P((p) => { p.print = { state: 'replaced', approved_file_in_use: false }; p.diff.brief_edited = ['theme']; }));
    expect(s.sub).toBe('Review before approving.');
  });

  test('a failed drawing beats a plan change; save failed beats generating; approving beats both', () => {
    const both = (p) => { p.pieces[1] = piece('cocktail:1', 'failed'); p.diff.added = [{ key: 'x', name: 'X' }]; };
    expect(run(P(both)).id).toBe('drawing-failed');
    const painting = (p) => { p.pieces[1] = piece('cocktail:1', 'working'); };
    expect(run(P(painting), { saveFailed: true }).id).toBe('save-failed');
    expect(run(P(painting), { saveFailed: true, approving: true }).id).toBe('approving');
  });

  test('no menu needed with a draft, and not set up with a draft', () => {
    expect(run(P((p) => { p.print.state = 'not_required'; })).id).toBe('no-menu');
    const s = run(P((p) => { p.configured.openai = false; }));
    expect([s.id, s.primary.id]).toEqual(['draft', 'view']);
  });

  test('the global image cap is never a card state', () => {
    expect(run(P((p) => { p.cap = { used: 60, limit: 60, remaining: 0, resets_at: null }; })).id).toBe('draft');
    expect(run(P((p) => { noDraft(p); p.cap.remaining = 0; })).id).toBe('never');
  });
});

describe('Generate', () => {
  test('the hints, by model, draft and cap', () => {
    expect(run(P(noDraft)).generate).toEqual({ disabled: false, hint: 'About 2 minutes, about 4 images, drawn by GPT Image.', need: 4 });
    expect(run(P(noDraft), { imageModel: 'gemini' }).generate.hint).toBe('About 2 minutes, about 4 images, drawn by Gemini.');
    expect(run(P()).generate.hint).toBe('Re-drafts words and art from scratch, drawn by GPT Image.');
    expect(run(P((p) => { noDraft(p); p.plan.drink_count = 11; })).generate.need).toBe(9);
  });

  test('gated on cap.remaining', () => {
    const later = NOW + 2 * 3600000;
    let g = run(P((p) => { noDraft(p); p.cap = { used: 60, limit: 60, remaining: 0, resets_at: new Date(later).toISOString() }; })).generate;
    expect(g).toMatchObject({ disabled: true, hint: `Re-rolls resume at ${at(later)}.` });
    g = run(P((p) => { noDraft(p); p.cap.remaining = 2; })).generate;
    expect(g).toMatchObject({ disabled: true, hint: 'Needs 4 images; 2 left in the last 24 hours.' });
  });

  test('blocked without the key or drinks, and while drafting or approving; no menu needed does not block it', () => {
    expect(run(P((p) => { noDraft(p); p.configured.openai = false; })).generate)
      .toMatchObject({ disabled: true, hint: 'Generate needs an AI key and drinks on the plan.' });
    expect(run(P((p) => { noDraft(p); p.plan.drink_count = 0; })).generate.disabled).toBe(true);
    expect(run(P((p) => { p.pieces[1] = piece('cocktail:1', 'pending'); })).generate.disabled).toBe(true);
    expect(run(P(), { approving: true }).generate.disabled).toBe(true);
    expect(run(P((p) => { noDraft(p); p.print.state = 'not_required'; })).generate.disabled).toBe(false);
  });
});

describe('Approve', () => {
  test('its label by print state', () => {
    expect(run(P()).approve).toEqual({ label: 'Approve', disabled: false, why: '' });
    expect(run(P(approved)).approve).toMatchObject({ label: 'Approved', disabled: true });
    expect(run(P((p) => { approved(p); p.print.state = 'edited_since_approval'; })).approve.label).toBe('Approve again');
    expect(run(P((p) => { p.print.state = 'removed'; })).approve.label).toBe('Approve again');
    expect(run(P((p) => { p.print.state = 'replaced'; })).approve.label).toBe('Use as print file');
    expect(run(P(), { approving: true }).approve).toMatchObject({ label: 'Approving...', disabled: true });
  });

  test('blocked by text too long, a failed drawing, drafting and no draft, with the reason as its title', () => {
    expect(run(P(), { tooLong: ['drinks.cocktail:2.description'] }).approve)
      .toEqual({ label: 'Approve', disabled: true, why: 'Shorten the long description first' });
    expect(run(P((p) => { p.pieces[1] = piece('cocktail:1', 'failed'); })).approve)
      .toEqual({ label: 'Approve', disabled: true, why: 'Fix the failed drawing first' });
    expect(run(P((p) => { p.pieces[1] = piece('cocktail:1', 'working'); })).approve.disabled).toBe(true);
    expect(run(P(noDraft)).approve.disabled).toBe(true);
  });
});

describe('table B, the editor banners', () => {
  const banner = (s, id) => s.banners.find((b) => b.id === id);

  test('generating: the background, then each drink', () => {
    let s = run(P((p) => { p.pieces = p.pieces.map((x) => piece(x.piece_key, x.piece_key === 'background' ? 'working' : 'pending')); }));
    expect(banner(s, 'generating')).toMatchObject({ tone: 'info', title: 'Words are in.', text: 'Painting the background next.' });
    s = run(P((p) => { p.pieces[2] = piece('cocktail:2', 'working'); p.pieces[3] = piece('mocktail:3', 'pending'); }));
    expect(banner(s, 'generating')).toMatchObject({ title: 'Painting Old Fashioned...', text: '1 of 3 drinks done. Text is editable now.' });
    expect(banner(run(P((p) => { p.draft.content = { words_status: 'working' }; })), 'generating')).toBeUndefined();
  });

  test('a single drawing (a re-roll, or one drink Update draft added) is worded for one piece', () => {
    let s = run(P((p) => { p.pieces[2] = piece('cocktail:2', 'working'); }), { activityKeys: ['cocktail:2'] });
    expect(banner(s, 'generating')).toMatchObject({ tone: 'info', title: 'Painting Old Fashioned...', text: 'One drawing under way. Text is editable now.' });
    s = run(P((p) => { p.pieces[0] = piece('background', 'working'); }), { activityKeys: ['background'] });
    expect(banner(s, 'generating')).toMatchObject({ title: 'Painting the background...', text: 'One drawing under way. Text is editable now.' });
    // A job of several keeps the counts.
    s = run(P((p) => { p.pieces[2] = piece('cocktail:2', 'working'); p.pieces[3] = piece('mocktail:3', 'pending'); }),
      { activityKeys: ['cocktail:2', 'mocktail:3'] });
    expect(banner(s, 'generating')).toMatchObject({ title: 'Painting Old Fashioned...', text: '0 of 2 drinks done. Text is editable now.' });
  });

  test('drawing failed: one with its reason and Re-roll, or several', () => {
    let s = run(P((p) => { p.pieces[2] = piece('cocktail:2', 'failed', { error: 'Gemini did not answer.' }); }));
    expect(banner(s, 'drawing-failed')).toEqual({
      id: 'drawing-failed', tone: 'danger', title: 'One drawing failed.',
      text: "Old Fashioned didn't draw: Gemini did not answer. Re-roll it or hide it.",
      buttons: [{ id: 'reroll', label: 'Re-roll', style: 'secondary', pieceKey: 'cocktail:2' }],
    });
    s = run(P((p) => { p.pieces[1] = piece('cocktail:1', 'failed'); p.pieces[2] = piece('cocktail:2', 'failed'); }));
    expect(banner(s, 'drawing-failed')).toMatchObject({ title: '2 drawings failed.', text: 'Re-roll or hide the flagged drinks.', buttons: [] });
  });

  test('image limit, drawing off, save failed, save conflict, too long and approve rejected', () => {
    const later = NOW + 3600000;
    let s = run(P((p) => { p.cap = { used: 60, limit: 60, remaining: 0, resets_at: new Date(later).toISOString() }; }));
    expect(banner(s, 'image-limit')).toMatchObject({ tone: 'warn', title: 'Daily image limit reached.',
      text: `60 of 60 images used in the last 24 hours. Re-rolls resume at ${at(later)}. Text, type and color still work.` });
    s = run(P((p) => { p.configured.openai = false; }));
    expect(banner(s, 'drawing-off')).toMatchObject({ tone: 'neutral', title: 'Drawing is off.',
      text: "The AI key isn't on the server. Text, type, color and Approve still work." });
    s = run(P(), { saveFailed: true, conflict: true, tooLong: ['drinks.cocktail:2.description'], approveError: 'The draft changed. Approve again.' });
    expect(banner(s, 'save-failed')).toMatchObject({ tone: 'danger', title: "Last change didn't save.", text: 'Your edits are kept in this tab.',
      buttons: [{ id: 'retry-save', label: 'Retry', style: 'secondary' }] });
    expect(banner(s, 'save-conflict')).toMatchObject({ tone: 'warn', title: 'This draft changed elsewhere.', text: 'It was reloaded.' });
    expect(banner(s, 'too-long')).toMatchObject({ tone: 'danger', title: 'Text too long to fit.',
      text: 'Old Fashioned description runs past the page. Shorten it to approve.' });
    expect(banner(s, 'approve-rejected')).toMatchObject({ tone: 'danger', title: "Couldn't approve.", text: 'The draft changed. Approve again.' });
  });

  test('plan changed and notes edited, with their buttons', () => {
    const s = run(P((p) => {
      p.diff.added = [{ key: 'custom:mule', name: 'Cucumber Mule' }];
      p.diff.dropped = [{ key: 'cocktail:2', name: 'Old Fashioned' }];
      p.diff.brief_edited = ['theme', 'notes'];
    }));
    expect(banner(s, 'plan-changed')).toEqual({ id: 'plan-changed', tone: 'info', title: 'Plan changed since this draft.',
      text: 'Cucumber Mule was added. Old Fashioned was dropped. Updating paints only the new drinks.',
      buttons: [{ id: 'dismiss', label: 'Dismiss', style: 'ghost' }, { id: 'update', label: 'Update draft', style: 'secondary' }] });
    expect(banner(s, 'notes-edited')).toMatchObject({ title: 'Client edited their menu notes.',
      text: "Theme & colors and Design notes changed. The draft hasn't been updated.", buttons: [{ id: 'mark-reviewed', label: 'Mark reviewed' }] });
    const img = run(P((p) => { p.diff.image_changed = true; }));
    expect(banner(img, 'notes-edited')).toMatchObject({ title: 'The client image changed since this draft.' });
  });

  test('the print states, no plan and couldnt load', () => {
    const one = (mut, id) => banner(run(P(mut)), id);
    expect(one(approved, 'approved')).toMatchObject({ tone: 'ok', title: `Approved ${OCT_9}.`,
      text: 'This is the print file staff download. Edits make a new draft until you approve again.', buttons: [{ id: 'download', label: 'Download' }] });
    expect(one((p) => { approved(p); p.print.state = 'edited_since_approval'; }, 'edited'))
      .toMatchObject({ tone: 'warn', title: 'Edited since approval.', text: `Staff still get the ${OCT_9} version until you approve again.` });
    expect(one((p) => { p.print.state = 'replaced'; }, 'replaced'))
      .toMatchObject({ tone: 'neutral', title: 'Print file is a manual upload.', text: 'Approving replaces it with this draft.' });
    expect(one((p) => { p.print.state = 'removed'; }, 'removed'))
      .toMatchObject({ tone: 'warn', title: 'Print file was removed.', text: 'Staff have nothing to print. Approve to restore it.' });
    expect(one((p) => { p.print.state = 'not_required'; }, 'no-menu'))
      .toMatchObject({ tone: 'neutral', title: 'Marked no menu needed.', text: 'Approving still posts this menu and clears the mark.', buttons: [{ id: 'undo' }] });
    expect(one((p) => { p.draft.read_only = true; p.plan = null; p.diff = null; }, 'no-plan'))
      .toMatchObject({ tone: 'neutral', title: 'No drink plan on this event.', text: 'The draft is read-only.' });
    expect(run(null, { loadError: 'Network error.' }).banners).toEqual([{ id: 'load-error', tone: 'danger',
      title: "Couldn't load the menu.", text: 'Network error.', buttons: [{ id: 'reload', label: 'Retry', style: 'secondary' }] }]);
  });

  test('two apply at once: they stack in table order', () => {
    const s = run(P((p) => { approved(p); p.diff.added = [{ key: 'x', name: 'X' }]; }));
    expect(s.banners.map((b) => b.id)).toEqual(['plan-changed', 'approved']);
  });
});

describe('table E, the empty editor', () => {
  test('one row each, and none with a draft to draw', () => {
    expect(run(null, { loading: true }).empty).toEqual({ id: 'loading' });
    expect(run(P((p) => { noDraft(p); p.configured.openai = false; })).empty)
      .toEqual({ id: 'not-set-up', title: "Menu art isn't set up", text: "The AI key isn't on the server yet.", button: null });
    expect(run(P((p) => { noDraft(p); p.plan.drink_count = 0; })).empty).toEqual({ id: 'no-drinks', title: 'No drinks on the plan',
      text: 'Menus are built from the drink plan. Add drinks there, then come back.', button: { id: 'open-plan', label: 'Open drink plan', style: 'secondary' } });
    expect(run(P((p) => { noDraft(p); p.plan = null; })).empty)
      .toEqual({ id: 'no-plan', title: 'No drink plan on this event', text: 'Menus are built from the drink plan.', button: null });
    expect(run(P(noDraft)).empty).toEqual({ id: 'never', title: 'No draft yet',
      text: 'Generate drafts the words in seconds, then paints the background and each drink. About 2 minutes.',
      button: { id: 'generate', label: 'Generate', style: 'primary' } });
    expect(run(P((p) => { p.draft.content = { words_status: 'failed' }; })).empty).toEqual({ id: 'words-failed',
      title: "Couldn't write the menu text", text: 'The words step failed, so no images were used. Try again.',
      button: { id: 'retry-words', label: 'Retry', style: 'primary' } });
    expect(run(P((p) => { noDraft(p); p.print.state = 'not_required'; })).empty)
      .toEqual({ id: 'no-menu', title: 'No menu for this event', text: 'Undo to draft one.', button: { id: 'undo', label: 'Undo', style: 'secondary' } });
    expect(run(P()).empty).toBeNull();
  });
});

describe('table D: facts the system does not store stay out', () => {
  test('no removal date, no upload name, no who-marked, no approver when unknown', () => {
    const all = (s) => JSON.stringify([s.message, s.sub, s.banners]);
    expect(all(run(P((p) => { p.print = { state: 'removed', approved_at: APPROVED_AT }; })))).not.toContain(OCT_9);
    expect(all(run(P((p) => { p.print = { state: 'replaced', print_key: 'menu-print/1/monogram.pdf' }; })))).not.toMatch(/monogram|\.pdf/);
    expect(run(P((p) => { noDraft(p); p.print.state = 'not_required'; })).sub).toBeNull();
    expect(run(P((p) => { approved(p); p.print.approved_by_name = null; })).sub).toBe(`Approved ${OCT_9}`);
  });
});

test('the time helpers', () => {
  expect(savedAgo(null, NOW)).toBe('');
  expect(savedAgo(NOW - 2 * 3600000, NOW)).toBe(`at ${at(NOW - 2 * 3600000)}`);
  expect(resumeTime(null, NOW)).toBe('soon');
  expect(resumeTime(new Date(NOW + 20 * 3600000).toISOString(), NOW)).toBe(`tomorrow at ${at(NOW + 20 * 3600000)}`);
});

describe('the review fixes', () => {
  test("Saved falls back to the draft's own last write, and past a day reads a date", () => {
    const day = 86400000;
    expect(run(P((p) => { p.draft.updated_at = new Date(NOW - 20000).toISOString(); })).sub).toBe('Saved just now');
    expect(run(P((p) => { p.draft.updated_at = new Date(NOW - 3 * day).toISOString(); })).sub).toBe(`Saved ${shortDate(NOW - 3 * day)}`);
    // This visit's own save wins over the row's timestamp.
    expect(run(P((p) => { p.draft.updated_at = new Date(NOW - 3 * day).toISOString(); }), { savedAt: NOW - 120000 }).sub).toBe('Saved 2 min ago');
  });

  test('two or more failed drawings say Re-roll them', () => {
    const s = run(P((p) => { p.pieces[1] = piece('cocktail:1', 'failed'); p.pieces[2] = piece('cocktail:2', 'failed'); }));
    expect(s.sub).toBe('Re-roll them in the editor.');
  });

  test('approved, then replaced by a manual upload: no staff-still-get line under a later state', () => {
    const s = run(P((p) => {
      p.print = { state: 'replaced', approved_at: APPROVED_AT, approved_by_name: 'Dallas', print_key: 'menu-print/1/up.pdf', approved_file_in_use: false };
      p.diff.added = [{ key: 'custom:mule', name: 'Cucumber Mule' }];
    }));
    expect([s.id, s.sub]).toEqual(['plan-changed', 'Update the draft to include it.']);
  });
});

test('Saved on the previous calendar day, under a day ago, says yesterday; past a day, the date', () => {
  const midnight = new Date(NOW);
  midnight.setHours(0, 0, 0, 0);
  const lastNight = midnight.getTime() - 3600000;
  expect(savedAgo(lastNight, NOW)).toBe(`yesterday at ${at(lastNight)}`);
  expect(run(P(), { savedAt: lastNight }).sub).toBe(`Saved yesterday at ${at(lastNight)}`);
  expect(savedAgo(NOW - 2 * 86400000, NOW)).toBe(shortDate(NOW - 2 * 86400000));
});


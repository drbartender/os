import menuCardState, {
  shortDate, reviewValue, historyValue, canCopyLink, canCloseRequest,
} from './menuCardState';

// The client review in the card state and the editor's banners (spec
// 2026-10-19 sections 10.3, 10.5 and 14; lane menu-approve-send): table C's
// two client states, Released, Put it back for staff, table B's three
// banners, the Client review fold value and the Brief tab's history lines.
// A sibling of menuCardState.test.js, which sits near the file-size ratchet.
const NOW = new Date('2026-11-14T17:00:00Z').getTime();
const SENT_AT = '2026-11-10T17:00:00Z';
const ANSWERED_AT = '2026-11-12T17:00:00Z';
const RELEASED_AT = '2026-11-13T17:00:00Z';
const NOV_10 = shortDate(SENT_AT);
const NOV_12 = shortDate(ANSWERED_AT);
const NOV_13 = shortDate(RELEASED_AT);

const drink = (key, name) => ({ key, display_name: name, group: 'sig', hidden: false, has_art: true });
const piece = (key) => ({ piece_key: key, status: 'done', error: null, has_image: true, image_rev: `rev-${key}` });
function base() {
  return {
    draft: {
      id: 1, version: 3, art_version: 4, read_only: false,
      inputs: { planner_image_role: 'logo', reference_source: 'none', has_reference: false },
      content: { words_status: 'done', title: 'Bar Menu', drinks: [drink('cocktail:1', 'Paloma'), drink('cocktail:2', 'Old Fashioned')] },
    },
    pieces: [piece('background'), piece('cocktail:1'), piece('cocktail:2')],
    brief: { theme: '', naming: '', notes: '', has_planner_image: false },
    diff: { added: [], dropped: [], brief_edited: [], image_changed: false, dismissed: false },
    print: { state: 'none', held: false, approved_at: null, approved_by_name: null, print_key: null, approved_file_in_use: false },
    proof: null,
    cap: { used: 4, limit: 60, remaining: 56, resets_at: null },
    configured: { openai: true, gemini: false },
    plan: { id: 7, menu_style: 'custom', drink_count: 2, drinks: [], bar_summary: { beer_wine: 0, spirits: 0, na: 0 } },
  };
}
const P = (mut) => { const p = base(); if (mut) mut(p); return p; };
const run = (payload, local = {}) => menuCardState({ payload, local: { now: NOW, ...local } });
const lines = (s) => [s.chip && s.chip.kind, s.chip && s.chip.text, s.message, s.sub];
const banner = (s, id) => s.banners.find((b) => b.id === id);

const proof = (over = {}) => ({
  id: 77, state: 'open', version: 3, art_version: 4, url: 'https://drbartender.com/menu-proof/abc', sent_at: SENT_AT,
  email_status: 'sent', expired: false, stale: false, answer: null, answer_note: null, answered_at: null, withdrawn_at: null,
  history: [], ...over,
});
// Approved at 3/4 and held: no file is live for staff, the proof is out.
const held = (over = {}, live = 'none') => (p) => {
  p.print = { state: 'held', held: true, live, approved_at: SENT_AT, approved_by_name: 'Dallas', approved_version: 3, approved_art_version: 4,
    print_key: live === 'none' ? null : 'menu-print/1/old.jpg', approved_file_in_use: false };
  p.proof = proof(over);
};
const released = (via) => (p) => {
  p.print = { state: 'approved', held: false, approved_at: SENT_AT, approved_by_name: 'Dallas', approved_version: 3, approved_art_version: 4,
    released_at: RELEASED_AT, released_via: via, released_by_name: via === 'admin' ? 'Dallas' : null,
    print_key: 'menu-print/1/a.jpg', approved_file_in_use: true };
};
const NOTE = 'Can the title say Happy 40th? And put the Paloma first, since it is the one everyone asked about at the party last year.';

describe('table C: Waiting on the client', () => {
  test('the chip, the message and Release for printing with a ghost Copy link', () => {
    const s = run(P(held()));
    expect(lines(s)).toEqual(['info', 'Waiting on client', `Sent to the client ${NOV_10}. Staff can print once they say it looks great.`, null]);
    expect(s.id).toBe('waiting');
    expect(s.primary).toEqual({ id: 'release', label: 'Release for printing', style: 'secondary' });
    expect(s.secondary).toEqual({ id: 'copy-link', label: 'Copy link', style: 'ghost' });
  });

  test.each([
    ['no email on file', { email_status: 'no_address' }, 'No email on file. Copy the link and send it yourself.'],
    ['the email failed', { email_status: 'failed' }, "The email didn't go out. Copy the link and send it yourself."],
    ['an email that was skipped', { email_status: 'skipped' }, "The email didn't go out. Copy the link and send it yourself."],
    ['the email was blocked', { email_status: 'suppressed' },
      "The email was blocked: the client's address is marked as not working, or the event was archived before it went out. Copy the link and send it another way."],
    ['the draft changed since', { stale: true }, 'The draft changed since. Approve again if it matters.'],
    ['the link expired', { state: 'expired', expired: true, email_status: 'no_address' }, 'The link expired. Approve again to send a fresh one.'],
    // A dated link ends at the Chicago midnight after the event day, when Approve refuses a fresh one.
    ['the link ended with the event', { state: 'expired', expired: true, event_passed: true }, 'The link ended with the event day.'],
  ])('%s: its sub line', (_n, over, sub) => {
    expect(run(P(held(over))).sub).toBe(sub);
  });

  // The client can no longer answer, so neither the card nor the banner says they still might.
  test('a link that ended with the event day: the sent date alone, Release for printing kept, never Approve again or Waiting', () => {
    const s = run(P(held({ state: 'expired', expired: true, event_passed: true })));
    expect(lines(s)).toEqual(['info', 'Waiting on client', `Sent to the client ${NOV_10}.`, 'The link ended with the event day.']);
    expect(s.primary).toMatchObject({ id: 'release', label: 'Release for printing' });
    const b = banner(s, 'client-waiting');
    expect([b.title, b.text]).toEqual([`Proof sent ${NOV_10}.`, 'The link ended with the event day.']);
    expect(b.buttons.map((x) => x.id)).toEqual(['release']);
    expect(JSON.stringify(s)).not.toMatch(/Approve again|Waiting on the client's answer|Staff can print once/);
  });

  test('every other expired or waiting branch keeps its first sentence', () => {
    const undated = run(P(held({ state: 'expired', expired: true })));
    expect(undated.message).toBe(`Sent to the client ${NOV_10}. Staff can print once they say it looks great.`);
    expect(banner(undated, 'client-waiting').text)
      .toBe("Waiting on the client's answer. Edits here don't change what they see. The link expired. Approve again to send a fresh one.");
    // event_passed with a live link (the clock between the two reads) is not the ended branch.
    expect(run(P(held({ event_passed: true }))).message).toBe(`Sent to the client ${NOV_10}. Staff can print once they say it looks great.`);
  });

  test('an expired link offers no Copy link, so the ghost View takes the slot', () => {
    const s = run(P(held({ state: 'expired', expired: true })));
    expect(s.secondary).toMatchObject({ id: 'view', style: 'ghost' });
  });

  test('a held file beside an older released one still waits on the client', () => {
    expect(run(P(held({}, 'previous'))).id).toBe('waiting');
  });
});

describe('table C: Client asked for changes', () => {
  test('the first 90 characters of the note, then "...", with Read notes and a ghost Release for printing', () => {
    const s = run(P(held({ state: 'changes', answer: 'changes', answer_note: NOTE, answered_at: ANSWERED_AT })));
    expect(lines(s)).toEqual(['warn', 'Changes requested', 'The client asked for changes.', `${Array.from(NOTE).slice(0, 90).join('').trimEnd()}...`]);
    expect(s.primary).toEqual({ id: 'read-notes', label: 'Read notes', style: 'primary', editor: { tab: 'brief' } });
    expect(s.secondary).toEqual({ id: 'release', label: 'Release for printing', style: 'ghost' });
  });

  test('a short note is shown whole; with stale, the version they saw', () => {
    expect(run(P(held({ state: 'changes', answer: 'changes', answer_note: 'More gin.', answered_at: ANSWERED_AT }))).sub).toBe('More gin.');
    expect(run(P(held({ state: 'changes', answer: 'changes', answer_note: 'More gin.', answered_at: ANSWERED_AT, stale: true }))).sub)
      .toBe(`More gin. They saw the version sent ${NOV_10}; the draft changed since.`);
  });
});

// The client's Looks great was refused a release (a blocker since gone): the file is still held.
describe('a held file the client already approved', () => {
  const approvedProof = { state: 'approved', answer: 'approved', answered_at: ANSWERED_AT };
  test('the card: Client approved, never Waiting on the client, with a primary Release for printing and no Copy link', () => {
    const s = run(P(held(approvedProof)));
    expect(s.id).toBe('client-approved');
    expect(lines(s)).toEqual(['info', 'Client approved', `The client said it looks great ${NOV_12}.`, "It isn't with staff yet. Release it for printing."]);
    expect(s.primary).toEqual({ id: 'release', label: 'Release for printing', style: 'primary' });
    expect(s.secondary).toMatchObject({ id: 'view', style: 'ghost' });
    expect(run(P(held({ ...approvedProof, expired: true }))).id).toBe('client-approved');
  });

  test("the editor: the same two sentences with Release for printing, and no Waiting on the client's answer", () => {
    const s = run(P(held(approvedProof)));
    expect(banner(s, 'client-approved')).toEqual({
      id: 'client-approved', tone: 'info', title: `The client said it looks great ${NOV_12}.`, text: "It isn't with staff yet. Release it for printing.",
      buttons: [{ id: 'release', label: 'Release for printing', style: 'secondary' }],
    });
    expect(banner(s, 'client-waiting')).toBeUndefined();
    expect(JSON.stringify(s)).not.toMatch(/Waiting on/);
  });
});

describe('table C: the precedence', () => {
  test('Plan changed and Notes edited come before the client states, which come before the print states', () => {
    expect(run(P((p) => { held()(p); p.diff.added = [{ key: 'x', name: 'X' }]; })).id).toBe('plan-changed');
    expect(run(P((p) => { held()(p); p.diff.brief_edited = ['notes']; })).id).toBe('notes-edited');
    expect(run(P(held({ state: 'changes', answer: 'changes', answer_note: 'x', answered_at: ANSWERED_AT }))).id).toBe('changes');
  });

  test('once the file is released, Released wins over a change request asked after it', () => {
    const s = run(P((p) => { released('admin')(p); p.proof = proof({ state: 'changes', answer: 'changes', answer_note: 'x', answered_at: ANSWERED_AT }); }));
    expect(s.id).toBe('approved');
    expect(run(P((p) => { released('admin')(p); p.print.state = 'edited_since_approval'; p.proof = proof({ state: 'changes', answer: 'changes' }); })).id)
      .toBe('edited');
  });
});

describe('table C: Released, which is the Approved row', () => {
  test('released by the client: its message and sub, View and a ghost Download', () => {
    const s = run(P(released('client')));
    expect(lines(s)).toEqual(['ok', 'Approved', 'Approved for print. Staff can download it.', `The client said it looks great ${NOV_13}.`]);
    expect(s.primary).toMatchObject({ id: 'view', style: 'secondary' });
    expect(s.secondary).toEqual({ id: 'download', label: 'Download', style: 'ghost' });
  });

  test('released by the admin, or a menu approved before releases existed (its approval date)', () => {
    expect(run(P(released('admin'))).sub).toBe(`You released it ${NOV_13}.`);
    expect(run(P((p) => { released('admin')(p); p.print.released_at = null; })).sub).toBe(`You released it ${shortDate(SENT_AT)}.`);
  });
});

// Staff download the released file, so "the <date> version" is the day it was released (approved Nov 10, released Nov 13).
describe('Staff still get the <date> version: the day of the file staff have', () => {
  const edited = (p) => { released('client')(p); p.print.state = 'edited_since_approval'; };
  test('Edited since approval, on the card and in the banner, names the release day', () => {
    const s = run(P(edited));
    expect(s.message).toBe(`Staff still get the ${NOV_13} version.`);
    expect(banner(s, 'edited').text).toBe(`Staff still get the ${NOV_13} version until you approve again.`);
  });

  test('a state above the print states names it too; a v1 approval with no release stamp keeps its approval day', () => {
    expect(run(P((p) => { released('admin')(p); p.diff.added = [{ key: 'x', name: 'X' }]; })).sub).toBe(`Staff still get the ${NOV_13} version.`);
    const v1 = run(P((p) => { edited(p); p.print.released_at = null; }));
    expect(v1.message).toBe(`Staff still get the ${NOV_10} version.`);
  });
});

describe('table C: the print states around the release', () => {
  test('Print file removed offers Put it back for staff when the removed file was the menu\'s own', () => {
    const s = run(P((p) => { p.print = { state: 'removed', restorable: true, approved_version: 3, approved_art_version: 4, print_key: null }; }));
    expect(lines(s)).toEqual(['warn', 'No print file', 'Print file was removed.', 'Staff have nothing to print.']);
    expect(s.primary).toMatchObject({ id: 'review-approve' });
    expect(s.secondary).toEqual({ id: 'put-back', label: 'Put it back for staff', style: 'secondary' });
  });

  test('No menu needed with a draft says to undo the mark, since Approve refuses while it is set', () => {
    expect(run(P((p) => { p.print.state = 'not_required'; })).sub).toBe('A draft exists; undo the mark to approve and send it.');
  });
});

describe('Approve and send in the top bar', () => {
  test('its label; Approved stays disabled; the mark holds it with its reason', () => {
    expect(run(P()).approve).toEqual({ label: 'Approve and send', disabled: false, why: '' });
    for (const mut of [held(), (p) => { p.print.state = 'edited_since_approval'; }, (p) => { p.print.state = 'removed'; }]) {
      expect(run(P(mut)).approve).toEqual({ label: 'Approve and send', disabled: false, why: '' });
    }
    // Beside the admin's own upload a Looks great could never release, and the server refuses Approve.
    expect(run(P((p) => { p.print.state = 'replaced'; })).approve)
      .toEqual({ label: 'Approve and send', disabled: true, why: 'Remove your uploaded file first' });
    expect(run(P(released('client'))).approve).toMatchObject({ label: 'Approved', disabled: true });
    expect(run(P((p) => { p.print.state = 'not_required'; })).approve).toEqual({ label: 'Approve and send', disabled: true, why: 'Undo the mark first' });
    expect(run(P(), { approving: true }).approve).toMatchObject({ label: 'Approving...', disabled: true });
  });
});

describe('table B: the client review banners', () => {
  test('Waiting on the client: info, the sent date, and a secondary Release for printing', () => {
    expect(banner(run(P(held())), 'client-waiting')).toEqual({
      id: 'client-waiting', tone: 'info', title: `Proof sent ${NOV_10}.`, text: "Waiting on the client's answer. Edits here don't change what they see.",
      buttons: [{ id: 'release', label: 'Release for printing', style: 'secondary' }],
    });
  });

  test('a proof the email never reached says so, with a ghost Copy link before Release', () => {
    const b = banner(run(P(held({ email_status: 'no_address' }))), 'client-waiting');
    expect(b.text).toBe("Waiting on the client's answer. Edits here don't change what they see. No email on file. Copy the link and send it yourself.");
    expect(b.buttons).toEqual([{ id: 'copy-link', label: 'Copy link', style: 'ghost' }, { id: 'release', label: 'Release for printing', style: 'secondary' }]);
    expect(banner(run(P(held({ state: 'expired', expired: true }))), 'client-waiting').buttons.map((x) => x.id)).toEqual(['release']);
  });

  test('Client asked for changes: warn, the full note, the version they saw when stale, and no buttons', () => {
    const changes = { state: 'changes', answer: 'changes', answer_note: NOTE, answered_at: ANSWERED_AT };
    expect(banner(run(P(held(changes))), 'client-changes')).toEqual({ id: 'client-changes', tone: 'warn', title: 'The client asked for changes.', text: NOTE, buttons: [] });
    expect(banner(run(P(held({ ...changes, stale: true }))), 'client-changes').text).toBe(`${NOTE} They saw the version sent ${NOV_10}.`);
    expect(banner(run(P(held(changes))), 'client-waiting')).toBeUndefined();
  });

  test('after Notes edited and before the print banners', () => {
    const s = run(P((p) => { held()(p); p.diff.brief_edited = ['notes']; }));
    expect(s.banners.map((b) => b.id)).toEqual(['notes-edited', 'client-waiting']);
  });

  test('Released: the Approved banner plus who released it', () => {
    const text = 'This is the print file staff download. Edits make a new draft until you approve again.';
    expect(banner(run(P(released('client'))), 'approved')).toMatchObject({ tone: 'ok', title: `Approved ${NOV_10}.`,
      text: `${text} The client said it looks great ${NOV_13}.`, buttons: [{ id: 'download', label: 'Download' }] });
    expect(banner(run(P(released('admin'))), 'approved').text).toBe(`${text} Released ${NOV_13} by Dallas.`);
    // A payload that does not say who released it keeps the banner as it was.
    expect(banner(run(P((p) => { released('admin')(p); delete p.print.released_via; })), 'approved').text).toBe(text);
  });

  test("Print file removed offers Put it back for staff; a manual upload and the mark say what is true now", () => {
    expect(banner(run(P((p) => { p.print = { state: 'removed', restorable: true, print_key: null }; })), 'removed'))
      .toEqual({ id: 'removed', tone: 'warn', title: 'Print file was removed.', text: 'Staff have nothing to print.',
        buttons: [{ id: 'put-back', label: 'Put it back for staff', style: 'secondary' }] });
    expect(banner(run(P((p) => { p.print = { state: 'replaced', print_key: 'up' }; })), 'replaced').text).toBe('Staff print the upload until you remove it.');
    expect(banner(run(P((p) => { p.print.state = 'not_required'; })), 'no-menu').text).toBe('Undo the mark to approve and send this menu.');
  });
});

describe('the Client review value line, and the history', () => {
  test.each([
    ['no proof', null, 'Not sent yet'],
    ['sent', proof(), `Sent ${NOV_10}`],
    ['sent, no email on file', proof({ email_status: 'no_address' }), `Sent ${NOV_10} · no email on file`],
    ['sent, the email failed', proof({ email_status: 'failed' }), `Sent ${NOV_10} · email failed`],
    ['sent, the email blocked', proof({ email_status: 'suppressed' }), `Sent ${NOV_10} · email blocked`],
    ['sent, the email skipped', proof({ email_status: 'skipped' }), `Sent ${NOV_10} · email not sent`],
    ['sent, the link expired', proof({ state: 'expired', expired: true, email_status: 'no_address' }), `Sent ${NOV_10} · link expired`],
    ['looks great', proof({ state: 'approved', answer: 'approved', answered_at: ANSWERED_AT }), `Looks great, ${NOV_12}`],
    ['changes requested', proof({ state: 'changes', answer: 'changes', answered_at: ANSWERED_AT }), `Changes requested ${NOV_12}`],
    ['closed', proof({ state: 'withdrawn', withdrawn_at: RELEASED_AT, answer: 'changes', answered_at: ANSWERED_AT }), `Closed ${NOV_13}`],
  ])('%s', (_n, p, value) => {
    expect(reviewValue(p)).toBe(value);
  });

  test('an earlier proof reads its answer, or Closed, or No answer', () => {
    expect(historyValue({ answer: 'approved', answered_at: ANSWERED_AT })).toBe(`Looks great, ${NOV_12}`);
    expect(historyValue({ answer: 'changes', answered_at: ANSWERED_AT, withdrawn_at: RELEASED_AT })).toBe(`Changes requested ${NOV_12}`);
    expect(historyValue({ answer: null, withdrawn_at: RELEASED_AT })).toBe(`Closed ${NOV_13}`);
    expect(historyValue({ answer: null, withdrawn_at: null, superseded_at: RELEASED_AT })).toBe('No answer');
  });

  test('Copy link while a live link exists; Close request on a change request with nothing held', () => {
    expect(canCopyLink(proof())).toBe(true);
    expect(canCopyLink(proof({ state: 'approved', answer: 'approved' }))).toBe(true);
    expect(canCopyLink(proof({ expired: true, state: 'expired' }))).toBe(false);
    expect(canCopyLink(proof({ state: 'withdrawn', withdrawn_at: RELEASED_AT }))).toBe(false);
    expect(canCopyLink(proof({ url: null }))).toBe(false);
    expect(canCopyLink(null)).toBe(false);
    const changes = proof({ state: 'changes', answer: 'changes' });
    expect(canCloseRequest(changes, { state: 'approved', held: false })).toBe(true);
    expect(canCloseRequest(changes, { state: 'held', held: true })).toBe(false);
    expect(canCloseRequest(proof(), { state: 'approved', held: false })).toBe(false);
    expect(canCloseRequest(proof({ state: 'withdrawn', answer: 'changes' }), { state: 'approved' })).toBe(false);
    expect(canCloseRequest(null, null)).toBe(false);
  });
});

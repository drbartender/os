// The Bar menu card's state, and the editor's banners and empty card, from a
// GET /proposals/:id/menu-draft payload plus the facts only the client knows
// (spec 2026-10-01 section 11.1: table C and its precedence, tables B and E;
// section 8, the derived print state). Pure.
//
// menuCardState({ payload, local }) -> {
//   id, chip: null | { kind, text }, message, sub, progress (0 to 100, or null),
//   primary, secondary: null | { id, label, style, editor? }, thumb (a draft to draw),
//   banners: [{ id, tone, title, text, buttons: [{ id, label, style, pieceKey? }] }],
//   empty: null | { id, title?, text?, button? }, approve: { label, disabled, why },
//   generate: { disabled, hint, need },
// }
// An action with `editor` ({ tab?, select? }) opens the editor; any other acts in place.
// local: { loading, loadError, saving, saveFailed, savedAt, conflict, approving,
//   approveError, tooLong: [data-mc-k keys], imageModel, activityKeys, now }.
// Table D: no removal date, no upload name or date, no client image filename and
// no "who marked no menu needed" is ever shown; the system does not store them.

const OPEN = new Set(['pending', 'working']);
const MODEL_NAME = { openai: 'GPT Image', gemini: 'Gemini' };
const FIELD_NAME = { theme: 'Theme & colors', naming: 'Drink naming', notes: 'Design notes' };
const ART_MAX = 8;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : []);
// new Date(null) is the epoch, not "no date".
const asDate = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function shortDate(v) {
  const d = asDate(v);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
}
const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

// "at 3:40 PM", or "tomorrow at 3:40 PM" (the rolling cap frees within 24 hours).
export function resumeTime(resetsAt, now = Date.now()) {
  const d = asDate(resetsAt);
  if (!d) return 'soon';
  return new Date(now).toDateString() === d.toDateString() ? `at ${clock(d)}` : `tomorrow at ${clock(d)}`;
}

// "just now", "5 min ago", "at 3:40 PM" today, "yesterday at 9:45 PM" within
// a day, then the date ("Oct 9").
export function savedAgo(savedAt, now = Date.now()) {
  const d = asDate(savedAt);
  if (!d) return '';
  const s = (now - d.getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) {
    const yesterday = new Date(now).toDateString() !== d.toDateString();
    return yesterday ? `yesterday at ${clock(d)}` : `at ${clock(d)}`;
  }
  return shortDate(d);
}

const andList = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

function readFacts(p) {
  const draft = isObj(p.draft) ? p.draft : null;
  const content = draft && isObj(draft.content) ? draft.content : {};
  const pieces = list(p.pieces).filter(isObj);
  const drinks = new Map(list(content.drinks).filter(isObj).map((d) => [d.key, d]));
  const wordsOpen = !!draft && OPEN.has(content.words_status);
  const wordsFailed = !!draft && !wordsOpen && content.words_status !== 'done';
  // A failed piece matters only when the layout uses it (Review Focus 3).
  const used = (pc) => pc.piece_key === 'background'
    || (drinks.has(pc.piece_key) && !drinks.get(pc.piece_key).hidden && drinks.get(pc.piece_key).has_art === true);
  const diff = isObj(p.diff) && !p.diff.dismissed && draft && !draft.read_only ? p.diff : null;
  const open = pieces.filter((pc) => OPEN.has(pc.status));
  const print = isObj(p.print) ? p.print : {};
  return {
    draft, pieces, drinks, wordsOpen, wordsFailed, open, print,
    hasDraft: !!draft && !wordsFailed,
    drafting: !!draft && (wordsOpen || open.length > 0),
    failed: wordsFailed ? [] : pieces.filter((pc) => pc.status === 'failed' && used(pc)),
    added: diff ? list(diff.added) : [],
    dropped: diff ? list(diff.dropped) : [],
    edited: diff ? list(diff.brief_edited) : [],
    imageChanged: !!(diff && diff.image_changed),
    plan: isObj(p.plan) ? p.plan : null,
    cap: isObj(p.cap) ? p.cap : null,
    configured: isObj(p.configured) ? p.configured : {},
    date: shortDate(print.approved_at),
  };
}

const pieceName = (f, key) => (key === 'background' ? 'The background' : (f.drinks.get(key) || {}).display_name || key);

// The pieces of the activity under way: the ones the hook saw open since it
// began (local.activityKeys), or every piece when it saw none.
function activity(f, L) {
  const seen = new Set(list(L.activityKeys));
  const scope = seen.size ? f.pieces.filter((pc) => seen.has(pc.piece_key) || OPEN.has(pc.status)) : f.pieces;
  const done = scope.filter((pc) => !OPEN.has(pc.status));
  const drinks = scope.filter((pc) => pc.piece_key !== 'background');
  return { n: scope.length, done: done.length, drinks: drinks.length, drinksDone: drinks.filter((pc) => !OPEN.has(pc.status)).length };
}

const S = (id, kind, text, message, sub = null, primary = null, secondary = null) => (
  { id, chip: kind ? { kind, text } : null, message, sub, primary, secondary });
const act = (id, label, style = 'primary') => ({ id, label, style });
const ed = (id, label, style = 'primary', editor = {}) => ({ id, label, style, editor });

function changeLines(f) {
  const all = [...f.added.map((d) => [d, 'added']), ...f.dropped.map((d) => [d, 'dropped'])];
  if (all.length !== 1) return { message: `${all.length} drinks changed on the plan.`, sub: 'Update the draft to match.' };
  const [d, how] = all[0];
  return how === 'added'
    ? { message: `${d.name} was added to the plan.`, sub: 'Update the draft to include it.' }
    : { message: `${d.name} was dropped from the plan.`, sub: 'Update the draft to remove it.' };
}

// Table C, the first state that applies.
function pickState(f, L) {
  if (L.approving) return S('approving', 'info', 'Approving', 'Saving the print file...');
  if (L.saveFailed) return S('save-failed', 'danger', 'Not saved', "Last change didn't save.", 'Edits are kept until you retry.', act('retry-save', 'Retry'));
  if (f.drafting) {
    const a = activity(f, L);
    const message = f.wordsOpen ? 'Writing the words...' : `Painting ${Math.min(a.done + 1, a.n)} of ${a.n}`;
    return { ...S('generating', 'info', 'Drafting', message, 'About 2 min. Keep working.', null, ed('watch', 'Watch', 'ghost')),
      progress: Math.round((100 * ((f.wordsOpen ? 0 : 1) + a.done)) / (1 + a.n)) };
  }
  if (f.wordsFailed) return S('words-failed', 'danger', 'Words failed', "Couldn't write the menu text.", 'No images were used.', act('retry-words', 'Retry'));
  if (f.failed.length) {
    const n = f.failed.length;
    const drink = f.failed.find((pc) => pc.piece_key !== 'background');
    const editor = drink ? { tab: 'drinks', select: drink.piece_key } : { tab: 'design' };
    return S('drawing-failed', 'danger', n === 1 ? '1 drawing failed' : `${n} drawings failed`,
      n === 1 ? `${pieceName(f, f.failed[0].piece_key)} didn't draw.` : `${n} drawings didn't come through.`,
      n === 1 ? 'Re-roll it in the editor.' : 'Re-roll them in the editor.', ed('fix', 'Fix', 'primary', editor));
  }
  if (f.added.length || f.dropped.length) {
    const { message, sub } = changeLines(f);
    return S('plan-changed', 'info', 'Plan changed', message, sub, act('update', 'Update draft'), act('dismiss', 'Dismiss', 'ghost'));
  }
  if (f.edited.length || f.imageChanged) {
    return S('notes-edited', 'info', 'Notes edited', f.edited.length ? 'Client edited their menu notes.' : 'The client image changed.',
      'Review before approving.', ed('review', 'Review', 'primary', { tab: 'brief' }));
  }
  const by = f.print.approved_by_name;
  switch (f.print.state) {
    case 'not_required':
      return S('no-menu', 'neutral', 'No menu needed', 'Marked no menu needed.',
        f.draft ? 'A draft exists; approving it posts a print file.' : null, null, act('undo', 'Undo', 'ghost'));
    case 'replaced':
      return S('replaced', 'neutral', 'Not in use', 'Print file is a manual upload.', "This draft isn't what staff print.", ed('view', 'View', 'secondary'));
    case 'removed':
      return S('removed', 'warn', 'No print file', 'Print file was removed.', 'Staff have nothing to print.', ed('review-approve', 'Review & approve'));
    case 'edited_since_approval':
      return S('edited', 'warn', 'Edited since approval', `Staff still get the ${f.date} version.`, 'Approve again to update it.', ed('review-approve', 'Review & approve'));
    case 'approved':
      return S('approved', 'ok', 'Approved', 'Print file ready for staff.', by ? `Approved ${f.date} by ${by}` : `Approved ${f.date}`, ed('view', 'View', 'secondary'));
    default:
  }
  if (f.draft) {
    // This visit's last save, else the draft's own last write.
    const ago = savedAgo(L.savedAt || f.draft.updated_at, L.now);
    return S('draft', 'warn', 'Draft', 'Ready to review.', L.saving ? 'Saving...' : ago ? `Saved ${ago}` : 'Saved', ed('view', 'View'));
  }
  if (!f.configured.openai) return S('not-set-up', 'neutral', 'Not set up', "Menu art isn't set up.", "The AI key isn't on the server yet.");
  if (!f.plan) return S('no-plan', 'neutral', 'No plan', 'No drink plan yet.', 'Menus are built from the drink plan.');
  if (!(Number(f.plan.drink_count) > 0)) return S('no-drinks', 'neutral', 'No drinks', 'Nothing to put on a menu yet.', 'Drafts are built from the drink plan.');
  const style = f.plan.menu_style;
  const message = style === 'house' ? 'The client chose the house menu.' : style === 'none' ? 'The client asked for no menu.' : 'Draft a custom 8×10 menu.';
  const sub = style === 'house' ? 'Draft a custom one anyway, or use the house menu below.' : "From the drink plan and the client's menu notes.";
  return S('never', 'neutral', 'Not started', message, sub,
    act('generate', 'Generate', style === 'house' || style === 'none' ? 'ghost' : 'primary'), ed('open-editor', 'Open editor', 'ghost'));
}

// States that sit above the print states say so when staff still print the approved file.
const STAFF_SUB = new Set(['save-failed', 'generating', 'words-failed', 'drawing-failed', 'plan-changed', 'notes-edited']);

function generateGate(f, L) {
  const drinks = f.plan ? Number(f.plan.drink_count) || 0 : 0;
  const need = 1 + Math.min(ART_MAX, drinks);
  const model = MODEL_NAME[L.imageModel] || MODEL_NAME.openai;
  const remaining = f.cap && Number.isFinite(f.cap.remaining) ? f.cap.remaining : null;
  const blocked = !f.configured.openai || drinks === 0 || !!(f.draft && f.draft.read_only);
  let disabled = blocked || f.drafting || !!L.approving;
  let hint;
  if (blocked) hint = 'Generate needs an AI key and drinks on the plan.';
  else if (remaining !== null && remaining <= 0) { hint = `Re-rolls resume ${resumeTime(f.cap.resets_at, L.now)}.`; disabled = true; }
  else if (remaining !== null && need > remaining) { hint = `Needs ${need} images; ${remaining} left in the last 24 hours.`; disabled = true; }
  else hint = f.draft ? `Re-drafts words and art from scratch, drawn by ${model}.` : `About 2 minutes, about ${need} images, drawn by ${model}.`;
  return { disabled, hint, need };
}

function approveGate(f, L, tooLong) {
  const st = f.print.state;
  const label = L.approving ? 'Approving...' : st === 'approved' ? 'Approved'
    : st === 'edited_since_approval' || st === 'removed' ? 'Approve again' : st === 'replaced' ? 'Use as print file' : 'Approve';
  const why = tooLong ? 'Shorten the long description first' : f.failed.length ? 'Fix the failed drawing first' : '';
  return { label, why, disabled: !f.hasDraft || f.drafting || !!L.approving || st === 'approved' || !!why };
}

// "<element> runs past the page": a data-mc-k key named the way the editor reads it.
function elementName(f, key) {
  const [head, k, field] = String(key).split('.');
  if (head === 'drinks') return `${pieceName(f, k)} ${field === 'display_name' ? 'name' : 'description'}`;
  if (head === 'headings') return 'A section heading';
  if (head === 'also_at_bar') return 'An "Also at the bar" line';
  return 'The title';
}

const btn = (id, label, style = 'secondary', extra = {}) => ({ id, label, style, ...extra });

// Table B, in its order; two or more stack.
function bannerList(f, L, tooLong) {
  const out = [];
  const B = (id, tone, title, text, buttons = []) => out.push({ id, tone, title, text, buttons });
  if (f.drafting && !f.wordsOpen) {
    const bg = f.pieces.find((pc) => pc.piece_key === 'background');
    const drink = f.open.find((pc) => pc.piece_key !== 'background');
    const a = activity(f, L);
    // One piece under way (a re-roll, or the one drink Update draft added): no counts.
    const one = a.n === 1 ? f.open[0] : null;
    if (one) {
      B('generating', 'info', one.piece_key === 'background' ? 'Painting the background...' : `Painting ${pieceName(f, one.piece_key)}...`,
        'One drawing under way. Text is editable now.');
    } else if (bg && OPEN.has(bg.status)) B('generating', 'info', 'Words are in.', 'Painting the background next.');
    else if (drink) B('generating', 'info', `Painting ${pieceName(f, drink.piece_key)}...`, `${a.drinksDone} of ${a.drinks} drinks done. Text is editable now.`);
  }
  if (f.failed.length === 1) {
    const pc = f.failed[0];
    const why = typeof pc.error === 'string' && pc.error.trim() ? `: ${pc.error.trim().replace(/\.+$/, '')}` : '';
    B('drawing-failed', 'danger', 'One drawing failed.',
      `${pieceName(f, pc.piece_key)} didn't draw${why}. ${pc.piece_key === 'background' ? 'Re-roll it.' : 'Re-roll it or hide it.'}`,
      [btn('reroll', 'Re-roll', 'secondary', { pieceKey: pc.piece_key })]);
  } else if (f.failed.length > 1) B('drawing-failed', 'danger', `${f.failed.length} drawings failed.`, 'Re-roll or hide the flagged drinks.');
  if (f.draft && f.cap && f.cap.remaining <= 0) {
    B('image-limit', 'warn', 'Daily image limit reached.',
      `${f.cap.used} of ${f.cap.limit} images used in the last 24 hours. Re-rolls resume ${resumeTime(f.cap.resets_at, L.now)}. Text, type and color still work.`);
  }
  if (f.draft && !f.configured.openai) B('drawing-off', 'neutral', 'Drawing is off.', "The AI key isn't on the server. Text, type, color and Approve still work.");
  if (f.added.length || f.dropped.length) {
    const lines = [...f.added.map((d) => `${d.name} was added.`), ...f.dropped.map((d) => `${d.name} was dropped.`)];
    B('plan-changed', 'info', 'Plan changed since this draft.', `${lines.join(' ')} Updating paints only the new drinks.`,
      [btn('dismiss', 'Dismiss', 'ghost'), btn('update', 'Update draft')]);
  }
  if (f.edited.length || f.imageChanged) {
    const fields = andList(f.edited.map((k) => FIELD_NAME[k] || k));
    B('notes-edited', 'info', f.edited.length ? 'Client edited their menu notes.' : 'The client image changed since this draft.',
      fields ? `${fields} changed. The draft hasn't been updated.` : "The draft hasn't been updated.", [btn('mark-reviewed', 'Mark reviewed')]);
  }
  if (L.saveFailed) B('save-failed', 'danger', "Last change didn't save.", 'Your edits are kept in this tab.', [btn('retry-save', 'Retry')]);
  if (L.conflict) B('save-conflict', 'warn', 'This draft changed elsewhere.', 'It was reloaded.');
  if (tooLong) B('too-long', 'danger', 'Text too long to fit.', `${elementName(f, L.tooLong[0])} runs past the page. Shorten it to approve.`);
  if (L.approveError) B('approve-rejected', 'danger', "Couldn't approve.", L.approveError);
  if (f.hasDraft) {
    const st = f.print.state;
    if (st === 'approved') B('approved', 'ok', `Approved ${f.date}.`, 'This is the print file staff download. Edits make a new draft until you approve again.', [btn('download', 'Download')]);
    if (st === 'edited_since_approval') B('edited', 'warn', 'Edited since approval.', `Staff still get the ${f.date} version until you approve again.`);
    if (st === 'replaced') B('replaced', 'neutral', 'Print file is a manual upload.', 'Approving replaces it with this draft.');
    if (st === 'removed') B('removed', 'warn', 'Print file was removed.', 'Staff have nothing to print. Approve to restore it.');
    if (st === 'not_required') B('no-menu', 'neutral', 'Marked no menu needed.', 'Approving still posts this menu and clears the mark.', [btn('undo', 'Undo')]);
  }
  if (f.draft && f.draft.read_only) B('no-plan', 'neutral', 'No drink plan on this event.', 'The draft is read-only.');
  return out;
}

// Table E: the editor's empty card in place of the canvas.
function emptyCard(f) {
  const E = (id, title, text, button = null) => ({ id, title, text, button });
  if (f.hasDraft) return null;
  if (f.wordsFailed) return E('words-failed', "Couldn't write the menu text", 'The words step failed, so no images were used. Try again.', btn('retry-words', 'Retry', 'primary'));
  if (f.print.state === 'not_required') return E('no-menu', 'No menu for this event', 'Undo to draft one.', btn('undo', 'Undo'));
  if (!f.configured.openai) return E('not-set-up', "Menu art isn't set up", "The AI key isn't on the server yet.");
  if (!f.plan) return E('no-plan', 'No drink plan on this event', 'Menus are built from the drink plan.');
  if (!(Number(f.plan.drink_count) > 0)) {
    return E('no-drinks', 'No drinks on the plan', 'Menus are built from the drink plan. Add drinks there, then come back.', btn('open-plan', 'Open drink plan'));
  }
  return E('never', 'No draft yet', 'Generate drafts the words in seconds, then paints the background and each drink. About 2 minutes.', btn('generate', 'Generate', 'primary'));
}

export default function menuCardState({ payload, local } = {}) {
  const L = isObj(local) ? local : {};
  const closed = { approve: { label: 'Approve', disabled: true, why: '' }, generate: { disabled: true, hint: '', need: 0 }, thumb: false, progress: null };
  if (!isObj(payload)) {
    if (!L.loadError) return { ...S('loading', null, null, null), ...closed, banners: [], empty: { id: 'loading' } };
    return { ...S('load-error', 'danger', 'Error', "Couldn't load the menu draft.", L.loadError, act('reload', 'Retry')), ...closed,
      banners: [{ id: 'load-error', tone: 'danger', title: "Couldn't load the menu.", text: L.loadError, buttons: [btn('reload', 'Retry')] }], empty: null };
  }
  const f = readFacts(payload);
  const tooLong = list(L.tooLong).length > 0;
  const state = { progress: null, ...pickState(f, L) };
  if (STAFF_SUB.has(state.id) && f.print.approved_file_in_use) state.sub = `Staff still get the ${f.date} version.`;
  // The vendored rule: with a draft, a ghost View joins whenever the row has room for it.
  if (f.hasDraft && !state.secondary && state.id !== 'approving' && (!state.primary || state.primary.id !== 'view')) {
    state.secondary = ed('view', 'View', 'ghost');
  }
  return {
    ...state, thumb: f.hasDraft, banners: bannerList(f, L, tooLong), empty: emptyCard(f),
    approve: approveGate(f, L, tooLong), generate: generateGate(f, L),
  };
}

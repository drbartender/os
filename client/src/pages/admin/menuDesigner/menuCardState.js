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
//   approveError, tooLong: [data-mc-k keys], imageModel, activityKeys, now,
//   heldInputs (the hook's pre-draft brief; the card and the editor pass it), referenceFile }.
// Table D: no removal date, no upload name or date and no client image filename
// is ever shown; the system does not store them. Who marked no menu needed is
// stored now (print.not_required_by, spec 2026-10-19 section 15), and only a
// planner mark is named: "The client chose Skip the Menu."
// local.conflict is true for a version conflict, or the server's own sentence
// when the autosave was refused for another reason (a 409 LEGAL_HOLD), which
// its banner shows in place of "This draft changed elsewhere.".
// A bar line renamed before bar picks were tracked (the diff's bar_unchecked)
// changes no state: the sub line of a draft at rest says it (uncheckedNotice,
// never "The bar picks changed since this draft."), a free secondary slot
// offers Update draft, and the editor gets the plan-changed banner's copy of
// the sentence or a banner of its own. A dismissal never covers it (spec
// 2026-10-19 section 17). The notice's own Update draft (the card's free slot,
// its own banner) carries scope 'bar', the bar-only rebuild, which applies no
// other change; the Plan changed one stays the full Update draft, and while a
// piece paints it waits on a draft holding such a line, since the notice that
// names the rebuild is hidden then (lane menu-bar-rebuild-only).
// layoutPieceKeys(content) is the client's copy of the server's one rule
// (server/routes/proposals/menuDraftShared.js; spec 2026-10-19 section 9.2): the
// pieces a printed draft uses, a custom draft's background and every visible
// drink with art, a house draft's background alone and none on a plain card
// (touch_key 'plain' or missing). A failed piece holds the card and Approve
// only when the layout uses it, and the house card owes its background by it.
// The look the page will post (spec 2026-10-19 section 9.1) is lookOf: the
// draft's stored inputs.look, else the held brief's chosen look, else what
// Generate decides (the house card for a Standard Menu client or one with no
// instructions; a display-only mirror of the server's decideLook, which the
// Brief tab shows too). Generate asks only for the keys that look uses (spec
// 9.2): with the GET's plan.house_plain, a plain house card needs no key and
// counts no image, one with touches needs the image model's key and counts
// one, and neither needs the words key, so Not set up does not show for a
// house look; a custom look is today's gate. The Not started card and the
// empty editor card describe the run that look will start, and a house draft
// (content.look house) is described as one: no words to write, no two-minute
// wait, an Update draft that paints nothing, and a Too long naming the card. A
// payload without house_plain
// (a server before the change) reads today's gate whatever the look. Before a
// draft the held brief and reference file are the page hook's, which the card
// and the editor both pass, so both read the look their Generate will post.
// The client review (spec 2026-10-19 sections 10.3 and 14; lane
// menu-approve-send) reads the GET's proof block (the draft's latest proof) and
// print.held. While a file is held, table C reads Client approved (the proof
// answered approved, its release refused before the blocker went), Client asked
// for changes (answered changes) or Waiting on the client (no answer), after
// Notes edited and before the print states, and the editor gets table B's
// matching banner; once the file is released, Released (the approved state)
// or Edited since approval wins, and a change request asked after it is
// closed from the fold (Close request, canCloseRequest). reviewValue is the
// Client review fold row's line and the Brief tab's latest one; historyValue
// an earlier proof's. Approve and send replaces Approve in the top bar with
// the same gate, held off while the no-menu mark is set or the admin's own
// upload is live (the server refuses Approve then). Released reads who released it (print.released_via); a payload
// without it keeps the Approved banner as it was.
// The set-up states read the read model's configured block by provider (spec
// 2026-10-19 section 16, lane menu-words-claude): Not set up and the empty
// card's not-set-up read configured.words (wordsReady), Drawing is off and
// Generate's gate the flag of the image model in use (imageReady: local's
// imageModel, else the server's default_image_model), never configured.openai
// on its own. A payload without words comes from a server before that change,
// whose words always went to OpenAI, so it reads the OpenAI key for them.

import { SENTENCES, BRIEF_FIX_TEXTS, isFixedSentence } from './menuArtSentences';

const OPEN = new Set(['pending', 'working']);
const MODEL_NAME = { openai: 'GPT Image', gemini: 'Gemini' };
const FIELD_NAME = { theme: 'Theme & colors', naming: 'Drink naming', notes: 'Design notes' };
const ART_MAX = 8;
export const BAR_LINE = 'The bar picks changed since this draft.';
const NOTES_LINE = 'Client edited their menu notes.';
// A planner mark's sub line (spec 2026-10-19 section 15).
const SKIP_MENU = 'The client chose Skip the Menu.';
// Draft ready's sub while the Inbox's menu_ready task is open (spec 14): the
// auto-start's run is current (draft.auto_started) and no proof has gone out.
const AUTO_STARTED = 'Drafted automatically when the client submitted their plan.';
// The client review's lines (spec 2026-10-19 section 14). The skipped email
// (notifications off, or an address sendEmail skips) reads as one that did not go out.
const EMAIL_TAIL = { no_address: ' · no email on file', failed: ' · email failed', suppressed: ' · email blocked', skipped: ' · email not sent' };
const DID_NOT_GO = "The email didn't go out. Copy the link and send it yourself.";
const EMAIL_SUB = {
  no_address: 'No email on file. Copy the link and send it yourself.',
  failed: DID_NOT_GO,
  skipped: DID_NOT_GO,
  suppressed: "The email was blocked: the client's address is marked as not working, or the event was archived before it went out. "
    + 'Copy the link and send it another way.',
};
const EXPIRED_SUB = 'The link expired. Approve again to send a fresh one.';
// A dated link ends at the Chicago midnight after the event day (proof.event_passed), when Approve refuses.
const expiredSub = (proof) => (proof.event_passed === true ? 'The link ended with the event day.' : EXPIRED_SUB);
// That link's client can no longer answer, so the card and the banner stop saying they might.
const linkEnded = (proof) => proof.expired === true && proof.event_passed === true;
const CLIENT_APPROVED_SUB = "It isn't with staff yet. Release it for printing.";
const STALE_SUB = 'The draft changed since. Approve again if it matters.';
const NOTE_CUT = 90;
const APPROVED_TEXT = 'This is the print file staff download. Edits make a new draft until you approve again.';
const BAR_SUB = 'refreshes the changed "Also at the bar" lines.';
// A house card prints bar sections, never "Also at the bar" lines.
const HOUSE_BAR_SUB = "refreshes the card's bar sections.";
// A bar line renamed before bar picks were tracked has no key, so nothing can
// say which category it stands for: the diff counts the stored lines left
// unkeyed as bar_unchecked, never bar_changed (spec 2026-10-19 section 17,
// lane menu-bar-renamed-lines). Its two sentences, for n such lines; the Brief
// tab prints them too. The Update draft it offers rebuilds only the bar lines
// (scope bar), so no dismissed change rides along to be named.
function uncheckedSentences(n) {
  const first = n === 1
    ? "A bar line renamed before bar picks were tracked can't be checked against them."
    : `${n} bar lines renamed before bar picks were tracked can't be checked against them.`;
  return [first, `Update draft rebuilds ${n === 1 ? 'it' : 'them'} from the client's picks.`];
}
// The notice's own Update draft: the bar-only rebuild (POST .../sync, scope bar).
const BAR_SCOPE = { scope: 'bar' };
// Two sentences side by side: one with no stop of its own gets a period.
const sentences = (a, b) => (a ? `${/[.!?]$/.test(a) ? a : `${a}.`} ${b}` : b);
// The states whose sub carries it: a draft at rest whose lines print. Busy or
// failed states keep their own; No menu needed and a manual upload print
// nothing from this draft.
const UNCHECKED_STATES = new Set(['plan-changed', 'notes-edited', 'removed', 'edited', 'approved', 'draft']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : []);
const HOUSE_PLAIN = 'plain';
const LOOKS = new Set(['house', 'custom']);
const blank = (v) => !(typeof v === 'string' && v.trim());

// The look the page will post (header): the chosen or stored one, else what Generate decides.
export function lookOf({ inputs, brief, plan, referenceFile } = {}) {
  const inp = isObj(inputs) ? inputs : {};
  if (LOOKS.has(inp.look)) return inp.look;
  if (isObj(plan) && plan.menu_style === 'house') return 'house';
  const b = isObj(brief) ? brief : {};
  const admin = isObj(inp.admin_brief) ? inp.admin_brief : {};
  const reference = !!referenceFile || (typeof inp.reference_source === 'string' && inp.reference_source !== 'none')
    || inp.planner_image_role === 'reference';
  const texts = [b.theme, b.naming, b.notes, admin.theme, admin.naming, admin.notes, inp.art_direction];
  return texts.every(blank) && !reference ? 'house' : 'custom';
}

// The pieces the printed layout uses (header); the server's rule, case for case.
export function layoutPieceKeys(content) {
  const c = isObj(content) ? content : {};
  if (c.look === 'house') {
    return typeof c.touch_key === 'string' && c.touch_key !== '' && c.touch_key !== HOUSE_PLAIN ? ['background'] : [];
  }
  const keys = new Set(['background']);
  for (const d of list(c.drinks)) {
    if (isObj(d) && d.hidden !== true && d.has_art === true && typeof d.key === 'string') keys.add(d.key);
  }
  return [...keys];
}

const IMAGE_MODELS = Object.keys(MODEL_NAME);
// The image model the server computed for the card and a new editor
// (configured.default_image_model), or 'openai' when it sent none.
export function defaultImageModel(configured) {
  const m = isObj(configured) ? configured.default_image_model : null;
  return IMAGE_MODELS.includes(m) ? m : 'openai';
}
// The words provider's key is on the server.
export function wordsReady(configured) {
  if (!isObj(configured)) return false;
  return typeof configured.words === 'boolean' ? configured.words : configured.openai === true;
}
// The key of this image model (the default when none is named) is on the server.
export function imageReady(configured, model) {
  const m = IMAGE_MODELS.includes(model) ? model : defaultImageModel(configured);
  return isObj(configured) && configured[m] === true;
}
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

// The Client review line (header) of the GET's proof block, or of none.
export function reviewValue(proof) {
  if (!isObj(proof)) return 'Not sent yet';
  if (proof.state === 'approved') return `Looks great, ${shortDate(proof.answered_at)}`;
  if (proof.state === 'changes') return `Changes requested ${shortDate(proof.answered_at)}`;
  if (proof.state === 'withdrawn') return `Closed ${shortDate(proof.withdrawn_at)}`;
  const tail = proof.expired === true ? ' · link expired' : EMAIL_TAIL[proof.email_status] || '';
  return `Sent ${shortDate(proof.sent_at)}${tail}`;
}

// An earlier proof's answer, for the Brief tab's history.
export function historyValue(entry) {
  const e = isObj(entry) ? entry : {};
  if (e.answer === 'approved') return `Looks great, ${shortDate(e.answered_at)}`;
  if (e.answer === 'changes') return `Changes requested ${shortDate(e.answered_at)}`;
  return e.withdrawn_at ? `Closed ${shortDate(e.withdrawn_at)}` : 'No answer';
}

// The link still opens a live page: not expired, not withdrawn.
export const canCopyLink = (proof) => isObj(proof) && typeof proof.url === 'string' && proof.url !== ''
  && proof.expired !== true && proof.state !== 'withdrawn';
// A change request with nothing held (released before the client asked): Close request (spec 10.3).
export const canCloseRequest = (proof, print) => isObj(proof) && proof.state === 'changes' && !(isObj(print) && print.held === true);

// The first NOTE_CUT characters of the client's note, then "..." when cut.
function noteExcerpt(note) {
  const chars = Array.from(typeof note === 'string' ? note.trim() : '');
  return chars.length > NOTE_CUT ? `${chars.slice(0, NOTE_CUT).join('').trimEnd()}...` : chars.join('');
}

// Who released the live file (table B), or '' when the payload does not say.
function releasedLine(print) {
  const day = shortDate(print.released_at || print.approved_at);
  if (print.released_via === 'client') return `The client said it looks great ${day}.`;
  if (print.released_via !== 'admin') return '';
  return print.released_by_name ? `Released ${day} by ${print.released_by_name}.` : `Released ${day}.`;
}

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

// The notice for a payload's draft, pieces and diff, or null: the ONE
// predicate the card, the banners and the Brief tab read. A dismissal never
// covers an unchecked line; a read-only draft, words not written or a piece
// painting say nothing.
export function uncheckedNotice({ draft, pieces, diff, readOnly = false } = {}) {
  if (!isObj(draft) || draft.read_only === true || readOnly === true || !isObj(diff)) return null;
  if (!isObj(draft.content) || draft.content.words_status !== 'done') return null;
  if (list(pieces).some((pc) => isObj(pc) && OPEN.has(pc.status))) return null;
  const count = Number(diff.bar_unchecked);
  if (!Number.isInteger(count) || count <= 0) return null;
  const [title, text] = uncheckedSentences(count);
  return { count, title, text, line: `${title} ${text}` };
}

// What this look's Generate uses (header): null for a custom look, or for a
// payload that does not say whether the house card is plain.
function houseGen(p, draft, L) {
  const plan = isObj(p.plan) ? p.plan : null;
  if (!plan || typeof plan.house_plain !== 'boolean') return null;
  const look = lookOf({
    inputs: draft ? draft.inputs : L.heldInputs, brief: p.brief, plan, referenceFile: L.referenceFile,
  });
  return look === 'house' ? { plain: plan.house_plain } : null;
}

function readFacts(p, L = {}) {
  const draft = isObj(p.draft) ? p.draft : null;
  const content = draft && isObj(draft.content) ? draft.content : {};
  const pieces = list(p.pieces).filter(isObj);
  const drinks = new Map(list(content.drinks).filter(isObj).map((d) => [d.key, d]));
  const wordsOpen = !!draft && OPEN.has(content.words_status);
  const wordsFailed = !!draft && !wordsOpen && content.words_status !== 'done';
  // A failed piece matters only when the layout uses it (Review Focus 3).
  const usedKeys = new Set(layoutPieceKeys(content));
  const used = (pc) => usedKeys.has(pc.piece_key);
  const diff = isObj(p.diff) && !p.diff.dismissed && draft && !draft.read_only ? p.diff : null;
  const open = pieces.filter((pc) => OPEN.has(pc.status));
  const print = isObj(p.print) ? p.print : {};
  const drafting = !!draft && (wordsOpen || open.length > 0);
  const notice = uncheckedNotice({ draft, pieces, diff: p.diff });
  return {
    draft, pieces, drinks, wordsOpen, wordsFailed, open, print, drafting,
    hasDraft: !!draft && !wordsFailed,
    failed: wordsFailed ? [] : pieces.filter((pc) => pc.status === 'failed' && used(pc)),
    added: diff ? list(diff.added) : [],
    dropped: diff ? list(diff.dropped) : [],
    edited: diff ? list(diff.brief_edited) : [],
    imageChanged: !!(diff && diff.image_changed),
    barChanged: !!(diff && diff.bar_changed === true),
    unchecked: notice ? notice.count : 0,
    notice,
    // The draft holds an unchecked line, whether or not the notice shows (it hides while a piece paints).
    uncheckedHeld: !!diff && Number(diff.bar_unchecked) > 0,
    plan: isObj(p.plan) ? p.plan : null,
    cap: isObj(p.cap) ? p.cap : null,
    configured: isObj(p.configured) ? p.configured : {},
    date: shortDate(print.approved_at),
    // The day of the file staff download: its release, or a v1 approval's own day.
    staffDate: shortDate(print.released_at || print.approved_at),
    house: houseGen(p, draft, L),
    // The draft the canvas draws as the house card (its content's look).
    houseDraft: !!draft && content.look === 'house',
    // The latest proof, and an approved file waiting on its release (spec 2026-10-19 section 10.3).
    proof: isObj(p.proof) ? p.proof : null,
    held: print.state === 'held',
  };
}

// The words key is set, or this look's Generate needs none.
const setUp = (f) => !!f.house || wordsReady(f.configured);

const pieceName = (f, key) => (key === 'background' ? 'The background' : (f.drinks.get(key) || {}).display_name || key);

// The job's own sentence, never provider text (spec 2026-10-19 section 16):
// a stored error shows only when it is one of the fixed sentences
// (menuArtSentences.js, the server's FIXED_TEXTS mirrored), else the generic
// line. wordsReason: the Words failed state's. pieceReason: the one failed
// piece that does not read "not attempted" speaks for the run only when its
// sentence is one that stops a run (an empty balance or a spend limit, which
// failed the rest unattempted); rows an earlier, cured stop left behind never
// lend their count to an unrelated failure. Alone, a piece shows any fixed
// sentence; two genuine failures keep the count.
const wordsReason = (f) => {
  const text = f.draft && isObj(f.draft.content) ? f.draft.content.words_error : null;
  return isFixedSentence(text) ? text : null;
};
const NOT_TRIED = /^not attempted\b/;
const RUN_STOPPING = new Set([SENTENCES.openaiOutOfCredit, SENTENCES.openaiLimit]);
function pieceReason(f) {
  const real = f.failed.filter((pc) => !(typeof pc.error === 'string' && NOT_TRIED.test(pc.error)));
  if (real.length !== 1 || !isFixedSentence(real[0].error)) return null;
  return f.failed.length === 1 || RUN_STOPPING.has(real[0].error) ? real[0].error : null;
}

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

// The Plan changed card: the drink lines, then the bar line when the bar
// picks changed too, then a notes edit or a new client image riding along
// (spec 2026-10-19 section 17), so a Dismiss never hides an edit the card did
// not show. The sub says what Update draft does: the drinks, and only the
// "Also at the bar" lines whose picks moved, or on a house draft its bar
// sections.
const briefLines = (f, image) => [...(f.edited.length ? [NOTES_LINE] : []), ...(f.imageChanged ? [image] : [])];

function changeLines(f) {
  const all = [...f.added.map((d) => [d, 'added']), ...f.dropped.map((d) => [d, 'dropped'])];
  const say = (first) => [first, ...briefLines(f, 'The client image changed.')].join(' ');
  const barSub = f.houseDraft ? HOUSE_BAR_SUB : BAR_SUB;
  if (!all.length) return { message: say(BAR_LINE), sub: `Update draft ${barSub}` };
  const withBar = (line) => say(f.barChanged ? `${line} ${BAR_LINE}` : line);
  if (all.length !== 1) {
    return { message: withBar(`${all.length} drinks changed on the plan.`),
      sub: f.barChanged ? `Update draft updates the drinks and ${barSub}` : 'Update the draft to match.' };
  }
  const [d, how] = all[0];
  if (how === 'added') {
    return { message: withBar(`${d.name} was added to the plan.`),
      sub: f.barChanged ? `Update draft adds the drink and ${barSub}` : 'Update the draft to include it.' };
  }
  return { message: withBar(`${d.name} was dropped from the plan.`),
    sub: f.barChanged ? `Update draft removes the drink and ${barSub}` : 'Update the draft to remove it.' };
}

// A held file whose latest proof the client already approved (its release was
// refused, then the blocker went away): the answer is in, so never "waiting".
const clientApproved = (proof) => [`The client said it looks great ${shortDate(proof.answered_at)}.`, CLIENT_APPROVED_SUB];

// Table C's client states (spec 2026-10-19 section 14), while the file is held.
function reviewState(f) {
  const proof = f.proof || {};
  const sent = shortDate(proof.sent_at);
  const release = act('release', 'Release for printing', 'secondary');
  if (proof.state === 'approved') {
    const [message, sub] = clientApproved(proof);
    return S('client-approved', 'info', 'Client approved', message, sub, { ...release, style: 'primary' });
  }
  if (proof.state === 'changes') {
    const stale = proof.stale === true ? `They saw the version sent ${sent}; the draft changed since.` : '';
    return S('changes', 'warn', 'Changes requested', 'The client asked for changes.', [noteExcerpt(proof.answer_note), stale].filter(Boolean).join(' ') || null,
      ed('read-notes', 'Read notes', 'primary', { tab: 'brief' }), { ...release, style: 'ghost' });
  }
  const sub = proof.expired === true ? expiredSub(proof) : EMAIL_SUB[proof.email_status] || (proof.stale === true ? STALE_SUB : null);
  const message = linkEnded(proof) ? `Sent to the client ${sent}.` : `Sent to the client ${sent}. Staff can print once they say it looks great.`;
  return S('waiting', 'info', 'Waiting on client', message, sub,
    release, canCopyLink(proof) ? act('copy-link', 'Copy link', 'ghost') : null);
}

// Table C, the first state that applies.
function pickState(f, L) {
  if (L.approving) return S('approving', 'info', 'Approving', 'Saving the print file...');
  if (L.saveFailed) return S('save-failed', 'danger', 'Not saved', "Last change didn't save.", 'Edits are kept until you retry.', act('retry-save', 'Retry'));
  if (f.drafting) {
    const a = activity(f, L);
    // A house run writes no words and draws one background at most: seconds, not minutes.
    const words = f.houseDraft ? 'Drafting the house card...' : 'Writing the words...';
    const message = f.wordsOpen ? words : `Painting ${Math.min(a.done + 1, a.n)} of ${a.n}`;
    const sub = f.houseDraft ? 'Keep working.' : 'About 2 min. Keep working.';
    return { ...S('generating', 'info', 'Drafting', message, sub, null, ed('watch', 'Watch', 'ghost')),
      progress: Math.round((100 * ((f.wordsOpen ? 0 : 1) + a.done)) / (1 + a.n)) };
  }
  if (f.wordsFailed) {
    // A refusal or an invalid reply repeats unless the brief changes, so the Brief tab is offered too.
    const reason = wordsReason(f);
    return S('words-failed', 'danger', 'Words failed', "Couldn't write the menu text.", reason || 'No images were used.', act('retry-words', 'Generate again'),
      BRIEF_FIX_TEXTS.includes(reason) ? ed('edit-brief', 'Edit the brief', 'ghost', { tab: 'brief' }) : null);
  }
  if (f.failed.length) {
    const n = f.failed.length;
    const drink = f.failed.find((pc) => pc.piece_key !== 'background');
    const editor = drink ? { tab: 'drinks', select: drink.piece_key } : { tab: 'design' };
    return S('drawing-failed', 'danger', n === 1 ? '1 drawing failed' : `${n} drawings failed`,
      n === 1 ? `${pieceName(f, f.failed[0].piece_key)} didn't draw.` : `${n} drawings didn't come through.`,
      pieceReason(f) || (n === 1 ? 'Re-roll it in the editor.' : 'Re-roll them in the editor.'), ed('fix', 'Fix', 'primary', editor));
  }
  if (f.added.length || f.dropped.length || f.barChanged) {
    const { message, sub } = changeLines(f);
    return S('plan-changed', 'info', 'Plan changed', message, sub, act('update', 'Update draft'), act('dismiss', 'Dismiss', 'ghost'));
  }
  if (f.edited.length || f.imageChanged) {
    return S('notes-edited', 'info', 'Notes edited', f.edited.length ? 'Client edited their menu notes.' : 'The client image changed.',
      'Review before approving.', ed('review', 'Review', 'primary', { tab: 'brief' }));
  }
  if (f.held) return reviewState(f);
  switch (f.print.state) {
    case 'not_required': {
      // Approve refuses while the mark is set (menuDraftApprove.js MENU_MARKED_NONE).
      const draftNote = f.draft ? 'A draft exists; undo the mark to approve and send it.' : null;
      const sub = f.print.not_required_by === 'planner' ? (draftNote ? `${SKIP_MENU} ${draftNote}` : SKIP_MENU) : draftNote;
      return S('no-menu', 'neutral', 'No menu needed', 'Marked no menu needed.', sub, null, act('undo', 'Undo', 'ghost'));
    }
    case 'replaced':
      return S('replaced', 'neutral', 'Not in use', 'Print file is a manual upload.', "This draft isn't what staff print.", ed('view', 'View', 'secondary'));
    case 'removed':
      // Put it back for staff re-posts the menu's own removed file (spec 10.3, print.restorable).
      return S('removed', 'warn', 'No print file', 'Print file was removed.', 'Staff have nothing to print.', ed('review-approve', 'Review & approve'),
        f.print.restorable === true ? act('put-back', 'Put it back for staff', 'secondary') : null);
    case 'edited_since_approval':
      return S('edited', 'warn', 'Edited since approval', `Staff still get the ${f.staffDate} version.`, 'Approve again to update it.', ed('review-approve', 'Review & approve'));
    case 'approved': {
      // Released (spec 2026-10-19 section 14): by the client's Looks great, or by the admin (a v1 approval reads as his).
      const day = shortDate(f.print.released_at || f.print.approved_at);
      const sub = f.print.released_via === 'client' ? `The client said it looks great ${day}.` : `You released it ${day}.`;
      return S('approved', 'ok', 'Approved', 'Approved for print. Staff can download it.', sub, ed('view', 'View', 'secondary'), act('download', 'Download', 'ghost'));
    }
    default:
  }
  if (f.draft) {
    // This visit's last save, else the draft's own last write.
    const ago = savedAgo(L.savedAt || f.draft.updated_at, L.now);
    const auto = f.draft.auto_started === true && !f.proof;
    return S('draft', 'warn', 'Draft', 'Ready to review.', L.saving ? 'Saving...' : auto ? AUTO_STARTED : ago ? `Saved ${ago}` : 'Saved', ed('view', 'View'));
  }
  if (!setUp(f)) return S('not-set-up', 'neutral', 'Not set up', "Menu art isn't set up.", "The AI key isn't on the server yet.");
  if (!f.plan) return S('no-plan', 'neutral', 'No plan', 'No drink plan yet.', 'Menus are built from the drink plan.');
  if (!(Number(f.plan.drink_count) > 0)) return S('no-drinks', 'neutral', 'No drinks', 'Nothing to put on a menu yet.', 'Drafts are built from the drink plan.');
  const style = f.plan.menu_style;
  const message = style === 'house' ? 'The client chose the house menu.' : style === 'none' ? 'The client asked for no menu.'
    : f.house ? 'Draft the house card.' : 'Draft a custom 8×10 menu.';
  // The look Generate will post (f.house: lookOf reads house) decides the sub.
  const sub = f.house ? 'Generate drafts our house card. For a custom design, switch the look in the editor.'
    : style === 'house' ? 'Draft a custom one anyway, or use the house menu below.' : "From the drink plan and the client's menu notes.";
  return S('never', 'neutral', 'Not started', message, sub,
    act('generate', 'Generate', style === 'house' || style === 'none' ? 'ghost' : 'primary'), ed('open-editor', 'Open editor', 'ghost'));
}

// States that sit above the print states say so when staff still print the approved file.
const STAFF_SUB = new Set(['save-failed', 'generating', 'words-failed', 'drawing-failed', 'plan-changed', 'notes-edited']);

// The hint of a gate that is open: what Generate makes, and with which model.
function openHint(f, need, model) {
  if (f.house && f.house.plain) return f.draft ? 'Re-drafts the plain house card. No images.' : 'The plain house card. No images.';
  if (f.house) return f.draft ? `Re-drafts the house card and its background, drawn by ${model}.` : `About a minute, 1 image, drawn by ${model}.`;
  return f.draft ? `Re-drafts words and art from scratch, drawn by ${model}.` : `About 2 minutes, about ${need} images, drawn by ${model}.`;
}

function generateGate(f, L) {
  const drinks = f.plan ? Number(f.plan.drink_count) || 0 : 0;
  // A house card draws its background alone, and nothing when plain (spec 9.2).
  const need = f.house ? (f.house.plain ? 0 : 1) : 1 + Math.min(ART_MAX, drinks);
  const imageModel = IMAGE_MODELS.includes(L.imageModel) ? L.imageModel : defaultImageModel(f.configured);
  const model = MODEL_NAME[imageModel];
  const remaining = f.cap && Number.isFinite(f.cap.remaining) ? f.cap.remaining : null;
  const ready = f.house ? (f.house.plain || imageReady(f.configured, imageModel))
    : wordsReady(f.configured) && imageReady(f.configured, imageModel);
  const blocked = !ready || drinks === 0 || !!(f.draft && f.draft.read_only);
  let disabled = blocked || f.drafting || !!L.approving;
  let hint;
  if (blocked) hint = 'Generate needs an AI key and drinks on the plan.';
  else if (need > 0 && remaining !== null && remaining <= 0) { hint = `Re-rolls resume ${resumeTime(f.cap.resets_at, L.now)}.`; disabled = true; }
  else if (remaining !== null && need > remaining) { hint = `Needs ${need} images; ${remaining} left in the last 24 hours.`; disabled = true; }
  else hint = openHint(f, need, model);
  return { disabled, hint, need };
}

// Approve and send (spec 2026-10-19 section 10.5): the same gate, its one label,
// and the no-menu mark or the admin's own upload holds it, since the server
// refuses Approve while either stands (a Looks great beside an upload could never release).
function approveGate(f, L, tooLong) {
  const st = f.print.state;
  const label = L.approving ? 'Approving...' : st === 'approved' ? 'Approved' : 'Approve and send';
  const long = f.houseDraft ? 'Make the card fit first' : 'Shorten the long description first';
  const held = st === 'not_required' ? 'Undo the mark first' : st === 'replaced' ? 'Remove your uploaded file first' : '';
  const why = tooLong ? long : f.failed.length ? 'Fix the failed drawing first' : f.hasDraft ? held : '';
  return { label, why, disabled: !f.hasDraft || f.drafting || !!L.approving || st === 'approved' || !!why };
}

// The house card lists names only beside fixed bar sections, so its Too long
// names the card and the remedies (spec 2026-10-19 section 23), never one text.
const HOUSE_LONG = 'The house card runs past the page. Hide a drink or shorten a name, or switch the look to Custom design on the Brief tab.';

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
    // The piece's name, then its fixed sentence; any other stored text is
    // never printed. The background cannot be hidden, so it is only re-rolled.
    const how = isFixedSentence(pc.error) ? pc.error : pc.piece_key === 'background' ? 'Re-roll it.' : 'Re-roll it or hide it.';
    B('drawing-failed', 'danger', 'One drawing failed.', `${pieceName(f, pc.piece_key)} didn't draw. ${how}`,
      [btn('reroll', 'Re-roll', 'secondary', { pieceKey: pc.piece_key })]);
  } else if (f.failed.length > 1) {
    B('drawing-failed', 'danger', `${f.failed.length} drawings failed.`, pieceReason(f) || 'Re-roll or hide the flagged drinks.');
  }
  if (f.draft && f.cap && f.cap.remaining <= 0) {
    B('image-limit', 'warn', 'Daily image limit reached.',
      `${f.cap.used} of ${f.cap.limit} images used in the last 24 hours. Re-rolls resume ${resumeTime(f.cap.resets_at, L.now)}. Text, type and color still work.`);
  }
  if (f.draft && !imageReady(f.configured, L.imageModel)) B('drawing-off', 'neutral', 'Drawing is off.', "The AI key isn't on the server. Text, type, color and Approve still work.");
  if (f.added.length || f.dropped.length || f.barChanged) {
    const drinks = [...f.added.map((d) => `${d.name} was added.`), ...f.dropped.map((d) => `${d.name} was dropped.`)];
    // Update draft rebuilds an unchecked line too; while a piece paints the
    // notice saying so is hidden, so on such a draft the button waits, and the
    // text says when it returns instead of describing it.
    const waits = f.uncheckedHeld && f.open.length > 0;
    // A house Update draft paints nothing: an added drink joins by its name.
    const houseTail = f.added.length ? [`Updating adds ${f.added.length === 1 ? 'it' : 'them'} to the card. No images.`] : [];
    const tail = waits ? ['Update draft returns when the drawing finishes.']
      : f.houseDraft ? houseTail : drinks.length ? ['Updating paints only the new drinks.'] : [];
    const lines = [...drinks, ...(f.barChanged ? [BAR_LINE] : []), ...briefLines(f, 'The client image changed since this draft.'),
      ...(f.notice ? [f.notice.line] : []), ...tail];
    B('plan-changed', 'info', 'Plan changed since this draft.', lines.join(' '),
      [btn('dismiss', 'Dismiss', 'ghost'), ...(waits ? [] : [btn('update', 'Update draft')])]);
  } else if (f.notice) {
    // Its own banner, with the bar-only Update draft it names; no Dismiss, which could not cover it.
    B('bar-unchecked', 'info', f.notice.title, f.notice.text, [btn('update', 'Update draft', 'secondary', BAR_SCOPE)]);
  }
  if (f.edited.length || f.imageChanged) {
    const fields = andList(f.edited.map((k) => FIELD_NAME[k] || k));
    B('notes-edited', 'info', f.edited.length ? 'Client edited their menu notes.' : 'The client image changed since this draft.',
      fields ? `${fields} changed. The draft hasn't been updated.` : "The draft hasn't been updated.", [btn('mark-reviewed', 'Mark reviewed')]);
  }
  if (f.held && f.hasDraft) {
    // Table B's client review banners (spec 2026-10-19 section 14).
    const proof = f.proof || {};
    const sent = shortDate(proof.sent_at);
    if (proof.state === 'approved') {
      const [title, text] = clientApproved(proof);
      B('client-approved', 'info', title, text, [btn('release', 'Release for printing')]);
    } else if (proof.state === 'changes') {
      const note = typeof proof.answer_note === 'string' ? proof.answer_note.trim() : '';
      B('client-changes', 'warn', 'The client asked for changes.', [note, proof.stale === true ? `They saw the version sent ${sent}.` : ''].filter(Boolean).join(' '));
    } else {
      // An email that never reached the client says so, as on the card, with the link to copy beside it.
      const unsent = proof.expired === true ? expiredSub(proof) : EMAIL_SUB[proof.email_status] || '';
      const copy = EMAIL_SUB[proof.email_status] && canCopyLink(proof) ? [btn('copy-link', 'Copy link', 'ghost')] : [];
      const waiting = linkEnded(proof) ? '' : "Waiting on the client's answer. Edits here don't change what they see.";
      B('client-waiting', 'info', `Proof sent ${sent}.`, [waiting, unsent].filter(Boolean).join(' '),
        [...copy, btn('release', 'Release for printing')]);
    }
  }
  if (L.saveFailed) B('save-failed', 'danger', "Last change didn't save.", 'Your edits are kept in this tab.', [btn('retry-save', 'Retry')]);
  if (typeof L.conflict === 'string') B('save-refused', 'danger', "Last change didn't save.", L.conflict);
  else if (L.conflict) B('save-conflict', 'warn', 'This draft changed elsewhere.', 'It was reloaded.');
  if (tooLong) B('too-long', 'danger', 'Text too long to fit.', f.houseDraft ? HOUSE_LONG : `${elementName(f, L.tooLong[0])} runs past the page. Shorten it to approve.`);
  if (L.approveError) B('approve-rejected', 'danger', "Couldn't approve.", L.approveError);
  if (f.hasDraft) {
    const st = f.print.state;
    if (st === 'approved') {
      const who = releasedLine(f.print);
      B('approved', 'ok', `Approved ${f.date}.`, who ? `${APPROVED_TEXT} ${who}` : APPROVED_TEXT, [btn('download', 'Download')]);
    }
    if (st === 'edited_since_approval') B('edited', 'warn', 'Edited since approval.', `Staff still get the ${f.staffDate} version until you approve again.`);
    // A held file is never released over an upload (spec 10.3, guard 4), so staff keep it until it goes.
    if (st === 'replaced') B('replaced', 'neutral', 'Print file is a manual upload.', 'Staff print the upload until you remove it.');
    if (st === 'removed') {
      if (f.print.restorable === true) B('removed', 'warn', 'Print file was removed.', 'Staff have nothing to print.', [btn('put-back', 'Put it back for staff')]);
      else B('removed', 'warn', 'Print file was removed.', 'Staff have nothing to print. Approve to restore it.');
    }
    if (st === 'not_required') B('no-menu', 'neutral', 'Marked no menu needed.', 'Undo the mark to approve and send this menu.', [btn('undo', 'Undo')]);
  }
  if (f.draft && f.draft.read_only) B('no-plan', 'neutral', 'No drink plan on this event.', 'The draft is read-only.');
  return out;
}

// Table E: the editor's empty card in place of the canvas.
function emptyCard(f) {
  const E = (id, title, text, button = null) => ({ id, title, text, button });
  if (f.hasDraft) return null;
  if (f.wordsFailed) {
    return E('words-failed', "Couldn't write the menu text", wordsReason(f) || 'The words step failed, so no images were used. Try again.',
      btn('retry-words', 'Generate again', 'primary'));
  }
  if (f.print.state === 'not_required') return E('no-menu', 'No menu for this event', 'Undo to draft one.', btn('undo', 'Undo'));
  if (!setUp(f)) return E('not-set-up', "Menu art isn't set up", "The AI key isn't on the server yet.");
  if (!f.plan) return E('no-plan', 'No drink plan on this event', 'Menus are built from the drink plan.');
  if (!(Number(f.plan.drink_count) > 0)) {
    return E('no-drinks', 'No drinks on the plan', 'Menus are built from the drink plan. Add drinks there, then come back.', btn('open-plan', 'Open drink plan'));
  }
  const text = !f.house ? 'Generate drafts the words in seconds, then paints the background and each drink. About 2 minutes.'
    : f.house.plain ? 'Generate drafts the house card from the drink plan in seconds. No images.'
      : 'Generate drafts the house card from the drink plan, then draws its background. About a minute.';
  return E('never', 'No draft yet', text, btn('generate', 'Generate', 'primary'));
}

export default function menuCardState({ payload, local } = {}) {
  const L = isObj(local) ? local : {};
  const closed = { approve: { label: 'Approve and send', disabled: true, why: '' }, generate: { disabled: true, hint: '', need: 0 }, thumb: false, progress: null };
  if (!isObj(payload)) {
    if (!L.loadError) return { ...S('loading', null, null, null), ...closed, banners: [], empty: { id: 'loading' } };
    return { ...S('load-error', 'danger', 'Error', "Couldn't load the menu draft.", L.loadError, act('reload', 'Retry')), ...closed,
      banners: [{ id: 'load-error', tone: 'danger', title: "Couldn't load the menu.", text: L.loadError, buttons: [btn('reload', 'Retry')] }], empty: null };
  }
  const f = readFacts(payload, L);
  const tooLong = list(L.tooLong).length > 0;
  const state = { progress: null, ...pickState(f, L) };
  if (STAFF_SUB.has(state.id) && f.print.approved_file_in_use) {
    // A failure keeps its fixed reason ahead of the staff line (spec 2026-10-19 section 16).
    const reason = state.id === 'words-failed' ? wordsReason(f) : state.id === 'drawing-failed' ? pieceReason(f) : null;
    state.sub = sentences(reason, `Staff still get the ${f.staffDate} version.`);
  }
  // An unchecked bar line changes no state; the muted sub says it after its own
  // words, and a state with no Update draft of its own offers the bar-only one
  // in a free slot, since that is what the sentence names (the full sync
  // rebuilds an unchecked line too, whatever else it applies).
  if (f.unchecked && UNCHECKED_STATES.has(state.id)) {
    state.sub = sentences(state.sub, f.notice.line);
    const offersUpdate = [state.primary, state.secondary].some((a) => a && a.id === 'update');
    // Released's ghost Download gives way: the fold's Print file row downloads too.
    const free = !state.secondary || state.secondary.id === 'download';
    if (!offersUpdate && free) state.secondary = { ...act('update', 'Update draft', 'ghost'), ...BAR_SCOPE };
  }
  // The vendored rule: with a draft, a ghost View joins whenever the row has room for it.
  if (f.hasDraft && !state.secondary && state.id !== 'approving' && (!state.primary || state.primary.id !== 'view')) {
    state.secondary = ed('view', 'View', 'ghost');
  }
  return {
    ...state, thumb: f.hasDraft, banners: bannerList(f, L, tooLong), empty: emptyCard(f),
    approve: approveGate(f, L, tooLong), generate: generateGate(f, L),
  };
}

// The editor's edits to a draft's content (spec 2026-10-01 sections 4.5 and
// 7.1). Pure. The limits mirror server/utils/menuDraftValidation.js exactly;
// the server is the judge, so these only keep the editor from sending what it
// would refuse.
//
// textLimit(k)              -> { min, max } for a canvas text key (data-mc-k)
// cleanText(raw)            -> the text as it is saved: runs of space collapsed, trimmed
// textPatch(content, k, raw) -> the content patch that saves raw at key k, or
//                              null when it is unchanged or out of its limits.
//                              A drink's name or description also drops its AI flag.
// drinkCounts(drinks)       -> { visible, art, noArt } over the visible drinks
// toggleHidden(content, key) -> { patch, why }: Hide, or Show within the limits
//                              (a drink shown while 8 have art lists as text;
//                              past 12 visible or 4 without art, why says so)

export const TEXT_LIMITS = Object.freeze({
  title: { min: 1, max: 60 },
  heading: { min: 1, max: 40 },
  display_name: { min: 1, max: 60 },
  description: { min: 0, max: 200 },
  label: { min: 1, max: 30 },
  text: { min: 0, max: 120 },
});
export const ART_DIRECTION_MAX = 500;
export const REROLL_NOTE_MAX = 200;
export const MAX_ART = 8;
export const MAX_VISIBLE = 12;
export const MAX_NO_ART = 4;
export const HEADING_KEYS = Object.freeze(['sig', 'mock', 'more', 'also']);
export const DEFAULT_HEADINGS = Object.freeze({
  sig: 'Signature Cocktails', mock: 'Mocktails', more: 'More from the bar', also: 'Also at the bar',
});

const AI_FLAG = { display_name: 'name_ai_suggested', description: 'description_ai_written' };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : '');

// Keys: title, headings.<k>, drinks.<drink key>.<field>, also_at_bar.<i>.<field>.
// A drink key holds a colon but never a dot (the server's pieceKey pattern).
function parseKey(k) {
  const parts = String(k).split('.');
  if (parts[0] === 'title') return { kind: 'title', limit: TEXT_LIMITS.title };
  if (parts[0] === 'headings') return { kind: 'heading', name: parts[1], limit: TEXT_LIMITS.heading };
  if (parts[0] === 'drinks') return { kind: 'drink', key: parts[1], field: parts[2], limit: TEXT_LIMITS[parts[2]] };
  if (parts[0] === 'also_at_bar') return { kind: 'also', index: Number(parts[1]), field: parts[2], limit: TEXT_LIMITS[parts[2]] };
  return { kind: null, limit: null };
}

export function textLimit(k) {
  return parseKey(k).limit || TEXT_LIMITS.text;
}

export function cleanText(raw) {
  return str(raw).replace(/\s+/g, ' ').trim();
}

const headingsOf = (c) => Object.fromEntries(HEADING_KEYS.map((h) => [h, str(isObj(c.headings) ? c.headings[h] : '') || DEFAULT_HEADINGS[h]]));

// The text stored at key k and how to send a new one, or null when k names nothing.
function target(c, p) {
  if (p.kind === 'title') return { stored: str(c.title), patch: (v) => ({ title: v }) };
  if (p.kind === 'heading') {
    if (!HEADING_KEYS.includes(p.name)) return null;
    const headings = headingsOf(c);
    return { stored: headings[p.name], patch: (v) => ({ headings: { ...headings, [p.name]: v } }) };
  }
  if (p.kind === 'drink') {
    const drinks = list(c.drinks);
    const d = drinks.find((x) => isObj(x) && x.key === p.key);
    if (!d || !AI_FLAG[p.field]) return null;
    return {
      stored: str(d[p.field]),
      patch: (v) => ({ drinks: drinks.map((x) => (x === d ? { ...x, [p.field]: v, [AI_FLAG[p.field]]: false } : x)) }),
    };
  }
  // Also at the bar: the lines are fixed, and each is sent as its label and text only.
  const lines = list(c.also_at_bar);
  if (!isObj(lines[p.index]) || (p.field !== 'label' && p.field !== 'text')) return null;
  return {
    stored: str(lines[p.index][p.field]),
    patch: (v) => ({
      also_at_bar: lines.map((a, i) => {
        const next = { label: str(isObj(a) ? a.label : ''), text: str(isObj(a) ? a.text : '') };
        return i === p.index ? { ...next, [p.field]: v } : next;
      }),
    }),
  };
}

export function textPatch(content, k, raw) {
  const p = parseKey(k);
  if (!p.kind || !p.limit) return null;
  const t = target(isObj(content) ? content : {}, p);
  if (!t) return null;
  const value = cleanText(raw);
  // Compared as saved on both sides: clicking into a stored text that holds a
  // newline or a double space and out again is no edit, and sends nothing (an
  // approved menu stays approved).
  if (value === cleanText(t.stored)) return null;
  if (value.length < p.limit.min || value.length > p.limit.max) return null;
  return t.patch(value);
}

export function drinkCounts(drinks) {
  const visible = list(drinks).filter((d) => isObj(d) && d.hidden !== true);
  const art = visible.filter((d) => d.has_art === true).length;
  return { visible: visible.length, art, noArt: visible.length - art };
}

export function toggleHidden(content, key) {
  const drinks = list(isObj(content) ? content.drinks : null);
  const d = drinks.find((x) => isObj(x) && x.key === key);
  if (!d) return { patch: null, why: '' };
  const swap = (next) => ({ patch: { drinks: drinks.map((x) => (x === d ? next : x)) }, why: '' });
  if (d.hidden !== true) return swap({ ...d, hidden: true });
  const now = drinkCounts(drinks);
  if (now.visible + 1 > MAX_VISIBLE) return { patch: null, why: 'At most 12 drinks can show on the menu. Hide another first.' };
  let next = { ...d, hidden: false };
  if (next.has_art === true && now.art + 1 > MAX_ART) next = { ...next, has_art: false };
  if (next.has_art !== true && now.noArt + 1 > MAX_NO_ART) {
    return { patch: null, why: 'At most 4 drinks can list without art. Hide another first.' };
  }
  return swap(next);
}

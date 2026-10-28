// Exports EditCtx, Text, Heading, DrinkText, Slot, tooLongKeys, useCanvasEdit, clearOnClick. Header
// generated from the file's exports by migrate-headers on 2026-10-27; replace with what it does.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { artGeometry } from './layouts';
import { textLimit, textPatch, toggleHidden, cleanText } from './menuEdits';

// MenuCanvas's text, headings and drink slots, and the editor's on-canvas
// editing (spec 2026-10-01 section 11.1, On-canvas editing). Without
// an EditCtx value (the card thumbnail, the export) every part renders exactly
// the read-only markup MenuCanvas always had. With one (MenuCanvas editable,
// once the words land):
// - text is contenteditable, commits on blur or Enter through textPatch (one
//   content patch into autosave), and is held to its 7.1 limit as it is typed
//   (a stored text already past it may only shrink, and says so); AI-written
//   text carries the dotted underline until edited, and the texts tooLongKeys
//   flags carry the Too long outline;
// - clicking a drink's art selects it (again clears it): the slot is outlined
//   and two pills show above the art, Re-roll art (absent when no image
//   remains or while it draws) and Hide; a failed slot gains its Re-roll.
// These draw over the menu, never on the export.

export const EditCtx = createContext(null);

const STATUS = { working: ['mc-run', 'Painting...'], pending: ['mc-wait', 'Waiting'], failed: ['mc-bad', "Couldn't draw this one"] };
const OPEN = new Set(['pending', 'working']);
const text = (v) => (typeof v === 'string' ? v : '');

function labelFor(k) {
  const [head, , field] = String(k).split('.');
  if (head === 'title') return 'Menu title';
  if (head === 'headings') return 'Section heading';
  if (head === 'drinks') return field === 'display_name' ? 'Drink name' : 'Drink description';
  return field === 'label' ? 'Also at the bar label' : 'Also at the bar line';
}

function caretToEnd(el) {
  const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
  if (!sel || typeof document.createRange !== 'function') return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

// An edit past its 7.1 limit says so (it cannot be saved until it is
// shortened); its outline is the mc-over class Text renders from EditCtx.
function markOver(el, max, over) {
  const n = cleanText(el.textContent).length;
  if (over) {
    el.setAttribute('title', `${max} characters at most, ${n} now. Shorten it to save.`);
    el.setAttribute('aria-invalid', 'true');
  } else {
    el.removeAttribute('title');
    el.removeAttribute('aria-invalid');
  }
}

// Typing is held to the limit (7.1 mirrored; the server judges). A stored text
// already past it (catalog descriptions have no cap) is never cut: it may only
// shrink, and it says it is over until it fits.
const capOf = (max, stored) => Math.max(max, stored.length);
function capLength(el, max, stored) {
  const cap = capOf(max, stored);
  if (el.textContent.length <= cap) return;
  el.textContent = el.textContent.slice(0, cap);
  caretToEnd(el);
}

// Pasted text arrives as plain text, one line, cut to the room left.
function pastePlain(e, cap) {
  e.preventDefault();
  const el = e.currentTarget;
  const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
  const chosen = sel && sel.rangeCount ? sel.toString().length : 0;
  const room = Math.max(0, cap - el.textContent.length + chosen);
  const raw = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
  const t = String(raw).replace(/\s+/g, ' ').slice(0, room);
  if (t && typeof document.execCommand === 'function') document.execCommand('insertText', false, t);
}

function onTextKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.currentTarget.blur();
  } else if (e.key === 'Escape') e.currentTarget.blur(); // commits; the editor's Escape then closes
}

// A menu text element. Keyed by its value while editable, so a committed edit
// remounts it from React's text rather than the DOM the browser edited. An
// unchanged or refused edit puts the stored text back, except a change still
// past the limit, which stays on screen, unsaved, outlined and saying so, and
// is reported as Too long (EditCtx over), so Approve holds while the preview
// shows text the print would not carry. A new stored value clears it.
export function Text({ as: Tag = 'div', k, className, value, ai = false }) {
  const ed = useContext(EditCtx);
  const setOver = ed ? ed.setOver : null;
  useEffect(() => () => { if (setOver) setOver(k, false); }, [setOver, k, value]);
  if (!ed) return <Tag className={className} data-mc-k={k}>{value}</Tag>;
  const { max } = textLimit(k);
  const cls = [className, 'mc-ed', ai && 'mc-ai', ed.long.has(k) && 'mc-long', ed.over.has(k) && 'mc-over']
    .filter(Boolean).join(' ');
  const flag = (el) => {
    const typed = cleanText(el.textContent);
    const over = typed.length > max && typed !== cleanText(value);
    markOver(el, max, over);
    ed.setOver(k, over);
    return over;
  };
  const onBlur = (e) => {
    const el = e.currentTarget;
    if (ed.commit(k, el.textContent)) { ed.setOver(k, false); return; }
    if (flag(el)) return;
    el.textContent = value;
    flag(el);
  };
  return (
    <Tag key={value} className={cls} data-mc-k={k} contentEditable suppressContentEditableWarning spellCheck={false}
      role="textbox" aria-label={labelFor(k)} onKeyDown={onTextKey} onBlur={onBlur}
      onInput={(e) => { capLength(e.currentTarget, max, value); flag(e.currentTarget); }}
      onPaste={(e) => pastePlain(e, capOf(max, value))}>
      {value}
    </Tag>
  );
}

// A group heading between its two 46 px hairlines (ornament.js GroupHeading's markup).
export function Heading({ k, children }) {
  return (
    <div className="mc-gh">
      <span className="mc-hair" />
      <Text as="span" k={k} value={children} />
      <span className="mc-hair" />
    </div>
  );
}

// A drink's name and description (the description only when it has one).
export function DrinkText({ d }) {
  return (
    <>
      <Text k={`drinks.${d.key}.display_name`} className="mc-name" value={text(d.display_name)} ai={d.name_ai_suggested === true} />
      {text(d.description) && (
        <Text k={`drinks.${d.key}.description`} className="mc-desc" value={d.description} ai={d.description_ai_written === true} />
      )}
    </>
  );
}

export function Slot({ drink, width, il, url, status, showStatus }) {
  const ed = useContext(EditCtx);
  const { aw, top } = artGeometry(il);
  const sel = !!ed && ed.selected === drink.key;
  // A flex basis, not a width (the snapshot's flex: 0 0 var(--sw)): at 280 px
  // art three to a row, the 202 px art box widens its 200 px slot as it did.
  return (
    <div className={sel ? 'mc-slot mc-sel' : 'mc-slot'} style={{ flex: `0 0 ${width}px` }}>
      {sel && (
        <div className="mc-tools">
          {ed.canReroll && !OPEN.has(status) && (
            <button type="button" className="mc-pill" onClick={() => ed.reroll(drink.key)}>Re-roll art</button>
          )}
          <button type="button" className="mc-pill" onClick={() => ed.hide(drink.key)}>Hide</button>
        </div>
      )}
      <div className="mc-art" style={{ width: aw, height: il }} data-mc-pending={url ? undefined : drink.key}
        onClick={ed ? () => ed.select(drink.key) : undefined}>
        {url && <img className="mc-art-img" src={url} alt="" data-mc-layer={drink.key} style={{ width: aw, height: aw, top }} />}
        {!url && showStatus && STATUS[status] && (
          <div className={`mc-slot-st ${STATUS[status][0]}`}>
            {status === 'working' && <span className="mc-sheen" />}
            <span className="mc-slot-st-text">{STATUS[status][1]}</span>
            {status === 'failed' && ed && ed.canReroll && (
              <button type="button" className="mc-st-btn" onClick={(e) => { e.stopPropagation(); ed.reroll(drink.key); }}>Re-roll</button>
            )}
          </div>
        )}
      </div>
      <DrinkText d={drink} />
    </div>
  );
}

// Too long (spec 11.2): which texts to flag once the page still runs past
// 1000 px with the art at its 65 px floor and the type stepped down. Neither
// design file names an element rule (v3 flags the one description that grew),
// so: each editable text against its share of the page (one line for the
// title, a heading and an Also line; two for a drink name and three for a
// description; one and two in More from the bar), most over first, as many as
// it takes to cover the overflow. The fixed Also labels are never flagged.
// With nothing over its share, the tallest description (else the tallest text)
// is named. The first key is the one the banner names (onFit's tooLong[0]).
// sizes: { over, title, name, body } in canvas px (the stepped sizes).
function shareOf(el, key, s) {
  const [head, , field] = key.split('.');
  const more = typeof el.closest === 'function' && !!el.closest('.mc-more');
  const near = (sel) => (typeof el.closest === 'function' && el.closest(sel)) || el;
  if (head === 'title') return { box: el, line: s.title * 1.2, lines: 1 };
  if (head === 'headings') return { box: near('.mc-gh'), line: 15 * 1.2, lines: 1 };
  if (head === 'also_at_bar') return field === 'text' ? { box: near('.mc-also-line'), line: s.body * 1.35, lines: 1 } : null;
  if (field === 'display_name') return { box: el, line: s.name * (more ? 0.82 : 1) * 1.12, lines: more ? 1 : 2 };
  return { box: el, line: s.body * (more ? 0.93 : 1) * 1.32, lines: more ? 2 : 3 };
}

export function tooLongKeys(page, sizes) {
  const frame = page.getBoundingClientRect();
  const k = page.offsetHeight > 0 && frame.height > 0 ? frame.height / page.offsetHeight : 1;
  const rows = [...page.querySelectorAll('[data-mc-k]')].map((el) => {
    const key = el.getAttribute('data-mc-k');
    const share = shareOf(el, key, sizes);
    if (!share) return null;
    const h = share.box.getBoundingClientRect().height / k;
    const excess = h - share.line * share.lines;
    return { key, h, excess: excess > share.line * 0.25 ? excess : 0, desc: /\.description$/.test(key) };
  }).filter(Boolean);
  const out = [];
  let freed = 0;
  for (const r of rows.filter((x) => x.excess > 0).sort((a, b) => b.excess - a.excess)) {
    out.push(r.key);
    freed += r.excess;
    if (freed >= sizes.over) break;
  }
  if (out.length || !rows.length) return out;
  const tallest = [...rows].sort((a, b) => Number(b.desc) - Number(a.desc) || b.h - a.h)[0];
  return [tallest.key];
}

// The EditCtx value, or null when not editing. The callbacks read the latest
// props, so the value changes only with what the parts draw.
export function useCanvasEdit({ on, content, selectedDrink, onSelectDrink, onPatch, onReroll, canReroll, tooLong }) {
  const live = useRef({});
  live.current = { content, selectedDrink, onSelectDrink, onPatch, onReroll };
  const longKey = (Array.isArray(tooLong) ? tooLong : []).join('|');
  const selected = selectedDrink || null;
  // The keys of unsaved edits still past their limit.
  const [over, setOverList] = useState([]);
  const setOver = useCallback((k, flagged) => setOverList((prev) => {
    const has = prev.includes(k);
    if (flagged) return has ? prev : [...prev, k];
    return has ? prev.filter((x) => x !== k) : prev;
  }), []);
  return useMemo(() => {
    if (!on) return null;
    const call = (name, ...args) => { if (typeof live.current[name] === 'function') live.current[name](...args); };
    return {
      selected,
      canReroll: !!canReroll,
      long: new Set(longKey ? longKey.split('|') : []),
      over: new Set(over),
      overList: over,
      setOver,
      commit: (k, raw) => {
        const patch = textPatch(live.current.content, k, raw);
        if (patch) call('onPatch', { content: patch });
        return !!patch;
      },
      select: (key) => call('onSelectDrink', live.current.selectedDrink === key ? null : key),
      clear: () => { if (live.current.selectedDrink) call('onSelectDrink', null); },
      reroll: (key) => call('onReroll', key),
      hide: (key) => {
        const { patch } = toggleHidden(live.current.content, key);
        if (patch) call('onPatch', { content: patch });
        call('onSelectDrink', null);
      },
    };
  }, [on, selected, canReroll, longKey, over, setOver]);
}

// A click on the menu outside the art, the pills and the text clears the selection.
export function clearOnClick(ed) {
  if (!ed) return undefined;
  return (e) => {
    const t = e.target;
    if (t && typeof t.closest === 'function' && t.closest('.mc-art, .mc-tools, .mc-ed')) return;
    ed.clear();
  };
}

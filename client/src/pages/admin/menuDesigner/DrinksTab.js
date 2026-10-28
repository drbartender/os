// DrinksTab (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React, { useRef, useState } from 'react';
import { partitionDrinks } from './layouts';
import { toggleHidden, textPatch, drinkCounts, MAX_ART, REROLL_NOTE_MAX, TEXT_LIMITS } from './menuEdits';
import { Section, useInert, rerollWhy, isReadOnly, READ_ONLY_WHY, OPEN, isObj, list } from './panelParts';

// The editor's Drinks tab (spec 2026-10-01 section 11.1, Drinks tab; 4.5).
// Props (the editor's panel contract): draft, content, pieces, configured, cap,
// onPatch({ content }), onReroll(pieceKey, note), onSelectDrink(key | null),
// selectedDrink, wordsDone, readOnly. Inert at 0.45 until the words land, and on
// a read-only draft (no plan), where nothing PATCHes or re-rolls.
// One row per drink in menu order (signatures, then mocktails): its number, its
// name over Signature / Mocktail / New from plan (plus " · Gemini" on done
// Gemini art), and its status. The selected row opens to the re-roll note and
// Re-roll art and Hide / Show, and, for a drink with no description (the
// canvas prints none, so has nothing to click), "Add a description"; the rows
// are the keyboard path to the canvas pills.

const STATUS = {
  working: ['PAINTING', 'md-st-info'], pending: ['WAITING', ''], failed: ['FAILED', 'md-st-danger'],
};

function rowStatus(d, piece) {
  if (d.hidden === true) return ['HIDDEN', ''];
  if (d.has_art !== true || !piece || !STATUS[piece.status]) return null;
  return STATUS[piece.status];
}

function subLine(d, piece) {
  const kind = d.added_by_sync === true ? 'New from plan' : d.group === 'mock' ? 'Mocktail' : 'Signature';
  const gemini = d.has_art === true && piece && piece.status === 'done' && piece.provider === 'gemini';
  return gemini ? `${kind} · Gemini` : kind;
}

const enterBlurs = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } };

function DrinkOpen({ d, piece, configured, cap, locked, onReroll, onToggle, onDescribe, hideWhy }) {
  const [note, setNote] = useState('');
  const why = (locked ? READ_ONLY_WHY : '') || rerollWhy(configured, cap)
    || (d.has_art !== true ? 'This drink lists as text, without art.' : '')
    || (piece && OPEN.has(piece.status) ? 'This drink is still being drawn.' : '');
  const noDescription = !(typeof d.description === 'string' && d.description.trim());
  return (
    <div className="md-drink-open">
      {noDescription && (
        <input className="input" type="text" defaultValue="" maxLength={TEXT_LIMITS.description.max} aria-label="Description"
          placeholder="Add a description" disabled={locked} onKeyDown={enterBlurs} onBlur={(e) => onDescribe(e.target.value)} />
      )}
      <input className="input" type="text" value={note} maxLength={REROLL_NOTE_MAX} aria-label="Note for the re-roll"
        placeholder="Note for the re-roll, e.g. add a salt rim" disabled={locked} onChange={(e) => setNote(e.target.value)} />
      <div className="md-drink-acts">
        <button type="button" className="btn btn-secondary btn-sm" disabled={!!why} title={why || undefined}
          onClick={() => { if (typeof onReroll === 'function') onReroll(d.key, note.trim()); setNote(''); }}>Re-roll art</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={locked || !!hideWhy} title={(locked ? READ_ONLY_WHY : hideWhy) || undefined}
          onClick={onToggle}>{d.hidden === true ? 'Show' : 'Hide'}</button>
      </div>
    </div>
  );
}

export default function DrinksTab({
  draft, content, pieces, configured, cap, onPatch, onReroll, onSelectDrink, selectedDrink = null, wordsDone = false, readOnly,
}) {
  const ref = useRef(null);
  const locked = isReadOnly(draft, readOnly);
  const live = wordsDone && !locked;
  useInert(ref, !live);
  const c = isObj(content) ? content : (isObj(draft) && isObj(draft.content) ? draft.content : {});
  const drinks = list(c.drinks);
  const rows = [...drinks.filter((d) => d.group !== 'mock'), ...drinks.filter((d) => d.group === 'mock')];
  const byKey = new Map(list(pieces).map((p) => [p.piece_key, p]));
  const art = Math.min(MAX_ART, drinkCounts(drinks).art);
  const extra = partitionDrinks(drinks).extra.length;
  const select = (key) => { if (typeof onSelectDrink === 'function') onSelectDrink(key); };
  const send = (patch) => { if (live && patch && typeof onPatch === 'function') onPatch({ content: patch }); };

  return (
    <div ref={ref} className={live ? 'md-tabpane md-tabpane-drinks' : 'md-tabpane md-tabpane-drinks is-off'} role="tabpanel" aria-label="Drinks">
      <Section label="Drinks" note={`${art} of ${MAX_ART} illustrated`} num>
        <div className="md-drinks">
          {rows.map((d, i) => {
            const piece = byKey.get(d.key);
            const st = rowStatus(d, piece);
            const open = d.key === selectedDrink;
            const toggle = toggleHidden(c, d.key);
            return (
              <div key={d.key} className={open ? 'md-drink is-sel' : 'md-drink'}>
                <button type="button" className="md-drink-btn" aria-expanded={open} onClick={() => select(open ? null : d.key)}>
                  <span className="md-drink-n md-num">{String(i + 1).padStart(2, '0')}</span>
                  <span className={d.hidden === true ? 'md-drink-name is-hidden' : 'md-drink-name'}>
                    {typeof d.display_name === 'string' ? d.display_name : d.key}
                    <span className="md-drink-sub">{subLine(d, piece)}</span>
                  </span>
                  <span className={st && st[1] ? `md-drink-st ${st[1]}` : 'md-drink-st'}>{st ? st[0] : ''}</span>
                </button>
                {open && (
                  <DrinkOpen d={d} piece={piece} configured={configured} cap={cap} locked={locked} hideWhy={toggle.why}
                    onReroll={(key, note) => { if (live && typeof onReroll === 'function') onReroll(key, note); }}
                    onToggle={() => send(toggle.patch)}
                    onDescribe={(v) => send(textPatch(c, `drinks.${d.key}.description`, v))} />
                )}
              </div>
            );
          })}
        </div>
        <div className="md-drinks-note">Up to 8 are illustrated. Drinks 9 to 12 list as text under “More from the bar”.</div>
        {extra > 0 && (
          <div className="md-drinks-note md-st-danger" role="status">
            {extra === 1 ? "1 drink won't fit on the menu. Hide one to fit." : `${extra} drinks won't fit on the menu. Hide ${extra} to fit.`}
          </div>
        )}
      </Section>
    </div>
  );
}

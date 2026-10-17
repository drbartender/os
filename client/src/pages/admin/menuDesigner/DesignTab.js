import React, { useEffect, useRef } from 'react';
import { PAIRINGS, PAIRING_IDS, pairingFor, ensureFontsLink } from './fontPairings';
import { resolveColors, isHex } from './menuColors';
import { Section, Seg, useInert, rerollWhy, isReadOnly, OPEN, isObj, list } from './panelParts';

// The editor's Design tab (spec 2026-10-01 section 11.1, Design tab; 4.5).
// Props (the editor's panel contract): draft, content (the draft's content with
// unsaved edits), inputs, pieces, configured, cap, onPatch({ content?, inputs? }),
// onReroll(pieceKey, note), wordsDone, readOnly. Inert at 0.45 until the words
// land, and on a read-only draft (no plan), where nothing PATCHes or re-rolls.
// - Font pairing: six buttons, "Bar Menu" in each title face; choosing one
//   resets ink and accent to its defaults.
// - Colors: Ink (Pairing default, Plum, Navy, Charcoal) and Accent (Pairing
//   default, then the words step's palette); "Pairing default" is the set the
//   background's tone picks (11.2) and saves as null.
// - Text backing; the Background row with Re-roll; the Dr. Bartender mark and,
//   while it is on, its Wordmark color.
// The editor loads all six pairings' faces on open, since this tab shows each.

const INKS = [['#6b3a6e', 'Plum'], ['#1f2a44', 'Navy'], ['#2a2a2a', 'Charcoal']];
const BACKINGS = [['off', 'Off'], ['soft', 'Soft'], ['panel', 'Panel']];
const MARK_COLORS = [['ink', 'Theme ink'], ['accent', 'Accent'], ['gold', 'Gold']];
const SAMPLE_MAX = 26;

function Swatches({ label, options, value, onPick }) {
  const v = isHex(value) ? value.toLowerCase() : null;
  const at = v ? options.findIndex((o, i) => i > 0 && o.hex.toLowerCase() === v) : 0;
  return (
    <>
      <span>{label}</span>
      <div className="md-swatches" role="group" aria-label={label}>
        {options.map((o, i) => (
          <button key={`${i}-${o.hex}`} type="button" className={i === at ? 'md-swatch is-on' : 'md-swatch'}
            title={o.name} aria-label={`${label}: ${o.name}`} aria-pressed={i === at}
            style={{ background: o.hex }} onClick={() => onPick(i === 0 ? null : o.hex)} />
        ))}
      </div>
    </>
  );
}

function backgroundSub(bg) {
  if (!bg) return 'Not drawn';
  if (OPEN.has(bg.status)) return 'Painting...';
  if (bg.status === 'failed') return "Didn't draw";
  const by = bg.status === 'done' && bg.provider === 'gemini' ? ' · Gemini' : '';
  return `Version ${Number.isInteger(bg.drawn_count) ? bg.drawn_count : 0}${by}`;
}

export default function DesignTab({
  draft, content, inputs, pieces, configured, cap, onPatch, onReroll, wordsDone = false, readOnly,
}) {
  const ref = useRef(null);
  const live = wordsDone && !isReadOnly(draft, readOnly);
  useInert(ref, !live);
  useEffect(() => { ensureFontsLink(PAIRING_IDS); }, []);

  const c = isObj(content) ? content : (isObj(draft) && isObj(draft.content) ? draft.content : {});
  const inp = isObj(inputs) ? inputs : (isObj(draft) && isObj(draft.inputs) ? draft.inputs : {});
  const all = list(pieces);
  const bg = all.find((p) => p.piece_key === 'background') || null;
  const pairing = pairingFor(c.font_pairing);
  const defaults = resolveColors({ pairing: pairing.id, tone: bg && bg.status === 'done' ? bg.tone : null });
  const send = (body) => { if (live && typeof onPatch === 'function') onPatch(body); };
  const patch = (next) => send({ content: next });

  const drafting = OPEN.has(c.words_status) || all.some((p) => OPEN.has(p.status));
  const rollWhy = rerollWhy(configured, cap);
  const palette = (Array.isArray(c.palette) ? c.palette : [])
    .filter((p) => isObj(p) && isHex(p.hex)).map((p) => ({ hex: p.hex, name: typeof p.name === 'string' && p.name ? p.name : p.hex }));
  const markOn = inp.drb_mark !== false;
  const markColor = c.mark_color === 'accent' || c.mark_color === 'gold' ? c.mark_color : 'ink';

  return (
    <div ref={ref} className={live ? 'md-tabpane' : 'md-tabpane is-off'} role="tabpanel" aria-label="Design">
      <Section label="Font pairing">
        <div className="md-pairs">
          {PAIRING_IDS.map((id) => {
            const p = PAIRINGS[id];
            const on = id === pairing.id;
            const upper = p.title.transform === 'uppercase';
            return (
              <button key={id} type="button" className={on ? 'md-pair is-on' : 'md-pair'} aria-pressed={on}
                title={`${p.name} · ${p.theme}`}
                onClick={() => patch({ font_pairing: id, ink_color: null, accent_color: null })}>
                <span className="md-pair-sample" style={{
                  fontFamily: p.title.stack, fontSize: `${Math.round(Math.min(SAMPLE_MAX, p.title.size * 0.3))}px`,
                  fontWeight: p.title.weight, textTransform: p.title.transform, letterSpacing: upper ? '0.18em' : '0',
                }}>Bar Menu</span>
                <span className="md-pair-id md-num">{id}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section label="Colors" className="md-sec-colors">
        <div className="md-colors">
          <Swatches label="Ink" value={c.ink_color} onPick={(hex) => patch({ ink_color: hex })}
            options={[{ hex: defaults.ink, name: 'Pairing default' }, ...INKS.map(([hex, name]) => ({ hex, name }))]} />
          <Swatches label="Accent" value={c.accent_color} onPick={(hex) => patch({ accent_color: hex })}
            options={[{ hex: defaults.accent, name: 'Pairing default' }, ...palette]} />
        </div>
      </Section>

      <Section label="Text backing">
        <Seg label="Text backing" className="md-seg-start" options={BACKINGS}
          value={c.text_backing === 'off' || c.text_backing === 'panel' ? c.text_backing : 'soft'}
          onChange={(v) => patch({ text_backing: v })} />
      </Section>

      <Section label="Background">
        <div className="md-bg-row">
          <div className="md-bg-text">
            {typeof c.background_label === 'string' && c.background_label ? c.background_label : 'Background'}
            <span className="md-bg-sub">{backgroundSub(bg)}</span>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" disabled={!live || !!rollWhy || drafting || !bg}
            title={rollWhy || undefined}
            onClick={() => { if (live && typeof onReroll === 'function') onReroll('background'); }}>Re-roll</button>
        </div>
      </Section>

      <div className="md-mark">
        <button type="button" role="switch" aria-checked={markOn} className="md-switch"
          onClick={() => send({ inputs: { drb_mark: !markOn } })}>
          <span>Dr. Bartender mark<span className="md-switch-sub">Small, bottom right</span></span>
          <span className={markOn ? 'md-switch-track is-on' : 'md-switch-track'}><span className="md-switch-knob" /></span>
        </button>
        {markOn && (
          <div className="md-mark-color">
            <span>Wordmark color</span>
            <Seg label="Wordmark color" options={MARK_COLORS} value={markColor} onChange={(v) => patch({ mark_color: v })} />
          </div>
        )}
      </div>
    </div>
  );
}

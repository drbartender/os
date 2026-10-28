// MenuCanvas (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React, { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  layoutDrinks, slotWidth, artGeometry, stepSize, logoSize, ART_FLOOR, ART_STEP,
  CANVAS_W, CANVAS_H, NAME_FLOOR, DESC_FLOOR, BADGE_PAD,
} from './layouts';
import { pairingFor, useFontsRevision } from './fontPairings';
import { resolveColors, groundRgb, rgba, overlay } from './menuColors';
import Ornament from './ornament';
import { drawSoftBacking, drawBadgeShadow, BADGE } from './softBacking';
import { useTintedWordmark } from './tintedWordmark';
import { EditCtx, Text, Heading, DrinkText, Slot, useCanvasEdit, clearOnClick, tooLongKeys } from './MenuCanvasEdit';

// The printed menu (spec 2026-10-01 sections 11.2, 11.3; plan Task C2): 800 x
// 1000 canvas px, 100 px = 1 in, ported from the 2026-10-01 snapshot
// (menu-designer.html, menuHTML and fit) with the v3 mark. Read-only by default
// (the card thumbnail, the export's hidden instance); editable in the editor's
// preview (MenuCanvasEdit.js), whose read-only output is unchanged.
// Props:
//   content       draft.content (title, headings, drinks, also_at_bar,
//                 font_pairing, ink_color, accent_color, text_backing,
//                 logo_mode, logo_badge, mark_color); missing keys default.
//   inputs        draft.inputs: drb_mark (on unless false) and
//                 planner_image_role ('logo' unless set).
//   pieces        the GET payload's pieces; the background's tone and
//                 ground_rgb count only once it is done.
//   layers        { [piece_key]: object URL } of the loaded piece images.
//   plannerImage  null (no planner image) or { url } (url null while loading);
//                 printed as the logo when planner_image_role is 'logo'.
//   scale         the frame's scale (0.12 for the card thumbnail); default 1.
//   showStatus    draw the painting, waiting and failed slot states and the
//                 background-painting ground (never on the export).
//   onFit         called once the fit settles: { artHeight, typeStep, tooLong }
//                 (tooLong: the data-mc-k keys of text past the page).
//   editable      the editor's preview: the drawing states, and once the words
//                 land, click-to-edit text (onPatch({ content })), drink
//                 selection (selectedDrink, onSelectDrink(key | null)), the
//                 pills (onReroll(key); Re-roll only while canReroll) and the
//                 Too long outline.
// The ref is the 800 x 1000 .mc-menu node (what html2canvas renders). Every
// layer image carries data-mc-layer; a layer the print needs and does not have
// yet is a placeholder carrying data-mc-pending instead.

export const AVATAR_SRC = `${process.env.PUBLIC_URL || ''}/images/menu-mark-avatar.png`;
const FIT_SLACK = 1;
const DEFAULT_TITLE = 'Bar Menu';
const DEFAULT_HEADINGS = { sig: 'Signature Cocktails', mock: 'Mocktails', more: 'More from the bar', also: 'Also at the bar' };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const px = (n) => `${n}px`;

// The fit resizes the art in place between measurements, as the snapshot's
// fit() did, and commits the result to state once.
function paintArt(root, il) {
  const { aw, top } = artGeometry(il);
  const set = (sel, style) => root.querySelectorAll(sel).forEach((el) => Object.assign(el.style, style));
  set('.mc-art', { height: px(il), width: px(aw) });
  set('.mc-art-img', { width: px(aw), height: px(aw), top: px(top) });
}

function Logo({ url, mode, badge, ratio, onLoad }) {
  const { width, height } = logoSize(mode, badge, ratio);
  const faceW = width === undefined ? 0 : width + 2 * BADGE_PAD.x;
  const faceH = height + 2 * BADGE_PAD.y;
  const shadow = useMemo(() => (badge && faceW > 0 ? drawBadgeShadow(faceW, faceH) : null), [badge, faceW, faceH]);
  const img = url
    ? <img className="mc-logo" src={url} alt="" data-mc-layer="logo" style={{ width, height }} onLoad={onLoad} />
    : <div className="mc-logo" data-mc-pending="logo" style={{ height }} />;
  if (!badge) return <div className="mc-logo-box">{img}</div>;
  // The badge's shadow is an image under an opaque face (softBacking.js).
  const pad = BADGE.pad;
  return (
    <div className="mc-logo-box mc-logo-badge">
      {shadow && (
        <img className="mc-badge-shadow" src={shadow} alt="" data-mc-layer="badge-shadow"
          style={{ left: -pad, top: -pad, width: Math.round(faceW) + 2 * pad, height: Math.round(faceH) + 2 * pad }} />
      )}
      <div className="mc-logo-face">{img}</div>
    </div>
  );
}

function Backing({ kind, ground, accent }) {
  const soft = useMemo(() => (kind === 'soft' ? drawSoftBacking(ground) : null), [kind, ground]);
  // Panel: the fill at .86, a 7 px ring and a 1 px accent hairline inside it,
  // as plain borders (html2canvas 1.4.1 inverts layered inset box-shadows).
  if (kind === 'panel') {
    return (
      <div className="mc-panel" style={{ background: rgba(ground, 0.86), borderColor: overlay(ground, 0.86, accent) }}>
        <div className="mc-panel-line" style={{ borderColor: accent }} />
      </div>
    );
  }
  return soft ? <img className="mc-layer" src={soft} alt="" data-mc-layer="backing" /> : null;
}

// With the Panel backing the mark sits inside the panel's line (review
// 2026-10-17: at 40 / 40 the line ran through the wordmark).
function Mark({ color, inPanel }) {
  const wordmark = useTintedWordmark(color);
  return (
    <div className={inPanel ? 'mc-mark mc-mark-panel' : 'mc-mark'}>
      <img className="mc-avatar" src={AVATAR_SRC} alt="" data-mc-layer="avatar" />
      {wordmark
        ? <img className="mc-wordmark" src={wordmark} alt="Dr. Bartender" data-mc-layer="wordmark" />
        : <span className="mc-wordmark" data-mc-pending="wordmark" />}
    </div>
  );
}

const MenuCanvas = forwardRef(function MenuCanvas({
  content, inputs, pieces, layers, plannerImage = null, scale = 1, showStatus = false, onFit, className,
  editable = false, selectedDrink = null, onSelectDrink, onPatch, onReroll, canReroll = false, ...rest
}, ref) {
  const c = isObject(content) ? content : {};
  const inp = isObject(inputs) ? inputs : {};
  const L = isObject(layers) ? layers : {};
  const pairing = pairingFor(c.font_pairing);

  const byKey = useMemo(() => new Map((Array.isArray(pieces) ? pieces : []).filter(isObject).map((p) => [p.piece_key, p])), [pieces]);
  const bg = byKey.get('background');
  const bgDone = bg ? bg.status === 'done' : Boolean(L.background);
  const bgUrl = bgDone ? L.background || null : null;
  const bgOpen = Boolean(bg) && (bg.status === 'pending' || bg.status === 'working');
  const ground = groundRgb(bgDone && bg ? bg.ground_rgb : null);
  const colors = resolveColors({
    pairing: pairing.id, tone: bgDone && bg ? bg.tone : null,
    ink: c.ink_color, accent: c.accent_color, markColor: c.mark_color,
  });

  const layout = useMemo(() => layoutDrinks(c.drinks), [c.drinks]);
  const headings = { ...DEFAULT_HEADINGS };
  if (isObject(c.headings)) Object.keys(DEFAULT_HEADINGS).forEach((k) => { if (text(c.headings[k])) headings[k] = c.headings[k]; });
  const title = text(c.title) || DEFAULT_TITLE;
  const also = (Array.isArray(c.also_at_bar) ? c.also_at_bar : [])
    .map((a, i) => ({ label: text(isObject(a) ? a.label : ''), text: text(isObject(a) ? a.text : ''), i }))
    .filter((a) => a.text.trim());
  const backing = c.text_backing === 'off' || c.text_backing === 'panel' ? c.text_backing : 'soft';

  const showLogo = (inp.planner_image_role || 'logo') === 'logo' && isObject(plannerImage);
  const logoUrl = showLogo ? plannerImage.url || null : null;
  const logoMode = c.logo_mode === 'replaces_title' ? 'replaces_title' : 'above_title';
  const [logoFit, setLogoFit] = useState({ url: null, ratio: null });
  const logoRatio = logoFit.url === logoUrl ? logoFit.ratio : null;
  const onLogoLoad = (e) => {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
    setLogoFit({ url: logoUrl, ratio: w > 0 && h > 0 ? w / h : null });
  };

  const fontsRev = useFontsRevision([pairing.id]);

  // The fit (11.2): the art starts by row count and shrinks in 6 px steps
  // while the page is taller than 1000, never below 65; then names and
  // descriptions step down once; then whatever still runs past is too long.
  const layoutKey = JSON.stringify([pairing.id, title, headings, layout.sig, layout.mock, layout.more, also,
    showLogo, logoMode, c.logo_badge === true, logoRatio, fontsRev, backing === 'panel']);
  const [fit, setFit] = useState({ key: null });
  const cur = fit.key === layoutKey ? fit : { key: layoutKey, il: layout.artStart, step: false, tooLong: [], settled: false };
  const menuRef = useRef(null);
  const pageRef = useRef(null);
  const setMenuRef = useCallback((node) => {
    menuRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);

  const hs = pairing.heading.size;
  const bs = pairing.body.size;
  const ts = pairing.title.size;
  useLayoutEffect(() => {
    const page = pageRef.current;
    const root = menuRef.current;
    if (!page || !root || cur.settled) return;
    const over = () => page.scrollHeight > CANVAS_H + FIT_SLACK;
    let il = cur.il;
    while (layout.rows > 0 && over() && il > ART_FLOOR) {
      il = Math.max(ART_FLOOR, il - ART_STEP);
      paintArt(root, il);
    }
    let step = cur.step;
    if (over() && !step) {
      step = true;
      root.style.setProperty('--mc-hs', px(stepSize(hs, NAME_FLOOR)));
      root.style.setProperty('--mc-bs', px(stepSize(bs, DESC_FLOOR)));
    }
    const sizes = { over: page.scrollHeight - CANVAS_H, title: ts,
      name: step ? stepSize(hs, NAME_FLOOR) : hs, body: step ? stepSize(bs, DESC_FLOOR) : bs };
    setFit({ key: cur.key, il, step, tooLong: over() ? tooLongKeys(page, sizes) : [], settled: true });
  }, [cur.key, cur.settled, cur.il, cur.step, layout.rows, hs, bs, ts]);

  const ed = useCanvasEdit({
    on: editable && c.words_status !== 'pending' && c.words_status !== 'working',
    content: c, selectedDrink, onSelectDrink, onPatch, onReroll, canReroll, tooLong: cur.tooLong,
  });

  // tooLong also carries any unsaved edit still past its 7.1 limit (editor
  // only), so Approve holds while the preview shows text the print would not.
  const onFitRef = useRef(onFit);
  onFitRef.current = onFit;
  const reported = useRef(null);
  useEffect(() => {
    if (!cur.settled || typeof onFitRef.current !== 'function') return;
    const tooLong = [...cur.tooLong, ...(ed ? ed.overList : []).filter((k) => !cur.tooLong.includes(k))];
    const sig = JSON.stringify([cur.key, cur.il, cur.step, tooLong]);
    if (reported.current === sig) return;
    reported.current = sig;
    onFitRef.current({ artHeight: cur.il, typeStep: cur.step, tooLong });
  });
  const states = showStatus || editable;

  const { title: t, heading: h, body: b } = pairing;
  const vars = {
    '--mc-ink': colors.ink, '--mc-accent': colors.accent,
    '--mc-tf': t.stack, '--mc-ts': px(t.size), '--mc-tw': String(t.weight), '--mc-tt': t.transform, '--mc-tk': t.tracking,
    '--mc-hf': h.stack, '--mc-hs': px(cur.step ? stepSize(hs, NAME_FLOOR) : hs), '--mc-hw': String(h.weight), '--mc-hk': h.tracking,
    '--mc-bf': b.stack, '--mc-bs': px(cur.step ? stepSize(bs, DESC_FLOOR) : bs), '--mc-bw': String(b.weight),
  };
  if (scale !== 1) vars.transform = `scale(${scale})`;

  const slot = (d, rowLen) => {
    const status = byKey.has(d.key) ? byKey.get(d.key).status : null;
    const done = status === null || status === 'done';
    return (
      <Slot key={d.key} drink={d} width={slotWidth(rowLen)} il={cur.il}
        url={done ? L[d.key] || null : null} status={status} showStatus={states} />
    );
  };
  const group = (rows, k) => rows.length > 0 && (
    <div className="mc-group">
      <Heading k={`headings.${k}`}>{headings[k]}</Heading>
      {rows.map((row) => <div className="mc-row" key={row[0].key}>{row.map((d) => slot(d, row.length))}</div>)}
    </div>
  );

  return (
    <div className={`mc-frame${className ? ` ${className}` : ''}`} style={{ width: CANVAS_W * scale, height: CANVAS_H * scale }} {...rest}>
      <EditCtx.Provider value={ed}>
        <div ref={setMenuRef} className={editable ? 'mc-menu mc-edit' : 'mc-menu mc-static'} style={vars} onClick={clearOnClick(ed)}>
          <div className="mc-layer mc-ground" data-mc-pending={bgUrl ? undefined : 'background'}>
            {bgUrl && <img className="mc-layer" src={bgUrl} alt="" data-mc-layer="background" />}
            {!bgUrl && states && bgOpen && <><span className="mc-sheen" /><span className="mc-ground-text">Painting the background...</span></>}
          </div>
          {bgDone && backing !== 'off' && <Backing kind={backing} ground={ground} accent={colors.accent} />}
          <div className={backing === 'panel' ? 'mc-page mc-page-panel' : 'mc-page'} ref={pageRef}>
            <div className="mc-head">
              {showLogo && <Logo url={logoUrl} mode={logoMode} badge={c.logo_badge === true} ratio={logoRatio} onLoad={onLogoLoad} />}
              {!(showLogo && logoMode === 'replaces_title') && <Text k="title" className="mc-title" value={title} />}
              <Ornament color={colors.accent} />
            </div>
            {group(layout.sigRows, 'sig')}
            {group(layout.mockRows, 'mock')}
            {layout.more.length > 0 && (
              <div className="mc-group">
                <Heading k="headings.more">{headings.more}</Heading>
                <div className="mc-more">
                  {layout.more.map((d) => <div className="mc-more-item" key={d.key}><DrinkText d={d} /></div>)}
                </div>
              </div>
            )}
            {also.length > 0 && (
              <div className="mc-also">
                <Heading k="headings.also">{headings.also}</Heading>
                {also.map((a) => (
                  <div className="mc-also-line" key={a.i}>
                    <Text as="span" k={`also_at_bar.${a.i}.label`} className="mc-also-label" value={a.label} />
                    <Text as="span" k={`also_at_bar.${a.i}.text`} value={a.text} />
                  </div>
                ))}
              </div>
            )}
          </div>
          {inp.drb_mark !== false && <Mark color={colors.mark} inPanel={backing === 'panel'} />}
        </div>
      </EditCtx.Provider>
    </div>
  );
});

export default MenuCanvas;

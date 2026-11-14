// The house card on the designer canvas (React component, default export): the planner's
// Standard Menu card (MenuPreview's print variant) at 800 x 1000, with the names fitted.

import React, { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CANVAS_W, CANVAS_H } from './layouts';
import { HOUSE_FACE_SET, useFontsRevision } from './fontPairings';
import { layoutPieceKeys } from './menuCardState';
import { EditCtx, Text, useCanvasEdit, clearOnClick } from './MenuCanvasEdit';

// Spec 2026-10-19 section 9.3 (lane menu-house-card). MenuCanvas renders this
// in place of the custom layout when content.look is 'house' (the job copies
// the look into content at Generate, so it reads content only). A port of
// client/src/pages/plan/components/MenuPreview.js's print variant, its 768 x
// 960 values scaled by 800 / 768 into the mc-house- rules (index.css): the ink
// ground #12161C, the brass crest round the title "The Bar Menu" in Pirata One,
// the sections labelled in IM Fell English SC between diamonds, the drink
// names in IM Fell English SC, and the footer band with the Dr. Bartender
// lockup. Faces come from the house face set (fontPairings.js HOUSE_FACE_SET),
// whose link this loads and refits on.
// - Ground: the background piece when there is one, else the flat ground. A
//   card whose layout uses a background (layoutPieceKeys: not plain) and has
//   none yet is a data-mc-pending layer, so the export waits for it.
// - Sections: Cocktails and Mocktails are the draft's visible drinks in order
//   (group 'mock' for mocktails), each name editable on the canvas like the
//   custom layout's (Text, data-mc-k drinks.<key>.display_name); then
//   content.house_sections as the job wrote them (Beer & Wine and the like on
//   one line joined by middots, unless it is the only section; Bar Service's
//   Call Drinks as a name). A malformed stored section is skipped.
// - Fit (v1 11.2's Too long): names start at 35 px and step down 1 px to a
//   24 px floor until the content fits above the footer; below the floor it
//   reports Too long, naming the first drink name past the footer when one
//   is, else the card itself (CARD_KEY, which names no element: the trailing
//   bar sections overflow, and no name that fits is flagged as the cause), so
//   the editor holds Approve and never prints a clipped file.
//   onFit({ artHeight: null, typeStep, nameSize, tooLong }).
// - Footer: the lockup on the left and, for a client image whose role is
//   logo, the client's logo on the right behind a brass divider, at most
//   167 x 75; both centre as one group when content.house_bottom_corners (the
//   December holiday's gifts sit in those corners).
// No .mc-mark, no Panel, no "Also at the bar" footer. Nothing here uses a
// transform, mask, filter, shadow or object-fit (v1 11.3: html2canvas).

const LOCKUP_SRC = `${process.env.PUBLIC_URL || ''}/images/menu-logo-gold.png`;
const NAME_START = 35;
const NAME_FLOOR = 24;
// The content box sits 50 px down; the footer band is 111.46 px tall.
const CONTENT_MAX = CANVAS_H - 50 - 111.46;
const FIT_SLACK = 1;
const LOGO_MAX = { w: 166.67, h: 75 };
const INLINE_KINDS = new Set(['beer-wine', 'bar-line']);
const OPEN = new Set(['pending', 'working']);
// Too long's key when no drink name is past the footer: the card as a whole.
const CARD_KEY = 'house_card';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const px = (n) => `${n}px`;

// The sections in print order (header).
function sectionsOf(c) {
  const visible = (Array.isArray(c.drinks) ? c.drinks : []).filter((d) => isObject(d) && d.hidden !== true && typeof d.key === 'string');
  const out = [];
  const sig = visible.filter((d) => d.group !== 'mock');
  const mock = visible.filter((d) => d.group === 'mock');
  if (sig.length) out.push({ kind: 'cocktails', title: 'Cocktails', drinks: sig });
  if (mock.length) out.push({ kind: 'mocktails', title: 'Mocktails', drinks: mock });
  for (const s of Array.isArray(c.house_sections) ? c.house_sections : []) {
    if (!isObject(s) || !text(s.title) || !Array.isArray(s.items)) continue;
    const items = s.items.filter((i) => text(i));
    if (items.length) out.push({ kind: text(s.kind), title: s.title, items });
  }
  return out;
}

// Too long: the first drink name past the footer, else the card itself (header).
function tooLongKey(content) {
  const names = [...content.querySelectorAll('[data-mc-k^="drinks."]')];
  const box = content.getBoundingClientRect();
  const k = content.offsetHeight > 0 && box.height > 0 ? box.height / content.offsetHeight : 1;
  const past = names.find((el) => (el.getBoundingClientRect().bottom - box.top) / k > CONTENT_MAX + FIT_SLACK);
  return past ? past.getAttribute('data-mc-k') : CARD_KEY;
}

function Rule() {
  return (
    <div className="mc-house-rule">
      <span className="mc-house-line" />
      <span className="mc-house-dia">{'◆'}</span>
      <span className="mc-house-line" />
    </div>
  );
}

function Section({ section, only }) {
  const inline = INLINE_KINDS.has(section.kind) && !only;
  return (
    <div className="mc-house-section">
      <div className="mc-house-label">
        <div className="mc-house-label-row">
          <span className="mc-house-label-dia">{'◆'}</span>
          <span>{section.title}</span>
          <span className="mc-house-label-dia">{'◆'}</span>
        </div>
      </div>
      <div className="mc-house-items">
        {section.drinks && section.drinks.map((d) => (
          <Text key={d.key} k={`drinks.${d.key}.display_name`} className="mc-house-name" value={text(d.display_name)}
            ai={d.name_ai_suggested === true} />
        ))}
        {!section.drinks && inline && <div className="mc-house-inline">{section.items.join(' · ')}</div>}
        {!section.drinks && !inline && section.items.map((item, i) => <div key={`${section.kind}-${i}`} className="mc-house-name">{item}</div>)}
      </div>
    </div>
  );
}

function ClientLogo({ url }) {
  const [fit, setFit] = useState({ url: null, size: null });
  const size = fit.url === url ? fit.size : null;
  if (!url) return <div className="mc-house-logo" data-mc-pending="logo" style={{ width: LOGO_MAX.w, height: LOGO_MAX.h }} />;
  const onLoad = (e) => {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
    if (!(w > 0 && h > 0)) return;
    const scale = Math.min(LOGO_MAX.w / w, LOGO_MAX.h / h);
    setFit({ url, size: { width: Math.round(w * scale * 100) / 100, height: Math.round(h * scale * 100) / 100 } });
  };
  return <img className="mc-house-logo" src={url} alt="" data-mc-layer="logo" style={size || { maxWidth: LOGO_MAX.w, maxHeight: LOGO_MAX.h }} onLoad={onLoad} />;
}

const HouseCard = forwardRef(function HouseCard({
  content, inputs, pieces, layers, plannerImage = null, scale = 1, showStatus = false, onFit, className,
  editable = false, selectedDrink = null, onSelectDrink, onPatch, onReroll, canReroll = false, ...rest
}, ref) {
  const c = isObject(content) ? content : {};
  const inp = isObject(inputs) ? inputs : {};
  const L = isObject(layers) ? layers : {};

  const byKey = useMemo(() => new Map((Array.isArray(pieces) ? pieces : []).filter(isObject).map((p) => [p.piece_key, p])), [pieces]);
  const bg = byKey.get('background');
  const bgDone = bg ? bg.status === 'done' : Boolean(L.background);
  const bgUrl = bgDone ? L.background || null : null;
  const bgOpen = Boolean(bg) && OPEN.has(bg.status);
  const owesBg = layoutPieceKeys(c).includes('background');
  const states = showStatus || editable;

  const title = text(c.title) || 'The Bar Menu';
  const sections = useMemo(() => sectionsOf(isObject(content) ? content : {}), [content]);
  const centred = c.house_bottom_corners === true;
  const showLogo = (inp.planner_image_role || 'logo') === 'logo' && isObject(plannerImage);
  const fontsRev = useFontsRevision([HOUSE_FACE_SET]);

  const layoutKey = JSON.stringify([title, sections, fontsRev]);
  const [fit, setFit] = useState({ key: null });
  const cur = fit.key === layoutKey ? fit : { key: layoutKey, size: NAME_START, tooLong: [], settled: false };
  const menuRef = useRef(null);
  const contentRef = useRef(null);
  const setMenuRef = useCallback((node) => {
    menuRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);

  useLayoutEffect(() => {
    const box = contentRef.current;
    const root = menuRef.current;
    if (!box || !root || cur.settled) return;
    const over = () => box.scrollHeight > CONTENT_MAX + FIT_SLACK;
    let size = cur.size;
    while (over() && size > NAME_FLOOR) {
      size -= 1;
      root.style.setProperty('--mc-house-name', px(size));
    }
    setFit({ key: cur.key, size, tooLong: over() ? [tooLongKey(box)] : [], settled: true });
  }, [cur.key, cur.settled, cur.size]);

  const ed = useCanvasEdit({
    on: editable && c.words_status === 'done', content: c, selectedDrink, onSelectDrink, onPatch, onReroll,
    canReroll: false, tooLong: cur.tooLong,
  });

  // tooLong also carries any unsaved edit still past its limit, as the custom canvas does.
  const onFitRef = useRef(onFit);
  onFitRef.current = onFit;
  const reported = useRef(null);
  useEffect(() => {
    if (!cur.settled || typeof onFitRef.current !== 'function') return;
    const tooLong = [...cur.tooLong, ...(ed ? ed.overList : []).filter((k) => !cur.tooLong.includes(k))];
    const sig = JSON.stringify([cur.key, cur.size, tooLong]);
    if (reported.current === sig) return;
    reported.current = sig;
    onFitRef.current({ artHeight: null, typeStep: cur.size < NAME_START, nameSize: cur.size, tooLong });
  });

  const vars = { '--mc-house-name': px(cur.size) };
  if (scale !== 1) vars.transform = `scale(${scale})`;

  return (
    <div className={`mc-frame${className ? ` ${className}` : ''}`} style={{ width: CANVAS_W * scale, height: CANVAS_H * scale }} {...rest}>
      <EditCtx.Provider value={ed}>
        <div ref={setMenuRef} className={editable ? 'mc-menu mc-house-card mc-edit' : 'mc-menu mc-house-card mc-static'} style={vars}
          onClick={clearOnClick(ed)}>
          <div className="mc-layer mc-house-ground" data-mc-pending={owesBg && !bgUrl ? 'background' : undefined}>
            {bgUrl && <img className="mc-layer" src={bgUrl} alt="" data-mc-layer="background" />}
            {!bgUrl && states && bgOpen && <><span className="mc-sheen" /><span className="mc-ground-text">Painting the background...</span></>}
          </div>
          <div className="mc-house-content" ref={contentRef}>
            <div className="mc-house-crest">
              <Rule />
              <Text k="title" className="mc-house-title" value={title} />
              <Rule />
            </div>
            <div className="mc-house-body">
              {sections.map((s, i) => <Section key={`${s.kind}-${i}`} section={s} only={sections.length === 1} />)}
            </div>
          </div>
          <div className={centred ? 'mc-house-foot mc-house-foot-center' : 'mc-house-foot'}>
            <div className="mc-house-lockup">
              <img className="mc-house-lockup-logo" src={LOCKUP_SRC} alt="Dr. Bartender" data-mc-layer="avatar" />
              <span className="mc-house-lockup-text">Dr. Bartender</span>
            </div>
            {!centred && <div className="mc-house-spacer" />}
            {showLogo && <div className="mc-house-divider" />}
            {showLogo && <ClientLogo url={plannerImage.url || null} />}
          </div>
        </div>
      </EditCtx.Provider>
    </div>
  );
});

export default HouseCard;

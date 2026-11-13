// The menu editor's Brief tab (React component, default export): the client brief, the admin
// brief, the planner's own picks, the client image, the style reference and the art direction.

import React, { useRef, useState } from 'react';
import { ART_DIRECTION_MAX } from './menuEdits';
import { BAR_LINE, uncheckedNotice } from './menuCardState';
import { Section, Seg, isObj, hasLiveDraft, isReadOnly } from './panelParts';

// The editor's Brief tab (spec 2026-10-01 sections 4.3 and 9; 11.1, Brief tab;
// spec 2026-10-19 section 7). Props (the editor's panel contract): draft,
// content, pieces, inputs (the draft's, or the hook's pre-draft brief), brief
// (the GET's), diff, plan (the GET's plan block, null with no plan),
// plannerImage (null or { url }), referenceFile and onReferenceFile(file |
// null) (the hook's held upload), onPatch({ content?, inputs? }), wordsDone and
// readOnly. Never inert: the brief is set before the first Generate. On a
// read-only draft (no plan) it is shown but every control is off and nothing
// PATCHes.
// - Client brief, read-only; a field the client edited since the draft is
//   tinted and labeled "Edited by client" (no time: the plan stores none).
// - Admin brief ("Yours · read first"): inputs.admin_brief, the owner's own
//   Theme & colors, Drink naming and Design notes, three Art direction inputs
//   of up to 1,000 characters each. An edit sends the whole three-field object
//   through onPatch (the hook's debounced PATCH with a draft, its pre-draft
//   brief without one, posted with Generate), whether or not the words have
//   landed. The words step reads it first, the client's text filling each
//   blank (the server's effectiveBrief), from the next Generate or Start over.
// - From the planner ("Potion Planner · read-only"), with a plan: the plan's
//   menu style and planner_reference, the planner's own picks whatever side
//   the menu's drinks come from (a consult-side plan says so first): Drinks
//   (n) as a list with mocktails marked, or that the client has not picked
//   any; the bar as the server's labelled lines; the additional and mocktail
//   notes when there are some. Display only. Under its Bar row, a change to
//   the bar picks prints the card's BAR_LINE (spec 2026-10-19 section 17), and
//   a bar line renamed before bar picks were tracked, which nothing can check
//   (the diff's bar_unchecked), prints the card's notice (uncheckedNotice, the
//   card's and the banners' one predicate: shown whether or not the diff is
//   dismissed, hidden while read-only, before the words land or while a piece
//   is painting).
// - Client image: Logo / Style ref / Ignore; under Logo, Placement and Backing,
//   which are draft content, so they wait for the words and say so.
// - Style reference, one at most: the planner image as Style ref, a held new
//   upload ("Applies when you start over" once a draft exists) or the draft's
//   stored upload. Choosing an upload while the planner image is the style
//   reference flips it to Ignore, and so does removing it; a dropped file is
//   taken like Upload.
// - Art direction, up to 500 characters.
// A role flip or a removal goes through onPatch at once (the hook saves it with
// a draft and keeps it with the brief without one); PATCH may set the source
// only to none or planner, so a stored upload is replaced only by Start over.

const REF_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const REF_EXT = /\.(jpe?g|png|webp)$/i;
const MAX_REF_BYTES = 10 * 1024 * 1024;
const ROLES = [['logo', 'Logo'], ['reference', 'Style ref'], ['ignore', 'Ignore']];
const PLACEMENT = [['above_title', 'Above title'], ['replaces_title', 'Replace title']];
const BADGE = [[false, 'None'], [true, 'Badge']];
const FIELDS = [['theme', 'Theme & colors'], ['naming', 'Drink naming'], ['notes', 'Design notes']];
// The admin brief's per-field limit (server/utils/menuDraftValidation.js LIMITS.admin_brief).
const ADMIN_BRIEF_MAX = 1000;
const ADMIN_PLACEHOLDERS = {
  theme: 'e.g. navy and brass, art deco, a little playful',
  naming: "e.g. name the cocktails after the couple's dogs",
  notes: 'e.g. keep the title small, no florals',
};
const ADMIN_HINT = "Used first. Where you leave a field blank, the client's text is used. Use it for anything the client told you by email, "
  + 'text or phone. Applies at the next Generate or Start over.';
const MENU_STYLES = new Map([['custom', 'Custom'], ['house', 'Standard (house)'], ['none', 'Skip']]);
const CONSULT_HINT = "This menu's drinks come from the consult form, which the shopping list uses. The planner picks below are what the "
  + 'client chose on their own.';
const NO_DRINKS = "The client hasn't picked drinks yet.";
const list = (v) => (Array.isArray(v) ? v : []);
const text = (v) => (typeof v === 'string' ? v : '');
const adminBriefOf = (inp) => {
  const a = isObj(inp.admin_brief) ? inp.admin_brief : {};
  return { theme: text(a.theme), naming: text(a.naming), notes: text(a.notes) };
};

function BriefField({ label, value, edited, children }) {
  return (
    <div className="md-brief-f">
      <div className="meta-k">{label}</div>
      <div className={edited ? 'md-brief-v is-edited' : 'md-brief-v'}>{value || <span className="md-brief-none">None</span>}</div>
      {children}
      {edited && <div className="md-brief-edited">Edited by client</div>}
    </div>
  );
}

function Palette({ palette }) {
  const colors = (Array.isArray(palette) ? palette : []).filter((p) => isObj(p) && typeof p.hex === 'string');
  if (!colors.length) return null;
  const names = colors.map((p) => p.name).filter((n) => typeof n === 'string' && n);
  return (
    <>
      <div className="md-dots">{colors.map((p, i) => <span key={`${i}-${p.hex}`} className="md-dot" title={p.name || p.hex} style={{ background: p.hex }} />)}</div>
      {names.length > 0 && <div className="md-dots-names">{names.join(', ')}</div>}
    </>
  );
}

// The planner's own picks and notes (header), read-only.
function FromPlanner({ plan, barNotes }) {
  const ref = isObj(plan.planner_reference) ? plan.planner_reference : {};
  const drinks = list(ref.drinks).filter((d) => isObj(d) && text(d.name));
  const bar = list(ref.bar).filter((line) => text(line));
  const none = (words) => <span className="md-brief-none">{words}</span>;
  return (
    <Section label="From the planner" note="Potion Planner · read-only">
      {plan.side === 'consult' && <div className="md-brief-hint">{CONSULT_HINT}</div>}
      <div className="md-brief-box">
        <BriefField label="Menu style" value={MENU_STYLES.get(plan.menu_style) || none('not chosen')} />
        <BriefField label={`Drinks (${drinks.length})`}
          value={drinks.length ? drinks.map((d) => (d.mock ? `${d.name} (mocktail)` : d.name)).join(', ') : none(NO_DRINKS)} />
        <BriefField label="Bar" value={bar.length ? bar.map((line, i) => <div key={`${i}-${line}`}>{line}</div>) : ''}>
          {barNotes}
        </BriefField>
        {text(ref.additional_notes) && <BriefField label="Additional notes" value={ref.additional_notes} />}
        {text(ref.mocktail_notes) && <BriefField label="Mocktail notes" value={ref.mocktail_notes} />}
      </div>
    </Section>
  );
}

export default function BriefTab({
  draft, content, pieces = [], inputs, brief, diff, plan = null, plannerImage = null, referenceFile = null, onReferenceFile, onPatch,
  wordsDone = false, readOnly,
}) {
  const fileRef = useRef(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
  const hasDraft = isObj(draft);
  const c = isObj(content) ? content : (hasDraft && isObj(draft.content) ? draft.content : {});
  const inp = isObj(inputs) ? inputs : (hasDraft && isObj(draft.inputs) ? draft.inputs : {});
  const admin = adminBriefOf(inp);
  const b = isObj(brief) ? brief : {};
  const live = isObj(diff) && !diff.dismissed && !(hasDraft && draft.read_only) ? diff : null;
  const edited = new Set(live && Array.isArray(live.brief_edited) ? live.brief_edited : []);
  const unchecked = uncheckedNotice({ draft, pieces, diff, readOnly: isReadOnly(draft, readOnly) });
  const hasImage = b.has_planner_image === true;
  const role = ROLES.some(([v]) => v === inp.planner_image_role) ? inp.planner_image_role : 'logo';
  const locked = isReadOnly(draft, readOnly);
  const send = (body) => { if (!locked && typeof onPatch === 'function') onPatch(body); };
  const setInputs = (next) => send({ inputs: next });
  const hold = (file) => { if (!locked && typeof onReferenceFile === 'function') onReferenceFile(file); };
  const logoWhy = locked ? '' : !hasDraft ? 'Placement and backing apply once a draft exists.'
    : !wordsDone ? 'Placement and backing apply once the menu words land.' : '';

  const setRole = (v) => {
    if (v === 'reference') {
      if (referenceFile) hold(null);
      setInputs({ planner_image_role: 'reference', reference_source: 'planner' });
    } else if (role === 'reference') setInputs({ planner_image_role: v, reference_source: 'none' });
    else setInputs({ planner_image_role: v });
  };
  const take = (file) => {
    if (!file || locked) return;
    if (!(REF_TYPES.has(file.type) || (!file.type && REF_EXT.test(file.name || '')))) { setError('Use a JPEG, PNG or WebP image.'); return; }
    if (file.size > MAX_REF_BYTES) { setError('The image must be 10 MB or smaller.'); return; }
    setError('');
    hold(file);
    if (role === 'reference') setInputs({ planner_image_role: 'ignore', reference_source: 'none' });
  };

  let ref = null;
  if (hasImage && role === 'reference') ref = { name: 'Client image', remove: () => setInputs({ planner_image_role: 'ignore', reference_source: 'none' }) };
  else if (referenceFile) ref = { name: referenceFile.name || 'Image', held: hasLiveDraft(draft), remove: () => hold(null) };
  else if (inp.reference_source === 'upload' && inp.has_reference === true) ref = { name: 'Uploaded image', remove: () => setInputs({ reference_source: 'none' }) };

  const url = isObj(plannerImage) ? plannerImage.url || null : null;
  return (
    <div className="md-tabpane" role="tabpanel" aria-label="Brief">
      <Section label="Client brief" note="Potion Planner · read-only">
        <div className="md-brief-box">
          {FIELDS.map(([k, label]) => (
            <BriefField key={k} label={label} value={typeof b[k] === 'string' ? b[k] : ''} edited={edited.has(k)}>
              {k === 'theme' && <Palette palette={c.palette} />}
            </BriefField>
          ))}
        </div>
      </Section>

      <Section label="Admin brief" note="Yours · read first">
        {FIELDS.map(([k, label]) => (
          <label key={k} className="meta-item">
            <span className="meta-k">{label}</span>
            <textarea className="input md-brief-dir" rows={2} maxLength={ADMIN_BRIEF_MAX} aria-label={`Admin brief: ${label}`}
              readOnly={locked} placeholder={ADMIN_PLACEHOLDERS[k]} value={admin[k]}
              onChange={(e) => setInputs({ admin_brief: { ...admin, [k]: e.target.value } })} />
          </label>
        ))}
        <div className="md-brief-hint">{ADMIN_HINT}</div>
      </Section>

      {isObj(plan) && (
        <FromPlanner plan={plan} barNotes={(
          <>
            {live && live.bar_changed === true && <div className="md-brief-edited">{BAR_LINE}</div>}
            {unchecked && <div className="md-brief-edited">{unchecked.line}</div>}
          </>
        )} />
      )}

      <Section label="Client image">
        {hasImage ? (
          <>
            <div className="md-brief-img-row">
              <div className="md-brief-img">{url && <img src={url} alt="From the planner" />}</div>
              <div className="md-brief-img-col">
                <div className="md-brief-img-label md-num">From the planner</div>
                <Seg label="Client image use" options={ROLES} value={role} onChange={setRole} disabled={locked} />
              </div>
            </div>
            {role === 'logo' && (
              <div className="md-brief-logo">
                <span>Placement</span>
                <Seg label="Logo placement" className="md-seg-start" options={PLACEMENT} disabled={locked || !wordsDone}
                  value={c.logo_mode === 'replaces_title' ? 'replaces_title' : 'above_title'}
                  onChange={(v) => { if (wordsDone) send({ content: { logo_mode: v } }); }} />
                <span>Backing</span>
                <Seg label="Logo backing" className="md-seg-start" options={BADGE} disabled={locked || !wordsDone}
                  value={c.logo_badge === true}
                  onChange={(v) => { if (wordsDone) send({ content: { logo_badge: v } }); }} />
              </div>
            )}
            {role === 'logo' && logoWhy && <div className="md-brief-hint">{logoWhy}</div>}
            {role === 'reference' && <div className="md-brief-hint">Used as the style reference below. Not printed.</div>}
          </>
        ) : <div className="md-brief-hint">The client didn&apos;t upload an image.</div>}
        {live && live.image_changed && <div className="md-brief-edited">The client image changed since this draft.</div>}
      </Section>

      <Section label="Style reference" note="Optional · never printed">
        {ref ? (
          <div className="md-ref-row">
            <span className="md-ref-name md-num">
              {ref.name}
              {ref.held && <span className="md-ref-held">Applies when you start over</span>}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" disabled={locked} onClick={ref.remove}>Remove</button>
          </div>
        ) : (
          <div className={over ? 'md-drop is-over' : 'md-drop'}
            onDragOver={(e) => { e.preventDefault(); setOver(!locked); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); if (!locked) take(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); }}>
            <span>Drop an image to steer the style</span>
            <button type="button" className="btn btn-secondary btn-sm" disabled={locked} onClick={() => fileRef.current && fileRef.current.click()}>Upload</button>
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden aria-label="Style reference image"
          onChange={(e) => { take(e.target.files && e.target.files[0]); e.target.value = ''; }} />
        {error && <p className="chip danger md-alert" role="alert">{error}</p>}
      </Section>

      <Section label="Art direction">
        <textarea className="input md-brief-dir" rows={3} maxLength={ART_DIRECTION_MAX} aria-label="Art direction" readOnly={locked}
          placeholder="e.g. watercolor, moody, gold accents" value={typeof inp.art_direction === 'string' ? inp.art_direction : ''}
          onChange={(e) => setInputs({ art_direction: e.target.value })} />
      </Section>
    </div>
  );
}

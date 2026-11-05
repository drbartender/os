// BriefTab (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React, { useRef, useState } from 'react';
import { ART_DIRECTION_MAX } from './menuEdits';
import { Section, Seg, isObj, hasLiveDraft, isReadOnly } from './panelParts';

// The editor's Brief tab (spec 2026-10-01 sections 4.3 and 9; 11.1, Brief tab).
// Props (the editor's panel contract): draft, content, inputs (the draft's, or
// the hook's pre-draft brief), brief (the GET's), diff, plannerImage (null or
// { url }), referenceFile and onReferenceFile(file | null) (the hook's held
// upload), onPatch({ content?, inputs? }), wordsDone and readOnly. Never inert:
// the brief is set before the first Generate. On a read-only draft (no plan)
// it is shown but every control is off and nothing PATCHes.
// - Client brief, read-only; a field the client edited since the draft is
//   tinted and labeled "Edited by client" (no time: the plan stores none).
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

export default function BriefTab({
  draft, content, inputs, brief, diff, plannerImage = null, referenceFile = null, onReferenceFile, onPatch, wordsDone = false,
  readOnly,
}) {
  const fileRef = useRef(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
  const hasDraft = isObj(draft);
  const c = isObj(content) ? content : (hasDraft && isObj(draft.content) ? draft.content : {});
  const inp = isObj(inputs) ? inputs : (hasDraft && isObj(draft.inputs) ? draft.inputs : {});
  const b = isObj(brief) ? brief : {};
  const live = isObj(diff) && !diff.dismissed && !(hasDraft && draft.read_only) ? diff : null;
  const edited = new Set(live && Array.isArray(live.brief_edited) ? live.brief_edited : []);
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

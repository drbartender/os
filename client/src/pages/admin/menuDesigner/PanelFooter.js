// PanelFooter (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React, { useEffect } from 'react';
import Icon from '../../../components/adminos/Icon';
import { Seg, isObj, hasLiveDraft } from './panelParts';
import { defaultImageModel } from './menuCardState';

// The editor's panel footer, fixed below the tabs (spec 2026-10-01 section
// 11.1, Panel footer; decision 11).
// Props: draft, configured, imageModel ('openai' | 'gemini'), onImageModel(model),
// onGenerate(), busy, gate.
// - Image model: GPT Image first, then Gemini; the hook opens at the read
//   model's default_image_model (Gemini when its key is set; spec 2026-10-19
//   section 16). Each option is disabled and titled "<name> isn't set up"
//   without its key, and a choice whose key is gone falls back to that
//   default.
// - Generate (primary) with no draft, Start over (secondary) once one exists.
// - gate is menuCardState(...).generate ({ disabled, hint, need }), computed
//   with the editor's imageModel and approving in local: disabled when not set
//   up, with no drinks, while drafting or approving, and when the images it
//   needs pass cap.remaining; the hint under the button says which.
// onGenerate is called on a click; with a draft the editor confirms Start over
// first ("Uses about <gate.need> images").

const MODELS = [['openai', 'GPT Image'], ['gemini', 'Gemini']];

export default function PanelFooter({ draft, configured, imageModel = 'openai', onImageModel, onGenerate, busy = false, gate }) {
  const live = hasLiveDraft(draft);
  const g = isObj(gate) ? gate : { disabled: true, hint: '' };
  // Gemini is offered only on its key; GPT Image unless the server says its key is gone.
  const c = isObj(configured) ? configured : {};
  const on = (m) => (m === 'gemini' ? c.gemini === true : c.openai !== false);
  const fallback = defaultImageModel(configured);
  const stale = !on(imageModel) && on(fallback);
  useEffect(() => {
    if (stale && typeof onImageModel === 'function') onImageModel(fallback);
  }, [stale, fallback, onImageModel]);
  const options = MODELS.map(([m, name]) => [m, name, on(m) ? {} : { disabled: true, title: `${name} isn't set up` }]);
  let shown = 'openai';
  if (on(imageModel)) shown = imageModel;
  else if (stale) shown = fallback;
  const label = busy ? (live ? 'Starting over...' : 'Generating...') : (live ? 'Start over' : 'Generate');
  return (
    <div className="md-panel-foot">
      <div className="md-foot-model">
        <span>Image model</span>
        <Seg label="Image model" options={options} value={shown}
          onChange={(v) => { if (typeof onImageModel === 'function') onImageModel(v); }} />
      </div>
      <button type="button" className={live ? 'btn btn-secondary md-foot-gen' : 'btn btn-primary md-foot-gen'}
        disabled={!!g.disabled || !!busy} onClick={() => { if (typeof onGenerate === 'function') onGenerate(); }}>
        <Icon name="sparkles" size={13} />{label}
      </button>
      {g.hint && <div className="md-foot-hint">{g.hint}</div>}
    </div>
  );
}

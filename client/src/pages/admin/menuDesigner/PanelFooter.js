import React, { useEffect } from 'react';
import Icon from '../../../components/adminos/Icon';
import { Seg, isObj, hasLiveDraft } from './panelParts';

// The editor's panel footer, fixed below the tabs (spec 2026-10-01 section
// 11.1, Panel footer; decision 11).
// Props: draft, configured, imageModel ('openai' | 'gemini'), onImageModel(model),
// onGenerate(), busy, gate.
// - Image model: GPT Image first (the hook opens at it), Gemini disabled and
//   titled "Gemini isn't set up" without its key; a Gemini choice whose key is
//   gone falls back to GPT Image.
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
  const gemini = isObj(configured) && configured.gemini === true;
  const noGemini = isObj(configured) && configured.gemini === false;
  useEffect(() => {
    if (imageModel === 'gemini' && noGemini && typeof onImageModel === 'function') onImageModel('openai');
  }, [imageModel, noGemini, onImageModel]);
  const options = [MODELS[0], [...MODELS[1], gemini ? {} : { disabled: true, title: "Gemini isn't set up" }]];
  const label = busy ? (live ? 'Starting over...' : 'Generating...') : (live ? 'Start over' : 'Generate');
  return (
    <div className="md-panel-foot">
      <div className="md-foot-model">
        <span>Image model</span>
        <Seg label="Image model" options={options} value={imageModel === 'gemini' && gemini ? 'gemini' : 'openai'}
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

import React, { forwardRef } from 'react';
import Icon from '../../../components/adminos/Icon';
import StatusChip from '../../../components/adminos/StatusChip';

// The bar menu editor's status surfaces, each drawn from menuCardState (spec
// 2026-10-01 section 11.1; tables B and E).
//
// EditorBanner({ banner, onAction, busy, busyLabel }): one table B banner, a
//   rounded row with a 7 px tone dot, a 600 title and the --ink-2 text, then up
//   to two small buttons (a ghost, then a secondary). The tones (ok, warn,
//   danger, info) are built on StatusChip's fixed hues in index.css, so a
//   banner always matches the chip beside it (table D, item 8); neutral is the
//   plain surface. Two or more stack in .md-ed-banners. busy is the id of the
//   button whose action runs (every button waits meanwhile, that one says so).
// EditorEmpty({ empty, height, onAction, busy, busyLabel, generate }): table
//   E's dashed card in the canvas's place; Generate waits on generate.disabled.
// EditorTopBar (ref: the back button): the 56 px bar. The back button with the
//   event's label (backDisabled while Approve runs), "Bar menu" and the chip, the save text (Not saved in danger,
//   then Retry), and Approve with its label, disabled state and reason (title).

const TONES = new Set(['ok', 'warn', 'danger', 'info', 'neutral']);
const STYLE = { ghost: 'btn btn-ghost btn-sm', secondary: 'btn btn-secondary btn-sm', primary: 'btn btn-primary btn-sm' };
const say = (b, busy, busyLabel) => (busy === b.id ? (busyLabel ? busyLabel(b) : 'Working...') : b.label);

export default function EditorBanner({ banner, onAction, busy = null, busyLabel }) {
  if (!banner) return null;
  const tone = TONES.has(banner.tone) ? banner.tone : 'neutral';
  const buttons = Array.isArray(banner.buttons) ? banner.buttons.slice(0, 2) : [];
  return (
    <div className={`md-banner md-banner-${tone}`} role={tone === 'danger' ? 'alert' : 'status'} data-banner={banner.id}>
      <span className="md-banner-dot" aria-hidden="true" />
      <div className="md-banner-body">
        <strong className="md-banner-title">{banner.title}</strong>{' '}
        <span className="md-banner-text">{banner.text}</span>
      </div>
      {buttons.map((b) => (
        <button key={b.id} type="button" className={STYLE[b.style] || STYLE.secondary} disabled={!!busy}
          onClick={() => onAction && onAction(b, banner)}>
          {say(b, busy, busyLabel)}
        </button>
      ))}
    </div>
  );
}

export function EditorEmpty({ empty, height, onAction, busy = null, busyLabel, generate }) {
  if (!empty) return null;
  const b = empty.button;
  const held = !!(b && b.id === 'generate' && generate && generate.disabled);
  return (
    <div className="md-ed-empty" style={{ height }} data-empty={empty.id}>
      <div className="md-ed-empty-title">{empty.title}</div>
      <div className="md-ed-empty-text">{empty.text}</div>
      {b && (
        <button type="button" className={b.style === 'primary' ? 'btn btn-primary' : 'btn btn-secondary'}
          disabled={!!busy || held} title={held ? generate.hint : undefined} onClick={() => onAction && onAction(b)}>
          {say(b, busy, busyLabel)}
        </button>
      )}
    </div>
  );
}

export const EditorTopBar = forwardRef(function EditorTopBar({
  label, chip, saveText, saveFailed, onBack, backDisabled = false, onRetrySave, retryLabel = 'Retry', approve, onApprove, busy = false,
}, backRef) {
  return (
    <div className="md-ed-top">
      <button ref={backRef} type="button" className="btn btn-ghost btn-sm md-ed-back" onClick={onBack} disabled={backDisabled}>
        <Icon name="left" size={13} /><span className="md-ed-back-label">{label}</span>
      </button>
      <span className="md-ed-div" aria-hidden="true" />
      <h2 className="md-ed-title">Bar menu</h2>
      {chip && <StatusChip kind={chip.kind}>{chip.text}</StatusChip>}
      <span className="md-ed-spacer" />
      <span className={saveFailed ? 'md-ed-save is-failed' : 'md-ed-save'} role="status">{saveText}</span>
      {saveFailed && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onRetrySave}>{retryLabel}</button>}
      <span className="md-ed-div md-ed-div-tall" aria-hidden="true" />
      <button type="button" className="btn btn-primary" disabled={approve.disabled} title={approve.why || undefined} onClick={onApprove}>
        {approve.label}
      </button>
    </div>
  );
});

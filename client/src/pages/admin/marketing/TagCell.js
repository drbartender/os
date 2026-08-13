import React, { useEffect, useRef, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import { MARKETING_TAGS, DERIVED_STATES, tagLabel } from '../../../utils/marketingTags';
import { HELD_BACK_LABELS, heldBackLabel, errorText } from './marketingFormat';

/**
 * The contact's marketing tags, with an inline picker.
 *
 * Writes are OPTIMISTIC. Classifying several hundred contacts by hand is a long
 * grind and a round trip per click makes it unusable, so the chip flips
 * immediately and rolls back with a toast if the save fails. A silent failed
 * save would be far worse than a slow one, which is why the rollback path is
 * explicit rather than a bare catch.
 *
 * DO_NOT_CONTACT_ID is deliberately absent from the picker. It carries a
 * required reason and its removal takes a confirmation, so it has its own
 * control and its own endpoint. It renders here as a chip only.
 */
export default function TagCell({ contact, onTagsChange }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const wrapRef = useRef(null);

  const tags = contact.tags || [];
  const excluded = contact.do_not_contact;
  // Held-back contacts cannot be tagged. Tags exist to build campaign
  // audiences, and someone who cannot receive one is not worth classifying
  // until whatever holds them back is resolved. Mailability itself is never
  // affected by a tag, so this is a workflow guard, not a safety one.
  const locked = contact.mailable === false;

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const commit = async (next, previous) => {
    setSaving(true);
    onTagsChange(contact.id, next);            // optimistic
    try {
      const res = await api.put(`/marketing/contacts/${contact.id}/tags`, { tags: next });
      // Trust the server's ordering, which is vocabulary order, not click order.
      onTagsChange(contact.id, res.data.tags);
    } catch (err) {
      onTagsChange(contact.id, previous);      // rollback
      toast.error(errorText(err, 'Could not save tags. Nothing was changed.'));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (id) => {
    const previous = tags;
    const next = tags.includes(id) ? tags.filter(t => t !== id) : [...tags, id];
    commit(next, previous);
  };

  const acceptSuggestion = () => {
    const s = contact.suggestion;
    if (!s) return;
    commit([...tags, s.tag], tags);
  };

  return (
    <div className="mkt-tagcell" ref={wrapRef}>
      <div className="mkt-chips">
        {excluded && (
          <span className="mkt-chip mkt-chip-danger" title={contact.do_not_contact_reason || ''}>
            {/* NOT tagLabel(DO_NOT_CONTACT_ID): that id is deliberately absent
                from MARKETING_TAGS, so tagLabel falls through to returning the
                raw slug and the chip reads "do-not-contact". */}
            {HELD_BACK_LABELS.do_not_contact}
          </span>
        )}
        {tags.map(t => <span key={t} className="mkt-chip">{tagLabel(t)}</span>)}
        {tags.length === 0 && !excluded && (
          <span className="mkt-chip mkt-chip-muted">{DERIVED_STATES.untagged}</span>
        )}
        {/* Derived state sits beside the human tags but is visually distinct,
            because nobody can set or remove it. */}
        {contact.derived && DERIVED_STATES[contact.derived] && (
          <span className="mkt-chip mkt-chip-derived">{DERIVED_STATES[contact.derived]}</span>
        )}
        {!contact.mailable && contact.held_back_reason && !excluded && (
          <span className="mkt-chip mkt-chip-muted">{heldBackLabel(contact.held_back_reason)}</span>
        )}
        <button
          type="button"
          className="mkt-tag-edit"
          onClick={() => setOpen(o => !o)}
          disabled={saving || locked}
          title={locked ? 'Held back, so tagging is disabled' : undefined}
          aria-expanded={open}
          aria-label={`Edit tags for ${contact.name || contact.email}`}
        >
          {saving ? 'Saving…' : 'Edit'}
        </button>
      </div>

      {contact.suggestion && (
        <div className="mkt-suggestion">
          <span>{contact.suggestion.reason}</span>
          <button type="button" className="btn-link" onClick={acceptSuggestion} disabled={saving || locked}>
            Tag {tagLabel(contact.suggestion.tag)}
          </button>
        </div>
      )}

      {open && (
        <div className="mkt-tag-menu" role="menu">
          {MARKETING_TAGS.map(t => (
            <label key={t.id} className="mkt-tag-option">
              <input
                type="checkbox"
                checked={tags.includes(t.id)}
                disabled={saving}
                onChange={() => toggle(t.id)}
              />
              <span>{t.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

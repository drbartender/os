import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import api from '../../utils/api';
import { PUBLIC_SITE_URL } from '../../utils/constants';
import { useToast } from '../../context/ToastContext';
import NeedsRecipeSection from './NeedsRecipeSection';
import SendModal from '../SendModal';
import DerivationStrip, { ClientPreview } from './DerivationStrip';

// Editor / Client-view segmented toggle button styling. Active reads as an
// accent-soft pill; inactive is quiet. Skin-safe (no hard-coded contrast pair).
const segBtn = (active) => ({
  background: active ? 'var(--accent-soft)' : 'transparent',
  color: active ? 'var(--accent)' : 'var(--ink-3)',
  border: 'none',
  padding: '0.3rem 0.75rem',
  fontSize: '0.78rem',
  fontWeight: active ? 600 : 400,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
});

// Regenerating pulls a fresh list from the server (the live par catalog) and
// discards manual edits; saving an already-approved list returns it to review.
// This copy gates every regenerate entry point (Reset + guest-count change).
const REGEN_CONFIRM = 'Regenerate replaces your edits, and saving will set the list back to Needs review. Continue?';

export default function ShoppingListModal({ listData, onClose, planId, planToken, initialApproveStatus = 'idle' }) {
  const toast = useToast();
  const [edited, setEdited] = useState(() => deepClone(listData));
  const [guestCount, setGuestCount] = useState(listData.guestCount);
  const [downloading, setDownloading] = useState(false);
  const [pdfError, setPdfError] = useState('');
  const [undoStack, setUndoStack] = useState([]);
  const [saveStatus, setSaveStatus] = useState('saved'); // 'saved' | 'saving' | 'unsaved'
  const [linkCopied, setLinkCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState('');
  // 'edit' shows the editable instrumented list; 'preview' shows exactly the
  // plain-language copy the client reads at /shopping-list/:token.
  const [mode, setMode] = useState('edit');
  // Set after a regenerate that held one or more admin-set quantities, so the
  // hold (HARD REQ #2) is visible instead of silent. Cleared on the next regen.
  const [heldNotice, setHeldNotice] = useState(null);
  // Approve state is seeded by the parent (ShoppingListButton already fetched
  // /shopping-list to load the saved list — it passes status here so we don't
  // duplicate the request on mount).
  const [approveStatus, setApproveStatus] = useState(initialApproveStatus); // 'idle' | 'saving' | 'approved'
  const [approveError, setApproveError] = useState('');
  // Compose-first send flow: the SendModal handles channel choice, message
  // edits, and the actual approve+send; lastSend keeps its per-channel result
  // so the button copy can tell the truth ("Approved, email FAILED").
  const [sendOpen, setSendOpen] = useState(false);
  const [lastSend, setLastSend] = useState(null);
  // Set true once the list has been approved and then edited back to review
  // this modal session; it stays true so the re-armed button reads
  // "Re-approve & Send" instead of the first-time "Approve & Send" copy.
  const [wasApproved, setWasApproved] = useState(false);
  const isFirstRender = useRef(true);
  const saveTimer = useRef(null);
  // Mirror approveStatus into a ref so the debounced auto-save closure reads
  // the current value (the timer captures state from when it was scheduled).
  const approveStatusRef = useRef(approveStatus);
  useEffect(() => { approveStatusRef.current = approveStatus; }, [approveStatus]);

  function deepClone(d) {
    const uid = () => typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    return {
      ...d,
      liquorBeerWine: d.liquorBeerWine.map(r => ({ ...r, _id: r._id || uid() })),
      everythingElse: d.everythingElse.map(r => ({ ...r, _id: r._id || uid() })),
    };
  }

  // Generation-run diagnostics (_unresolvedIngredients, _signatureCocktails,
  // _syrupSelfProvided) never ride a save; the server strips them too.
  const stripGenerationKeys = (list) =>
    Object.fromEntries(Object.entries(list).filter(([k]) => !k.startsWith('_')));

  // Pending debounced save payload: set when a debounce is armed, cleared on a
  // successful save. The unmount effect below flushes it so closing the modal
  // within the debounce window never drops the last edit.
  const pendingSaveRef = useRef(null);

  // Auto-save with debounce
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!planId) return;

    setSaveStatus('unsaved');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const payload = { edited, guestCount };
    pendingSaveRef.current = payload;
    saveTimer.current = setTimeout(async () => {
      setSaveStatus('saving');
      try {
        await api.put(`/drink-plans/${planId}/shopping-list`, {
          shopping_list: {
            ...stripGenerationKeys(edited),
            guestCount: parseInt(guestCount, 10) || edited.guestCount,
          },
        });
        // Identity-guarded clear: an edit made while this PUT was in flight
        // armed a NEWER payload, and nulling it here would let a fast modal
        // close drop that edit (the unmount flush would see nothing pending).
        if (pendingSaveRef.current === payload) pendingSaveRef.current = null;
        setSaveStatus('saved');
        // The server reverts an approved list to pending_review on any edit
        // (drinkPlans.js), hiding it from the client. Re-arm the approve
        // button so the admin can re-approve and re-send the updated list.
        if (approveStatusRef.current === 'approved') {
          setApproveStatus('idle');
          setWasApproved(true);
        }
      } catch (err) {
        // A failed save leaves the button state as-is (the server never
        // reverted the list); the next successful save re-arms it.
        console.error('Auto-save failed:', err);
        setSaveStatus('unsaved');
      }
    }, 1500);

    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edited, guestCount, planId]);

  // Unmount: flush a pending debounced save instead of dropping it (fire and
  // forget; the modal is gone, but the edit must not be). Flushing an APPROVED
  // list reverts it to review server-side; the toast makes that visible since
  // the re-approve button unmounted with the modal.
  useEffect(() => () => {
    const pending = pendingSaveRef.current;
    if (!pending || !planId) return;
    const wasApprovedAtFlush = approveStatusRef.current === 'approved';
    api.put(`/drink-plans/${planId}/shopping-list`, {
      shopping_list: {
        ...stripGenerationKeys(pending.edited),
        guestCount: parseInt(pending.guestCount, 10) || pending.edited.guestCount,
      },
    }).then(() => {
      if (wasApprovedAtFlush) {
        toast.info('List saved and returned to review. Re-approve to publish the update to the client.');
      }
    }).catch((err) => {
    console.error('Flush-on-close save failed:', err);
    // The modal is gone; the toast is the only surface left to say the
    // final edit did not land.
    toast.error('Your last shopping-list edit failed to save.');
  });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Regenerate from the server (live par catalog); the client-side generator
  // mirror is retired. Replaces manual edits, so each call site gates it behind
  // window.confirm (REGEN_CONFIRM), matching the old Reset/guest-count pattern.
  const regenerate = useCallback(async (count) => {
    if (!planId) return;
    setRegenerating(true);
    setRegenError('');
    try {
      const n = parseInt(count, 10);
      const body = {};
      if (n > 0) body.guest_count_override = n;
      const res = await api.post(`/drink-plans/${planId}/shopping-list/regenerate`, body);
      const fresh = res.data.list;
      // The server list omits the display-only event-type label; carry it over.
      if (!fresh.eventTypeLabel && listData.eventTypeLabel) fresh.eventTypeLabel = listData.eventTypeLabel;
      setEdited(deepClone(fresh));
      if (n > 0) setGuestCount(n);
      setUndoStack([]);
      // Surface any admin-set quantities the server held onto the fresh list
      // (applyAdminSetHolds marks them admin_set) so the hold is not silent.
      const held = [...(fresh.liquorBeerWine || []), ...(fresh.everythingElse || [])]
        .filter(i => i.admin_set);
      setHeldNotice(held.length > 0
        ? { count: held.length, names: held.map(i => `${i.item} (${i.qty})`) }
        : null);
    } catch (err) {
      setRegenError(err?.message || 'Failed to regenerate. Try again.');
    } finally {
      setRegenerating(false);
    }
  }, [planId, listData]);

  const handleGuestCountChange = (val) => {
    setGuestCount(val);
  };

  const handleGuestCountBlur = () => {
    const count = parseInt(guestCount, 10);
    if (count > 0 && count !== edited.guestCount) {
      if (window.confirm(REGEN_CONFIRM)) {
        regenerate(count);
      }
    }
  };

  const updateItem = (section, index, field, value) => {
    setEdited(prev => {
      const next = deepClone(prev);
      const row = { ...next[section][index], [field]: field === 'qty' ? (parseInt(value, 10) || 0) : value };
      // A hand-set quantity is deliberate admin judgment: mark it so a later
      // regenerate HOLDS it instead of clobbering it (server applyAdminSetHolds
      // reads this `admin_set` flag; it rides the saved blob, not a _underscore
      // diagnostic). Only quantity edits set the marker (HARD REQ #2).
      if (field === 'qty') row.admin_set = true;
      next[section][index] = row;
      return next;
    });
  };

  const removeItem = (section, index) => {
    setEdited(prev => {
      const next = deepClone(prev);
      const removed = next[section][index];
      setUndoStack(stack => [...stack, { section, index, item: { ...removed } }]);
      next[section] = next[section].filter((_, i) => i !== index);
      return next;
    });
  };

  const undoLastDelete = () => {
    setUndoStack(stack => {
      if (stack.length === 0) return stack;
      const newStack = [...stack];
      const last = newStack.pop();
      setEdited(prev => {
        const next = deepClone(prev);
        const insertAt = Math.min(last.index, next[last.section].length);
        next[last.section].splice(insertAt, 0, { ...last.item });
        return next;
      });
      return newStack;
    });
  };

  const addItem = (section) => {
    const uid = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    setEdited(prev => {
      const next = deepClone(prev);
      next[section] = [...next[section], { _id: uid, item: '', size: '', qty: 1 }];
      return next;
    });
  };

  const handleDragEnd = (section) => (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setEdited(prev => {
      const next = deepClone(prev);
      const items = next[section];
      const oldIndex = items.findIndex(i => i._id === active.id);
      const newIndex = items.findIndex(i => i._id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      next[section] = arrayMove(items, oldIndex, newIndex);
      return next;
    });
  };

  const handleDownload = async () => {
    setDownloading(true);
    setPdfError('');
    try {
      const finalData = {
        ...edited,
        guestCount: parseInt(guestCount, 10) || edited.guestCount,
        eventTypeLabel: edited.eventTypeLabel || listData.eventTypeLabel,
      };
      // Dynamic-import the PDF generator (which carries the embedded logo
      // + jspdf) so admins who never download a PDF don't pay that cost.
      const { generateShoppingListPDF } = await import('./ShoppingListPDF');
      const blob = await generateShoppingListPDF(finalData);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `DRB_ShoppingList_${(edited.clientName || 'Event').replace(/\s+/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('PDF generation failed:', err);
      setPdfError('PDF generation failed. Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  const handleShareLink = () => {
    if (!planToken) return;
    const url = `${PUBLIC_SITE_URL}/shopping-list/${planToken}`;
    navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }).catch(() => {
      window.prompt('Copy this link:', url);
    });
  };

  // Compose-first approve (spec 4.4): save the on-screen state synchronously,
  // then open the SendModal. The status flip and the email both happen on the
  // modal's confirm (POST /comms/send); Cancel there means nothing happened.
  const handleOpenSend = async () => {
    if (!planId) return;
    // Flush any pending auto-save so the version that goes out matches what
    // admin sees on screen.
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    // Clear BEFORE the await: this PUT carries the current edited state, so
    // nothing is pending anymore; clearing after would clobber a payload
    // armed by an edit made while the PUT was in flight.
    const approvePayload = { edited, guestCount };
    pendingSaveRef.current = null;
    setApproveStatus('saving');
    setApproveError('');
    try {
      await api.put(`/drink-plans/${planId}/shopping-list`, {
        shopping_list: {
          ...stripGenerationKeys(edited),
          guestCount: parseInt(guestCount, 10) || edited.guestCount,
        },
      });
      setSaveStatus('saved');
      setApproveStatus('idle');
      setSendOpen(true);
    } catch (err) {
      console.error('Pre-send save failed:', err);
      // Restore the flush safety net (the save may not have landed), unless
      // an in-flight edit already armed a newer payload.
      if (!pendingSaveRef.current) pendingSaveRef.current = approvePayload;
      setApproveStatus('idle');
      setApproveError(err?.message || 'Failed to save before sending. Try again.');
    }
  };

  // Fires only after the SendModal's confirm resolved (any outcome). A Cancel
  // never calls this, so approve state only advances when the server really
  // flipped the status (side effects are idempotent server-side).
  const handleSendComplete = (results) => {
    if (results && results.ok) {
      setLastSend(results);
      setApproveStatus('approved');
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  const saveIndicator = saveStatus === 'saving' ? 'Saving...'
    : saveStatus === 'saved' ? 'Saved'
    : 'Unsaved';
  // Admin-os semantic colors (skin-aware via the html[data-app=admin-os] cascade).
  const saveColor = saveStatus === 'saved' ? 'hsl(var(--ok-h) var(--ok-s) 42%)'
    : saveStatus === 'saving' ? 'var(--ink-3)'
    : 'hsl(var(--danger-h) var(--danger-s) 55%)';

  // Approve button copy. Once the list was approved and edited back to review,
  // the re-armed button reads "Re-approve & Send" and its tooltip warns that
  // the client is currently on the pending screen until it is re-sent.
  // Approved copy tells the per-channel truth from the last send (spec 4.6):
  // an approved list whose email failed or was skipped never reads "& Sent".
  const approvedLabel = !lastSend ? '✓ Approved & Sent'
    : lastSend.email === 'sent' ? '✓ Approved & Sent'
    : lastSend.email === 'failed' ? '✓ Approved, email FAILED'
    : '✓ Approved (no email)';
  const approveLabel = approveStatus === 'saving' ? 'Saving…'
    : approveStatus === 'approved' ? approvedLabel
    : wasApproved ? 'Re-approve & Send'
    : 'Approve & Send to Client';
  const approveTitle = approveStatus === 'approved'
    ? (lastSend && lastSend.email === 'failed'
        ? `Approved, but the email did not go out: ${lastSend.email_error || 'unknown error'}. Reopen to retry.`
        : lastSend && lastSend.email === 'skipped'
          ? `Approved. Email skipped: ${(lastSend.skip_reasons && lastSend.skip_reasons.email) || 'no email applies'}.`
          : 'Already approved, client can now see this list')
    : wasApproved
      ? 'Your edits set this list back to Needs review, so the client sees the pending screen. Re-approve to send them the updated list.'
      : 'Review the message and recipient, then approve and send';

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      backgroundColor: 'rgba(0,0,0,0.6)',
      display: 'flex', flexDirection: 'column',
      overflowY: 'auto',
      paddingTop: 'calc(60px + 1.5rem)',
    }}>
      <div style={{
        backgroundColor: 'var(--bg-elev)',
        margin: '0 auto 1.5rem',
        width: '100%',
        maxWidth: 960,
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-pop)',
        border: '1px solid var(--line-2)',
        display: 'flex',
        flexDirection: 'column',
      }}>

        {/* ── Modal Header ── */}
        <div style={{
          backgroundColor: 'transparent',
          borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
          padding: '0.875rem 1.25rem',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
          borderBottom: '1px solid var(--line-2)',
        }}>
          <div style={{ flex: 1 }}>
            <p style={{ color: 'var(--ink-1)', fontFamily: 'var(--font-display)', fontSize: '1.1rem', margin: 0 }}>
              {edited.clientName || 'Shopping List'}
            </p>
            {edited.eventDate && (
              <p style={{ color: 'var(--ink-3)', fontSize: '0.8rem', margin: '2px 0 0', fontStyle: 'italic' }}>
                {new Date(edited.eventDate).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
            )}
          </div>
          <div style={{
            display: 'inline-flex',
            border: '1px solid var(--line-2)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
          }}>
            <button onClick={() => setMode('edit')} style={segBtn(mode === 'edit')}>Editor</button>
            <button onClick={() => setMode('preview')} style={segBtn(mode === 'preview')}>Client view</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <label style={{ color: 'var(--ink-2)', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>Guests:</label>
            <input
              type="number"
              min="1"
              value={guestCount}
              onChange={e => handleGuestCountChange(e.target.value)}
              onBlur={handleGuestCountBlur}
              style={{
                width: 64, padding: '0.3rem 0.5rem', borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--line-2)', backgroundColor: 'var(--bg-3)',
                color: 'var(--ink-1)', fontSize: '0.9rem', textAlign: 'center',
              }}
            />
          </div>
          {planId && (
            <span style={{ color: saveColor, fontSize: '0.72rem', fontStyle: 'italic', whiteSpace: 'nowrap' }}>
              {saveIndicator}
            </span>
          )}
          {undoStack.length > 0 && (
            <button
              className="btn btn-sm btn-primary"
              onClick={undoLastDelete}
              style={{ whiteSpace: 'nowrap' }}
              title={`Undo (${undoStack.length} item${undoStack.length > 1 ? 's' : ''})`}
            >
              Undo ({undoStack.length})
            </button>
          )}
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => { if (window.confirm(REGEN_CONFIRM)) regenerate(guestCount); }}
            disabled={regenerating}
            style={{ whiteSpace: 'nowrap' }}
          >
            {regenerating ? 'Regenerating…' : 'Regenerate'}
          </button>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--ink-2)',
            fontSize: '1.4rem', cursor: 'pointer', lineHeight: 1, padding: '0 0.25rem',
          }}>×</button>
        </div>

        {/* ── Editor: derivation strip + editable body ── */}
        {mode === 'edit' && (
          <>
            <DerivationStrip derivation={edited._derivation} />
            {heldNotice && (
              <div style={{
                margin: '1rem 1.25rem 0',
                background: 'var(--accent-soft)',
                border: '1px solid var(--accent-line)',
                borderRadius: 'var(--radius)',
                padding: '0.55rem 0.875rem',
                display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap',
              }}>
                <span className="chip accent"><span className="chip-dot" />Regenerated</span>
                <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                  Fresh list pulled from the live par catalog.{' '}
                  <span style={{ color: 'var(--ink-1)', fontWeight: 600 }}>
                    {heldNotice.count} admin-set {heldNotice.count === 1 ? 'quantity was' : 'quantities were'} held:
                  </span>{' '}
                  {heldNotice.names.join(', ')}.
                </span>
              </div>
            )}
            {/* ── Two-column editable body ── */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '1.5rem',
              padding: '1.25rem',
            }}>
          <EditableSection
            title="Liquor · Beer · Wine"
            items={edited.liquorBeerWine}
            onUpdate={(i, f, v) => updateItem('liquorBeerWine', i, f, v)}
            onRemove={(i) => removeItem('liquorBeerWine', i)}
            onAdd={() => addItem('liquorBeerWine')}
            onDragEnd={handleDragEnd('liquorBeerWine')}
            sensors={sensors}
          />
          <EditableSection
            title="Everything Else"
            items={edited.everythingElse}
            onUpdate={(i, f, v) => updateItem('everythingElse', i, f, v)}
            onRemove={(i) => removeItem('everythingElse', i)}
            onAdd={() => addItem('everythingElse')}
            onDragEnd={handleDragEnd('everythingElse')}
            sensors={sensors}
          />
        </div>

        {/* ── Signature cocktails reference (read-only) ── */}
        {edited.signatureCocktailNames && edited.signatureCocktailNames.length > 0 && (
          <div style={{
            margin: '0 1.25rem',
            backgroundColor: 'var(--bg-2)',
            border: '1px solid var(--line-2)',
            borderRadius: 'var(--radius)',
            padding: '0.5rem 0.875rem',
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}>
            <span style={{ color: 'var(--ink-3)', fontSize: '0.78rem', fontStyle: 'italic', whiteSpace: 'nowrap' }}>
              Signature Cocktails:
            </span>
            <span style={{ color: 'var(--ink-1)', fontSize: '0.82rem' }}>
              {edited.signatureCocktailNames.join('  ·  ')}
            </span>
          </div>
        )}

            {/* ── Client-requested drinks with no recipe yet + recipe drawer ── */}
            <NeedsRecipeSection
              needsRecipe={edited.needsRecipe}
              unresolved={edited._unresolvedIngredients}
              onRegenerate={() => regenerate(guestCount)}
            />
          </>
        )}

        {/* ── Client-view preview (1:1 copy with the public page) ── */}
        {mode === 'preview' && (
          <ClientPreview
            list={edited}
            clientName={edited.clientName}
            guestCount={parseInt(guestCount, 10) || edited.guestCount}
            eventDate={edited.eventDate}
            approved={approveStatus === 'approved'}
          />
        )}

        {/* ── Footer actions ── */}
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '0.75rem',
          padding: '1rem 1.25rem',
          borderTop: '1px solid var(--line-2)',
          marginTop: '1rem',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}>
          {/* Approve consequence line, states the Enhancement Lab window closes.
              The Lab ships in a later lane; the sentence is forward-true now. */}
          <div style={{ marginRight: 'auto', maxWidth: 440, fontSize: '0.75rem', color: 'var(--ink-3)', lineHeight: 1.45 }}>
            {approveStatus === 'approved'
              ? 'Published. The client link is live and their Enhancement Lab window is closed. Any edit returns this list to Needs review and hides it from the client.'
              : 'Approving publishes this list to the client and closes their Enhancement Lab window.'}
          </div>
          {pdfError && (
            <span style={{ color: 'hsl(var(--danger-h) var(--danger-s) 55%)', fontSize: '0.82rem' }}>{pdfError}</span>
          )}
          {approveError && (
            <span style={{ color: 'hsl(var(--danger-h) var(--danger-s) 55%)', fontSize: '0.82rem' }}>{approveError}</span>
          )}
          {regenError && (
            <span style={{ color: 'hsl(var(--danger-h) var(--danger-s) 55%)', fontSize: '0.82rem' }}>{regenError}</span>
          )}
          {planToken && (
            <button className="btn btn-sm btn-secondary" onClick={handleShareLink}>
              {linkCopied ? 'Link Copied!' : 'Share Client Link'}
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn" onClick={handleDownload} disabled={downloading}>
            {downloading ? 'Generating PDF...' : 'Download PDF'}
          </button>
          {planId && (
            <button
              className="btn btn-success"
              onClick={handleOpenSend}
              disabled={approveStatus !== 'idle' || sendOpen}
              title={approveTitle}
            >
              {approveLabel}
            </button>
          )}
        </div>
        {sendOpen && (
          <SendModal
            action="shopping_list_approve"
            entityId={planId}
            title="Approve & Send Shopping List"
            confirmLabel="Approve & Send"
            allowNoChannelConfirm
            noChannelConfirmLabel="Approve"
            noChannelNote="No send channel applies (the reasons above say why). Approving publishes the list without sending anything."
            onClose={() => setSendOpen(false)}
            onComplete={handleSendComplete}
          />
        )}
      </div>
    </div>,
    document.body
  );
}

function EditableSection({ title, items, onUpdate, onRemove, onAdd, onDragEnd, sensors }) {
  return (
    <div>
      {/* Section header */}
      <div style={{
        backgroundColor: 'var(--bg-2)',
        color: 'var(--ink-2)',
        fontSize: '0.78rem',
        textAlign: 'center',
        padding: '0.3rem 0.5rem',
        marginBottom: '0.25rem',
        borderRadius: 'var(--radius-sm)',
        fontFamily: 'var(--font-display)',
        letterSpacing: '0.05em',
      }}>
        {title}
      </div>

      {/* Column headers */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '20px 40px 60px 1fr 28px',
        gap: '0.25rem',
        backgroundColor: 'var(--bg-3)',
        padding: '0.3rem 0.4rem',
        borderBottom: '1px solid var(--line-2)',
        marginBottom: '0.125rem',
      }}>
        <span />
        {['Qty', 'Size', 'Item', ''].map(h => (
          <span key={h} style={{ color: 'var(--ink-3)', fontSize: '0.7rem', textAlign: h === 'Qty' ? 'center' : 'left' }}>{h}</span>
        ))}
      </div>

      {/* Item rows with drag-and-drop */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map(i => i._id)} strategy={verticalListSortingStrategy}>
          {items.map((row, i) => (
            <SortableRow
              key={row._id}
              row={row}
              index={i}
              onUpdate={onUpdate}
              onRemove={onRemove}
            />
          ))}
        </SortableContext>
      </DndContext>

      {/* Add item button */}
      <button
        onClick={onAdd}
        style={{
          width: '100%', marginTop: '0.375rem',
          background: 'none', border: '1px dashed var(--accent-line)',
          color: 'var(--accent)', fontSize: '0.78rem', cursor: 'pointer',
          borderRadius: 'var(--radius-sm)', padding: '0.3rem 0', textAlign: 'center',
        }}
      >
        + Add Item
      </button>
    </div>
  );
}

function SortableRow({ row, index, onUpdate, onRemove }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row._id });

  const style = {
    display: 'grid',
    gridTemplateColumns: '20px 40px 60px 1fr 28px',
    gap: '0.25rem',
    alignItems: 'center',
    padding: '0.2rem 0.4rem',
    backgroundColor: isDragging ? 'var(--accent-soft)' : index % 2 === 0 ? 'var(--bg-elev)' : 'var(--bg-2)',
    borderBottom: '0.5px solid var(--line-1)',
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.8 : 1,
    zIndex: isDragging ? 10 : undefined,
    cursor: isDragging ? 'grabbing' : undefined,
  };

  return (
    <div ref={setNodeRef} style={style}>
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        style={{
          background: 'none', border: 'none', cursor: 'grab',
          color: 'var(--ink-3)', fontSize: '0.8rem', lineHeight: 1, padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          touchAction: 'none',
        }}
        title="Drag to reorder"
      >⠿</button>
      <input
        type="number"
        min="0"
        value={row.qty}
        onChange={e => onUpdate(index, 'qty', e.target.value)}
        style={rowInput({
          textAlign: 'center', color: 'var(--accent)', fontWeight: 'bold',
          ...(row.admin_set ? { backgroundColor: 'var(--accent-soft)', borderRadius: 4 } : {}),
        })}
        title={row.admin_set ? 'Admin-set quantity, held on regenerate' : undefined}
      />
      <input
        value={row.size}
        onChange={e => onUpdate(index, 'size', e.target.value)}
        style={rowInput({ color: 'var(--ink-3)', fontSize: '0.78rem' })}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        <input
          value={row.item}
          onChange={e => onUpdate(index, 'item', e.target.value)}
          style={rowInput({ fontWeight: '600', color: 'var(--ink-1)', flex: 1, minWidth: 0, width: 'auto' })}
        />
        {row.admin_set && (
          <span className="chip accent" style={{ height: 16, fontSize: '9.5px', padding: '0 5px', whiteSpace: 'nowrap' }}>set</span>
        )}
      </div>
      <button
        onClick={() => onRemove(index)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--ink-3)', fontSize: '0.9rem', lineHeight: 1, padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        title="Remove"
      >×</button>
    </div>
  );
}

function rowInput(extra = {}) {
  return {
    width: '100%',
    border: 'none',
    backgroundColor: 'transparent',
    fontSize: '0.82rem',
    padding: '0.1rem 0.2rem',
    outline: 'none',
    ...extra,
  };
}

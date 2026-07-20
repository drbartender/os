import React, { useState, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import Icon from '../adminos/Icon';

// Lazy-load the modal so @dnd-kit and the PDF/jspdf graph stay out of the
// admin bundle for sessions where the Shopping List button is never clicked.
const ShoppingListModal = lazy(() => import('./ShoppingListModal'));

// className/style/iconSize let the caller match this to its sibling buttons
// (e.g. DrinkPlanCard renders it btn-sm + centered alongside its other rows;
// DrinkPlanDetail keeps the default full-size header button).
export default function ShoppingListButton({
  planId,
  planToken,
  className = 'btn btn-secondary',
  style,
  iconSize = 12,
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [guestCountPrompt, setGuestCountPrompt] = useState(false);
  const [manualGuests, setManualGuests] = useState('');
  const [modalData, setModalData] = useState(null);
  // Initial Approve & Send button state — passed to modal so it doesn't have
  // to re-fetch the same /shopping-list endpoint on mount.
  const [initialApproveStatus, setInitialApproveStatus] = useState('idle');
  const [initialEverApproved, setInitialEverApproved] = useState(false);

  const handleClick = async () => {
    setLoading(true);
    try {
      // Check for a saved shopping list first.
      const savedRes = await api
        .get(`/drink-plans/${planId}/shopping-list`)
        .catch(() => ({ data: { shopping_list: null } }));
      const saved = savedRes.data.shopping_list;
      // Snapshot the approve state up front so the modal can render the
      // correct button label without an extra round-trip.
      setInitialApproveStatus(savedRes.data.shopping_list_status === 'approved' ? 'approved' : 'idle');
      setInitialEverApproved(savedRes.data.ever_approved === true);

      if (saved) {
        // Use the saved list directly.
        setModalData(saved);
        return;
      }

      // No saved list — generate a fresh one on the server from the live par
      // catalog (the old client-side generator is retired).
      try {
        const res = await api.post(`/drink-plans/${planId}/shopping-list/regenerate`, {});
        setModalData(res.data.list);
      } catch (err) {
        // The endpoint returns 400 when the plan has no guest count anywhere
        // (no linked proposal); prompt the admin for one, then regenerate.
        if (err.status === 400) {
          setGuestCountPrompt(true);
          setManualGuests('');
        } else {
          throw err;
        }
      }
    } catch (err) {
      console.error('Failed to load shopping list data:', err);
      toast.error('Failed to load shopping list. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleGuestCountSubmit = async (e) => {
    e.preventDefault();
    const count = parseInt(manualGuests, 10);
    if (!count || count < 1) return;
    setGuestCountPrompt(false);
    setLoading(true);
    try {
      const res = await api.post(`/drink-plans/${planId}/shopping-list/regenerate`, {
        guest_count_override: count,
      });
      setModalData(res.data.list);
    } catch (err) {
      console.error('Failed to generate shopping list:', err);
      toast.error(err?.message || 'Failed to generate shopping list. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        className={className}
        style={style}
        onClick={handleClick}
        disabled={loading}
      >
        <Icon name="clipboard" size={iconSize} />{loading ? 'Loading…' : 'Shopping List'}
      </button>

      {/* Guest count prompt when no proposal is linked */}
      {guestCountPrompt && createPortal(
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          paddingTop: '60px',
        }}>
          <div className="card" style={{ maxWidth: 340, width: '100%', margin: '1rem' }}>
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>
              Guest Count
            </h3>
            <p className="text-muted text-small mb-1">
              No proposal is linked to this plan. Enter the guest count to scale the list.
            </p>
            <form onSubmit={handleGuestCountSubmit}>
              <input
                type="number"
                className="form-input mb-1"
                placeholder="e.g. 75"
                min="1"
                value={manualGuests}
                onChange={e => setManualGuests(e.target.value)}
                autoFocus
              />
              <div className="flex gap-1">
                <button type="submit" className="btn" disabled={!manualGuests || loading}>Continue</button>
                <button type="button" className="btn btn-secondary" onClick={() => setGuestCountPrompt(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {/* Shopping list editor modal */}
      {modalData && (
        <Suspense fallback={null}>
          <ShoppingListModal
            listData={modalData}
            onClose={() => setModalData(null)}
            planId={planId}
            planToken={planToken}
            initialApproveStatus={initialApproveStatus}
            initialEverApproved={initialEverApproved}
          />
        </Suspense>
      )}
    </>
  );
}

import React, { useState } from 'react';
import api from '../../utils/api';
import { generateShoppingList } from './generateShoppingList';
import ShoppingListModal from './ShoppingListModal';

export default function ShoppingListButton({ planId, planToken }) {
  const [loading, setLoading] = useState(false);
  const [guestCountPrompt, setGuestCountPrompt] = useState(false);
  const [manualGuests, setManualGuests] = useState('');
  const [pendingData, setPendingData] = useState(null);
  const [modalData, setModalData] = useState(null);

  const openModal = (apiData, guestCount, savedList) => {
    if (savedList) {
      // Use persisted shopping list
      setModalData(savedList);
    } else {
      // Generate fresh from pars
      const listData = generateShoppingList({
        clientName: apiData.client_name,
        guestCount,
        signatureCocktails: apiData.signature_cocktails,
        syrupSelfProvided: apiData.syrup_self_provided || [],
        eventDate: apiData.event_date,
        notes: apiData.notes,
        serviceStyle: apiData.service_style || 'full_bar',
        beerSelections: apiData.beer_selections || [],
        wineSelections: apiData.wine_selections || [],
        mixersForSignatureDrinks: apiData.mixers_for_signature_drinks,
      });
      setModalData(listData);
    }
  };

  const handleClick = async () => {
    setLoading(true);
    try {
      // Check for saved shopping list first
      const [dataRes, savedRes] = await Promise.all([
        api.get(`/drink-plans/${planId}/shopping-list-data`),
        api.get(`/drink-plans/${planId}/shopping-list`).catch(() => ({ data: { shopping_list: null } })),
      ]);
      const data = dataRes.data;
      const saved = savedRes.data.shopping_list;

      if (saved) {
        // Use saved list directly
        setModalData(saved);
      } else if (!data.guest_count) {
        // No linked proposal — prompt admin for guest count
        setPendingData(data);
        setGuestCountPrompt(true);
        setManualGuests('');
      } else {
        openModal(data, data.guest_count, null);
      }
    } catch (err) {
      console.error('Failed to load shopping list data:', err);
      alert('Failed to load shopping list. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleGuestCountSubmit = (e) => {
    e.preventDefault();
    const count = parseInt(manualGuests, 10);
    if (!count || count < 1) return;
    setGuestCountPrompt(false);
    openModal(pendingData, count, null);
    setPendingData(null);
  };

  return (
    <>
      <button
        className="btn btn-secondary"
        onClick={handleClick}
        disabled={loading}
      >
        {loading ? 'Loading...' : 'Shopping List'}
      </button>

      {/* Guest count prompt when no proposal is linked */}
      {guestCountPrompt && (
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
                <button type="submit" className="btn" disabled={!manualGuests}>Continue</button>
                <button type="button" className="btn btn-secondary" onClick={() => { setGuestCountPrompt(false); setPendingData(null); }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Shopping list editor modal */}
      {modalData && (
        <ShoppingListModal
          listData={modalData}
          onClose={() => setModalData(null)}
          planId={planId}
          planToken={planToken}
        />
      )}
    </>
  );
}

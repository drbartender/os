import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';

const BASE_URL = process.env.REACT_APP_API_URL || '';

export default function ClientShoppingList() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(`shopping-list-checked-${token}`)) || {};
    } catch { return {}; }
  });

  const fetchList = useCallback(async () => {
    try {
      const res = await axios.get(`${BASE_URL}/api/drink-plans/t/${token}/shopping-list`);
      setData(res.data);
      setError('');
    } catch (err) {
      // eslint-disable-next-line no-restricted-syntax
      if (err.response?.status === 404) {
        setError('Shopping list not found.');
      } else {
        setError('Failed to load shopping list.');
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchList(); }, [fetchList]);

  useEffect(() => {
    localStorage.setItem(`shopping-list-checked-${token}`, JSON.stringify(checked));
  }, [checked, token]);

  const toggleItem = (key) => {
    setChecked(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const itemKey = (section, item) => `${section}:${item.item}:${item.size}`;

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
            <div className="spinner" style={{ margin: '0 auto 1rem' }} />
            <p style={{ color: '#D49549', fontStyle: 'italic' }}>Loading your shopping list...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <div style={styles.header}>
            <h1 style={styles.brand}>Dr. Bartender</h1>
          </div>
          <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
            <p style={{ color: '#D49549', fontSize: '1.1rem' }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!data?.ready) {
    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <div style={styles.header}>
            <h1 style={styles.brand}>Dr. Bartender</h1>
            {data?.client_name && <p style={styles.clientName}>{data.client_name}</p>}
          </div>
          <div style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
            <p style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Your shopping list is being prepared</p>
            <p style={{ color: '#D49549', fontStyle: 'italic' }}>
              Our team is customizing your shopping list. Check back soon!
            </p>
          </div>
        </div>
      </div>
    );
  }

  const list = data.shopping_list;
  const allItems = [
    ...list.liquorBeerWine.map(i => ({ ...i, section: 'liquorBeerWine' })),
    ...list.everythingElse.map(i => ({ ...i, section: 'everythingElse' })),
  ];
  const totalItems = allItems.length;
  const checkedCount = allItems.filter(i => checked[itemKey(i.section, i)]).length;
  const progress = totalItems > 0 ? Math.round((checkedCount / totalItems) * 100) : 0;

  const formatDate = (d) => {
    if (!d) return '';
    return new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  };

  const renderSection = (title, items, section) => {
    const uncheckedItems = items.filter(i => !checked[itemKey(section, i)]);
    const checkedItems = items.filter(i => checked[itemKey(section, i)]);

    return (
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={styles.sectionHeader}>{title}</div>
        {uncheckedItems.map((item, i) => (
          <div
            key={itemKey(section, item) + '-' + i}
            onClick={() => toggleItem(itemKey(section, item))}
            style={styles.itemRow}
          >
            <div style={styles.checkbox}>
              <div style={styles.checkboxEmpty} />
            </div>
            <div style={{ flex: 1 }}>
              <span style={styles.itemName}>{item.item}</span>
              {item.size && <span style={styles.itemSize}> · {item.size}</span>}
            </div>
            <span style={styles.itemQty}>{item.qty}</span>
          </div>
        ))}
        {checkedItems.length > 0 && (
          <div style={{ opacity: 0.5, marginTop: '0.25rem' }}>
            {checkedItems.map((item, i) => (
              <div
                key={itemKey(section, item) + '-checked-' + i}
                onClick={() => toggleItem(itemKey(section, item))}
                style={{ ...styles.itemRow, backgroundColor: 'rgba(26,20,16,0.3)' }}
              >
                <div style={styles.checkbox}>
                  <div style={styles.checkboxChecked}>✓</div>
                </div>
                <div style={{ flex: 1, textDecoration: 'line-through' }}>
                  <span style={styles.itemName}>{item.item}</span>
                  {item.size && <span style={styles.itemSize}> · {item.size}</span>}
                </div>
                <span style={{ ...styles.itemQty, textDecoration: 'line-through' }}>{item.qty}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        {/* Header */}
        <div style={styles.header}>
          <h1 style={styles.brand}>Dr. Bartender</h1>
          <p style={styles.tagline}>Premium Bar Services</p>
        </div>

        {/* Client info */}
        <div style={styles.clientInfo}>
          <h2 style={styles.clientName}>{data.client_name || list.clientName}</h2>
          <div style={styles.metaRow}>
            {list.guestCount && <span>{list.guestCount} Guests</span>}
            {data.event_date && <span>{formatDate(data.event_date)}</span>}
          </div>
        </div>

        {/* Progress bar */}
        <div style={styles.progressContainer}>
          <div style={styles.progressBar}>
            <div style={{ ...styles.progressFill, width: `${progress}%` }} />
          </div>
          <p style={styles.progressText}>
            {checkedCount} of {totalItems} items {checkedCount === totalItems && totalItems > 0 ? '- All done!' : 'checked'}
          </p>
        </div>

        {/* Shopping list sections */}
        {renderSection('Liquor · Beer · Wine', list.liquorBeerWine, 'liquorBeerWine')}
        {renderSection('Everything Else', list.everythingElse, 'everythingElse')}

        {/* Signature cocktails */}
        {list.signatureCocktailNames && list.signatureCocktailNames.length > 0 && (
          <div style={styles.cocktailBar}>
            <span style={{ color: '#D49549', fontSize: '0.82rem', fontStyle: 'italic' }}>Signature Cocktails: </span>
            <span style={{ color: '#F5F0E8', fontSize: '0.85rem' }}>
              {list.signatureCocktailNames.join('  ·  ')}
            </span>
          </div>
        )}

        {/* Refresh button */}
        <div style={{ textAlign: 'center', padding: '1.5rem 0 2rem' }}>
          <button
            onClick={() => { setLoading(true); fetchList(); }}
            style={styles.refreshBtn}
          >
            Refresh List
          </button>
          <p style={{ color: '#7A6245', fontSize: '0.75rem', marginTop: '0.5rem', fontStyle: 'italic' }}>
            Pull to refresh or tap above to check for updates
          </p>
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <p style={styles.disclaimer}>
            *Given the natural variation in preferred drink choices this list represents our best recommendations,
            drawn from decades of experience in bar service. We advise purchasing refundable alcohol as close to
            the event date as possible to ensure compliance with return policies from your alcohol supplier.
          </p>
          <p style={{ color: '#C17D3C', fontSize: '0.8rem', textAlign: 'center', marginTop: '0.5rem' }}>
            drbartender.com
          </p>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    backgroundColor: '#1A1410',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#F5F0E8',
  },
  container: {
    maxWidth: 500,
    margin: '0 auto',
    padding: '0',
  },
  header: {
    textAlign: 'center',
    padding: '2rem 1rem 1rem',
    borderBottom: '2px solid #C17D3C',
  },
  brand: {
    fontFamily: 'Georgia, serif',
    fontSize: '1.6rem',
    color: '#F5F0E8',
    margin: 0,
  },
  tagline: {
    color: '#D49549',
    fontSize: '0.8rem',
    fontStyle: 'italic',
    margin: '0.25rem 0 0',
  },
  clientInfo: {
    textAlign: 'center',
    padding: '1rem 1rem 0.5rem',
  },
  clientName: {
    fontFamily: 'Georgia, serif',
    fontSize: '1.2rem',
    color: '#F5F0E8',
    margin: '0 0 0.25rem',
  },
  metaRow: {
    display: 'flex',
    justifyContent: 'center',
    gap: '1.5rem',
    color: '#D49549',
    fontSize: '0.85rem',
    fontStyle: 'italic',
  },
  progressContainer: {
    padding: '0.75rem 1.25rem 1.25rem',
  },
  progressBar: {
    height: 6,
    backgroundColor: '#2a2a2a',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#C17D3C',
    borderRadius: 3,
    transition: 'width 0.3s ease',
  },
  progressText: {
    textAlign: 'center',
    fontSize: '0.78rem',
    color: '#D49549',
    marginTop: '0.375rem',
  },
  sectionHeader: {
    backgroundColor: '#2a2a2a',
    color: '#E8DFC4',
    fontSize: '0.82rem',
    textAlign: 'center',
    padding: '0.4rem 0.5rem',
    fontFamily: 'Georgia, serif',
    letterSpacing: '0.04em',
    borderBottom: '1.5px solid #C17D3C',
  },
  itemRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '0.65rem 1rem',
    borderBottom: '1px solid rgba(193,125,60,0.15)',
    cursor: 'pointer',
    userSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
  },
  checkbox: {
    marginRight: '0.75rem',
    flexShrink: 0,
  },
  checkboxEmpty: {
    width: 22,
    height: 22,
    borderRadius: 4,
    border: '2px solid #C17D3C',
  },
  checkboxChecked: {
    width: 22,
    height: 22,
    borderRadius: 4,
    backgroundColor: '#C17D3C',
    color: '#1A1410',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 'bold',
    fontSize: '0.85rem',
  },
  itemName: {
    fontSize: '0.92rem',
    fontWeight: '600',
  },
  itemSize: {
    fontSize: '0.8rem',
    color: '#D49549',
  },
  itemQty: {
    fontSize: '1rem',
    fontWeight: 'bold',
    color: '#C17D3C',
    marginLeft: '0.5rem',
    minWidth: 24,
    textAlign: 'right',
  },
  cocktailBar: {
    backgroundColor: '#2a2a2a',
    border: '1px solid #C17D3C',
    borderRadius: 4,
    padding: '0.5rem 1rem',
    margin: '0 1rem',
  },
  refreshBtn: {
    background: 'none',
    border: '1px solid #C17D3C',
    color: '#C17D3C',
    padding: '0.5rem 2rem',
    borderRadius: 4,
    fontSize: '0.85rem',
    cursor: 'pointer',
  },
  footer: {
    borderTop: '1px solid rgba(193,125,60,0.3)',
    padding: '1rem 1.25rem 2rem',
  },
  disclaimer: {
    fontSize: '0.7rem',
    color: '#7A6245',
    fontStyle: 'italic',
    lineHeight: 1.5,
  },
};

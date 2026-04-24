import React, { useEffect, useRef, useCallback, useState } from 'react';
import { MENU_SAMPLES } from '../data/menuSamples';

export default function MenuSamplesModal({ isOpen, onClose }) {
  const closeRef = useRef(null);
  const modalRef = useRef(null);
  const [enlargedIndex, setEnlargedIndex] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    closeRef.current?.focus();
    const handleKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (enlargedIndex !== null) setEnlargedIndex(null);
      else onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, enlargedIndex]);

  useEffect(() => {
    if (!isOpen) setEnlargedIndex(null);
  }, [isOpen]);

  const handleTabTrap = useCallback((e) => {
    if (e.key !== 'Tab' || !modalRef.current) return;
    const focusable = modalRef.current.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, []);

  if (!isOpen) return null;

  const enlarged = enlargedIndex !== null ? MENU_SAMPLES[enlargedIndex] : null;

  return (
    <div className="menu-samples-overlay" onClick={onClose}>
      <div
        ref={modalRef}
        className="menu-samples-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="menu-samples-title"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleTabTrap}
      >
        <div className="menu-samples-header">
          <h3 id="menu-samples-title">Sample Menu Designs</h3>
          <button
            ref={closeRef}
            type="button"
            className="menu-samples-close"
            onClick={onClose}
            aria-label="Close sample menus"
          >
            ×
          </button>
        </div>

        {MENU_SAMPLES.length === 0 ? (
          <p className="menu-samples-empty">Samples coming soon.</p>
        ) : (
          <div className="menu-samples-grid">
            {MENU_SAMPLES.map((sample, i) => (
              <button
                key={sample.src}
                type="button"
                className="menu-samples-thumb"
                onClick={() => setEnlargedIndex(i)}
              >
                <img src={sample.src} alt={sample.alt} loading="lazy" />
                {sample.caption && <span className="menu-samples-caption">{sample.caption}</span>}
              </button>
            ))}
          </div>
        )}

        {enlarged && (
          <div
            className="menu-samples-enlarged-overlay"
            onClick={() => setEnlargedIndex(null)}
            role="dialog"
            aria-modal="true"
            aria-label={enlarged.alt}
          >
            <button
              type="button"
              className="menu-samples-enlarged-close"
              onClick={() => setEnlargedIndex(null)}
              aria-label="Close enlarged view"
            >
              ×
            </button>
            <img
              src={enlarged.src}
              alt={enlarged.alt}
              onClick={e => e.stopPropagation()}
            />
          </div>
        )}
      </div>
    </div>
  );
}

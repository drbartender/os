import React, { useState } from 'react';
import MenuSamplesModal from '../../../../components/MenuSamplesModal';
import { MENU_SAMPLES } from '../../../../data/menuSamples';
import ScopeBanner from '../../components/ScopeBanner';
import LogoUploadField from '../../components/LogoUploadField';

// Menu design (spec §3.1): the three-way choice, minus the duplicate
// selections recap the old step opened with (review shows everything once).
export default function MenuDesignV2({ selections, updateSelections }) {
  const [samplesOpen, setSamplesOpen] = useState(false);
  const style = selections.menuStyle;

  return (
    <div>
      <ScopeBanner
        tone="aside"
        title="Just the menu card"
        body="Nothing here changes what we buy or pour. It's about how the menu looks on the bar."
      />
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>Design Your Menu Card</h2>
        <p className="text-muted">We print and frame it to display on the bar.</p>
      </div>

      <div className="card">
        <div className="form-group">
          <div className="radio-group">
            {[
              ['custom', 'Custom Menu', 'Your drinks with your names on a designed card.'],
              ['house', 'Standard Menu', 'Our apothecary house card with your selections.'],
              ['none', 'Skip the Menu', 'No printed menu. The bartender talks guests through it.'],
            ].map(([value, label, desc]) => (
              <label key={value} className={`radio-option${style === value ? ' selected' : ''}`}>
                <input type="radio" name="menuStyle" checked={style === value} onChange={() => updateSelections('menuStyle', value)} />
                <span className="radio-label"><strong>{label}</strong><br /><span className="text-muted text-small">{desc}</span></span>
              </label>
            ))}
          </div>
          {MENU_SAMPLES.length > 0 && style === 'custom' && (
            <button type="button" className="menu-samples-trigger" onClick={() => setSamplesOpen(true)}>
              See sample menus &rarr;
            </button>
          )}
        </div>

        <MenuSamplesModal isOpen={samplesOpen} onClose={() => setSamplesOpen(false)} />

        {style === 'custom' && (
          <>
            <div className="form-group">
              <label className="form-label" htmlFor="pp2-menu-theme">Your event theme, colors, or overall vibe</label>
              <textarea
                id="pp2-menu-theme"
                className="form-textarea"
                rows={3}
                placeholder="e.g. rustic fall colors, elegant black and gold, tropical vibes, garden party..."
                value={selections.menuTheme || ''}
                onChange={(e) => updateSelections('menuTheme', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="pp2-drink-naming">Any drink names you'd like included?</label>
              <textarea
                id="pp2-drink-naming"
                className="form-textarea"
                rows={3}
                placeholder="e.g. rename 'Old Fashioned' to 'The Groom's Go-To', or let us get creative..."
                value={selections.drinkNaming || ''}
                onChange={(e) => updateSelections('drinkNaming', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="pp2-menu-notes">Any other inspiration or preferences for the menu design?</label>
              <textarea
                id="pp2-menu-notes"
                className="form-textarea"
                rows={3}
                placeholder="e.g. we have a Pinterest board, match our invitation style, include our monogram..."
                value={selections.menuDesignNotes || ''}
                onChange={(e) => updateSelections('menuDesignNotes', e.target.value)}
              />
            </div>
          </>
        )}

        {style === 'house' && (
          <span className="potion-field-note">
            Our standard bar menu. Dr. Bartender branded, listing your drinks in plain terms like Vodka Lemonade or Old Fashioned. We bring it printed and framed for the bar. No setup needed from you.
          </span>
        )}
        {style === 'none' && (
          <span className="potion-field-note">
            No printed menu will be created. Your selections still drive everything else.
          </span>
        )}

        {(style === 'custom' || style === 'house') && (
          <LogoUploadField
            companyLogo={selections.companyLogo || ''}
            onUploadSuccess={(updatedSelections) => {
              Object.keys(updatedSelections).forEach((key) => {
                if (key !== '_logoFilename') updateSelections(key, updatedSelections[key]);
              });
            }}
          />
        )}
      </div>
    </div>
  );
}

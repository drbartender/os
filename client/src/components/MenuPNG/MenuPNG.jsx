import React, { useRef, useState } from 'react';
import html2canvas from 'html2canvas';
import MenuPreview from '../../pages/plan/components/MenuPreview';

/**
 * Admin-side Standard Menu PNG export. Renders a hidden full-size
 * <MenuPreview variant="print"> off-screen, captures it via html2canvas
 * at scale 3 (8x10 inches at 300 DPI = 2400x3000 px target; 2304x2880
 * is the actual output, close enough for print at 8x10), and triggers
 * a browser download.
 *
 * Props:
 *   plan - the drink plan object as returned by GET /api/drink-plans/:id
 *          (must include selections, signatureDrinkNames, mocktailNames,
 *          and client_name)
 */
export default function MenuPNG({ plan }) {
  const hiddenRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const sanitizeName = (name) => {
    const safe = (name || '')
      .replace(/[/\\:"*?<>|\x00-\x1f]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .trim();
    return safe;
  };

  const handleDownload = async () => {
    setError('');
    setBusy(true);
    try {
      const node = hiddenRef.current;
      if (!node) throw new Error('Render surface not ready.');
      const canvas = await html2canvas(node, {
        scale: 3,
        backgroundColor: '#12161C',
        useCORS: true,
        logging: false,
      });
      const safeName = sanitizeName(plan.client_name);
      const filename = safeName ? `Standard Menu - ${safeName}.png` : 'Standard Menu.png';
      canvas.toBlob((blob) => {
        if (!blob) {
          setError('Failed to generate PNG. Please try again.');
          setBusy(false);
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setBusy(false);
      }, 'image/png');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('MenuPNG export failed:', err);
      setError('Failed to generate menu PNG. See console for details.');
      setBusy(false);
    }
  };

  // Resolve the cocktails/mocktails reference arrays from the plan's
  // pre-resolved name fields so <MenuPreview> can render names.
  const cocktailsRef = (plan.selections?.signatureDrinks || []).map((id, i) => ({
    id,
    name: plan.signatureDrinkNames?.[i] || `(drink ${id})`,
  }));
  const mocktailsRef = (plan.selections?.mocktails || []).map((id, i) => ({
    id,
    name: plan.mocktailNames?.[i] || `(mocktail ${id})`,
  }));

  return (
    <div>
      <button
        type="button"
        className="btn btn-primary"
        onClick={handleDownload}
        disabled={busy}
      >
        {busy ? 'Generating...' : 'Download Standard Menu PNG'}
      </button>
      {error && <p style={{ color: 'var(--rust)', marginTop: '0.5rem' }}>{error}</p>}

      {/* Hidden full-size render surface for html2canvas to capture. */}
      <div
        ref={hiddenRef}
        style={{
          position: 'absolute',
          left: '-99999px',
          top: 0,
          width: '768px',
          height: '960px',
          pointerEvents: 'none',
        }}
        aria-hidden="true"
        className="potion-app"
      >
        <MenuPreview
          selections={plan.selections || {}}
          activeModules={plan.selections?.activeModules || {}}
          cocktails={cocktailsRef}
          mocktails={mocktailsRef}
          companyLogo={plan.selections?.companyLogo || ''}
          variant="print"
        />
      </div>
    </div>
  );
}

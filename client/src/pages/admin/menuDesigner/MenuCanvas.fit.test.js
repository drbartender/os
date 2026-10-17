import React from 'react';
import '@testing-library/jest-dom';
import { render, act } from '@testing-library/react';
import MenuCanvas from './MenuCanvas';

// The fit (spec 11.2): art shrink, the one type step and Too long. jsdom has
// no layout, so these fake scrollHeight and element boxes; the two
// canvas-drawn layers are mocked (spec 14). Fixtures as in MenuCanvas.test.js.
jest.mock('./tintedWordmark', () => ({
  useTintedWordmark: (color) => `data:image/png;base64,TINT${String(color).replace('#', '')}`,
}));
// A plain function: CRA's jest config resets jest.fn implementations per test.
jest.mock('./softBacking', () => ({
  drawSoftBacking: () => 'data:image/png;base64,SOFT',
  drawBadgeShadow: (w, h) => `data:image/png;base64,SHADOW${w}x${h}`,
  BADGE: { pad: 20 },
}));

const drink = (key, name, desc, over = {}) => ({
  key, source: 'custom', group: 'sig', display_name: name, description: desc, hidden: false, has_art: true, ...over,
});

// The garden sample (board C): 4 signatures and 1 mocktail, 3 rows.
const GARDEN = () => ({
  title: 'Bar Menu',
  headings: { sig: 'Signature Cocktails', mock: 'Mocktails', more: 'More from the bar', also: 'Also at the bar' },
  drinks: [
    drink('custom:paloma', "Roscoe's Paloma", 'Tequila, grapefruit, lime, and soda.'),
    drink('cocktail:7', "The Groom's Old Fashioned", 'Bourbon, bitters, orange.'),
    drink('cocktail:9', 'Lavender Lemon Drop', 'Vodka, lemon, and lavender syrup.'),
    drink('custom:spritz', "Phoebe's Garden Spritz", 'Aperol, prosecco, and soda.'),
    drink('mocktail:3', 'Coral Crush', 'Strawberry, lime, mint.', { group: 'mock' }),
  ],
  also_at_bar: [
    { label: 'Beer and Wine', text: 'Pinot Grigio, Cabernet, Prosecco.' },
    { label: 'Spirits', text: 'Vodka, Tequila, Bourbon.' },
    { label: 'Non-Alcoholic', text: '' },
  ],
  font_pairing: 'elegant-script', ink_color: null, accent_color: null, text_backing: 'soft',
  logo_mode: 'above_title', logo_badge: false, mark_color: 'ink',
});

const piece = (key, over = {}) => ({ piece_key: key, status: 'done', has_image: true, tone: null, ground_rgb: null, ...over });
const PIECES = () => [
  piece('background', { tone: 'light', ground_rgb: '250,246,248' }),
  ...GARDEN().drinks.map((d) => piece(d.key)),
];
const LAYERS = () => Object.fromEntries(PIECES().map((p) => [p.piece_key, `blob:${p.piece_key}`]));

const renderCanvas = (props = {}) => render(
  <MenuCanvas content={GARDEN()} inputs={{ drb_mark: true, planner_image_role: 'logo' }}
    pieces={PIECES()} layers={LAYERS()} {...props} />,
);
const menuVar = (container, name) => container.querySelector('.mc-menu').style.getPropertyValue(name);

afterEach(() => {
  document.head.querySelectorAll('link[data-menu-fonts]').forEach((l) => l.remove());
});

describe('the fit', () => {
  afterEach(() => {
    delete HTMLElement.prototype.scrollHeight;
    jest.restoreAllMocks();
  });

  // The page reads too tall while the art is taller than `over`.
  const fakePage = (overWhile) => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        if (!this.classList.contains('mc-page')) return 0;
        const art = this.querySelector('.mc-art');
        return overWhile(art ? parseFloat(art.style.height) : 0) ? 1060 : 1000;
      },
    });
  };

  test('the art shrinks in 6 px steps until the page fits', () => {
    fakePage((h) => h > 100);
    const onFit = jest.fn();
    const { container } = renderCanvas({ onFit });
    // 165, 159, ... 105, 99.
    const art = container.querySelector('.mc-art');
    expect(art.style.height).toBe('99px');
    expect(art.style.width).toBe('71px');
    expect(art.querySelector('img').style.width).toBe('71px');
    expect(onFit).toHaveBeenLastCalledWith({ artHeight: 99, typeStep: false, tooLong: [] });
    expect(menuVar(container, '--mc-hs')).toBe('25px');
  });

  test('at 65 px the type steps down once, then what runs past is flagged too long', () => {
    fakePage(() => true);
    jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function box() {
      const k = this.getAttribute && this.getAttribute('data-mc-k');
      const isPage = this.classList && this.classList.contains('mc-page');
      const bottom = isPage ? 1060 : (k && k.startsWith('also_at_bar.')) ? 1040 : 400;
      return { top: 0, left: 0, right: 0, width: 0, bottom, height: bottom, x: 0, y: 0 };
    });
    const onFit = jest.fn();
    const { container } = renderCanvas({ onFit });
    expect(container.querySelector('.mc-art').style.height).toBe('65px');
    // Cormorant 25 -> 22.5 for names, 17.5 -> 15.75 for descriptions.
    expect(menuVar(container, '--mc-hs')).toBe('22.5px');
    expect(menuVar(container, '--mc-bs')).toBe('15.75px');
    expect(onFit).toHaveBeenLastCalledWith({
      artHeight: 65,
      typeStep: true,
      tooLong: ['also_at_bar.0.label', 'also_at_bar.0.text', 'also_at_bar.1.label', 'also_at_bar.1.text'],
    });
  });

  test('the type step never goes below the floors', () => {
    fakePage(() => true);
    // Gallery: names 18 (already under the 20 floor) stay 18; Karla 15 -> 14.
    const { container } = renderCanvas({ content: { ...GARDEN(), font_pairing: 'modern-clean' } });
    expect(menuVar(container, '--mc-hs')).toBe('18px');
    expect(menuVar(container, '--mc-bs')).toBe('14px');
  });

  test('an edit refits from the start value', () => {
    fakePage((h) => h > 150);
    const onFit = jest.fn();
    const { container, rerender } = renderCanvas({ onFit });
    expect(container.querySelector('.mc-art').style.height).toBe('147px');
    fakePage(() => false);
    const content = GARDEN();
    content.title = 'Cheers';
    rerender(<MenuCanvas content={content} inputs={{}} pieces={PIECES()} layers={LAYERS()} onFit={onFit} />);
    expect(container.querySelector('.mc-art').style.height).toBe('165px');
    expect(onFit).toHaveBeenLastCalledWith({ artHeight: 165, typeStep: false, tooLong: [] });
  });

  test('a font load refits', async () => {
    const listeners = {};
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        ready: new Promise(() => {}),
        addEventListener: (t, fn) => { listeners[t] = fn; },
        removeEventListener: jest.fn(),
      },
    });
    try {
      fakePage(() => false);
      const onFit = jest.fn();
      renderCanvas({ onFit });
      const before = onFit.mock.calls.length;
      await act(async () => { listeners.loadingdone(); });
      expect(onFit.mock.calls.length).toBe(before + 1);
      // A new loading cycle refits once it settles.
      let settle;
      document.fonts.ready = new Promise((resolve) => { settle = resolve; });
      await act(async () => { listeners.loading(); });
      expect(onFit.mock.calls.length).toBe(before + 1);
      await act(async () => { settle(); });
      expect(onFit.mock.calls.length).toBe(before + 2);
    } finally {
      delete document.fonts;
    }
  });

  test('the pairing stylesheet arriving refits', async () => {
    fakePage(() => false);
    const onFit = jest.fn();
    renderCanvas({ onFit });
    const before = onFit.mock.calls.length;
    const link = document.head.querySelector('link[data-menu-fonts]');
    expect(link.getAttribute('href')).toContain('Pinyon+Script');
    await act(async () => { link.dispatchEvent(new Event('load')); });
    expect(onFit.mock.calls.length).toBe(before + 1);
  });
});

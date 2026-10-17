import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import MenuCanvas, { AVATAR_SRC } from './MenuCanvas';

// jsdom has no 2D canvas (spec 14): the two canvas-drawn layers are mocked.
// The fit's tests are MenuCanvas.fit.test.js.
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

test('renders the title, headings, drinks, Also at the bar and the mark from props', () => {
  const { container } = renderCanvas();
  expect(screen.getByText('Bar Menu')).toBeInTheDocument();
  expect(screen.getByText('Signature Cocktails')).toBeInTheDocument();
  expect(screen.getByText('Mocktails')).toBeInTheDocument();
  expect(screen.getByText("The Groom's Old Fashioned")).toBeInTheDocument();
  expect(screen.getByText('Strawberry, lime, mint.')).toBeInTheDocument();
  expect(screen.getByText('Also at the bar')).toBeInTheDocument();
  expect(screen.getByText('Beer and Wine')).toBeInTheDocument();
  expect(screen.getByText('Vodka, Tequila, Bourbon.')).toBeInTheDocument();
  // An Also line with no text prints nothing, label included.
  expect(screen.queryByText('Non-Alcoholic')).toBeNull();
  // No More from the bar without unillustrated drinks.
  expect(screen.queryByText('More from the bar')).toBeNull();
  // The mark: the avatar, and the wordmark through the (mocked) tint in the light ink.
  expect(container.querySelector('[data-mc-layer="avatar"]').getAttribute('src')).toBe(AVATAR_SRC);
  expect(AVATAR_SRC).toMatch(/\/images\/menu-mark-avatar\.png$/);
  expect(screen.getByAltText('Dr. Bartender').getAttribute('src')).toBe('data:image/png;base64,TINT2c2238');
  expect(container.querySelector('[data-mc-layer="background"]').getAttribute('src')).toBe('blob:background');
  expect(container.querySelector('[data-mc-layer="backing"]').getAttribute('src')).toBe('data:image/png;base64,SOFT');
  expect(container.querySelector('[data-mc-pending]')).toBeNull();
});

test('no mark when drb_mark is false', () => {
  const { container } = renderCanvas({ inputs: { drb_mark: false } });
  expect(container.querySelector('.mc-mark')).toBeNull();
  expect(screen.queryByAltText('Dr. Bartender')).toBeNull();
});

test('each drink image is a square of its box width, centered, never stretched', () => {
  const { container } = renderCanvas();
  // 3 rows start the art at 165: the box is 119 wide, the image 119 x 119, 23 down.
  const arts = container.querySelectorAll('.mc-art');
  expect(arts).toHaveLength(5);
  arts.forEach((art) => {
    expect(art.style.height).toBe('165px');
    expect(art.style.width).toBe('119px');
    const img = art.querySelector('img');
    expect(img.style.width).toBe('119px');
    expect(img.style.height).toBe('119px');
    expect(img.style.top).toBe('23px');
  });
  expect(container.querySelector('[data-mc-layer="cocktail:7"]').getAttribute('src')).toBe('blob:cocktail:7');
  // Slot widths by row length: 2 + 2 signatures at 250, the lone mocktail at 360.
  const widths = [...container.querySelectorAll('.mc-slot')].map((s) => s.style.flexBasis);
  expect(widths).toEqual(['250px', '250px', '250px', '250px', '360px']);
});

test('More from the bar lists the visible drinks without art', () => {
  const content = GARDEN();
  content.drinks.push(drink('custom:mule', 'Cucumber Mule', 'Vodka, cucumber, ginger beer.', { has_art: false }));
  content.drinks.push(drink('custom:hidden', 'Hidden One', 'Never shown.', { has_art: false, hidden: true }));
  const { container } = renderCanvas({ content });
  expect(screen.getByText('More from the bar')).toBeInTheDocument();
  const more = container.querySelector('.mc-more');
  expect(more).toHaveTextContent('Cucumber Mule');
  expect(more).toHaveTextContent('Vodka, cucumber, ginger beer.');
  expect(more.querySelector('.mc-art')).toBeNull();
  expect(screen.queryByText('Hidden One')).toBeNull();
});

test('zero drinks still lays out: a beer-and-wine-only menu (Review Focus 3)', () => {
  const content = { ...GARDEN(), drinks: GARDEN().drinks.map((d) => ({ ...d, hidden: true })) };
  const onFit = jest.fn();
  const { container } = renderCanvas({ content, onFit });
  expect(screen.getByText('Bar Menu')).toBeInTheDocument();
  expect(screen.getByText('Beer and Wine')).toBeInTheDocument();
  expect(screen.queryByText('Signature Cocktails')).toBeNull();
  expect(container.querySelector('.mc-art')).toBeNull();
  expect(onFit).toHaveBeenCalledWith({ artHeight: 130, typeStep: false, tooLong: [] });
});

describe('colors', () => {
  test('a dark background picks the dark set, and the wordmark follows the ink', () => {
    const pieces = PIECES().map((p) => (p.piece_key === 'background' ? { ...p, tone: 'dark', ground_rgb: '15,24,48' } : p));
    const { container } = renderCanvas({ pieces });
    expect(menuVar(container, '--mc-ink')).toBe('#f5eedf');
    expect(menuVar(container, '--mc-accent')).toBe('#dcbc6e');
    expect(screen.getByAltText('Dr. Bartender').getAttribute('src')).toBe('data:image/png;base64,TINTf5eedf');
    expect(container.querySelector('.mc-orn path').getAttribute('stroke')).toBe('#dcbc6e');
  });

  test('overrides and the gold mark', () => {
    const content = { ...GARDEN(), ink_color: '#3a2647', accent_color: '#7a4a86', mark_color: 'gold' };
    const { container } = renderCanvas({ content });
    expect(menuVar(container, '--mc-ink')).toBe('#3a2647');
    expect(menuVar(container, '--mc-accent')).toBe('#7a4a86');
    expect(screen.getByAltText('Dr. Bartender').getAttribute('src')).toBe('data:image/png;base64,TINTd9b77e');
  });

  test('while the background is pending: the light set, no backing, the layer pending', () => {
    const pieces = PIECES().map((p) => (p.piece_key === 'background' ? { ...p, status: 'working', tone: 'dark', has_image: false } : p));
    const { container } = renderCanvas({ pieces });
    expect(menuVar(container, '--mc-ink')).toBe('#2c2238');
    expect(container.querySelector('[data-mc-layer="backing"]')).toBeNull();
    expect(container.querySelector('[data-mc-pending="background"]')).not.toBeNull();
    expect(screen.queryByText('Painting the background...')).toBeNull();
  });
});

describe('backing', () => {
  test('Panel: the fill at .86, the 7 px ring and the accent hairline as borders, no blur', () => {
    const { container } = renderCanvas({ content: { ...GARDEN(), text_backing: 'panel' } });
    const panel = container.querySelector('.mc-panel');
    expect(panel.style.background).toBe('rgba(250, 246, 248, 0.86)');
    // The ring: the ground at .86 over the accent #8a6a2f, opaque.
    expect(panel.style.borderColor).toBe('rgb(234,226,220)');
    expect(panel.querySelector('.mc-panel-line').style.borderColor).toBe('#8a6a2f');
    expect(panel.outerHTML).not.toMatch(/box-shadow|backdrop|blur/);
    expect(container.querySelector('[data-mc-layer="backing"]')).toBeNull();
  });

  test('Off: nothing', () => {
    const { container } = renderCanvas({ content: { ...GARDEN(), text_backing: 'off' } });
    expect(container.querySelector('.mc-panel')).toBeNull();
    expect(container.querySelector('[data-mc-layer="backing"]')).toBeNull();
  });
});

describe('the logo', () => {
  test('above the title at 96 px, sized from its natural ratio once loaded', () => {
    const { container } = renderCanvas({ plannerImage: { url: 'blob:logo' } });
    const img = container.querySelector('[data-mc-layer="logo"]');
    expect(img.getAttribute('src')).toBe('blob:logo');
    expect(img.style.height).toBe('96px');
    Object.defineProperty(img, 'naturalWidth', { value: 400 });
    Object.defineProperty(img, 'naturalHeight', { value: 200 });
    fireEvent.load(img);
    expect(img.style.width).toBe('192px');
    expect(img.style.height).toBe('96px');
    expect(screen.getByText('Bar Menu')).toBeInTheDocument();
  });

  test('a very wide logo is capped to the page width without stretching', () => {
    const { container } = renderCanvas({ plannerImage: { url: 'blob:logo' } });
    const img = container.querySelector('[data-mc-layer="logo"]');
    Object.defineProperty(img, 'naturalWidth', { value: 2000 });
    Object.defineProperty(img, 'naturalHeight', { value: 100 });
    fireEvent.load(img);
    expect(img.style.width).toBe('668px');
    expect(img.style.height).toBe('33.4px');
  });

  test('replacing the title: 150 px, no title; with a badge', () => {
    const content = { ...GARDEN(), logo_mode: 'replaces_title', logo_badge: true };
    const { container } = renderCanvas({ content, plannerImage: { url: 'blob:logo' } });
    expect(container.querySelector('[data-mc-layer="logo"]').style.height).toBe('150px');
    expect(container.querySelector('.mc-logo-badge')).not.toBeNull();
    expect(screen.queryByText('Bar Menu')).toBeNull();
  });

  test('the badge shadow is an image under an opaque face, sized once the logo loads', () => {
    const content = { ...GARDEN(), logo_badge: true };
    const { container } = renderCanvas({ content, plannerImage: { url: 'blob:logo' } });
    // No size yet, so no shadow yet.
    expect(container.querySelector('[data-mc-layer="badge-shadow"]')).toBeNull();
    const img = container.querySelector('[data-mc-layer="logo"]');
    Object.defineProperty(img, 'naturalWidth', { value: 300 });
    Object.defineProperty(img, 'naturalHeight', { value: 300 });
    fireEvent.load(img);
    // A 96 x 96 logo in a 124 x 116 face; the shadow image is padded 20 a side.
    const shadow = container.querySelector('[data-mc-layer="badge-shadow"]');
    expect(shadow.getAttribute('src')).toBe('data:image/png;base64,SHADOW124x116');
    expect(shadow.style.left).toBe('-20px');
    expect(shadow.style.top).toBe('-20px');
    expect(shadow.style.width).toBe('164px');
    expect(shadow.style.height).toBe('156px');
    const face = container.querySelector('.mc-logo-face');
    expect(face.contains(img)).toBe(true);
    // The face comes after the shadow, so it paints over it.
    expect(shadow.compareDocumentPosition(face) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('still loading: a pending box of the same height', () => {
    const { container } = renderCanvas({ plannerImage: { url: null } });
    const box = container.querySelector('[data-mc-pending="logo"]');
    expect(box.style.height).toBe('96px');
  });

  test('a style reference or ignored image is never printed', () => {
    const { container } = renderCanvas({ inputs: { planner_image_role: 'reference' }, plannerImage: { url: 'blob:logo' } });
    expect(container.querySelector('.mc-logo')).toBeNull();
    expect(screen.getByText('Bar Menu')).toBeInTheDocument();
  });
});

describe('drawing states', () => {
  const states = () => PIECES().map((p) => {
    if (p.piece_key === 'cocktail:7') return { ...p, status: 'working', has_image: false };
    if (p.piece_key === 'cocktail:9') return { ...p, status: 'pending', has_image: false };
    if (p.piece_key === 'custom:spritz') return { ...p, status: 'failed', has_image: false };
    return p;
  });

  test('read-only by default: empty boxes marked pending, no state text', () => {
    const { container } = renderCanvas({ pieces: states() });
    expect(screen.queryByText('Painting...')).toBeNull();
    expect(screen.queryByText("Couldn't draw this one")).toBeNull();
    expect(container.querySelector('[data-mc-pending="cocktail:7"]')).not.toBeNull();
    // A piece being redrawn never shows its old layer.
    expect(container.querySelector('[data-mc-layer="cocktail:7"]')).toBeNull();
  });

  test('showStatus draws painting, waiting and failed', () => {
    const pieces = states().map((p) => (p.piece_key === 'background' ? { ...p, status: 'working', has_image: false } : p));
    renderCanvas({ pieces, showStatus: true });
    expect(screen.getByText('Painting...')).toBeInTheDocument();
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.getByText("Couldn't draw this one")).toBeInTheDocument();
    expect(screen.getByText('Painting the background...')).toBeInTheDocument();
  });
});

test('scale, ref and the pairing font link', () => {
  const ref = React.createRef();
  const { container } = renderCanvas({ scale: 0.12, ref });
  const frame = container.querySelector('.mc-frame');
  expect(frame.style.width).toBe('96px');
  expect(frame.style.height).toBe('120px');
  expect(ref.current).toBe(container.querySelector('.mc-menu'));
  expect(ref.current.style.transform).toBe('scale(0.12)');
  const link = document.head.querySelector('link[data-menu-fonts]');
  expect(link.getAttribute('href')).toContain('Pinyon+Script');
});

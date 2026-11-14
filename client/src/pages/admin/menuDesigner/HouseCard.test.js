import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import MenuCanvas from './MenuCanvas';
import { fontsHref } from './fontPairings';

// The house card on the designer canvas (spec 2026-10-19 section 9.3; plan
// lane menu-house-card): MenuPreview's print variant at 800 x 1000. jsdom has
// no layout, so the fit fakes the content box's scrollHeight and the name
// boxes. MenuCanvas is rendered, so the look branch is under test too.
jest.mock('./tintedWordmark', () => ({
  useTintedWordmark: (color) => `data:image/png;base64,TINT${String(color).replace('#', '')}`,
}));
jest.mock('./softBacking', () => ({
  drawSoftBacking: () => 'data:image/png;base64,SOFT',
  drawBadgeShadow: (w, h) => `data:image/png;base64,SHADOW${w}x${h}`,
  BADGE: { pad: 20 },
}));

const drink = (key, name, over = {}) => ({
  key, source: 'catalog', group: 'sig', display_name: name, description: null, hidden: false, has_art: false,
  name_ai_suggested: false, description_ai_written: false, ...over,
});
const HOUSE = (over = {}) => ({
  words_status: 'done', title: 'The Bar Menu', look: 'house', touch_key: 'balloons', house_bottom_corners: false, font_pairing: null,
  drinks: [
    drink('cocktail:paloma', 'Paloma'),
    drink('mocktail:3', 'Coral Crush', { group: 'mock' }),
    drink('cocktail:7', 'Old Fashioned'),
    drink('custom:hidden', 'Hidden One', { hidden: true }),
  ],
  house_sections: [
    { kind: 'beer-wine', title: 'Beer & Wine', items: ['Beer', 'Seltzer', 'Red'] },
    { kind: 'bar-service', title: 'Bar Service', items: ['Call Drinks'] },
  ],
  ...over,
});
const BG = { piece_key: 'background', status: 'done', has_image: true, tone: 'dark', ground_rgb: '18,22,28' };
const renderHouse = (props = {}) => render(
  <MenuCanvas content={HOUSE()} inputs={{ planner_image_role: 'logo', drb_mark: true }} pieces={[BG]} layers={{ background: 'blob:bg' }} {...props} />,
);
const menu = (container) => container.querySelector('.mc-menu');
const sectionTitles = (container) => [...container.querySelectorAll('.mc-house-label')].map((el) => el.textContent.replace(/◆/g, '').trim());

afterEach(() => {
  document.head.querySelectorAll('link[data-menu-fonts]').forEach((l) => l.remove());
  delete HTMLElement.prototype.scrollHeight;
  jest.restoreAllMocks();
});

test('a house draft renders the house card, never the custom canvas; a custom draft is unchanged', () => {
  const { container, rerender } = renderHouse();
  expect(menu(container)).toHaveClass('mc-house-card');
  expect(container.querySelector('.mc-page')).toBeNull();
  expect(container.querySelector('.mc-mark')).toBeNull();
  expect(container.querySelector('.mc-panel')).toBeNull();
  expect(container.querySelector('.mc-also')).toBeNull();
  rerender(<MenuCanvas content={{ ...HOUSE(), look: 'custom' }} inputs={{ drb_mark: true }} pieces={[BG]} layers={{ background: 'blob:bg' }} />);
  expect(menu(container)).not.toHaveClass('mc-house-card');
  expect(container.querySelector('.mc-page')).not.toBeNull();
  expect(container.querySelector('.mc-mark')).not.toBeNull();
});

test('the title crest, then the sections in order: Cocktails, Mocktails, then the bar sections; hidden drinks left out', () => {
  const { container } = renderHouse();
  expect(screen.getByText('The Bar Menu')).toHaveClass('mc-house-title');
  expect(container.querySelectorAll('.mc-house-rule')).toHaveLength(2);
  expect(sectionTitles(container)).toEqual(['Cocktails', 'Mocktails', 'Beer & Wine', 'Bar Service']);
  const cocktails = container.querySelectorAll('.mc-house-section')[0];
  expect([...cocktails.querySelectorAll('.mc-house-name')].map((el) => el.textContent)).toEqual(['Paloma', 'Old Fashioned']);
  expect(within(container.querySelectorAll('.mc-house-section')[1]).getByText('Coral Crush')).toHaveClass('mc-house-name');
  expect(screen.queryByText('Hidden One')).toBeNull();
  expect(screen.getByText('Paloma')).toHaveAttribute('data-mc-k', 'drinks.cocktail:paloma.display_name');
  // Beer & Wine is one line joined by middots beside other sections; Bar Service lists Call Drinks as a name.
  expect(screen.getByText('Beer · Seltzer · Red')).toHaveClass('mc-house-inline');
  expect(screen.getByText('Call Drinks')).toHaveClass('mc-house-name');
  // Drink names only: no descriptions, no art slots.
  expect(container.querySelector('.mc-desc, .mc-art, .mc-slot')).toBeNull();
});

test('Beer & Wine alone stacks like a drink list; no sections at all draws an empty body', () => {
  const only = HOUSE({ drinks: [], house_sections: [{ kind: 'beer-wine', title: 'Beer & Wine', items: ['Beer', 'Red'] }] });
  const { container, rerender } = renderHouse({ content: only });
  expect([...container.querySelectorAll('.mc-house-name')].map((el) => el.textContent)).toEqual(['Beer', 'Red']);
  expect(container.querySelector('.mc-house-inline')).toBeNull();
  rerender(<MenuCanvas content={HOUSE({ drinks: [], house_sections: [] })} pieces={[]} layers={{}} />);
  expect(container.querySelectorAll('.mc-house-section')).toHaveLength(0);
  // A malformed stored section is skipped, never drawn.
  rerender(<MenuCanvas content={HOUSE({ drinks: [], house_sections: [null, { kind: 'x' }, { kind: 'beer-wine', title: 'Beer & Wine', items: 'Beer' }] })} pieces={[]} layers={{}} />);
  expect(container.querySelectorAll('.mc-house-section')).toHaveLength(0);
});

describe('the fit (Review Focus 5)', () => {
  // The content box reads too tall while the names are larger than `fits`.
  const fakeContent = (overWhile) => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        if (!this.classList.contains('mc-house-content')) return 0;
        const size = parseFloat(this.closest('.mc-menu').style.getPropertyValue('--mc-house-name'));
        return overWhile(size) ? 900 : 800;
      },
    });
  };
  const nameSize = (container) => menu(container).style.getPropertyValue('--mc-house-name');

  test('names start at 35 px and nothing steps when the card fits', () => {
    fakeContent(() => false);
    const onFit = jest.fn();
    const { container } = renderHouse({ onFit });
    expect(nameSize(container)).toBe('35px');
    expect(onFit).toHaveBeenLastCalledWith({ artHeight: null, typeStep: false, nameSize: 35, tooLong: [] });
  });

  test('the names step down 1 px at a time until the sections fit above the footer', () => {
    fakeContent((size) => size > 29);
    const onFit = jest.fn();
    const { container } = renderHouse({ onFit });
    expect(nameSize(container)).toBe('29px');
    expect(onFit).toHaveBeenLastCalledWith({ artHeight: null, typeStep: true, nameSize: 29, tooLong: [] });
  });

  test('a 20-drink Standard Menu steps to the 24 px floor, then reads Too long, naming the first name past the footer', () => {
    fakeContent(() => true);
    const many = Array.from({ length: 20 }, (_, i) => drink(`cocktail:d${i + 1}`, `Drink Number ${i + 1}`));
    // Each name 50 px further down: the 17th (850) is the first past 838.5, the room above the footer.
    jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function box() {
      const k = this.getAttribute && this.getAttribute('data-mc-k');
      const m = k && /^drinks\.cocktail:d(\d+)\./.exec(k);
      const bottom = m ? 50 * Number(m[1]) : 0;
      return { top: 0, left: 0, right: 0, width: 0, bottom, height: bottom, x: 0, y: 0 };
    });
    const onFit = jest.fn();
    const { container } = renderHouse({ onFit, content: HOUSE({ drinks: many }) });
    expect(nameSize(container)).toBe('24px');
    expect(onFit).toHaveBeenLastCalledWith({ artHeight: null, typeStep: true, nameSize: 24, tooLong: ['drinks.cocktail:d17.display_name'] });
  });

  test('Too long with no name past the footer reports the card itself, never a drink name that fits', () => {
    fakeContent(() => true);
    const onFit = jest.fn();
    // jsdom puts every box at 0, so no name is past the footer: the trailing bar sections overflow.
    const { container } = renderHouse({ onFit, editable: true });
    expect(onFit).toHaveBeenLastCalledWith({ artHeight: null, typeStep: true, nameSize: 24, tooLong: ['house_card'] });
    // The key names no element, so no drink name is flagged as the one too long.
    for (const el of container.querySelectorAll('[data-mc-k]')) expect(el).not.toHaveClass('mc-long');
  });
});

describe('the footer', () => {
  test('the Dr. Bartender lockup on the left; the client logo behind a brass divider when its role is logo', () => {
    const { container } = renderHouse({ plannerImage: { url: 'blob:logo' } });
    const foot = container.querySelector('.mc-house-foot');
    expect(foot).not.toHaveClass('mc-house-foot-center');
    const lockup = within(foot).getByAltText('Dr. Bartender');
    expect(lockup).toHaveAttribute('data-mc-layer', 'avatar');
    expect(lockup.getAttribute('src')).toMatch(/\/images\/menu-logo-gold\.png$/);
    expect(foot).toHaveTextContent('Dr. Bartender');
    expect(foot.querySelector('.mc-house-spacer')).not.toBeNull();
    expect(foot.querySelector('.mc-house-divider')).not.toBeNull();
    expect(foot.querySelector('img[data-mc-layer="logo"]')).toHaveAttribute('src', 'blob:logo');
  });

  test('no client logo for another role or no client image; a logo still loading is a pending layer', () => {
    const { container, rerender } = renderHouse({ plannerImage: { url: 'blob:logo' }, inputs: { planner_image_role: 'ignore' } });
    expect(container.querySelector('.mc-house-divider')).toBeNull();
    expect(container.querySelector('[data-mc-layer="logo"]')).toBeNull();
    rerender(<MenuCanvas content={HOUSE()} inputs={{ planner_image_role: 'logo' }} pieces={[BG]} layers={{ background: 'blob:bg' }} plannerImage={null} />);
    expect(container.querySelector('.mc-house-divider')).toBeNull();
    rerender(<MenuCanvas content={HOUSE()} inputs={{}} pieces={[BG]} layers={{ background: 'blob:bg' }} plannerImage={{ url: null }} />);
    expect(container.querySelector('[data-mc-pending="logo"]')).not.toBeNull();
  });

  test('when the touches use the bottom corners, the lockup and the logo centre as one group', () => {
    const { container } = renderHouse({ content: HOUSE({ touch_key: 'holiday', house_bottom_corners: true }), plannerImage: { url: 'blob:logo' } });
    const foot = container.querySelector('.mc-house-foot');
    expect(foot).toHaveClass('mc-house-foot-center');
    expect(foot.querySelector('.mc-house-spacer')).toBeNull();
    expect(foot.querySelector('.mc-house-lockup')).not.toBeNull();
    expect(foot.querySelector('img[data-mc-layer="logo"]')).not.toBeNull();
  });
});

describe('the ground and the faces', () => {
  test('the background piece when done; a background still owed is a pending layer the export waits on', () => {
    const { container, rerender } = renderHouse();
    expect(container.querySelector('img[data-mc-layer="background"]')).toHaveAttribute('src', 'blob:bg');
    rerender(<MenuCanvas content={HOUSE()} pieces={[{ ...BG, status: 'working' }]} layers={{}} showStatus />);
    expect(container.querySelector('[data-mc-pending="background"]')).not.toBeNull();
    expect(screen.getByText('Painting the background...')).toBeInTheDocument();
  });

  test('a plain card paints the flat ground and owes no background', () => {
    const { container } = render(<MenuCanvas content={HOUSE({ touch_key: 'plain' })} pieces={[]} layers={{}} />);
    expect(container.querySelector('.mc-house-ground')).not.toBeNull();
    expect(container.querySelector('[data-mc-pending]')).toBeNull();
    expect(container.querySelector('img[data-mc-layer="background"]')).toBeNull();
  });

  test('the house faces load for the preview, and the ref is the 800 x 1000 menu node, scaled like the custom one', () => {
    const ref = React.createRef();
    const { container } = render(<MenuCanvas ref={ref} content={HOUSE()} pieces={[BG]} layers={{ background: 'blob:bg' }} scale={0.12} />);
    expect(document.head.querySelector('link[data-menu-fonts]').getAttribute('href')).toBe(fontsHref(['house']));
    expect(ref.current).toBe(menu(container));
    expect(container.querySelector('.mc-frame')).toHaveStyle({ width: '96px', height: '120px' });
    expect(menu(container).style.transform).toBe('scale(0.12)');
  });
});

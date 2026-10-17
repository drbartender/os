import React, { useState } from 'react';
import fs from 'fs';
import path from 'path';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import MenuCanvas from './MenuCanvas';
import useMenuDraft, { SAVE_DEBOUNCE_MS } from './useMenuDraft';
import menuCardState from './menuCardState';
import { EditorEmpty } from './EditorBanner';
import api from '../../../utils/api';

// The editor's on-canvas editing (spec 2026-10-01 section 11.1, On-canvas
// editing; table E). jsdom has no 2D canvas: the two canvas-drawn layers are
// mocked (spec 14). The read-only output is MenuCanvas.test.js's.
jest.mock('./tintedWordmark', () => ({ useTintedWordmark: () => 'data:image/png;base64,TINT' }));
jest.mock('./softBacking', () => ({
  drawSoftBacking: () => 'data:image/png;base64,SOFT',
  drawBadgeShadow: () => 'data:image/png;base64,SHADOW',
  BADGE: { pad: 20 },
}));
// Hoisted above the imports by babel-jest.
jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));

const drink = (key, name, desc, over = {}) => ({
  key, source: 'custom', group: 'sig', display_name: name, description: desc, hidden: false, has_art: true,
  name_ai_suggested: false, description_ai_written: false, ...over,
});
const CONTENT = () => ({
  words_status: 'done', title: 'Bar Menu',
  headings: { sig: 'Signature Cocktails', mock: 'Mocktails', more: 'More from the bar', also: 'Also at the bar' },
  drinks: [
    drink('custom:paloma', "Roscoe's Paloma", 'Tequila, grapefruit, lime.', { name_ai_suggested: true, description_ai_written: true }),
    drink('cocktail:7', 'Old Fashioned', 'Bourbon, bitters, orange.'),
    drink('mocktail:3', 'Coral Crush', 'Strawberry, lime, mint.', { group: 'mock' }),
  ],
  also_at_bar: [{ label: 'Beer and Wine', text: 'Pinot Grigio, Lager.' }],
  font_pairing: 'elegant-script', text_backing: 'soft',
});
const piece = (key, status = 'done') => ({ piece_key: key, status, has_image: status === 'done', tone: 'light', ground_rgb: '250,246,248' });
const PIECES = () => [piece('background'), ...CONTENT().drinks.map((d) => piece(d.key))];
const LAYERS = () => Object.fromEntries(PIECES().map((p) => [p.piece_key, `blob:${p.piece_key}`]));

// A preview wired like the editor's: content follows the patches, the selection is state.
function Preview({ onPatch = () => {}, onSelect = () => {}, initial = CONTENT(), ...props }) {
  const [content, setContent] = useState(initial);
  const [sel, setSel] = useState(null);
  return (
    <MenuCanvas content={content} inputs={{ drb_mark: true }} pieces={PIECES()} layers={LAYERS()} editable canReroll
      selectedDrink={sel} onSelectDrink={(k) => { setSel(k); onSelect(k); }}
      onPatch={(p) => { onPatch(p); setContent((c) => ({ ...c, ...p.content })); }} {...props} />
  );
}

const edit = (el, value) => { el.textContent = value; fireEvent.input(el); fireEvent.blur(el); };

afterEach(() => {
  document.head.querySelectorAll('link[data-menu-fonts]').forEach((l) => l.remove());
  jest.restoreAllMocks();
});

describe('text', () => {
  test('every text is editable once the words land, never on the read-only canvas', () => {
    const { container, unmount } = render(<Preview />);
    const keys = [...container.querySelectorAll('[contenteditable="true"]')].map((el) => el.getAttribute('data-mc-k'));
    expect(keys).toEqual(expect.arrayContaining([
      'title', 'headings.sig', 'headings.mock', 'headings.also', 'drinks.custom:paloma.display_name',
      'drinks.custom:paloma.description', 'also_at_bar.0.label', 'also_at_bar.0.text',
    ]));
    expect(container.querySelector('.mc-menu')).toHaveClass('mc-edit');
    unmount();
    const ro = render(<MenuCanvas content={CONTENT()} pieces={PIECES()} layers={LAYERS()} />);
    expect(ro.container.querySelector('[contenteditable]')).toBeNull();
    expect(ro.container.querySelector('.mc-menu')).toHaveClass('mc-static');
    ro.unmount();
    const pending = render(<MenuCanvas content={{ ...CONTENT(), words_status: 'pending' }} pieces={PIECES()} layers={LAYERS()} editable />);
    expect(pending.container.querySelector('[contenteditable]')).toBeNull();
  });

  test('commits on blur, cleaned, as one content patch', () => {
    const onPatch = jest.fn();
    render(<Preview onPatch={onPatch} />);
    edit(screen.getByText('Bar Menu'), '  Cheers\n to Love ');
    expect(onPatch).toHaveBeenCalledWith({ content: { title: 'Cheers to Love' } });
    expect(screen.getByText('Cheers to Love')).toHaveAttribute('data-mc-k', 'title');
    // Unchanged is no patch.
    edit(screen.getByText('Cheers to Love'), 'Cheers to Love');
    expect(onPatch).toHaveBeenCalledTimes(1);
  });

  test('Enter commits (and never adds a line)', () => {
    const onPatch = jest.fn();
    render(<Preview onPatch={onPatch} />);
    const el = screen.getByText('Mocktails');
    el.focus();
    expect(document.activeElement).toBe(el);
    el.textContent = 'Zero Proof';
    const notPrevented = fireEvent.keyDown(el, { key: 'Enter' });
    expect(notPrevented).toBe(false);
    expect(document.activeElement).not.toBe(el);
    expect(onPatch).toHaveBeenCalledWith({ content: { headings: {
      sig: 'Signature Cocktails', mock: 'Zero Proof', more: 'More from the bar', also: 'Also at the bar',
    } } });
  });

  test('a refused edit puts the stored text back', () => {
    const onPatch = jest.fn();
    render(<Preview onPatch={onPatch} />);
    const el = screen.getByText('Old Fashioned');
    edit(el, '   ');
    expect(onPatch).not.toHaveBeenCalled();
    expect(el.textContent).toBe('Old Fashioned');
  });

  test('typing past the limit is cut back to it; a paste arrives as one plain line', () => {
    render(<Preview />);
    const el = screen.getByText('Bar Menu');
    el.textContent = 'x'.repeat(75);
    fireEvent.input(el);
    expect(el.textContent).toBe('x'.repeat(60));
    document.execCommand = jest.fn();
    const desc = screen.getByText('Bourbon, bitters, orange.');
    const notPrevented = fireEvent.paste(desc, { clipboardData: { getData: () => 'Two\nlines <b>bold</b>' } });
    expect(notPrevented).toBe(false);
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, 'Two lines <b>bold</b>');
    delete document.execCommand;
  });

  test('AI-written text carries the dotted underline until edited', () => {
    const onPatch = jest.fn();
    render(<Preview onPatch={onPatch} />);
    const name = screen.getByText("Roscoe's Paloma");
    expect(name).toHaveClass('mc-ai');
    expect(screen.getByText('Tequila, grapefruit, lime.')).toHaveClass('mc-ai');
    expect(screen.getByText('Old Fashioned')).not.toHaveClass('mc-ai');
    edit(name, "Roscoe's Grapefruit Paloma");
    expect(onPatch.mock.calls[0][0].content.drinks[0]).toMatchObject({ display_name: "Roscoe's Grapefruit Paloma", name_ai_suggested: false });
    expect(screen.getByText("Roscoe's Grapefruit Paloma")).not.toHaveClass('mc-ai');
    expect(screen.getByText('Tequila, grapefruit, lime.')).toHaveClass('mc-ai');
  });

  test('commits into autosave: the hook PATCHes the edit 800 ms later', async () => {
    jest.useFakeTimers();
    try {
      api.get.mockResolvedValue({ data: {
        draft: { id: 1, version: 3, art_version: 1, read_only: false, inputs: { drb_mark: true }, content: CONTENT() },
        pieces: PIECES().map((p) => ({ ...p, has_image: false })), brief: null, diff: null, print: { state: 'none' },
        cap: { used: 0, limit: 60, remaining: 60 }, configured: { openai: true, gemini: false }, plan: { id: 7, drink_count: 3 },
      } });
      api.patch.mockResolvedValue({ data: { version: 4 } });
      function Wired() {
        const menu = useMenuDraft(42);
        if (!menu.draft) return null;
        return <MenuCanvas content={menu.draft.content} inputs={menu.draft.inputs} pieces={menu.payload.pieces} layers={{}} editable onPatch={menu.edit} />;
      }
      render(<Wired />);
      for (let i = 0; i < 6; i += 1) await act(async () => {}); // eslint-disable-line no-await-in-loop
      edit(screen.getByText('Also at the bar'), 'Also Pouring');
      expect(api.patch).not.toHaveBeenCalled();
      await act(async () => { jest.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
      expect(api.patch).toHaveBeenCalledWith('/proposals/42/menu-draft', { version: 3, content: { headings: {
        sig: 'Signature Cocktails', mock: 'Mocktails', more: 'More from the bar', also: 'Also Pouring',
      } } });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('a stored text already past its limit (catalog descriptions have no cap)', () => {
  const long = 'x'.repeat(230);
  const initial = () => ({ ...CONTENT(), drinks: CONTENT().drinks.map((d) => (d.key === 'cocktail:7' ? { ...d, description: long } : d)) });

  test('is never cut as it is typed into: it may shrink, and says it is over until it fits', () => {
    const onPatch = jest.fn();
    render(<Preview onPatch={onPatch} initial={initial()} />);
    const el = screen.getByText(long);
    el.textContent = `${'x'.repeat(220)} more`;
    fireEvent.input(el);
    expect(el.textContent).toBe(`${'x'.repeat(220)} more`);
    expect(el).toHaveClass('mc-over');
    expect(el).toHaveAttribute('title', '200 characters at most, 225 now. Shorten it to save.');
    // It never grows past what was stored.
    el.textContent = 'y'.repeat(240);
    fireEvent.input(el);
    expect(el.textContent).toBe('y'.repeat(230));
    // Left still over the limit: unsaved, kept on screen, still saying so.
    el.textContent = 'z'.repeat(210);
    fireEvent.input(el);
    fireEvent.blur(el);
    expect(onPatch).not.toHaveBeenCalled();
    expect(el.textContent).toBe('z'.repeat(210));
    expect(el).toHaveClass('mc-over');
    // Shortened to fit: saved.
    el.textContent = 'Bourbon, bitters, stirred.';
    fireEvent.input(el);
    fireEvent.blur(el);
    expect(onPatch.mock.calls[0][0].content.drinks.find((d) => d.key === 'cocktail:7').description).toBe('Bourbon, bitters, stirred.');
  });

  test('an unsaved edit still past its limit is reported as Too long (Approve holds) until it fits', () => {
    const onFit = jest.fn();
    render(<Preview onFit={onFit} initial={initial()} />);
    const lastTooLong = () => onFit.mock.calls[onFit.mock.calls.length - 1][0].tooLong;
    expect(lastTooLong()).toEqual([]);
    const el = screen.getByText(long);
    el.textContent = 'z'.repeat(210);
    fireEvent.input(el);
    fireEvent.blur(el);
    expect(lastTooLong()).toEqual(['drinks.cocktail:7.description']);
    el.textContent = 'Bourbon, stirred.';
    fireEvent.input(el);
    fireEvent.blur(el);
    expect(lastTooLong()).toEqual([]);
  });

  test('its outline survives the Too long outline toggling on the same text', () => {
    let overflow = false;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true, get() { return this.classList.contains('mc-page') && overflow ? 1060 : 0; },
    });
    jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function box() {
      const isPage = this.classList && this.classList.contains('mc-page');
      const k = this.getAttribute && this.getAttribute('data-mc-k');
      const height = isPage ? 1060 : k === 'drinks.cocktail:7.description' ? 300 : 5;
      return { top: 0, left: 0, right: 0, width: 0, bottom: height, height, x: 0, y: 0 };
    });
    try {
      render(<Preview initial={initial()} />);
      const el = screen.getByText(long);
      el.textContent = 'z'.repeat(210);
      fireEvent.input(el);
      fireEvent.blur(el);
      expect(el).toHaveClass('mc-over');
      overflow = true;
      edit(screen.getByText('Bar Menu'), 'Cheers');
      expect(el).toHaveClass('mc-long');
      expect(el).toHaveClass('mc-over');
      overflow = false;
      edit(screen.getByText('Cheers'), 'Cheers Again');
      expect(el).not.toHaveClass('mc-long');
      expect(el).toHaveClass('mc-over');
      expect(el.textContent).toBe('z'.repeat(210));
    } finally {
      delete HTMLElement.prototype.scrollHeight;
    }
  });

  test('clicked into and out of unchanged, it sends nothing and stays whole', () => {
    const onPatch = jest.fn();
    const spaced = 'Bourbon,  bitters,\n orange.';
    render(<Preview onPatch={onPatch} initial={{ ...initial(), drinks: initial().drinks.map((d) => (d.key === 'mocktail:3' ? { ...d, description: spaced } : d)) }} />);
    [screen.getByText(long), screen.getByText((t, node) => node.getAttribute && node.getAttribute('data-mc-k') === 'drinks.mocktail:3.description')]
      .forEach((el) => {
        const before = el.textContent;
        el.focus();
        fireEvent.input(el);
        fireEvent.blur(el);
        expect(el.textContent).toBe(before);
        expect(el).not.toHaveClass('mc-over');
      });
    expect(onPatch).not.toHaveBeenCalled();
  });
});

describe('drinks', () => {
  const art = (container, key) => container.querySelector(`[data-mc-layer="${key}"]`).closest('.mc-art');

  test('clicking the art selects the drink: the outline and the two pills; again clears it', () => {
    const onSelect = jest.fn();
    const { container } = render(<Preview onSelect={onSelect} />);
    fireEvent.click(art(container, 'cocktail:7'));
    expect(onSelect).toHaveBeenLastCalledWith('cocktail:7');
    const slot = art(container, 'cocktail:7').closest('.mc-slot');
    expect(slot).toHaveClass('mc-sel');
    const pills = within(slot.querySelector('.mc-tools'));
    expect(pills.getByRole('button', { name: 'Re-roll art' })).toBeInTheDocument();
    expect(pills.getByRole('button', { name: 'Hide' })).toBeInTheDocument();
    fireEvent.click(art(container, 'cocktail:7'));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(container.querySelector('.mc-sel')).toBeNull();
  });

  test('a click elsewhere on the menu clears the selection; a click on text does not', () => {
    const onSelect = jest.fn();
    const { container } = render(<Preview onSelect={onSelect} />);
    fireEvent.click(art(container, 'mocktail:3'));
    fireEvent.click(screen.getByText('Coral Crush'));
    expect(container.querySelector('.mc-sel')).not.toBeNull();
    fireEvent.click(container.querySelector('.mc-page'));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(container.querySelector('.mc-sel')).toBeNull();
  });

  test('the pills: Re-roll art re-rolls; Hide hides and clears the selection', () => {
    const onReroll = jest.fn();
    const onPatch = jest.fn();
    const { container } = render(<Preview onReroll={onReroll} onPatch={onPatch} />);
    fireEvent.click(art(container, 'cocktail:7'));
    fireEvent.click(screen.getByRole('button', { name: 'Re-roll art' }));
    expect(onReroll).toHaveBeenCalledWith('cocktail:7');
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(onPatch.mock.calls[0][0].content.drinks.find((d) => d.key === 'cocktail:7').hidden).toBe(true);
    expect(screen.queryByText('Old Fashioned')).toBeNull();
    expect(container.querySelector('.mc-sel')).toBeNull();
  });

  test('a read-only draft (the editor passes editable false): no selection, no pills, no re-roll, no editing', () => {
    const onReroll = jest.fn();
    const pieces = PIECES().map((p) => (p.piece_key === 'mocktail:3' ? { ...p, status: 'failed', has_image: false } : p));
    const { container } = render(<MenuCanvas content={CONTENT()} pieces={pieces} layers={LAYERS()} showStatus canReroll
      onReroll={onReroll} onSelectDrink={onReroll} onPatch={onReroll} />);
    fireEvent.click(art(container, 'cocktail:7'));
    expect(container.querySelector('.mc-sel, .mc-tools')).toBeNull();
    expect(within(screen.getByText("Couldn't draw this one").closest('.mc-slot-st')).queryByRole('button')).toBeNull();
    expect(container.querySelector('[contenteditable]')).toBeNull();
    expect(onReroll).not.toHaveBeenCalled();
  });

  test('no Re-roll pill when no image remains', () => {
    const { container } = render(<Preview canReroll={false} />);
    fireEvent.click(art(container, 'cocktail:7'));
    const tools = container.querySelector('.mc-tools');
    expect(within(tools).queryByRole('button', { name: 'Re-roll art' })).toBeNull();
    expect(within(tools).getByRole('button', { name: 'Hide' })).toBeInTheDocument();
  });
});

describe('drawing states', () => {
  const states = () => PIECES().map((p) => {
    if (p.piece_key === 'background') return { ...p, status: 'working', has_image: false };
    if (p.piece_key === 'custom:paloma') return { ...p, status: 'working', has_image: false };
    if (p.piece_key === 'cocktail:7') return { ...p, status: 'pending', has_image: false };
    if (p.piece_key === 'mocktail:3') return { ...p, status: 'failed', has_image: false, error: 'interrupted' };
    return p;
  });

  test('painting, waiting and failed slots and the background-painting ground, in the editor', () => {
    const onReroll = jest.fn();
    const onSelect = jest.fn();
    const { container } = render(<Preview pieces={states()} onReroll={onReroll} onSelect={onSelect} />);
    const painting = screen.getByText('Painting...').closest('.mc-slot-st');
    expect(painting).toHaveClass('mc-run');
    expect(painting.querySelector('.mc-sheen')).not.toBeNull();
    expect(screen.getByText('Waiting').closest('.mc-slot-st')).toHaveClass('mc-wait');
    const failed = screen.getByText("Couldn't draw this one").closest('.mc-slot-st');
    expect(failed).toHaveClass('mc-bad');
    fireEvent.click(within(failed).getByRole('button', { name: 'Re-roll' }));
    expect(onReroll).toHaveBeenCalledWith('mocktail:3');
    expect(onSelect).not.toHaveBeenCalled();
    const ground = container.querySelector('.mc-ground');
    expect(ground.querySelector('.mc-sheen')).not.toBeNull();
    expect(within(ground).getByText('Painting the background...')).toBeInTheDocument();
  });

  test('a failed slot has no Re-roll when no image remains; a drawing drink has no Re-roll pill', () => {
    const atCap = render(<Preview pieces={states()} canReroll={false} />);
    expect(within(screen.getByText("Couldn't draw this one").closest('.mc-slot-st')).queryByRole('button')).toBeNull();
    atCap.unmount();
    const { container } = render(<Preview pieces={states()} />);
    fireEvent.click(container.querySelector('[data-mc-pending="cocktail:7"]'));
    const tools = container.querySelector('.mc-tools');
    expect(within(tools).queryByRole('button', { name: 'Re-roll art' })).toBeNull();
    expect(within(tools).getByRole('button', { name: 'Hide' })).toBeInTheDocument();
  });

  test('reduced motion stops the sheens', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../../index.css'), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.mc-menu \.mc-sheen \{ animation: none; \}/);
  });
});

test('Too long: the flagged text gets the outline in the editor only', () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true, get() { return this.classList.contains('mc-page') ? 1060 : 0; },
  });
  // The Also line runs to two lines (its share is one); the label is fixed.
  jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function box() {
    const isPage = this.classList && this.classList.contains('mc-page');
    const isAlso = this.classList && this.classList.contains('mc-also-line');
    const height = isPage ? 1060 : isAlso ? 44 : this.getAttribute && this.getAttribute('data-mc-k') === 'also_at_bar.0.label' ? 900 : 5;
    return { top: 0, left: 0, right: 0, width: 0, bottom: height, height, x: 0, y: 0 };
  });
  try {
    const onFit = jest.fn();
    render(<Preview onFit={onFit} />);
    expect(onFit).toHaveBeenLastCalledWith(expect.objectContaining({ tooLong: ['also_at_bar.0.text'] }));
    expect(screen.getByText('Pinot Grigio, Lager.')).toHaveClass('mc-long');
    expect(screen.getByText('Beer and Wine')).not.toHaveClass('mc-long');
  } finally {
    delete HTMLElement.prototype.scrollHeight;
  }
});

describe("table E's empty cards", () => {
  const base = (over = {}) => ({
    draft: null, pieces: [], brief: null, diff: null, print: { state: 'none' }, cap: { used: 0, limit: 60, remaining: 60 },
    configured: { openai: true, gemini: false }, plan: { id: 7, menu_style: 'custom', drink_count: 4 }, ...over,
  });
  const card = (payload) => {
    const { empty, generate } = menuCardState({ payload, local: {} });
    return render(<EditorEmpty empty={empty} height={500} onAction={() => {}} generate={generate} />);
  };
  test.each([
    ['Words failed', base({ draft: { id: 1, version: 2, inputs: {}, content: { words_status: 'failed', words_error: 'interrupted' } } }),
      "Couldn't write the menu text", 'The words step failed, so no images were used. Try again.', 'Retry'],
    ['Never generated', base(), 'No draft yet', 'Generate drafts the words in seconds, then paints the background and each drink. About 2 minutes.', 'Generate'],
    ['No drinks', base({ plan: { id: 7, menu_style: 'custom', drink_count: 0 } }), 'No drinks on the plan',
      'Menus are built from the drink plan. Add drinks there, then come back.', 'Open drink plan'],
    ['Not set up', base({ configured: { openai: false, gemini: false } }), "Menu art isn't set up", "The AI key isn't on the server yet.", null],
    ['No plan', base({ plan: null }), 'No drink plan on this event', 'Menus are built from the drink plan.', null],
    ['No menu needed', base({ print: { state: 'not_required' } }), 'No menu for this event', 'Undo to draft one.', 'Undo'],
  ])('%s', (_, payload, title, text, button) => {
    card(payload);
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
    if (button) expect(screen.getByRole('button', { name: button })).toBeInTheDocument();
    else expect(screen.queryByRole('button')).toBeNull();
  });
});

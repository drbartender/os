import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DesignTab from './DesignTab';

// The editor's Design tab (spec 2026-10-01 section 11.1, Design tab; 4.5).

const bg = (over = {}) => ({ piece_key: 'background', status: 'done', tone: 'light', provider: 'openai', drawn_count: 2, ...over });
const CONTENT = (over = {}) => ({
  words_status: 'done', font_pairing: 'elegant-script', ink_color: null, accent_color: null, text_backing: 'soft',
  mark_color: 'ink', background_label: 'Pastel garden',
  palette: [{ name: 'Periwinkle', hex: '#8f9ee6' }, { name: 'Coral', hex: '#ee8a72' }, { name: 'Bad', hex: 'blue' }],
  ...over,
});
const props = (over = {}) => ({
  draft: { id: 1, content: CONTENT(), inputs: { drb_mark: true } }, content: CONTENT(), inputs: { drb_mark: true },
  pieces: [bg()], configured: { openai: true, gemini: true }, cap: { used: 4, limit: 60, remaining: 56 },
  onPatch: jest.fn(), onReroll: jest.fn(), wordsDone: true, ...over,
});

afterEach(() => { document.head.querySelectorAll('link[data-menu-fonts]').forEach((l) => l.remove()); });

test('inert at 0.45 until the words land (the attribute set through a ref)', () => {
  const { container, rerender } = render(<DesignTab {...props({ wordsDone: false })} />);
  const pane = container.querySelector('.md-tabpane');
  expect(pane).toHaveAttribute('inert');
  expect(pane).toHaveClass('is-off');
  rerender(<DesignTab {...props()} />);
  expect(pane).not.toHaveAttribute('inert');
  expect(pane).not.toHaveClass('is-off');
});

test('a read-only draft (no plan): inert, and nothing PATCHes or re-rolls', () => {
  const p = props({ draft: { id: 1, read_only: true, content: CONTENT(), inputs: { drb_mark: true } } });
  const { container } = render(<DesignTab {...p} />);
  const pane = container.querySelector('.md-tabpane');
  expect(pane).toHaveAttribute('inert');
  expect(pane).toHaveClass('is-off');
  fireEvent.click(screen.getAllByRole('button', { name: /^Bar Menu/ })[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Ink: Navy' }));
  fireEvent.click(screen.getByRole('switch', { name: /Dr\. Bartender mark/ }));
  expect(screen.getByText('Pastel garden').closest('.md-bg-row').querySelector('button')).toBeDisabled();
  expect(p.onPatch).not.toHaveBeenCalled();
  expect(p.onReroll).not.toHaveBeenCalled();
  // The editor may say so itself.
  const q = props({ readOnly: true });
  const { container: second } = render(<DesignTab {...q} />);
  fireEvent.click(within(second).getAllByRole('button', { name: /^Bar Menu/ })[1]);
  expect(q.onPatch).not.toHaveBeenCalled();
});

test('loads all twelve pairings\' faces, since the tab shows each', () => {
  render(<DesignTab {...props()} />);
  const href = document.head.querySelector('link[data-menu-fonts]').getAttribute('href');
  ['Pinyon+Script', 'Rye', 'Josefin+Sans', 'Shrikhand', 'Creepster', 'Pacifico',
    'Limelight', 'Playfair+Display', 'Caveat', 'Lilita+One', 'DM+Serif+Display', 'Cinzel'].forEach((f) => expect(href).toContain(f));
});

const TWELVE = [
  'elegant-script', 'rustic', 'modern-clean', 'retro', 'spooky', 'tropical',
  'art-deco', 'botanical', 'hand-lettered', 'fiesta', 'editorial', 'black-tie',
];
const pairButton = (id) => screen.getAllByRole('button', { name: /^Bar Menu/ })
  .find((b) => b.querySelector('.md-pair-id').textContent === id);

describe('font pairing', () => {
  test('twelve buttons, "Bar Menu" in each title face with its id; the chosen one is pressed', () => {
    render(<DesignTab {...props()} />);
    const buttons = screen.getAllByRole('button', { name: /^Bar Menu/ });
    expect(buttons).toHaveLength(12);
    expect(buttons.map((b) => b.querySelector('.md-pair-id').textContent)).toEqual(TWELVE);
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    expect(buttons[0]).toHaveClass('is-on');
    const gallery = buttons[2].querySelector('.md-pair-sample');
    expect(gallery.style.fontFamily).toContain('Josefin Sans');
    expect(gallery.style.fontSize).toBe('16px');
    expect(gallery.style.textTransform).toBe('uppercase');
    expect(gallery.style.letterSpacing).toBe('0.18em');
    expect(buttons[0].querySelector('.md-pair-sample').style.fontSize).toBe('26px');
  });

  test('a new pairing\'s sample: Gatsby\'s uppercase deco title at 0.3 of its size, tracked', () => {
    render(<DesignTab {...props()} />);
    const deco = pairButton('art-deco').querySelector('.md-pair-sample');
    expect(deco.style.fontFamily).toContain('Limelight');
    expect(deco.style.fontSize).toBe('17px');
    expect(deco.style.textTransform).toBe('uppercase');
    expect(deco.style.letterSpacing).toBe('0.18em');
    expect(pairButton('black-tie').querySelector('.md-pair-sample').style.fontFamily).toContain('Cinzel');
    expect(pairButton('black-tie')).toHaveAttribute('title', 'Black Tie · Formal');
  });

  test('choosing a pairing resets ink and accent to its defaults', () => {
    const p = props({ content: CONTENT({ ink_color: '#1f2a44', accent_color: '#ee8a72', font_pairing_suggested: 'fiesta' }) });
    render(<DesignTab {...p} />);
    fireEvent.click(screen.getAllByRole('button', { name: /^Bar Menu/ })[1]);
    expect(p.onPatch).toHaveBeenCalledWith({ content: { font_pairing: 'rustic', ink_color: null, accent_color: null } });
    // A new pairing, and the suggested one, reset the same way; the suggestion is never sent.
    fireEvent.click(pairButton('black-tie'));
    expect(p.onPatch).toHaveBeenLastCalledWith({ content: { font_pairing: 'black-tie', ink_color: null, accent_color: null } });
    fireEvent.click(pairButton('fiesta'));
    expect(p.onPatch).toHaveBeenLastCalledWith({ content: { font_pairing: 'fiesta', ink_color: null, accent_color: null } });
  });

  // v2 spec 6: the words step's pick is tagged Suggested; the chosen pairing
  // stays font_pairing, so the tag and the pressed button can differ.
  const tags = (container) => [...container.querySelectorAll('.md-pairs .tag')];

  test('the Suggested tag sits on the words step\'s pick, beside its id', () => {
    const { container, rerender } = render(<DesignTab {...props({ content: CONTENT({ font_pairing_suggested: 'rustic' }) })} />);
    expect(tags(container)).toHaveLength(1);
    const tag = tags(container)[0];
    expect(tag).toHaveTextContent(/^Suggested$/);
    expect(tag.closest('.md-pair')).toBe(pairButton('rustic'));
    expect(tag.nextElementSibling).toHaveClass('md-pair-id');
    // Stacked over the id in one right-hand column, never a third item in the row.
    expect(tag.parentElement).toHaveClass('md-pair-meta');
    expect(tag.parentElement.parentElement).toBe(pairButton('rustic'));
    // The chosen pairing is still the pressed one.
    expect(pairButton('elegant-script')).toHaveAttribute('aria-pressed', 'true');
    expect(pairButton('rustic')).toHaveAttribute('aria-pressed', 'false');
    // On the chosen pairing too, and on a new one.
    rerender(<DesignTab {...props({ content: CONTENT({ font_pairing: 'botanical', font_pairing_suggested: 'botanical' }) })} />);
    expect(tags(container)).toHaveLength(1);
    expect(tags(container)[0].closest('.md-pair')).toBe(pairButton('botanical'));
    expect(pairButton('botanical')).toHaveAttribute('aria-pressed', 'true');
  });

  test('no Suggested tag on a draft without a suggestion, or with one that is not a pairing', () => {
    const { container, rerender } = render(<DesignTab {...props()} />);
    expect(tags(container)).toHaveLength(0);
    expect(screen.queryByText('Suggested')).toBeNull();
    rerender(<DesignTab {...props({ content: CONTENT({ font_pairing_suggested: null }) })} />);
    expect(tags(container)).toHaveLength(0);
    rerender(<DesignTab {...props({ content: CONTENT({ font_pairing_suggested: 'comic-sans' }) })} />);
    expect(tags(container)).toHaveLength(0);
  });
});

describe('colors', () => {
  const ring = (name) => screen.getByRole('button', { name });

  test('the pairing default is ringed until a swatch is chosen; the default follows the tone', () => {
    render(<DesignTab {...props({ pieces: [bg({ tone: 'dark' })] })} />);
    expect(ring('Ink: Pairing default')).toHaveClass('is-on');
    expect(ring('Ink: Pairing default')).toHaveAttribute('aria-pressed', 'true');
    expect(ring('Ink: Navy')).not.toHaveClass('is-on');
    // Garden Script on dark art: #f5eedf ink, #dcbc6e accent.
    expect(ring('Ink: Pairing default').style.background).toBe('rgb(245, 238, 223)');
    expect(ring('Accent: Pairing default').style.background).toBe('rgb(220, 188, 110)');
    expect(ring('Ink: Plum')).toHaveAttribute('title', 'Plum');
  });

  test('the chosen swatch carries the ring; the accent row is the default, then the palette', () => {
    const p = props({ content: CONTENT({ ink_color: '#1F2A44', accent_color: '#ee8a72' }) });
    render(<DesignTab {...p} />);
    expect(ring('Ink: Navy')).toHaveClass('is-on');
    expect(ring('Ink: Pairing default')).not.toHaveClass('is-on');
    const accents = within(screen.getByRole('group', { name: 'Accent' })).getAllByRole('button');
    expect(accents.map((b) => b.getAttribute('title'))).toEqual(['Pairing default', 'Periwinkle', 'Coral']);
    expect(ring('Accent: Coral')).toHaveClass('is-on');
    fireEvent.click(ring('Ink: Charcoal'));
    expect(p.onPatch).toHaveBeenLastCalledWith({ content: { ink_color: '#2a2a2a' } });
    fireEvent.click(ring('Accent: Pairing default'));
    expect(p.onPatch).toHaveBeenLastCalledWith({ content: { accent_color: null } });
  });
});

test('text backing is Off / Soft / Panel', () => {
  const p = props();
  render(<DesignTab {...p} />);
  const seg = screen.getByRole('group', { name: 'Text backing' });
  expect(within(seg).getByRole('button', { name: 'Soft' })).toHaveClass('active');
  fireEvent.click(within(seg).getByRole('button', { name: 'Panel' }));
  expect(p.onPatch).toHaveBeenCalledWith({ content: { text_backing: 'panel' } });
});

describe('background', () => {
  const row = () => screen.getByText('Pastel garden').closest('.md-bg-row');

  test('"Version n", and " · Gemini" only on a done piece Gemini drew', () => {
    const { rerender } = render(<DesignTab {...props()} />);
    expect(row()).toHaveTextContent('Version 2');
    expect(row()).not.toHaveTextContent('Gemini');
    rerender(<DesignTab {...props({ pieces: [bg({ provider: 'gemini', drawn_count: 3 })] })} />);
    expect(row()).toHaveTextContent('Version 3 · Gemini');
    rerender(<DesignTab {...props({ pieces: [bg({ provider: 'gemini', status: 'working' })] })} />);
    expect(row()).toHaveTextContent('Painting...');
    expect(row()).not.toHaveTextContent('Gemini');
    rerender(<DesignTab {...props({ pieces: [bg({ provider: 'gemini', status: 'failed' })] })} />);
    expect(row()).not.toHaveTextContent('Gemini');
  });

  test('Re-roll re-rolls the background; disabled while drafting or with no image left', () => {
    const p = props();
    const { rerender } = render(<DesignTab {...p} />);
    fireEvent.click(within(row()).getByRole('button', { name: 'Re-roll' }));
    expect(p.onReroll).toHaveBeenCalledWith('background');
    rerender(<DesignTab {...props({ cap: { used: 60, limit: 60, remaining: 0 } })} />);
    expect(within(row()).getByRole('button', { name: 'Re-roll' })).toBeDisabled();
    expect(within(row()).getByRole('button', { name: 'Re-roll' })).toHaveAttribute('title', 'Daily image limit reached.');
    rerender(<DesignTab {...props({ pieces: [bg(), { piece_key: 'cocktail:7', status: 'working' }] })} />);
    expect(within(row()).getByRole('button', { name: 'Re-roll' })).toBeDisabled();
    rerender(<DesignTab {...props({ configured: { openai: false, gemini: false } })} />);
    expect(within(row()).getByRole('button', { name: 'Re-roll' })).toBeDisabled();
  });
});

describe('the Dr. Bartender mark', () => {
  test('a switch, on by default; off hides the Wordmark color row', () => {
    const p = props();
    const { rerender } = render(<DesignTab {...p} />);
    const sw = screen.getByRole('switch', { name: /Dr\. Bartender mark/ });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Wordmark color')).toBeInTheDocument();
    const seg = screen.getByRole('group', { name: 'Wordmark color' });
    expect(within(seg).getAllByRole('button').map((b) => b.textContent)).toEqual(['Theme ink', 'Accent', 'Gold']);
    fireEvent.click(within(seg).getByRole('button', { name: 'Gold' }));
    expect(p.onPatch).toHaveBeenLastCalledWith({ content: { mark_color: 'gold' } });
    fireEvent.click(sw);
    expect(p.onPatch).toHaveBeenLastCalledWith({ inputs: { drb_mark: false } });
    rerender(<DesignTab {...props({ inputs: { drb_mark: false } })} />);
    expect(screen.getByRole('switch', { name: /Dr\. Bartender mark/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText('Wordmark color')).toBeNull();
  });

  // v2 spec 5: the Placement .seg, the Wordmark color row's twin, under the
  // switch and above Wordmark color; missing reads as right.
  const placement = () => screen.getByRole('group', { name: 'Mark placement' });
  const sub = () => screen.getByRole('switch', { name: /Dr\. Bartender mark/ }).querySelector('.md-switch-sub');

  test('Placement: Left / Center / Right under the switch, above Wordmark color; missing reads as right', () => {
    const { container } = render(<DesignTab {...props()} />);
    expect(screen.getByText('Placement')).toBeInTheDocument();
    expect(within(placement()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Left', 'Center', 'Right']);
    expect(within(placement()).getByRole('button', { name: 'Right' })).toHaveClass('active');
    expect(within(placement()).getByRole('button', { name: 'Right' })).toHaveAttribute('aria-pressed', 'true');
    expect(sub()).toHaveTextContent(/^Small, bottom right$/);
    // The order in the mark block: the switch, Placement, then Wordmark color.
    const rows = [...container.querySelector('.md-mark').children];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute('role', 'switch');
    expect(within(rows[1]).getByRole('group', { name: 'Mark placement' })).toBeInTheDocument();
    expect(within(rows[2]).getByRole('group', { name: 'Wordmark color' })).toBeInTheDocument();
  });

  test('Placement PATCHes { content: { mark_position } } and the sub line follows the value', () => {
    const p = props();
    const { rerender } = render(<DesignTab {...p} />);
    fireEvent.click(within(placement()).getByRole('button', { name: 'Left' }));
    expect(p.onPatch).toHaveBeenLastCalledWith({ content: { mark_position: 'left' } });
    fireEvent.click(within(placement()).getByRole('button', { name: 'Center' }));
    expect(p.onPatch).toHaveBeenLastCalledWith({ content: { mark_position: 'center' } });
    // The chosen one again sends nothing.
    p.onPatch.mockClear();
    fireEvent.click(within(placement()).getByRole('button', { name: 'Right' }));
    expect(p.onPatch).not.toHaveBeenCalled();
    [['left', 'Left', 'Small, bottom left'], ['center', 'Center', 'Small, bottom center'], ['right', 'Right', 'Small, bottom right']]
      .forEach(([v, label, line]) => {
        rerender(<DesignTab {...props({ content: CONTENT({ mark_position: v }) })} />);
        expect(within(placement()).getByRole('button', { name: label })).toHaveClass('active');
        expect(sub()).toHaveTextContent(new RegExp(`^${line}$`));
      });
    // An unknown stored value reads as right.
    rerender(<DesignTab {...props({ content: CONTENT({ mark_position: 'middle' }) })} />);
    expect(within(placement()).getByRole('button', { name: 'Right' })).toHaveClass('active');
    expect(sub()).toHaveTextContent(/^Small, bottom right$/);
  });

  test('Placement is off with the rest of the tab until the words land, and hidden with the mark off', () => {
    const p = props({ wordsDone: false });
    const { rerender } = render(<DesignTab {...p} />);
    expect(placement().closest('.md-tabpane')).toHaveAttribute('inert');
    fireEvent.click(within(placement()).getByRole('button', { name: 'Left' }));
    expect(p.onPatch).not.toHaveBeenCalled();
    const ro = props({ readOnly: true });
    rerender(<DesignTab {...ro} />);
    expect(placement().closest('.md-tabpane')).toHaveAttribute('inert');
    fireEvent.click(within(placement()).getByRole('button', { name: 'Center' }));
    expect(ro.onPatch).not.toHaveBeenCalled();
    rerender(<DesignTab {...props({ inputs: { drb_mark: false }, content: CONTENT({ mark_position: 'left' }) })} />);
    expect(screen.queryByRole('group', { name: 'Mark placement' })).toBeNull();
    expect(screen.queryByText('Placement')).toBeNull();
    // The sub line still says where the mark goes when it is switched back on.
    expect(sub()).toHaveTextContent(/^Small, bottom left$/);
  });
});

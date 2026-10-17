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
  render(<DesignTab {...q} />);
  fireEvent.click(screen.getAllByRole('button', { name: /^Bar Menu/ })[7]);
  expect(q.onPatch).not.toHaveBeenCalled();
});

test('loads all six pairings\' faces, since the tab shows each', () => {
  render(<DesignTab {...props()} />);
  const href = document.head.querySelector('link[data-menu-fonts]').getAttribute('href');
  ['Pinyon+Script', 'Rye', 'Josefin+Sans', 'Shrikhand', 'Creepster', 'Pacifico'].forEach((f) => expect(href).toContain(f));
});

describe('font pairing', () => {
  test('six buttons, "Bar Menu" in each title face with its id; the chosen one is pressed', () => {
    render(<DesignTab {...props()} />);
    const buttons = screen.getAllByRole('button', { name: /^Bar Menu/ });
    expect(buttons).toHaveLength(6);
    expect(buttons.map((b) => b.querySelector('.md-pair-id').textContent))
      .toEqual(['elegant-script', 'rustic', 'modern-clean', 'retro', 'spooky', 'tropical']);
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    expect(buttons[0]).toHaveClass('is-on');
    const gallery = buttons[2].querySelector('.md-pair-sample');
    expect(gallery.style.fontFamily).toContain('Josefin Sans');
    expect(gallery.style.fontSize).toBe('16px');
    expect(gallery.style.textTransform).toBe('uppercase');
    expect(gallery.style.letterSpacing).toBe('0.18em');
    expect(buttons[0].querySelector('.md-pair-sample').style.fontSize).toBe('26px');
  });

  test('choosing a pairing resets ink and accent to its defaults', () => {
    const p = props({ content: CONTENT({ ink_color: '#1f2a44', accent_color: '#ee8a72' }) });
    render(<DesignTab {...p} />);
    fireEvent.click(screen.getAllByRole('button', { name: /^Bar Menu/ })[1]);
    expect(p.onPatch).toHaveBeenCalledWith({ content: { font_pairing: 'rustic', ink_color: null, accent_color: null } });
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
});

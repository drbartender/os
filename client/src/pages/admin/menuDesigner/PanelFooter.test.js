import React, { useState } from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, within } from '@testing-library/react';
import PanelFooter from './PanelFooter';
import menuCardState from './menuCardState';

// The editor's panel footer (spec 2026-10-01 section 11.1, Panel footer;
// decision 11). Its gate is menuCardState's generate, as the editor passes it.

const DRAFT = (words = 'done') => ({ id: 1, version: 2, read_only: false, inputs: {}, content: { words_status: words } });
const payload = (over = {}) => ({
  draft: null, pieces: [], brief: null, diff: null, print: { state: 'none' },
  cap: { used: 10, limit: 60, remaining: 50, resets_at: null }, configured: { openai: true, gemini: true },
  plan: { id: 7, menu_style: 'custom', drink_count: 4 }, ...over,
});
const gateOf = (p, local = {}) => menuCardState({ payload: p, local: { imageModel: 'openai', ...local } }).generate;
const models = () => screen.getByRole('group', { name: 'Image model' });

// The editor's wiring: the model choice is state that opens at GPT Image.
function Footer({ p = payload(), approving = false, ...rest }) {
  const [model, setModel] = useState('openai');
  return <PanelFooter draft={p.draft} configured={p.configured} imageModel={model} onImageModel={setModel}
    gate={gateOf(p, { imageModel: model, approving })} onGenerate={() => {}} {...rest} />;
}

test('GPT Image is first and selected on mount; Gemini draws once chosen', () => {
  render(<Footer />);
  const [gpt, gemini] = within(models()).getAllByRole('button');
  expect(gpt).toHaveTextContent('GPT Image');
  expect(gpt).toHaveClass('active');
  expect(gemini).toHaveTextContent('Gemini');
  expect(gemini).not.toHaveClass('active');
  expect(screen.getByText('About 2 minutes, about 5 images, drawn by GPT Image.')).toBeInTheDocument();
  fireEvent.click(gemini);
  expect(gemini).toHaveClass('active');
  expect(screen.getByText('About 2 minutes, about 5 images, drawn by Gemini.')).toBeInTheDocument();
});

test('Gemini is disabled, with its title, without its key; a stale Gemini choice falls back', () => {
  const onImageModel = jest.fn();
  render(<PanelFooter draft={null} configured={{ openai: true, gemini: false }} imageModel="gemini" onImageModel={onImageModel} gate={{ disabled: false, hint: '' }} />);
  const gemini = within(models()).getByRole('button', { name: 'Gemini' });
  expect(gemini).toBeDisabled();
  expect(gemini).toHaveAttribute('title', "Gemini isn't set up");
  expect(within(models()).getByRole('button', { name: 'GPT Image' })).toHaveClass('active');
  expect(onImageModel).toHaveBeenCalledWith('openai');
});

test('Generate (primary) with no draft, Start over (secondary) once one exists', () => {
  const onGenerate = jest.fn();
  const { rerender } = render(<Footer onGenerate={onGenerate} />);
  const gen = () => screen.getByRole('button', { name: /Generate|Start over/ });
  expect(gen()).toHaveTextContent('Generate');
  expect(gen()).toHaveClass('btn-primary');
  fireEvent.click(gen());
  expect(onGenerate).toHaveBeenCalledTimes(1);
  rerender(<Footer p={payload({ draft: DRAFT() })} onGenerate={onGenerate} />);
  expect(gen()).toHaveTextContent('Start over');
  expect(gen()).toHaveClass('btn-secondary');
  expect(screen.getByText('Re-drafts words and art from scratch, drawn by GPT Image.')).toBeInTheDocument();
  // A draft whose words failed retries as a Generate.
  rerender(<Footer p={payload({ draft: DRAFT('failed') })} onGenerate={onGenerate} />);
  expect(gen()).toHaveTextContent('Generate');
  rerender(<Footer p={payload({ draft: DRAFT() })} busy />);
  expect(screen.getByRole('button', { name: 'Starting over...' })).toBeDisabled();
});

describe('the gate', () => {
  const gen = () => screen.getByRole('button', { name: /Generate|Start over/ });

  test('cap.remaining short of the images it needs: held, and how many are left', () => {
    render(<Footer p={payload({ cap: { used: 57, limit: 60, remaining: 3, resets_at: null } })} />);
    expect(gen()).toBeDisabled();
    expect(screen.getByText('Needs 5 images; 3 left in the last 24 hours.')).toBeInTheDocument();
  });

  test('nothing left: held until the cap frees', () => {
    const resets = new Date(Date.now() + 3600 * 1000).toISOString();
    render(<Footer p={payload({ cap: { used: 60, limit: 60, remaining: 0, resets_at: resets } })} />);
    expect(gen()).toBeDisabled();
    expect(screen.getByText(/^Re-rolls resume (at|tomorrow at) /)).toBeInTheDocument();
  });

  test('not set up, or no drinks: held with the reason', () => {
    const { rerender } = render(<Footer p={payload({ configured: { openai: false, gemini: false } })} />);
    expect(gen()).toBeDisabled();
    expect(screen.getByText('Generate needs an AI key and drinks on the plan.')).toBeInTheDocument();
    rerender(<Footer p={payload({ plan: { id: 7, menu_style: 'custom', drink_count: 0 } })} />);
    expect(gen()).toBeDisabled();
  });

  test('held while drafting or approving; a no-menu mark does not hold it', () => {
    const drafting = payload({ draft: DRAFT('pending') });
    const { rerender } = render(<Footer p={drafting} />);
    expect(gen()).toBeDisabled();
    rerender(<Footer p={payload({ draft: DRAFT() })} approving />);
    expect(gen()).toBeDisabled();
    rerender(<Footer p={payload({ print: { state: 'not_required' } })} />);
    expect(gen()).toBeEnabled();
  });
});

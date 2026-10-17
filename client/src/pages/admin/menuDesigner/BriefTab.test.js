import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, within } from '@testing-library/react';
import BriefTab from './BriefTab';

// The editor's Brief tab (spec 2026-10-01 sections 4.3 and 9; 11.1, Brief tab).

const BRIEF = { theme: 'Garden wedding, soft and romantic.', naming: 'Name two after us.', notes: '', has_planner_image: true, planner_image_rev: 'r1' };
const DRAFT = (inputs = {}) => ({
  id: 1, version: 3, read_only: false,
  inputs: { planner_image_role: 'logo', reference_source: 'none', art_direction: '', drb_mark: true, has_reference: false, ...inputs },
  content: { words_status: 'done', logo_mode: 'above_title', logo_badge: false, palette: [{ name: 'Periwinkle', hex: '#8f9ee6' }, { name: 'Coral', hex: '#ee8a72' }] },
});
const props = (over = {}) => {
  const draft = over.draft === undefined ? DRAFT(over.inputs) : over.draft;
  return {
    draft, content: draft ? draft.content : undefined, inputs: draft ? draft.inputs : { planner_image_role: 'logo', reference_source: 'none', art_direction: '' },
    brief: BRIEF, diff: { added: [], dropped: [], brief_edited: [], image_changed: false, dismissed: false },
    plannerImage: { url: 'blob:planner' }, referenceFile: null, onReferenceFile: jest.fn(), onPatch: jest.fn(), wordsDone: true,
    ...over,
  };
};
const png = (name = 'moodboard.png', type = 'image/png', size = 1000) => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};
const fileInput = (container) => container.querySelector('input[type="file"]');

test('the client brief, read-only, with the palette', () => {
  render(<BriefTab {...props()} />);
  expect(screen.getByText('Potion Planner · read-only')).toBeInTheDocument();
  expect(screen.getByText('Garden wedding, soft and romantic.')).toBeInTheDocument();
  expect(screen.getByText('Name two after us.')).toBeInTheDocument();
  expect(screen.getByText('Design notes').parentElement).toHaveTextContent('None');
  expect(screen.getByTitle('Periwinkle')).toHaveClass('md-dot');
  expect(screen.getByText('Periwinkle, Coral')).toBeInTheDocument();
  expect(screen.queryByText('Edited by client')).toBeNull();
});

test('a field the client edited is tinted and labeled; the client image changed note', () => {
  const diff = { added: [], dropped: [], brief_edited: ['naming'], image_changed: true, dismissed: false };
  const { rerender } = render(<BriefTab {...props({ diff })} />);
  const naming = screen.getByText('Name two after us.');
  expect(naming).toHaveClass('is-edited');
  expect(naming.parentElement).toHaveTextContent('Edited by client');
  expect(screen.getByText('Garden wedding, soft and romantic.')).not.toHaveClass('is-edited');
  expect(screen.getByText('The client image changed since this draft.')).toBeInTheDocument();
  // Mark reviewed (dismissed) clears them until the plan changes again.
  rerender(<BriefTab {...props({ diff: { ...diff, dismissed: true } })} />);
  expect(screen.getByText('Name two after us.')).not.toHaveClass('is-edited');
  expect(screen.queryByText('Edited by client')).toBeNull();
  expect(screen.queryByText('The client image changed since this draft.')).toBeNull();
});

describe('the client image', () => {
  const roles = () => screen.getByRole('group', { name: 'Client image use' });

  test('Logo, with Placement and Backing beneath', () => {
    const p = props();
    render(<BriefTab {...p} />);
    expect(screen.getByAltText('From the planner')).toHaveAttribute('src', 'blob:planner');
    expect(screen.getByText('From the planner')).toBeInTheDocument();
    expect(within(roles()).getByRole('button', { name: 'Logo' })).toHaveClass('active');
    fireEvent.click(within(screen.getByRole('group', { name: 'Logo placement' })).getByRole('button', { name: 'Replace title' }));
    expect(p.onPatch).toHaveBeenLastCalledWith({ content: { logo_mode: 'replaces_title' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Logo backing' })).getByRole('button', { name: 'Badge' }));
    expect(p.onPatch).toHaveBeenLastCalledWith({ content: { logo_badge: true } });
  });

  test('Placement and Backing wait for the words', () => {
    render(<BriefTab {...props({ wordsDone: false })} />);
    within(screen.getByRole('group', { name: 'Logo placement' })).getAllByRole('button').forEach((b) => expect(b).toBeDisabled());
    expect(within(roles()).getByRole('button', { name: 'Style ref' })).toBeEnabled();
  });

  test('before a draft, or before its words, Placement and Backing say why they are off', () => {
    const { rerender } = render(<BriefTab {...props({ draft: null, wordsDone: false })} />);
    within(screen.getByRole('group', { name: 'Logo backing' })).getAllByRole('button').forEach((b) => expect(b).toBeDisabled());
    expect(screen.getByText('Placement and backing apply once a draft exists.')).toBeInTheDocument();
    rerender(<BriefTab {...props({ wordsDone: false })} />);
    expect(screen.getByText('Placement and backing apply once the menu words land.')).toBeInTheDocument();
    rerender(<BriefTab {...props()} />);
    expect(screen.queryByText(/^Placement and backing apply/)).toBeNull();
  });

  test('Style ref names the planner image as the reference; leaving it sends the source back to none', () => {
    const p = props({ referenceFile: png() });
    const { rerender } = render(<BriefTab {...p} />);
    fireEvent.click(within(roles()).getByRole('button', { name: 'Style ref' }));
    expect(p.onReferenceFile).toHaveBeenCalledWith(null);
    expect(p.onPatch).toHaveBeenLastCalledWith({ inputs: { planner_image_role: 'reference', reference_source: 'planner' } });
    const q = props({ inputs: { planner_image_role: 'reference', reference_source: 'planner' } });
    rerender(<BriefTab {...q} />);
    expect(screen.getByText('Used as the style reference below. Not printed.')).toBeInTheDocument();
    expect(screen.queryByText('Placement')).toBeNull();
    fireEvent.click(within(roles()).getByRole('button', { name: 'Logo' }));
    expect(q.onPatch).toHaveBeenLastCalledWith({ inputs: { planner_image_role: 'logo', reference_source: 'none' } });
  });

  test('Logo to Ignore leaves the source alone', () => {
    const p = props();
    render(<BriefTab {...p} />);
    fireEvent.click(within(roles()).getByRole('button', { name: 'Ignore' }));
    expect(p.onPatch).toHaveBeenLastCalledWith({ inputs: { planner_image_role: 'ignore' } });
  });

  test('no planner image', () => {
    render(<BriefTab {...props({ brief: { ...BRIEF, has_planner_image: false }, plannerImage: null })} />);
    expect(screen.getByText("The client didn't upload an image.")).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Client image use' })).toBeNull();
  });
});

describe('the style reference', () => {
  test('an upload while the planner image is the style ref flips it to Ignore', () => {
    const p = props({ inputs: { planner_image_role: 'reference', reference_source: 'planner' } });
    const { container } = render(<BriefTab {...p} />);
    expect(screen.getByText('Client image', { selector: '.md-ref-name' })).toBeInTheDocument();
    const file = png();
    fireEvent.change(fileInput(container), { target: { files: [file] } });
    expect(p.onReferenceFile).toHaveBeenCalledWith(file);
    expect(p.onPatch).toHaveBeenLastCalledWith({ inputs: { planner_image_role: 'ignore', reference_source: 'none' } });
  });

  test('Remove on the planner image flips it to Ignore', () => {
    const p = props({ inputs: { planner_image_role: 'reference', reference_source: 'planner' } });
    render(<BriefTab {...p} />);
    fireEvent.click(within(screen.getByText('Client image', { selector: '.md-ref-name' }).closest('.md-ref-row')).getByRole('button', { name: 'Remove' }));
    expect(p.onPatch).toHaveBeenLastCalledWith({ inputs: { planner_image_role: 'ignore', reference_source: 'none' } });
  });

  test('a dropped file is taken like Upload', () => {
    const p = props();
    render(<BriefTab {...p} />);
    const zone = screen.getByText('Drop an image to steer the style').closest('.md-drop');
    fireEvent.dragOver(zone, { dataTransfer: { files: [] } });
    expect(zone).toHaveClass('is-over');
    const file = png('board.webp', 'image/webp');
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(p.onReferenceFile).toHaveBeenCalledWith(file);
    expect(p.onPatch).not.toHaveBeenCalled();
  });

  test('once a draft exists a new file is staged: "Applies when you start over"', () => {
    const { rerender } = render(<BriefTab {...props({ referenceFile: png('board.png') })} />);
    const row = screen.getByText('board.png').closest('.md-ref-row');
    expect(row).toHaveTextContent('Applies when you start over');
    rerender(<BriefTab {...props({ draft: null, referenceFile: png('board.png') })} />);
    expect(screen.getByText('board.png').closest('.md-ref-row')).not.toHaveTextContent('Applies when you start over');
  });

  test('Remove on a held file drops it; on the stored upload it saves the source as none', () => {
    const p = props({ referenceFile: png('board.png') });
    const { rerender } = render(<BriefTab {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(p.onReferenceFile).toHaveBeenCalledWith(null);
    const q = props({ inputs: { reference_source: 'upload', has_reference: true } });
    rerender(<BriefTab {...q} />);
    expect(screen.getByText('Uploaded image')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(q.onPatch).toHaveBeenLastCalledWith({ inputs: { reference_source: 'none' } });
  });

  test('only a JPEG, PNG or WebP of 10 MB or less is taken', () => {
    const p = props();
    const { container } = render(<BriefTab {...p} />);
    expect(fileInput(container)).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    fireEvent.change(fileInput(container), { target: { files: [png('menu.pdf', 'application/pdf')] } });
    expect(screen.getByRole('alert')).toHaveTextContent('Use a JPEG, PNG or WebP image.');
    fireEvent.change(fileInput(container), { target: { files: [png('big.jpg', 'image/jpeg', 11 * 1024 * 1024)] } });
    expect(screen.getByRole('alert')).toHaveTextContent('The image must be 10 MB or smaller.');
    expect(p.onReferenceFile).not.toHaveBeenCalled();
  });
});

test('a read-only draft (no plan): shown, but nothing PATCHes or is taken', () => {
  const draft = { ...DRAFT(), read_only: true };
  const p = props({ draft, content: draft.content, inputs: draft.inputs });
  const { container } = render(<BriefTab {...p} />);
  within(screen.getByRole('group', { name: 'Client image use' })).getAllByRole('button').forEach((b) => expect(b).toBeDisabled());
  within(screen.getByRole('group', { name: 'Logo placement' })).getAllByRole('button').forEach((b) => expect(b).toBeDisabled());
  expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
  expect(screen.getByLabelText('Art direction')).toHaveAttribute('readonly');
  fireEvent.change(screen.getByLabelText('Art direction'), { target: { value: 'moody' } });
  fireEvent.drop(screen.getByText('Drop an image to steer the style').closest('.md-drop'), { dataTransfer: { files: [png()] } });
  fireEvent.change(fileInput(container), { target: { files: [png()] } });
  expect(p.onPatch).not.toHaveBeenCalled();
  expect(p.onReferenceFile).not.toHaveBeenCalled();
});

test('art direction, up to 500 characters, into the brief', () => {
  const p = props({ draft: null });
  render(<BriefTab {...p} />);
  const box = screen.getByPlaceholderText('e.g. watercolor, moody, gold accents');
  expect(box).toHaveAttribute('maxLength', '500');
  expect(box).toHaveAttribute('rows', '3');
  fireEvent.change(box, { target: { value: 'watercolor, airy' } });
  expect(p.onPatch).toHaveBeenCalledWith({ inputs: { art_direction: 'watercolor, airy' } });
});

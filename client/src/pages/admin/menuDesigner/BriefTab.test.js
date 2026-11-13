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
// The GET's plan block (spec 2026-10-19 section 7.1): planner_reference is the
// planner's own picks, the bar as labelled lines, and the two notes.
const PLAN = {
  id: 7, menu_style: 'custom', drink_count: 3, drinks: [], bar_summary: { beer_wine: 2, spirits: 1, na: 0 }, side: 'planner',
  planner_reference: {
    drinks: [{ name: 'Lavender Fizz', mock: false, typed: true }, { name: 'Margarita', mock: false, typed: false }, { name: 'Nojito', mock: true, typed: false }],
    bar: ['Beer and Wine: Light beer, Red.', 'Spirits: Vodka.'],
    additional_notes: 'Two guests are allergic to nuts.',
    mocktail_notes: null,
  },
};
const props = (over = {}) => {
  const draft = over.draft === undefined ? DRAFT(over.inputs) : over.draft;
  return {
    draft, content: draft ? draft.content : undefined, inputs: draft ? draft.inputs : { planner_image_role: 'logo', reference_source: 'none', art_direction: '' },
    brief: BRIEF, diff: { added: [], dropped: [], brief_edited: [], image_changed: false, dismissed: false }, plan: PLAN,
    plannerImage: { url: 'blob:planner' }, referenceFile: null, onReferenceFile: jest.fn(), onPatch: jest.fn(), wordsDone: true,
    ...over,
  };
};
// A section of the tab by its label.
const section = (label) => screen.getByText(label, { selector: '.md-sec-label' }).closest('.md-sec');
const png = (name = 'moodboard.png', type = 'image/png', size = 1000) => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};
const fileInput = (container) => container.querySelector('input[type="file"]');

test('the client brief, read-only, with the palette', () => {
  render(<BriefTab {...props()} />);
  const client = within(section('Client brief'));
  expect(client.getByText('Potion Planner · read-only')).toBeInTheDocument();
  expect(screen.getByText('Garden wedding, soft and romantic.')).toBeInTheDocument();
  expect(screen.getByText('Name two after us.')).toBeInTheDocument();
  expect(client.getByText('Design notes').parentElement).toHaveTextContent('None');
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

test('the bar picks changed note shows until dismissed', () => {
  const line = 'The bar picks changed since this draft.';
  const diff = { added: [], dropped: [], brief_edited: [], image_changed: false, bar_changed: true, dismissed: false };
  const { rerender } = render(<BriefTab {...props({ diff })} />);
  expect(screen.getByText(line)).toHaveClass('md-brief-edited');
  rerender(<BriefTab {...props({ diff: { ...diff, dismissed: true } })} />);
  expect(screen.queryByText(line)).toBeNull();
  rerender(<BriefTab {...props({ diff: { ...diff, bar_changed: false } })} />);
  expect(screen.queryByText(line)).toBeNull();
});

test('a renamed pre-deploy bar line: the unchecked note shows whether or not the diff is dismissed, never the bar picks changed note; plural for several', () => {
  const one = "A bar line renamed before bar picks were tracked can't be checked against them. Update draft rebuilds it from the client's picks.";
  const two = "2 bar lines renamed before bar picks were tracked can't be checked against them. Update draft rebuilds them from the client's picks.";
  const diff = { added: [], dropped: [], brief_edited: [], image_changed: false, bar_changed: false, bar_unchecked: 1, dismissed: false };
  const { rerender } = render(<BriefTab {...props({ diff })} />);
  expect(screen.getByText(one)).toHaveClass('md-brief-edited');
  expect(screen.queryByText('The bar picks changed since this draft.')).toBeNull();
  rerender(<BriefTab {...props({ diff: { ...diff, bar_changed: true } })} />);
  expect(screen.getByText(one)).toBeInTheDocument();
  expect(screen.getByText('The bar picks changed since this draft.')).toBeInTheDocument();
  rerender(<BriefTab {...props({ diff: { ...diff, dismissed: true } })} />);
  expect(screen.getByText(one)).toBeInTheDocument();
  rerender(<BriefTab {...props({ diff: { ...diff, bar_unchecked: 2 } })} />);
  expect(screen.getByText(two)).toBeInTheDocument();
  rerender(<BriefTab {...props({ diff: { ...diff, bar_unchecked: 0 } })} />);
  expect(screen.queryByText(one)).toBeNull();
  rerender(<BriefTab {...props({ diff, draft: { ...DRAFT(), read_only: true } })} />);
  expect(screen.queryByText(one)).toBeNull();
});

test('the unchecked note names no dismissed change, since the Update draft it names is the bar-only rebuild', () => {
  const diff = { added: [{ key: 'custom:mule', name: 'Cucumber Mule' }], dropped: [], brief_edited: [], image_changed: false,
    bar_changed: true, bar_unchecked: 1, dismissed: true };
  render(<BriefTab {...props({ diff })} />);
  expect(screen.getByText("A bar line renamed before bar picks were tracked can't be checked against them. Update draft rebuilds it "
    + "from the client's picks.")).toBeInTheDocument();
  expect(screen.queryByText(/changes you dismissed/)).toBeNull();
});

test('the unchecked note hides while a piece is painting, as the card and the banner do', () => {
  const one = "A bar line renamed before bar picks were tracked can't be checked against them. Update draft rebuilds it from the client's picks.";
  const diff = { added: [], dropped: [], brief_edited: [], image_changed: false, bar_changed: false, bar_unchecked: 1, dismissed: false };
  const { rerender } = render(<BriefTab {...props({ diff, pieces: [{ piece_key: 'background', status: 'working' }] })} />);
  expect(screen.queryByText(one)).toBeNull();
  rerender(<BriefTab {...props({ diff, pieces: [{ piece_key: 'background', status: 'done' }] })} />);
  expect(screen.getByText(one)).toBeInTheDocument();
});

describe('the client image', () => {
  const roles = () => screen.getByRole('group', { name: 'Client image use' });

  test('Logo, with Placement and Backing beneath', () => {
    const p = props();
    render(<BriefTab {...p} />);
    expect(screen.getByAltText('From the planner')).toHaveAttribute('src', 'blob:planner');
    expect(screen.getByText('From the planner', { selector: '.md-brief-img-label' })).toBeInTheDocument();
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
  const draft = { ...DRAFT({ admin_brief: { theme: 'Navy and brass', naming: '', notes: '' } }), read_only: true };
  const p = props({ draft, content: draft.content, inputs: draft.inputs, plan: null });
  const { container } = render(<BriefTab {...p} />);
  for (const name of ['Admin brief: Theme & colors', 'Admin brief: Drink naming', 'Admin brief: Design notes']) {
    expect(screen.getByLabelText(name)).toHaveAttribute('readonly');
    fireEvent.change(screen.getByLabelText(name), { target: { value: 'changed' } });
  }
  expect(screen.getByLabelText('Admin brief: Theme & colors')).toHaveValue('Navy and brass');
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

// ── The admin brief and the planner data (spec 2026-10-19 section 7) ───────

test('the sections in order: the client brief, the admin brief, from the planner, then the image, the reference and the art direction', () => {
  const { container } = render(<BriefTab {...props()} />);
  expect([...container.querySelectorAll('.md-sec-label')].map((el) => el.textContent))
    .toEqual(['Client brief', 'Admin brief', 'From the planner', 'Client image', 'Style reference', 'Art direction']);
  expect(within(section('Admin brief')).getByText('Yours · read first')).toHaveClass('md-sec-note');
  expect(within(section('From the planner')).getByText('Potion Planner · read-only')).toHaveClass('md-sec-note');
});

describe('the admin brief', () => {
  const ADMIN = { theme: 'Navy and brass', naming: '', notes: 'No florals' };
  const FIELDS = [
    ['Admin brief: Theme & colors', 'e.g. navy and brass, art deco, a little playful', 'theme'],
    ['Admin brief: Drink naming', "e.g. name the cocktails after the couple's dogs", 'naming'],
    ['Admin brief: Design notes', 'e.g. keep the title small, no florals', 'notes'],
  ];

  test('three Art direction inputs with their placeholders, 1,000 characters each, under the hint', () => {
    render(<BriefTab {...props({ inputs: { admin_brief: ADMIN } })} />);
    const box = within(section('Admin brief'));
    for (const [name, placeholder, key] of FIELDS) {
      const field = box.getByLabelText(name);
      expect(field.tagName).toBe('TEXTAREA');
      expect(field).toHaveClass('input');
      expect(field).toHaveAttribute('placeholder', placeholder);
      expect(field).toHaveAttribute('maxLength', '1000');
      expect(field).toHaveValue(ADMIN[key]);
      expect(field).not.toHaveAttribute('readonly');
    }
    expect(box.getByText('Theme & colors')).toHaveClass('meta-k');
    expect(box.getByText('Used first. Where you leave a field blank, the client\'s text is used. Use it for anything the client told you '
      + 'by email, text or phone. Applies at the next Generate or Start over.')).toHaveClass('md-brief-hint');
  });

  test('an edit saves the whole brief as one inputs object, the other fields as they stand', () => {
    const p = props({ inputs: { admin_brief: ADMIN } });
    render(<BriefTab {...p} />);
    fireEvent.change(screen.getByLabelText('Admin brief: Drink naming'), { target: { value: 'After the dogs' } });
    expect(p.onPatch).toHaveBeenLastCalledWith({ inputs: { admin_brief: { ...ADMIN, naming: 'After the dogs' } } });
    fireEvent.change(screen.getByLabelText('Admin brief: Theme & colors'), { target: { value: '' } });
    expect(p.onPatch).toHaveBeenLastCalledWith({ inputs: { admin_brief: { ...ADMIN, theme: '' } } });
  });

  test('before a draft, and on a draft that has none stored, the fields start empty and still save, words or no words', () => {
    const p = props({ draft: null, wordsDone: false });
    const { rerender } = render(<BriefTab {...p} />);
    for (const [name] of FIELDS) expect(screen.getByLabelText(name)).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Admin brief: Design notes'), { target: { value: 'Keep the title small' } });
    expect(p.onPatch).toHaveBeenLastCalledWith({ inputs: { admin_brief: { theme: '', naming: '', notes: 'Keep the title small' } } });
    const q = props({ wordsDone: false, draft: { ...DRAFT(), content: { words_status: 'pending' } } });
    rerender(<BriefTab {...q} />);
    fireEvent.change(screen.getByLabelText('Admin brief: Theme & colors'), { target: { value: 'Gold' } });
    expect(q.onPatch).toHaveBeenLastCalledWith({ inputs: { admin_brief: { theme: 'Gold', naming: '', notes: '' } } });
  });
});

describe('from the planner', () => {
  const box = () => within(section('From the planner'));
  const row = (label) => box().getByText(label, { selector: '.meta-k' }).closest('.md-brief-f');
  const CONSULT = "This menu's drinks come from the consult form, which the shopping list uses. The planner picks below are what the client chose on their own.";

  test('the menu style, the drinks with mocktails marked, the bar lines and the notes, in a client brief box', () => {
    render(<BriefTab {...props()} />);
    expect(row('Menu style')).toHaveTextContent('Custom');
    expect(row('Menu style').closest('.md-brief-box')).not.toBeNull();
    expect(row('Drinks (3)')).toHaveTextContent('Lavender Fizz, Margarita, Nojito (mocktail)');
    expect(within(row('Bar')).getByText('Beer and Wine: Light beer, Red.')).toBeInTheDocument();
    expect(within(row('Bar')).getByText('Spirits: Vodka.')).toBeInTheDocument();
    expect(row('Additional notes')).toHaveTextContent('Two guests are allergic to nuts.');
    expect(box().queryByText('Mocktail notes')).toBeNull();
    expect(screen.queryByText(CONSULT)).toBeNull();
    expect(screen.queryByText("The client hasn't picked drinks yet.")).toBeNull();
  });

  test('each menu style reads by its label, and an unset one reads not chosen', () => {
    const { rerender } = render(<BriefTab {...props()} />);
    for (const [style, label] of [['custom', 'Custom'], ['house', 'Standard (house)'], ['none', 'Skip'], [null, 'not chosen']]) {
      rerender(<BriefTab {...props({ plan: { ...PLAN, menu_style: style } })} />);
      expect(row('Menu style').querySelector('.md-brief-v')).toHaveTextContent(new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`));
    }
  });

  test('on the consult side the box says so above the planner picks; the mocktail notes show when present', () => {
    render(<BriefTab {...props({ plan: { ...PLAN, side: 'consult', planner_reference: { ...PLAN.planner_reference, mocktail_notes: 'No grapefruit.' } } })} />);
    const hint = box().getByText(CONSULT);
    expect(hint).toHaveClass('md-brief-hint');
    expect(hint.compareDocumentPosition(row('Drinks (3)')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row('Mocktail notes')).toHaveTextContent('No grapefruit.');
  });

  test('a planner side with no drinks says the client has not picked any; no bar lines read None', () => {
    render(<BriefTab {...props({ plan: { ...PLAN, planner_reference: { ...PLAN.planner_reference, drinks: [], bar: [], additional_notes: null } } })} />);
    expect(row('Drinks (0)')).toHaveTextContent("The client hasn't picked drinks yet.");
    expect(row('Bar')).toHaveTextContent('None');
    expect(box().queryByText('Additional notes')).toBeNull();
  });

  test('the bar picks changed line, and the unchecked bar line note beside it, sit under the Bar row, not the client brief', () => {
    const line = 'The bar picks changed since this draft.';
    const unchecked = "A bar line renamed before bar picks were tracked can't be checked against them. Update draft rebuilds it from the client's picks.";
    render(<BriefTab {...props({ diff: { added: [], dropped: [], brief_edited: [], image_changed: false, bar_changed: true, bar_unchecked: 1, dismissed: false } })} />);
    expect(within(row('Bar')).getByText(line)).toHaveClass('md-brief-edited');
    expect(within(row('Bar')).getByText(unchecked)).toHaveClass('md-brief-edited');
    expect(within(section('Client brief')).queryByText(line)).toBeNull();
    expect(within(section('Client brief')).queryByText(unchecked)).toBeNull();
  });

  test('no plan, no box', () => {
    render(<BriefTab {...props({ plan: null })} />);
    expect(screen.queryByText('From the planner', { selector: '.md-sec-label' })).toBeNull();
  });
});

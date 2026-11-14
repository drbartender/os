import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

jest.mock('../../../utils/api', () => ({ __esModule: true, default: { post: jest.fn(), patch: jest.fn(), delete: jest.fn() } }));
jest.mock('../../../utils/downloadMenuPrint', () => ({ downloadMenuPrint: jest.fn() }));
// eslint-disable-next-line import/first
import api from '../../../utils/api';
// eslint-disable-next-line import/first
import { downloadMenuPrint } from '../../../utils/downloadMenuPrint';
// eslint-disable-next-line import/first
import MenuCardFold from './MenuCardFold';
// eslint-disable-next-line import/first
import { shortDate } from './menuCardState';

// The fold carries every behavior of AdminMenuPrintBlock and EventDetailPlanLogo
// (spec 2026-10-01 decision 12, section 11.1). Both rows' kebabs share the
// trigger title "More actions".
const SAFE_LOGO = '/api/drink-plans/t/7f1c/logo';
const plan = (companyLogo = SAFE_LOGO) => ({ id: 7, selections: { companyLogo, menuStyle: 'custom' } });
const kebab = (i) => fireEvent.click(screen.getAllByTitle('More actions')[i]);
const menuItem = (name) => within(screen.getByRole('menu')).getByRole('menuitem', { name });
const fileOf = (size, name = 'menu.pdf') => {
  const f = new File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

beforeEach(() => {
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
});

// Ported from AdminMenuPrintBlock.test.js. Dallas could upload, replace and
// remove the print file but never read it back (fix list, 2026-09-22).
// Download reads it through the admin route.
describe('Download (the three ported tests)', () => {
  test('a posted file offers Download, which reads it back through the admin route', async () => {
    downloadMenuPrint.mockResolvedValue();
    render(<MenuCardFold proposalId={42} menuPrintKey="menu-print/42/a.pdf" menuNotRequired={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^Download$/ }));
    expect(screen.getByRole('button', { name: /Downloading/ })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Download$/ })).toBeEnabled());
    expect(downloadMenuPrint).toHaveBeenCalledWith('/proposals/42/menu-print');
  });

  test('no Download when nothing is posted', () => {
    render(<MenuCardFold proposalId={42} menuPrintKey={null} menuNotRequired={false} />);
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Upload$/ })).toBeInTheDocument();
  });

  // The helper rejects with a status-mapped message (downloadMenuPrint.test.js);
  // the card prints whatever message it is handed.
  test('a failed download says so on the card', async () => {
    downloadMenuPrint.mockRejectedValue({ status: 502, message: 'The menu file is temporarily unavailable. Try again in a minute.' });
    render(<MenuCardFold proposalId={42} menuPrintKey="menu-print/42/a.pdf" menuNotRequired={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^Download$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The menu file is temporarily unavailable. Try again in a minute.');
  });
});

describe('the Print file row', () => {
  test('its four values', () => {
    const { rerender } = render(<MenuCardFold proposalId={42} menuPrintKey="menu-print/42/a.jpg"
      print={{ state: 'approved', print_key: 'menu-print/42/a.jpg', approved_file_in_use: true, approved_at: '2026-10-09T17:00:00Z' }} />);
    expect(screen.getByText(`Approved menu · ${shortDate('2026-10-09T17:00:00Z')}`)).toBeInTheDocument();
    rerender(<MenuCardFold proposalId={42} menuPrintKey="menu-print/42/up.pdf" print={{ state: 'replaced', print_key: 'menu-print/42/up.pdf' }} />);
    expect(screen.getByText('Uploaded file')).toBeInTheDocument();
    // The draft GET failed: a posted file still reads as a file.
    rerender(<MenuCardFold proposalId={42} menuPrintKey="menu-print/42/up.pdf" print={null} />);
    expect(screen.getByText('Uploaded file')).toBeInTheDocument();
    rerender(<MenuCardFold proposalId={42} menuPrintKey={null} print={{ state: 'removed' }} />);
    expect(screen.getByText('Removed')).toBeInTheDocument();
    rerender(<MenuCardFold proposalId={42} menuPrintKey={null} print={null} />);
    expect(screen.getByText('None yet')).toBeInTheDocument();
  });

  test('Upload checks 10 MB before sending, then posts the file, says Working... and reloads', async () => {
    let land;
    api.post.mockReturnValue(new Promise((r) => { land = r; }));
    const onPrintChange = jest.fn(() => Promise.resolve());
    render(<MenuCardFold proposalId={42} onPrintChange={onPrintChange} />);
    const input = screen.getByTestId('menu-print-input');
    expect(input).toHaveAttribute('accept', '.pdf,.png,.jpg,.jpeg');
    fireEvent.change(input, { target: { files: [fileOf(10 * 1024 * 1024 + 1)] } });
    expect(screen.getByRole('alert')).toHaveTextContent('That file is too large. Keep the print file under 10MB.');
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [fileOf(2048)] } });
    expect(screen.getByText('Working...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
    land({ data: {} });
    await waitFor(() => expect(onPrintChange).toHaveBeenCalled());
    const [url, form, opts] = api.post.mock.calls[0];
    expect(url).toBe('/proposals/42/menu-print');
    expect(form.get('file').name).toBe('menu.pdf');
    // No file and no draft payload on the card: it saw no file and no proof.
    expect([form.get('expected_print_key'), form.get('seen_proof_id'), form.get('seen_proof_answer')]).toEqual(['', '', '']);
    expect(opts).toEqual({ headers: { 'Content-Type': 'multipart/form-data' } });
  });

  // A card loaded before the client answered, or before a Looks great released a file, posts what it showed.
  test('Replace file posts the file and the proof the card showed; a 409 on either code says so and refetches', async () => {
    const onPrintChange = jest.fn(() => Promise.resolve());
    const shown = 'menu-print/42/older.jpg';
    const proof = { id: 77, state: 'changes', answer: 'changes', url: 'u', sent_at: '2026-11-10T17:00:00Z', expired: false, history: [] };
    render(<MenuCardFold proposalId={42} menuPrintKey={shown} onPrintChange={onPrintChange}
      print={{ state: 'approved', print_key: shown, approved_file_in_use: true, approved_at: '2026-11-10T17:00:00Z' }}
      review={{ proof, print: { state: 'approved', held: false }, narrow: false, busyLabel: null, onRelease: jest.fn(), onClose: jest.fn(), onReadNotes: null }} />);
    for (const [code, line] of [['MENU_PROOF_CHANGED', "The client's review changed. Refresh to see it."],
      ['MENU_PRINT_CHANGED', 'A different print file is live now. Refresh to see it.']]) {
      api.post.mockRejectedValueOnce({ status: 409, code, message: line });
      fireEvent.change(screen.getByTestId('menu-print-input'), { target: { files: [fileOf(2048)] } });
      expect(await screen.findByRole('alert')).toHaveTextContent(line);
    }
    const form = api.post.mock.calls[0][1];
    expect([form.get('expected_print_key'), form.get('seen_proof_id'), form.get('seen_proof_answer')]).toEqual([shown, '77', 'changes']);
    await waitFor(() => expect(onPrintChange).toHaveBeenCalledTimes(2));
  });

  test("the server's magic-byte refusal shows its fieldErrors.file message", async () => {
    api.post.mockRejectedValue({ status: 400, message: 'Invalid upload.', fieldErrors: { file: 'The print file must be a PDF, PNG or JPEG.' } });
    render(<MenuCardFold proposalId={42} />);
    fireEvent.change(screen.getByTestId('menu-print-input'), { target: { files: [fileOf(100)] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('The print file must be a PDF, PNG or JPEG.');
  });

  test('the kebab with a file: Replace file opens the picker, Remove deletes and reloads', async () => {
    const onPrintChange = jest.fn(() => Promise.resolve());
    render(<MenuCardFold proposalId={42} menuPrintKey="menu-print/42/a.pdf" onPrintChange={onPrintChange} drinkPlan={plan()} />);
    const input = screen.getByTestId('menu-print-input');
    const click = jest.spyOn(input, 'click');
    kebab(0);
    fireEvent.click(menuItem('Replace file'));
    expect(click).toHaveBeenCalled();
    kebab(0);
    fireEvent.click(menuItem('Remove'));
    await waitFor(() => expect(onPrintChange).toHaveBeenCalled());
    // With no print block (the draft GET has not landed) the file shown is the proposal's.
    expect(api.delete).toHaveBeenCalledWith('/proposals/42/menu-print', { data: { expected_print_key: 'menu-print/42/a.pdf' } });
  });

  test("Remove names the file the card showed (print.print_key); a 409 MENU_PRINT_CHANGED says so and refetches", async () => {
    const onPrintChange = jest.fn(() => Promise.resolve());
    const shown = 'menu-print/42/older.jpg';
    render(<MenuCardFold proposalId={42} menuPrintKey={shown} onPrintChange={onPrintChange}
      print={{ state: 'approved', print_key: shown, approved_file_in_use: true, approved_at: '2026-11-10T17:00:00Z' }} />);
    api.delete.mockRejectedValueOnce({ status: 409, code: 'MENU_PRINT_CHANGED', message: 'A different print file is live now. Refresh to see it.' });
    kebab(0);
    fireEvent.click(menuItem('Remove'));
    expect(await screen.findByRole('alert')).toHaveTextContent('A different print file is live now. Refresh to see it.');
    expect(api.delete).toHaveBeenCalledWith('/proposals/42/menu-print', { data: { expected_print_key: shown } });
    await waitFor(() => expect(onPrintChange).toHaveBeenCalledTimes(1));
  });

  test('a download never blocks a replace', async () => {
    downloadMenuPrint.mockReturnValue(new Promise(() => {}));
    render(<MenuCardFold proposalId={42} menuPrintKey="menu-print/42/a.pdf" />);
    fireEvent.click(screen.getByRole('button', { name: /^Download$/ }));
    kebab(0);
    expect(menuItem('Replace file')).toBeEnabled();
  });

  test('No menu needed toggles both ways, and the 409 on the flip shows', async () => {
    const onPrintChange = jest.fn(() => Promise.resolve());
    const { rerender } = render(<MenuCardFold proposalId={42} menuNotRequired={false} onPrintChange={onPrintChange} />);
    kebab(0);
    fireEvent.click(menuItem('No menu needed for this event'));
    await waitFor(() => expect(onPrintChange).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith('/proposals/42/menu-print', { not_required: true });
    rerender(<MenuCardFold proposalId={42} menuNotRequired onPrintChange={onPrintChange} />);
    api.patch.mockRejectedValueOnce({ status: 409, message: 'A print file is posted for this event.' });
    kebab(0);
    fireEvent.click(menuItem('A menu is needed after all'));
    expect(await screen.findByRole('alert')).toHaveTextContent('A print file is posted for this event.');
    expect(api.patch).toHaveBeenLastCalledWith('/proposals/42/menu-print', { not_required: false });
    expect(onPrintChange).toHaveBeenCalledTimes(1);
  });
});

describe('the Client image row', () => {
  test('the role as its value, and the thumbnail from the ?w=240 layer', () => {
    const { rerender, container } = render(<MenuCardFold proposalId={42} drinkPlan={plan()} thumbUrl="blob:thumb" />);
    expect(screen.getByText('Logo on top')).toBeInTheDocument();
    expect(container.querySelector('.md-fold-img img')).toHaveAttribute('src', 'blob:thumb');
    rerender(<MenuCardFold proposalId={42} drinkPlan={plan()} role="reference" />);
    expect(screen.getByText('Style reference')).toBeInTheDocument();
    rerender(<MenuCardFold proposalId={42} drinkPlan={plan()} role="ignore" />);
    expect(screen.getByText('Ignored')).toBeInTheDocument();
  });

  test('Replace uploads with the image accept list, says Uploading..., and hands the plan its new selections', async () => {
    let land;
    api.post.mockReturnValue(new Promise((r) => { land = r; }));
    const setDrinkPlan = jest.fn();
    const onImageChange = jest.fn();
    render(<MenuCardFold proposalId={42} drinkPlan={plan()} setDrinkPlan={setDrinkPlan} onImageChange={onImageChange} />);
    const input = screen.getByTestId('menu-logo-input');
    expect(input).toHaveAttribute('accept', 'image/png,image/jpeg');
    const click = jest.spyOn(input, 'click');
    kebab(1);
    fireEvent.click(menuItem('Replace'));
    expect(click).toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [new File(['x'], 'logo.png', { type: 'image/png' })] } });
    expect(screen.getByText('Uploading...')).toBeInTheDocument();
    const selections = { companyLogo: '/api/drink-plans/t/7f1c/logo?v=2' };
    land({ data: { selections } });
    await waitFor(() => expect(onImageChange).toHaveBeenCalled());
    expect(api.post.mock.calls[0][0]).toBe('/drink-plans/7/logo');
    expect(api.post.mock.calls[0][1].get('logo').name).toBe('logo.png');
    const update = setDrinkPlan.mock.calls[0][0];
    expect(update({ id: 7, selections: { menuStyle: 'custom' } })).toEqual({ id: 7, selections });
    expect(update(null)).toBeNull();
  });

  test('an upload refusal shows fieldErrors.logo', async () => {
    api.post.mockRejectedValue({ status: 400, message: 'Invalid upload.', fieldErrors: { logo: 'Logo must be a PNG or JPEG image.' } });
    render(<MenuCardFold proposalId={42} drinkPlan={plan()} setDrinkPlan={jest.fn()} />);
    fireEvent.change(screen.getByTestId('menu-logo-input'), { target: { files: [new File(['x'], 'logo.gif')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Logo must be a PNG or JPEG image.');
  });

  test('Remove deletes the logo and keeps the plan in step', async () => {
    const setDrinkPlan = jest.fn();
    const onImageChange = jest.fn();
    api.delete.mockResolvedValue({ data: { selections: { menuStyle: 'custom' } } });
    render(<MenuCardFold proposalId={42} drinkPlan={plan()} setDrinkPlan={setDrinkPlan} onImageChange={onImageChange} />);
    kebab(1);
    fireEvent.click(menuItem('Remove'));
    await waitFor(() => expect(onImageChange).toHaveBeenCalled());
    expect(api.delete).toHaveBeenCalledWith('/drink-plans/7/logo');
    expect(setDrinkPlan).toHaveBeenCalled();
  });

  test('Download original opens a new tab, only for a URL the isSafeLogoUrl rule allows', () => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const { rerender } = render(<MenuCardFold proposalId={42} drinkPlan={plan()} />);
    kebab(1);
    fireEvent.click(menuItem('Download original'));
    expect(open).toHaveBeenCalledWith(SAFE_LOGO, '_blank', 'noopener,noreferrer');
    rerender(<MenuCardFold proposalId={42} drinkPlan={plan('javascript:alert(1)')} />);
    kebab(1);
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Download original' })).toBeNull();
    rerender(<MenuCardFold proposalId={42} drinkPlan={plan('https://evil.example/api/drink-plans/t/x/logo')} />);
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Download original' })).toBeNull();
    open.mockRestore();
  });

  test('no image: No image and Upload; no plan: No drink plan and no actions', async () => {
    const { rerender } = render(<MenuCardFold proposalId={42} drinkPlan={plan('')} setDrinkPlan={jest.fn()} />);
    expect(screen.getByText('No image')).toBeInTheDocument();
    const click = jest.spyOn(screen.getByTestId('menu-logo-input'), 'click');
    const uploads = screen.getAllByRole('button', { name: 'Upload' });
    fireEvent.click(uploads[uploads.length - 1]);
    expect(click).toHaveBeenCalled();
    rerender(<MenuCardFold proposalId={42} menuPrintKey="menu-print/42/a.pdf" drinkPlan={null} />);
    expect(screen.getByText('No drink plan')).toBeInTheDocument();
    expect(screen.queryByTestId('menu-logo-input')).toBeNull();
    expect(screen.getAllByTitle('More actions')).toHaveLength(1);
  });
});

describe('the review fixes', () => {
  test('no file and marked not required reads No menu needed, from the loaded proposal', () => {
    const { rerender } = render(<MenuCardFold proposalId={42} menuNotRequired print={null} />);
    expect(screen.getByText('No menu needed')).toBeInTheDocument();
    rerender(<MenuCardFold proposalId={42} menuNotRequired={false} print={null} />);
    expect(screen.getByText('None yet')).toBeInTheDocument();
  });

  test('the 409 on marking no menu needed shows, and nothing reloads', async () => {
    const onPrintChange = jest.fn(() => Promise.resolve());
    api.patch.mockRejectedValue({ status: 409, message: 'A print file is posted; remove it first.' });
    render(<MenuCardFold proposalId={42} menuNotRequired={false} onPrintChange={onPrintChange} />);
    kebab(0);
    fireEvent.click(menuItem('No menu needed for this event'));
    expect(await screen.findByRole('alert')).toHaveTextContent('A print file is posted; remove it first.');
    expect(api.patch).toHaveBeenCalledWith('/proposals/42/menu-print', { not_required: true });
    expect(onPrintChange).not.toHaveBeenCalled();
  });

  test('a 409 MENU_PRINT_CHANGED on No menu needed (a release posted a file since the card loaded) says so and refetches', async () => {
    const onPrintChange = jest.fn(() => Promise.resolve());
    api.patch.mockRejectedValue({ status: 409, code: 'MENU_PRINT_CHANGED', message: 'A print file is live now. Refresh to see it.' });
    render(<MenuCardFold proposalId={42} menuNotRequired={false} onPrintChange={onPrintChange} />);
    kebab(0);
    fireEvent.click(menuItem('No menu needed for this event'));
    expect(await screen.findByRole('alert')).toHaveTextContent('A print file is live now. Refresh to see it.');
    await waitFor(() => expect(onPrintChange).toHaveBeenCalledTimes(1));
  });

  test('with a file, No menu needed is not offered', () => {
    render(<MenuCardFold proposalId={42} menuPrintKey="menu-print/42/a.pdf" menuNotRequired={false} />);
    kebab(0);
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((b) => b.textContent);
    expect(items).toEqual(['Replace file', 'Remove']);
  });

  test('each row kebab has its own accessible name', () => {
    render(<MenuCardFold proposalId={42} drinkPlan={plan()} />);
    expect(screen.getByRole('button', { name: 'Print file actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Client image actions' })).toBeInTheDocument();
  });

  test('the thumbnail falls back to a safe companyLogo, never an unsafe one', () => {
    const { container, rerender } = render(<MenuCardFold proposalId={42} drinkPlan={plan()} thumbUrl={null} />);
    expect(container.querySelector('.md-fold-img img')).toHaveAttribute('src', SAFE_LOGO);
    rerender(<MenuCardFold proposalId={42} drinkPlan={plan('javascript:alert(1)')} thumbUrl={null} />);
    expect(container.querySelector('.md-fold-img img')).toBeNull();
  });

  test('a row with Upload and no kebab keeps the kebab slot, so the Upload buttons line up', () => {
    const { container } = render(<MenuCardFold proposalId={42} drinkPlan={plan('')} />);
    const rows = container.querySelectorAll('.md-fold-row');
    expect(rows[0].lastElementChild).toHaveClass('md-fold-kebab');
    expect(rows[1].lastElementChild).toHaveClass('md-fold-kebab');
    expect(rows[1].lastElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});

test('each fold value carries its full text as a title, for a row that ellipsizes it', () => {
  render(<MenuCardFold proposalId={42} menuPrintKey="menu-print/42/a.jpg" drinkPlan={plan()}
    print={{ state: 'approved', print_key: 'menu-print/42/a.jpg', approved_file_in_use: true, approved_at: '2026-10-09T17:00:00Z' }} />);
  const approvedText = `Approved menu · ${shortDate('2026-10-09T17:00:00Z')}`;
  expect(screen.getByText(approvedText)).toHaveAttribute('title', approvedText);
  expect(screen.getByText('Logo on top')).toHaveAttribute('title', 'Logo on top');
});


// ── The Client review row (spec 2026-10-19 section 14; lane menu-approve-send) ──

describe('the Client review row', () => {
  const SENT = '2026-11-10T17:00:00Z';
  const URL_ = 'https://drbartender.com/menu-proof/11111111-2222-4333-8444-555555555555';
  const proof = (over = {}) => ({ id: 77, state: 'open', url: URL_, sent_at: SENT, email_status: 'sent', expired: false, answer: null,
    answered_at: null, withdrawn_at: null, history: [], ...over });
  const review = (over = {}) => ({ proof: proof(), print: { state: 'held', held: true }, narrow: false, busyLabel: null,
    onRelease: jest.fn(), onClose: jest.fn(), onReadNotes: jest.fn(), ...over });
  const row = () => screen.getByText('Client review').closest('.md-fold-row');
  const writeText = jest.fn();
  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });
  afterEach(() => { jest.useRealTimers(); });

  test('the third row, after Print file and Client image; none without the draft payload', () => {
    const { container, rerender } = render(<MenuCardFold proposalId={42} drinkPlan={plan('')} review={review()} />);
    expect([...container.querySelectorAll('.md-fold-row .meta-k')].map((el) => el.textContent)).toEqual(['Print file', 'Client image', 'Client review']);
    expect(within(row()).getByText(`Sent ${shortDate(SENT)}`)).toHaveAttribute('title', `Sent ${shortDate(SENT)}`);
    rerender(<MenuCardFold proposalId={42} drinkPlan={plan('')} review={null} />);
    expect(screen.queryByText('Client review')).toBeNull();
  });

  test('Not sent yet, with no Copy link and an empty kebab slot', () => {
    render(<MenuCardFold proposalId={42} review={review({ proof: null, print: { state: 'none', held: false } })} />);
    expect(within(row()).getByText('Not sent yet')).toBeInTheDocument();
    expect(within(row()).queryByRole('button', { name: 'Copy link' })).toBeNull();
    expect(row().lastElementChild).toHaveClass('md-fold-kebab');
    expect(row().lastElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  test('Copy link copies the link and reads Copied for 2 s', async () => {
    jest.useFakeTimers();
    render(<MenuCardFold proposalId={42} review={review()} />);
    const copy = within(row()).getByRole('button', { name: 'Copy link' });
    expect(copy).toHaveClass('btn', 'btn-ghost', 'btn-sm');
    await act(async () => { fireEvent.click(copy); });
    expect(writeText).toHaveBeenCalledWith(URL_);
    expect(within(row()).getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(1999); });
    expect(within(row()).getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(1); });
    expect(within(row()).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
  });

  test('a copy that fails says so in an alert', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(<MenuCardFold proposalId={42} review={review()} />);
    fireEvent.click(within(row()).getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't copy. Open the editor to approve again.");
  });

  test('no Copy link once the link has expired, or the proof was withdrawn', () => {
    const { rerender } = render(<MenuCardFold proposalId={42} review={review({ proof: proof({ state: 'expired', expired: true }) })} />);
    expect(within(row()).getByText(`Sent ${shortDate(SENT)} · link expired`)).toBeInTheDocument();
    expect(within(row()).queryByRole('button', { name: 'Copy link' })).toBeNull();
    rerender(<MenuCardFold proposalId={42} review={review({ proof: proof({ state: 'withdrawn', withdrawn_at: SENT }), print: { state: 'approved' } })} />);
    expect(within(row()).queryByRole('button', { name: 'Copy link' })).toBeNull();
  });

  test('the kebab while held: Release for printing, and for a change request Read the client\'s notes', () => {
    const r = review({ proof: proof({ state: 'changes', answer: 'changes', answered_at: SENT }) });
    render(<MenuCardFold proposalId={42} review={r} />);
    expect(within(row()).getByText(`Changes requested ${shortDate(SENT)}`)).toBeInTheDocument();
    fireEvent.click(within(row()).getByTitle('More actions'));
    expect(within(row()).getByTitle('More actions')).toHaveAttribute('aria-label', 'Client review actions');
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((m) => m.textContent.trim())).toEqual(['Release for printing', "Read the client's notes"]);
    fireEvent.click(menuItem('Release for printing'));
    expect(r.onRelease).toHaveBeenCalledTimes(1);
    fireEvent.click(within(row()).getByTitle('More actions'));
    fireEvent.click(menuItem("Read the client's notes"));
    expect(r.onReadNotes).toHaveBeenCalledTimes(1);
  });

  test('a change request on a released menu offers Close request; while it runs the row reads Closing...', () => {
    const r = review({ proof: proof({ state: 'changes', answer: 'changes', answered_at: SENT }), print: { state: 'approved', held: false } });
    const { rerender } = render(<MenuCardFold proposalId={42} review={r} />);
    fireEvent.click(within(row()).getByTitle('More actions'));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((m) => m.textContent.trim())).toEqual(["Read the client's notes", 'Close request']);
    fireEvent.click(menuItem('Close request'));
    expect(r.onClose).toHaveBeenCalledTimes(1);
    rerender(<MenuCardFold proposalId={42} review={{ ...r, busyLabel: 'Closing...' }} />);
    expect(within(row()).getByText('Closing...')).toBeInTheDocument();
    fireEvent.click(within(row()).getByTitle('More actions'));
    expect(menuItem('Close request')).toBeDisabled();
  });

  test("with no editor to open, the kebab has no Read the client's notes", () => {
    render(<MenuCardFold proposalId={42} review={review({ proof: proof({ state: 'changes', answer: 'changes' }), onReadNotes: null })} />);
    fireEvent.click(within(row()).getByTitle('More actions'));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((m) => m.textContent.trim())).toEqual(['Release for printing']);
  });

  test('below 900 px the row keeps Copy link and drops the kebab', () => {
    render(<MenuCardFold proposalId={42} review={review({ narrow: true })} />);
    expect(within(row()).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(within(row()).queryByTitle('More actions')).toBeNull();
  });
});

test('the Print file row: the released menu staff still have beside a newer held one is the approved menu, not an upload', () => {
  render(<MenuCardFold proposalId={42} menuPrintKey="menu-print/42/old.jpg"
    print={{ state: 'held', held: true, live: 'previous', print_key: 'menu-print/42/old.jpg', approved_file_in_use: false,
      approved_at: '2026-11-10T17:00:00Z', released_at: '2026-10-09T17:00:00Z' }} />);
  expect(screen.getByText(`Approved menu · ${shortDate('2026-10-09T17:00:00Z')}`)).toBeInTheDocument();
  expect(screen.queryByText('Uploaded file')).toBeNull();
});

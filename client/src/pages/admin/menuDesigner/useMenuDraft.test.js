import React, { useState } from 'react';
import '@testing-library/jest-dom';
import { render, renderHook, act, screen, fireEvent } from '@testing-library/react';
import useMenuDraft, { POLL_MS, BACKOFF_MS, SAVE_DEBOUNCE_MS } from './useMenuDraft';

jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));
// eslint-disable-next-line import/first
import api from '../../../utils/api';

// Spec 2026-10-01 section 10.2: polling, autosave, the layer cache by image_rev
// and size, the page-visit brief, and decision 11's model choice.

const piece = (key, status = 'done', rev = `rev-${key}`) => ({
  piece_key: key, status, has_image: status === 'done', image_rev: status === 'done' ? rev : null,
});
const payload = ({ pieces = [piece('background'), piece('cocktail:1')], words = 'done', version = 3, plannerImage = false } = {}) => ({
  draft: { id: 1, version, art_version: 2, read_only: false, inputs: { planner_image_role: 'logo', reference_source: 'none' },
    content: { words_status: words, title: 'Bar Menu', drinks: [] } },
  pieces, brief: { theme: '', naming: '', notes: '', has_planner_image: plannerImage }, diff: null,
  print: { state: 'none' }, cap: { used: 0, limit: 60, remaining: 60, resets_at: null }, configured: { openai: true, gemini: true },
  plan: { id: 7, menu_style: 'custom', drink_count: 1 },
});

// Microtasks only (the timers are fake): let every resolved promise run.
const settle = async () => { for (let i = 0; i < 8; i += 1) await act(async () => {}); };
const advance = async (ms) => { await act(async () => { jest.advanceTimersByTime(ms); }); await settle(); };
const draftGets = () => api.get.mock.calls.filter(([url]) => /\/menu-draft$/.test(url));
const imageGets = () => api.get.mock.calls.filter(([url]) => /\/image|planner-image/.test(url)).map(([url]) => url);

// GET answers: menu-draft from the queue (the last repeats), images as named blobs.
let draftAnswers;
function answer(url) {
  if (/\/menu-draft$/.test(url)) {
    const next = draftAnswers.length > 1 ? draftAnswers.shift() : draftAnswers[0];
    return next instanceof Error || (next && next.status) ? Promise.reject(next) : Promise.resolve({ data: next });
  }
  return Promise.resolve({ data: { name: url } });
}

let urls;
beforeEach(() => {
  jest.useFakeTimers();
  draftAnswers = [payload()];
  api.get.mockImplementation(answer);
  api.patch.mockResolvedValue({ data: { version: 4 } });
  api.post.mockResolvedValue({ data: {} });
  urls = 0;
  URL.createObjectURL = jest.fn((blob) => { urls += 1; return `blob:${urls}:${blob.name}`; });
  URL.revokeObjectURL = jest.fn();
});
afterEach(() => { jest.useRealTimers(); });

const mount = async (id = 42) => {
  let hook;
  await act(async () => { hook = renderHook(({ pid }) => useMenuDraft(pid), { initialProps: { pid: id } }); });
  await settle();
  return hook;
};

describe('polling', () => {
  test('runs every 2 s while a piece is pending or working, and stops once nothing is', async () => {
    draftAnswers = [payload({ pieces: [piece('background', 'working'), piece('cocktail:1', 'pending')] }),
      payload({ pieces: [piece('background'), piece('cocktail:1', 'working')] }), payload()];
    const { result } = await mount();
    expect(draftGets()).toHaveLength(1);
    expect(result.current.activityKeys).toEqual(['background', 'cocktail:1']);
    await advance(POLL_MS - 1);
    expect(draftGets()).toHaveLength(1);
    await advance(1);
    expect(draftGets()).toHaveLength(2);
    await advance(POLL_MS);
    expect(draftGets()).toHaveLength(3);
    expect(result.current.activityKeys).toEqual([]);
    await advance(POLL_MS * 5);
    expect(draftGets()).toHaveLength(3);
  });

  test('runs while the words step is pending, and never with nothing open', async () => {
    draftAnswers = [payload({ words: 'pending', pieces: [] }), payload()];
    await mount();
    await advance(POLL_MS);
    expect(draftGets()).toHaveLength(2);
    await advance(POLL_MS * 3);
    expect(draftGets()).toHaveLength(2);
  });

  test('a 429 backs off to 10 s and says reconnecting', async () => {
    draftAnswers = [payload({ pieces: [piece('background', 'working')] }), { status: 429, message: 'Too many requests.' },
      payload({ pieces: [piece('background', 'working')] })];
    const { result } = await mount();
    await advance(POLL_MS);
    expect(draftGets()).toHaveLength(2);
    expect(result.current.reconnecting).toBe(true);
    await advance(POLL_MS * 4);
    expect(draftGets()).toHaveLength(2);
    await advance(BACKOFF_MS - POLL_MS * 4);
    expect(draftGets()).toHaveLength(3);
    expect(result.current.reconnecting).toBe(false);
  });

  test('a failed first load is the error, with no payload; refetch retries', async () => {
    draftAnswers = [{ status: 500, message: 'Something went wrong. Please try again.' }, payload()];
    const { result } = await mount();
    expect(result.current.payload).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toEqual({ message: 'Something went wrong. Please try again.', status: 500 });
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBeNull();
    expect(result.current.payload.draft.version).toBe(3);
  });
});

describe('autosave', () => {
  test('debounces 800 ms after the last edit and PATCHes only the sent sections', async () => {
    const { result } = await mount();
    act(() => { result.current.edit({ content: { title: 'Fall Menu' } }); });
    expect(result.current.draft.content.title).toBe('Fall Menu');
    expect(result.current.save.state).toBe('saving');
    await advance(SAVE_DEBOUNCE_MS - 100);
    act(() => { result.current.edit({ content: { title: 'Fall Bar' } }); });
    await advance(SAVE_DEBOUNCE_MS - 1);
    expect(api.patch).not.toHaveBeenCalled();
    await advance(1);
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledWith('/proposals/42/menu-draft', { version: 3, content: { title: 'Fall Bar' } });
    expect(result.current.save.state).toBe('saved');
    expect(result.current.draft.version).toBe(4);
  });

  test('a 409 refetches, drops the unsaved edits and reports a conflict', async () => {
    api.patch.mockRejectedValue({ status: 409, code: 'MENU_DRAFT_CHANGED', message: 'The draft changed. Try again.' });
    draftAnswers = [payload(), payload({ version: 5 })];
    const { result } = await mount();
    act(() => { result.current.edit({ content: { title: 'Mine' } }); });
    await advance(SAVE_DEBOUNCE_MS);
    expect(draftGets()).toHaveLength(2);
    expect(result.current.save.conflict).toBe(true);
    expect(result.current.draft.content.title).toBe('Bar Menu');
    expect(result.current.draft.version).toBe(5);
  });

  test('flush() resolves after an in-flight save', async () => {
    let land;
    api.patch.mockReturnValue(new Promise((r) => { land = r; }));
    const { result } = await mount();
    act(() => { result.current.edit({ inputs: { art_direction: 'moody' } }); });
    await advance(SAVE_DEBOUNCE_MS);
    let flushed = false;
    let p;
    act(() => { p = result.current.flush().then(() => { flushed = true; }); });
    await settle();
    expect(flushed).toBe(false);
    await act(async () => { land({ data: { version: 4 } }); await p; });
    expect(flushed).toBe(true);
    expect(api.patch).toHaveBeenCalledTimes(1);
  });

  test('flush() sends at once, and rejects when the save fails; the edits are kept for Retry', async () => {
    api.patch.mockRejectedValueOnce({ status: 500, message: 'Something went wrong.' });
    const { result } = await mount();
    act(() => { result.current.edit({ content: { title: 'Kept' } }); });
    let caught = null;
    await act(async () => { await result.current.flush().catch((e) => { caught = e; }); });
    expect(caught).toEqual({ status: 500, message: 'Something went wrong.' });
    expect(result.current.save.state).toBe('failed');
    expect(result.current.draft.content.title).toBe('Kept');
    await act(async () => { await result.current.retrySave(); });
    expect(api.patch).toHaveBeenLastCalledWith('/proposals/42/menu-draft', { version: 3, content: { title: 'Kept' } });
    expect(result.current.save.state).toBe('saved');
  });
});

describe('layers', () => {
  test('cached by image_rev and size: only a changed rev is fetched, has_image false never is, and URLs are revoked', async () => {
    draftAnswers = [
      payload({ pieces: [piece('background'), piece('cocktail:1'), piece('mocktail:2', 'pending')] }),
      payload({ pieces: [piece('background'), piece('cocktail:1', 'done', 'rev-new'), piece('mocktail:2', 'working')] }),
      payload({ pieces: [piece('background'), piece('cocktail:1', 'done', 'rev-new'), piece('mocktail:2', 'pending')] }),
    ];
    const { result, unmount } = await mount();
    expect(imageGets()).toEqual([
      '/proposals/42/menu-draft/pieces/background/image?w=240',
      '/proposals/42/menu-draft/pieces/cocktail%3A1/image?w=240',
    ]);
    expect(api.get).toHaveBeenCalledWith('/proposals/42/menu-draft/pieces/background/image?w=240', { responseType: 'blob' });
    const first = result.current.layers['240'];
    expect(Object.keys(first).sort()).toEqual(['background', 'cocktail:1']);
    await advance(POLL_MS);
    expect(imageGets()).toHaveLength(3);
    expect(imageGets()[2]).toBe('/proposals/42/menu-draft/pieces/cocktail%3A1/image?w=240');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first['cocktail:1']);
    expect(result.current.layers['240'].background).toBe(first.background);
    await advance(POLL_MS);
    expect(imageGets()).toHaveLength(3);
    const held = Object.values(result.current.layers['240']);
    unmount();
    held.forEach((u) => expect(URL.revokeObjectURL).toHaveBeenCalledWith(u));
  });

  test('a piece that loses its image is dropped and revoked; full size only once asked for', async () => {
    draftAnswers = [payload({ pieces: [piece('background')] }), payload({ pieces: [piece('background', 'pending')] })];
    const { result } = await mount();
    const bg = result.current.layers['240'].background;
    let release;
    act(() => { release = result.current.wantSize('full'); });
    await settle();
    expect(imageGets()).toContain('/proposals/42/menu-draft/pieces/background/image');
    const full = result.current.layers.full.background;
    act(() => { release(); });
    await settle();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(full);
    await act(async () => { await result.current.refetch(); });
    await settle();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(bg);
    expect(result.current.layers['240']).toBeUndefined();
  });

  test('the planner image loads at 240 and refetches on refreshPlannerImage', async () => {
    draftAnswers = [payload({ plannerImage: true })];
    const { result } = await mount();
    expect(imageGets()).toContain('/proposals/42/menu-draft/planner-image?w=240');
    const was = result.current.plannerImages['240'];
    act(() => { result.current.refreshPlannerImage(); });
    await settle();
    expect(imageGets().filter((u) => u.includes('planner-image'))).toHaveLength(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(was);
  });
});

describe('the brief and the event', () => {
  test('the pre-draft inputs and the held file survive the editor closing and reopening', async () => {
    draftAnswers = [{ ...payload(), draft: null, pieces: [] }];
    const file = new File(['x'], 'ref.png', { type: 'image/png' });
    function FakeEditor({ menu }) {
      return <button type="button" onClick={() => { menu.setBrief({ art_direction: 'gold leaf' }); menu.setReferenceFile(file); }}>set</button>;
    }
    function Page() {
      const menu = useMenuDraft(42);
      const [open, setOpen] = useState(true);
      return (
        <>
          {open && <FakeEditor menu={menu} />}
          <button type="button" onClick={() => setOpen((o) => !o)}>toggle</button>
          <span data-testid="brief">{`${menu.brief.art_direction}|${menu.referenceFile ? menu.referenceFile.name : ''}`}</span>
        </>
      );
    }
    render(<Page />);
    await settle();
    fireEvent.click(screen.getByText('set'));
    fireEvent.click(screen.getByText('toggle'));
    fireEvent.click(screen.getByText('toggle'));
    expect(screen.getByTestId('brief')).toHaveTextContent('gold leaf|ref.png');
  });

  test('a proposalId change sends the pending save to the OLD id, then resets everything', async () => {
    const { result, rerender } = await mount(42);
    act(() => {
      result.current.edit({ content: { title: 'Old event' } });
      result.current.setBrief({ art_direction: 'x' });
      result.current.setReferenceFile(new File(['x'], 'r.png'));
      result.current.setImageModel('gemini');
    });
    expect(Object.keys(result.current.layers['240'])).toHaveLength(2);
    draftAnswers = [payload({ pieces: [] })];
    rerender({ pid: 43 });
    expect(result.current.payload).toBeNull();
    expect(result.current.brief.art_direction).toBe('');
    expect(result.current.referenceFile).toBeNull();
    expect(result.current.imageModel).toBe('openai');
    expect(result.current.layers).toEqual({});
    await settle();
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledWith('/proposals/42/menu-draft', { version: 3, content: { title: 'Old event' } });
    expect(draftGets().map(([u]) => u)).toEqual(['/proposals/42/menu-draft', '/proposals/43/menu-draft']);
    expect(result.current.draft.content.title).toBe('Bar Menu');
  });
});

describe('the image model (decision 11)', () => {
  test('rides each image request, the caller can pass its own, and it resets to openai on remount', async () => {
    const { result, unmount } = await mount();
    act(() => { result.current.setImageModel('gemini'); });
    await act(async () => { await result.current.generate(); });
    let form = api.post.mock.calls[0][1];
    expect(api.post.mock.calls[0][0]).toBe('/proposals/42/menu-draft/generate');
    expect(form.get('image_model')).toBe('gemini');
    expect([form.get('planner_image_role'), form.get('reference_source'), form.get('drb_mark')]).toEqual(['logo', 'none', 'true']);
    await act(async () => { await result.current.generate({ imageModel: 'openai' }); });
    form = api.post.mock.calls[1][1];
    expect(form.get('image_model')).toBe('openai');
    await act(async () => { await result.current.sync(); });
    expect(api.post).toHaveBeenLastCalledWith('/proposals/42/menu-draft/sync', { version: 3, image_model: 'gemini' });
    await act(async () => { await result.current.reroll('cocktail:1', { note: ' add a salt rim ' }); });
    expect(api.post).toHaveBeenLastCalledWith('/proposals/42/menu-draft/pieces/cocktail%3A1/reroll', { image_model: 'gemini', note: 'add a salt rim' });
    await act(async () => { await result.current.dismissPlanChange(); });
    expect(api.post).toHaveBeenLastCalledWith('/proposals/42/menu-draft/dismiss-plan-change', { version: 3 });
    unmount();
    const again = await mount();
    expect(again.result.current.imageModel).toBe('openai');
  });

  test('with no draft, Generate posts the brief and the held file, then lets the file go', async () => {
    draftAnswers = [{ ...payload(), draft: null, pieces: [] }];
    const { result } = await mount();
    const file = new File(['x'], 'ref.png', { type: 'image/png' });
    act(() => { result.current.setBrief({ planner_image_role: 'reference', reference_source: 'planner', art_direction: 'moody' }); });
    act(() => { result.current.setReferenceFile(file); });
    await act(async () => { await result.current.generate({ imageModel: 'openai' }); });
    const form = api.post.mock.calls[0][1];
    // A chosen upload replaces the planner image as the reference (spec 4.3).
    expect([form.get('planner_image_role'), form.get('reference_source'), form.get('art_direction')]).toEqual(['ignore', 'upload', 'moody']);
    expect(form.get('reference').name).toBe('ref.png');
    expect(result.current.referenceFile).toBeNull();
    expect(draftGets()).toHaveLength(2);
  });
});

describe('the review fixes', () => {
  test('an action resolves only once a GET after it lands; a failed refetch keeps trying with back-off', async () => {
    draftAnswers = [{ ...payload(), draft: null, pieces: [] }];
    const { result } = await mount();
    draftAnswers = [{ status: 500, message: 'Server error.' }, payload({ words: 'pending', pieces: [] })];
    let done = false;
    act(() => { result.current.generate({ imageModel: 'openai' }).then(() => { done = true; }); });
    await settle();
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    expect(result.current.reconnecting).toBe(true);
    await advance(POLL_MS);
    expect(draftGets()).toHaveLength(2);
    await advance(BACKOFF_MS - POLL_MS);
    expect(draftGets()).toHaveLength(3);
    expect(done).toBe(true);
    expect(result.current.draft.content.words_status).toBe('pending');
  });

  test('the version an action returns is kept, so a second Update draft never sends a stale one', async () => {
    const { result } = await mount();
    api.post.mockResolvedValue({ data: { version: 4 } });
    api.get.mockImplementation((url) => (/\/menu-draft$/.test(url) ? new Promise(() => {}) : answer(url)));
    act(() => { result.current.sync(); });
    await settle();
    act(() => { result.current.sync(); });
    await settle();
    expect(api.post.mock.calls.map((c) => c[1].version)).toEqual([3, 4]);
  });

  test('a non-429 failure while drawing backs off to 10 s and says reconnecting', async () => {
    draftAnswers = [payload({ pieces: [piece('background', 'working')] }), { status: 502, message: 'Bad gateway.' },
      payload({ pieces: [piece('background', 'working')] })];
    const { result } = await mount();
    await advance(POLL_MS);
    expect(draftGets()).toHaveLength(2);
    expect(result.current.reconnecting).toBe(true);
    await advance(POLL_MS * 4);
    expect(draftGets()).toHaveLength(2);
    await advance(BACKOFF_MS - POLL_MS * 4);
    expect(draftGets()).toHaveLength(3);
  });

  test('a GET from before our PATCH landed never steps the version back', async () => {
    const { result } = await mount();
    act(() => { result.current.edit({ content: { title: 'Mine' } }); });
    await advance(SAVE_DEBOUNCE_MS);
    expect(result.current.draft.version).toBe(4);
    draftAnswers = [payload({ version: 3 }), payload({ version: 4 })];
    await act(async () => { await result.current.refetch(); });
    expect(result.current.draft.version).toBe(4);
    expect(result.current.draft.content.title).toBe('Mine');
    await advance(POLL_MS);
    expect(draftGets()).toHaveLength(3);
  });

  test('a manual refetch replaces the scheduled poll rather than adding a second one', async () => {
    draftAnswers = [payload({ pieces: [piece('background', 'working')] })];
    const { result } = await mount();
    await advance(POLL_MS / 2);
    await act(async () => { await result.current.refetch(); });
    expect(draftGets()).toHaveLength(2);
    await advance(POLL_MS / 2);
    expect(draftGets()).toHaveLength(2);
    await advance(POLL_MS / 2);
    expect(draftGets()).toHaveLength(3);
  });

  test('the planner image is keyed on brief.planner_image_rev, and the cached rev is exposed', async () => {
    const withRev = (rev) => ({ ...payload({ plannerImage: true }), brief: { has_planner_image: true, planner_image_rev: rev } });
    draftAnswers = [withRev('aaaa'), withRev('bbbb'), withRev('bbbb')];
    const { result } = await mount();
    const planner = () => imageGets().filter((u) => u.includes('planner-image'));
    expect(planner()).toHaveLength(1);
    expect(result.current.plannerImageRevs['240']).toBe('aaaa');
    await act(async () => { await result.current.refetch(); });
    await settle();
    expect(planner()).toHaveLength(2);
    expect(result.current.plannerImageRevs['240']).toBe('bbbb');
    await act(async () => { await result.current.refetch(); });
    await settle();
    expect(planner()).toHaveLength(2);
    act(() => { result.current.refreshPlannerImage(); });
    await settle();
    expect(planner()).toHaveLength(3);
  });

  test("an event change sends the old event's pending edits even past an in-flight PATCH", async () => {
    let land;
    api.patch.mockImplementationOnce(() => new Promise((r) => { land = r; }));
    const { result, rerender } = await mount(42);
    act(() => { result.current.edit({ content: { title: 'A' } }); });
    await advance(SAVE_DEBOUNCE_MS);
    act(() => { result.current.edit({ content: { title: 'B' } }); });
    rerender({ pid: 43 });
    await settle();
    act(() => { result.current.edit({ content: { title: 'C' } }); });
    await act(async () => { land({ data: { version: 4 } }); });
    await advance(SAVE_DEBOUNCE_MS);
    const sent = api.patch.mock.calls.map(([url, body]) => [url, body.content.title]);
    expect(sent).toEqual([['/proposals/42/menu-draft', 'A'], ['/proposals/42/menu-draft', 'B'], ['/proposals/43/menu-draft', 'C']]);
  });

  test('a layer that lands after its piece left, or after unmount, is dropped and never made a URL', async () => {
    const lands = {};
    api.get.mockImplementation((url) => (/\/image/.test(url) ? new Promise((r) => { lands[url] = r; }) : answer(url)));
    draftAnswers = [payload({ pieces: [piece('background')] }), payload({ pieces: [piece('background', 'pending')] })];
    const { result, unmount } = await mount();
    await act(async () => { await result.current.refetch(); });
    await act(async () => { lands['/proposals/42/menu-draft/pieces/background/image?w=240']({ data: { name: 'late' } }); });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    draftAnswers = [payload({ pieces: [piece('background', 'done', 'rev-2')] })];
    await act(async () => { await result.current.refetch(); });
    await settle();
    unmount();
    await act(async () => { Object.values(lands).forEach((land) => land({ data: { name: 'after' } })); });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  test('Painting k of n: a job seen already under way counts every piece it could draw; a re-roll only its own', async () => {
    const at = (key, status, drawn) => ({ ...piece(key, status), drawn_count: drawn });
    draftAnswers = [payload({ pieces: [at('background', 'done', 1), at('cocktail:1', 'done', 1), at('cocktail:2', 'working', 0)] })];
    let hook = await mount();
    expect(hook.result.current.activityKeys.sort()).toEqual(['background', 'cocktail:1', 'cocktail:2']);
    hook.unmount();
    draftAnswers = [payload({ pieces: [at('background', 'done', 1), at('cocktail:1', 'working', 1)] })];
    hook = await mount();
    expect(hook.result.current.activityKeys).toEqual(['cocktail:1']);
  });
});


import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../../utils/api';

// The menu draft's image layers, for useMenuDraft (spec 2026-10-01 section
// 10.2). Each done piece (?w=240 for the card; full size once wantSize('full')
// asks) and the plan's planner image, fetched as blobs into object URLs cached
// by piece_key, rev and size:
// - a piece's rev is its image_rev: only a changed rev is fetched, and a piece
//   with has_image false never is;
// - the planner image's rev is the GET's brief.planner_image_rev, plus a
//   counter refreshPlannerImage() bumps to force a refetch; plannerImageRevs
//   names the rev of the image actually cached per size (Approve posts it back
//   as expected_planner_image_rev for the logo it drew);
// - a URL is revoked when replaced, when its piece leaves the wanted set, on
//   an event change and on unmount, and a fetch that lands after its piece left
//   the wanted set (or the event changed) is dropped, never turned into a URL.
// payload must belong to id (null until it does).

export const CARD_SIZE = '240';
export const FULL_SIZE = 'full';
const PLANNER = '#planner';
const NO_LAYERS = Object.freeze({ layers: {}, plannerImages: {}, plannerImageRevs: {} });

export default function useMenuLayers(id, payload) {
  const [extraSizes, setExtraSizes] = useState([]);
  const [bump, setBump] = useState(0);
  const [shown, setShown] = useState(NO_LAYERS);
  const live = useRef(null);
  const cache = useRef(new Map());
  const loading = useRef(new Map());

  const publish = useCallback(() => {
    const out = { layers: {}, plannerImages: {}, plannerImageRevs: {} };
    cache.current.forEach((e, k) => {
      const [size, key] = k.split('|');
      if (key === PLANNER) {
        out.plannerImages[size] = e.url;
        out.plannerImageRevs[size] = e.imageRev;
      } else (out.layers[size] = out.layers[size] || {})[key] = e.url;
    });
    setShown(out);
  }, []);

  useEffect(() => {
    live.current = id;
    setShown(NO_LAYERS);
    setBump(0);
    return () => {
      live.current = null;
      cache.current.forEach((e) => URL.revokeObjectURL(e.url));
      cache.current = new Map();
      loading.current = new Map();
    };
  }, [id]);

  const sizesKey = useMemo(() => [...new Set([CARD_SIZE, ...extraSizes])].join(','), [extraSizes]);

  useEffect(() => {
    if (!id || !payload || live.current !== id) return;
    const want = new Map();
    const pieces = Array.isArray(payload.pieces) ? payload.pieces : [];
    const brief = payload.brief || {};
    for (const size of sizesKey.split(',')) {
      const w = size === FULL_SIZE ? '' : `?w=${size}`;
      for (const p of pieces) {
        if (p && p.has_image && p.image_rev) {
          want.set(`${size}|${p.piece_key}`, { rev: p.image_rev, path: `/proposals/${id}/menu-draft/pieces/${encodeURIComponent(p.piece_key)}/image${w}` });
        }
      }
      if (brief.has_planner_image) {
        const imageRev = brief.planner_image_rev || null;
        want.set(`${size}|${PLANNER}`, { rev: `${imageRev}#${bump}`, imageRev, path: `/proposals/${id}/menu-draft/planner-image${w}` });
      }
    }
    let dropped = false;
    cache.current.forEach((e, k) => {
      if (!want.has(k)) { URL.revokeObjectURL(e.url); cache.current.delete(k); dropped = true; }
    });
    // A fetch for a key no longer wanted, or for an older rev, lands as nothing.
    loading.current.forEach((rev, k) => { if (!want.has(k) || want.get(k).rev !== rev) loading.current.delete(k); });
    want.forEach(({ rev, path, imageRev }, k) => {
      const have = cache.current.get(k);
      if ((have && have.rev === rev) || loading.current.get(k) === rev) return;
      loading.current.set(k, rev);
      const mine = loading.current;
      api.get(path, { responseType: 'blob' }).then((res) => {
        if (live.current !== id || mine !== loading.current || mine.get(k) !== rev) return;
        mine.delete(k);
        const prev = cache.current.get(k);
        cache.current.set(k, { rev, imageRev, url: URL.createObjectURL(res.data) });
        if (prev) URL.revokeObjectURL(prev.url);
        publish();
      }, () => { if (mine.get(k) === rev) mine.delete(k); });
    });
    if (dropped) publish();
  }, [id, payload, sizesKey, bump, publish]);

  const wantSize = useCallback((size) => {
    setExtraSizes((s) => [...s, String(size)]);
    return () => setExtraSizes((s) => { const i = s.indexOf(String(size)); return i < 0 ? s : [...s.slice(0, i), ...s.slice(i + 1)]; });
  }, []);
  const refreshPlannerImage = useCallback(() => setBump((b) => b + 1), []);

  return { ...shown, wantSize, refreshPlannerImage };
}

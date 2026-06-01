import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { QRCodeSVG } from 'qrcode.react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { formatMoney } from '../../utils/formatMoney';

/**
 * TipCardPage — staff portal v2 Tip Card tab (spec §6.8).
 *
 * URL: /staff-v2/tip-card
 *
 * Data fetches (lean — three round-trips on first paint):
 *   1. GET /api/me/tip-page — public tip URL (built server-side via PUBLIC_SITE_URL
 *      so we don't second-guess origin), `active` flag, `has_stripe_link` for the
 *      card row, preferred_name for the QR card head. Note: this route predates
 *      the Zelle column and does NOT project zelle_handle — that's why we also
 *      hit /payment-methods below.
 *   2. GET /api/me/payment-methods — canonical "what handles are on file" source.
 *      It's the ONLY route that returns zelle_handle, plus venmo / cashapp / paypal.
 *      Card method is always considered on file (it's the default rail).
 *   3. GET /api/me/tips — recent tips for the "this week" card. Filtered to the
 *      last 7 days client-side (the endpoint orders newest-first; we walk until
 *      we cross the 7-day boundary).
 *
 * `tip_card_order` comes from /api/me/ui-preferences (single small read) rather
 * than the global /me payload so this page stays self-contained and the order
 * lives in only one cache surface here. Order persists via PUT /me/tip-card-order
 * on every drag-end and arrow-tap.
 *
 * Reorder PUT serialization (spec §6.8): a PUT can be slow; without a queue,
 * a fast burst of arrow taps would race the server and the last-applied order
 * could lose to an earlier in-flight write. We serialize: at most one PUT in
 * flight; if a reorder fires while another is pending, we stash the latest
 * desired order and replay it AFTER the in-flight one resolves. On server
 * error we revert the optimistic UI to the last-acknowledged order and toast.
 *
 * Async-state coverage (spec §6.1.5):
 *   - Loading: hero + skeleton.
 *   - Error: inline retry card; hero stays visible. Composite-fetch failure
 *     blanks the page (any one of the three reads is load-bearing for the
 *     surface — without /tip-page we can't render the QR; without /payment-
 *     methods we can't enumerate methods).
 *   - Empty: (a) no tip page activated yet (token absent) → friendly guide,
 *     no crash; (b) no tips this week → mono empty copy in the tips card.
 */
export default function TipCardPage() {
  const navigate = useNavigate();
  const toast = useToast();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // optimistic order — server-confirmed mirror lives in `acknowledgedOrder`.
  const [order, setOrder] = useState([]);
  const acknowledgedOrderRef = useRef([]);
  // PUT serialization state. `inFlightRef` is true while a PUT is pending;
  // `queuedOrderRef` holds the latest desired order if another reorder fired
  // mid-flight. We deliberately only keep the LATEST queued order — older
  // intermediate orders are coalesced away (no point replaying them).
  const inFlightRef = useRef(false);
  const queuedOrderRef = useRef(null);

  const fetchAll = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [tipPageRes, methodsRes, tipsRes, prefsRes] = await Promise.all([
        api.get('/me/tip-page'),
        api.get('/me/payment-methods'),
        api.get('/me/tips'),
        api.get('/me/ui-preferences'),
      ]);
      const tipPage = tipPageRes.data || {};
      const methods = methodsRes.data || {};
      const tips = Array.isArray(tipsRes.data?.tips) ? tipsRes.data.tips : [];
      const prefs = prefsRes.data?.ui_preferences || {};

      // Canonical "on file" set: card is implicit, p2p depends on saved handles
      // from /payment-methods (the only source with zelle_handle).
      const onFile = new Set(['card']);
      if (methods.venmo_handle) onFile.add('venmo');
      if (methods.cashapp_handle) onFile.add('cashapp');
      if (methods.paypal_url) onFile.add('paypal');
      if (methods.zelle_handle) onFile.add('zelle');

      const savedOrder = Array.isArray(prefs.tip_card_order) ? prefs.tip_card_order : [];
      const resolvedOrder = resolveDisplayOrder(savedOrder, onFile);

      setData({
        url: tipPage.url || null,
        active: !!tipPage.active,
        has_stripe_link: !!tipPage.has_stripe_link,
        preferred_name: tipPage.preferred_name || methods.preferred_name || null,
        methods: {
          venmo_handle: methods.venmo_handle || null,
          cashapp_handle: methods.cashapp_handle || null,
          paypal_url: methods.paypal_url || null,
          zelle_handle: methods.zelle_handle || null,
        },
        tips,
      });
      setOrder(resolvedOrder);
      acknowledgedOrderRef.current = resolvedOrder;
    } catch (err) {
      setError(err?.message || 'Could not load your tip card.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // ── Serialized PUT pipeline ───────────────────────────────────────────
  // Public API: persistOrder(nextOrder). Optimistically updates `order`, then
  // fires the PUT (or queues if one is in flight). Single in-flight invariant
  // is enforced by inFlightRef; queuedOrderRef holds the LATEST queued state.
  const persistOrder = useCallback(async (nextOrder) => {
    setOrder(nextOrder);
    if (inFlightRef.current) {
      queuedOrderRef.current = nextOrder;
      return;
    }
    inFlightRef.current = true;
    let attemptOrder = nextOrder;
    try {
      while (attemptOrder) {
        try {
          await api.put('/me/tip-card-order', { order: attemptOrder });
          acknowledgedOrderRef.current = attemptOrder;
        } catch (err) {
          // Roll back optimistic UI to the last server-confirmed state and
          // drop the queue — the user needs to know something went wrong
          // before they keep dragging.
          setOrder(acknowledgedOrderRef.current);
          queuedOrderRef.current = null;
          toast.error(err?.message || "Couldn't save your card order.");
          return;
        }
        // Pull whatever was queued during this PUT and loop. If nothing's
        // queued we exit cleanly with inFlightRef released.
        attemptOrder = queuedOrderRef.current;
        queuedOrderRef.current = null;
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [toast]);

  // ── Action handlers ───────────────────────────────────────────────────
  const handleOpenPrint = useCallback(() => {
    window.open('/my-tip-page/print', '_blank', 'noopener,noreferrer');
  }, []);

  const handleShare = useCallback(async () => {
    const url = data?.url;
    if (!url) return;
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ url, title: 'Tip me on Dr. Bartender' });
        return;
      } catch (err) {
        // AbortError is the user cancelling the share sheet — silent. Other
        // errors fall through to clipboard.
        if (err?.name === 'AbortError') return;
      }
    }
    await copyToClipboard(url, toast);
  }, [data?.url, toast]);

  const handleCopy = useCallback(async () => {
    const url = data?.url;
    if (!url) return;
    await copyToClipboard(url, toast);
  }, [data?.url, toast]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const onDragEnd = useCallback((event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = order.indexOf(active.id);
    const newIdx = order.indexOf(over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(order, oldIdx, newIdx);
    persistOrder(next);
  }, [order, persistOrder]);

  const move = useCallback((idx, delta) => {
    const j = idx + delta;
    if (j < 0 || j >= order.length) return;
    const next = order.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
    persistOrder(next);
  }, [order, persistOrder]);

  // ── Loading state ─────────────────────────────────────────────────────
  if (loading && !data) {
    return (
      <>
        <Hero />
        <Skeleton />
      </>
    );
  }

  // ── Hard error state ──────────────────────────────────────────────────
  if (error && !data) {
    return (
      <>
        <Hero />
        <div className="sp-error-card">
          <div className="sp-error-card-msg">
            <strong>Couldn’t load your tip card.</strong>
            <div className="sp-error-card-sub">{error}</div>
          </div>
          <button type="button" className="sp-btn sp-btn-sm" onClick={fetchAll}>
            Retry
          </button>
        </div>
      </>
    );
  }

  // ── No tip page activated yet ─────────────────────────────────────────
  if (!data?.url) {
    return (
      <>
        <Hero />
        <div className="sp-empty">
          <div className="sp-empty-icon">
            <QrIcon size={22} />
          </div>
          <div className="sp-empty-title">Your tip page isn’t active yet.</div>
          <div>Finish onboarding and an admin will switch it on. Your tip card will appear here once it’s live.</div>
        </div>
      </>
    );
  }

  const displayUrl = stripScheme(data.url);
  const tipsThisWeek = filterLast7Days(data.tips);
  const tipsThisWeekTotal = tipsThisWeek.reduce((a, t) => a + (Number(t.amount_cents) || 0), 0);

  return (
    <>
      <Hero />

      {/* QR card preview */}
      <div className="sp-tipcard-wrap">
        <div className="sp-tipcard">
          <div className="sp-tipcard-head">Tip Your Bartender</div>
          <div className="sp-tipcard-name">{data.preferred_name || 'your bartender'}</div>
          <div className="sp-qr">
            <QRCodeSVG
              value={data.url}
              size={164}
              bgColor="#FFFFFF"
              fgColor="#000000"
              level="M"
              includeMargin={false}
            />
          </div>
          <div className="sp-tipcard-handle">{displayUrl}</div>
          <div className="sp-tipcard-cta">Scan with your phone camera</div>
        </div>
      </div>

      {/* Action buttons row */}
      <div className="sp-tipcard-actions">
        <button type="button" className="sp-btn sp-btn-sm" onClick={handleOpenPrint}>
          <ExternalIcon size={12} />
          Open print page
        </button>
        <button type="button" className="sp-btn sp-btn-sm" onClick={handleShare}>
          <SendIcon size={12} />
          Share link
        </button>
        <button type="button" className="sp-btn sp-btn-sm" onClick={handleCopy}>
          <CopyIcon size={12} />
          Copy URL
        </button>
      </div>

      {/* How it's shown on your card — reorderable list */}
      <section className="sp-card">
        <div className="sp-card-head">
          <div className="sp-card-title">How it’s shown on your card</div>
          <button
            type="button"
            className="sp-card-link"
            onClick={() => navigate('/staff-v2/account/payments')}
          >
            Manage methods →
          </button>
        </div>
        <div className="sp-reorder-help">
          Drag (or use the arrows) to reorder. Top of the list shows first on the
          printed card and on the chooser page guests see after scanning.
        </div>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            <div className="sp-reorder">
              {order.map((tok, i) => (
                <ReorderRow
                  key={tok}
                  token={tok}
                  index={i}
                  total={order.length}
                  meta={getMethodMeta(tok, data.methods)}
                  onMoveUp={() => move(i, -1)}
                  onMoveDown={() => move(i, 1)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </section>

      {/* Tips received this week */}
      <section className="sp-card">
        <div className="sp-card-head">
          <div className="sp-card-title">Tips received this week</div>
          <span className="sp-tips-total">{formatMoney(tipsThisWeekTotal)}</span>
        </div>
        {tipsThisWeek.length === 0 ? (
          <div className="sp-empty" style={{ padding: '1.4rem 1rem' }}>
            <div className="sp-empty-title">No tips this week.</div>
            <div>Card tips through your QR show up here as guests scan.</div>
          </div>
        ) : (
          <>
            {tipsThisWeek.slice(0, 5).map((t) => (
              <div key={t.id} className="sp-tip">
                <div className="sp-tip-icon">$</div>
                <div className="sp-tip-l">
                  <div className="sp-tip-from">
                    Card tip
                    <span style={{ color: 'var(--sp-ink-3)', fontWeight: 400 }}> · via Stripe</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="sp-tip-amt">{formatMoney(t.amount_cents)}</div>
                  <div className="sp-tip-when">{fmtRelDay(t.tipped_at)}</div>
                </div>
              </div>
            ))}
            <div className="sp-tipcard-foot">
              Customer tips delivered through your QR card. Not the same as the
              card-tip pool on paystubs.
            </div>
          </>
        )}
      </section>
    </>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function Hero() {
  return (
    <div className="sp-hero">
      <div>
        <h1>Tip Card</h1>
        <div className="sp-page-sub">
          Print or share a QR sign so guests can tip you directly. The QR opens a
          chooser page with every method on file.
        </div>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}
      aria-hidden="true"
    >
      <div
        style={{
          height: 320,
          borderRadius: 14,
          background: 'var(--sp-bg-2)',
          border: '1px solid var(--sp-line-1)',
          opacity: 0.5,
          margin: '0 auto',
          maxWidth: 280,
          width: '100%',
        }}
      />
      {Array.from({ length: 2 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 160,
            borderRadius: 10,
            background: 'var(--sp-bg-2)',
            border: '1px solid var(--sp-line-1)',
            opacity: 0.5,
          }}
        />
      ))}
    </div>
  );
}

function ReorderRow({ token, index, total, meta, onMoveUp, onMoveDown }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: token });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className="sp-reorder-row">
      <button
        type="button"
        className="sp-reorder-grip"
        title="Drag to reorder"
        aria-label={`Drag ${meta.label} to reorder`}
        {...attributes}
        {...listeners}
      >
        <GripIcon size={14} />
      </button>
      <div className={`sp-pm-icon ${meta.tone}`} aria-hidden="true">{meta.icon}</div>
      <div className="sp-reorder-l">
        <div className="sp-reorder-name">{meta.label}</div>
        <div className="sp-reorder-sub sp-mono">{meta.sub}</div>
      </div>
      <div className="sp-reorder-acts">
        <button
          type="button"
          className="sp-icon-btn"
          disabled={index === 0}
          onClick={onMoveUp}
          aria-label={`Move ${meta.label} up`}
          title="Move up"
        >
          <ArrowUpIcon size={12} />
        </button>
        <button
          type="button"
          className="sp-icon-btn"
          disabled={index === total - 1}
          onClick={onMoveDown}
          aria-label={`Move ${meta.label} down`}
          title="Move down"
        >
          <ArrowDownIcon size={12} />
        </button>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

// Method tokens recognized by the spec §6.8 vocabulary. The default order
// matches the design source; methods get filtered/reordered against what's
// actually on file before render.
const DEFAULT_ORDER = ['card', 'venmo', 'cashapp', 'paypal', 'zelle'];

/**
 * Build the final render order: saved-order tokens first (if still on file),
 * then any on-file methods missing from the saved order in natural order, in
 * the DEFAULT_ORDER sequence. Mirrors the public /tip/:token consumer rule
 * (Task 41 will read this same array and apply the same fallback). Tokens
 * in the saved order but not on file are skipped.
 */
function resolveDisplayOrder(savedOrder, onFile) {
  const out = [];
  const seen = new Set();
  for (const tok of savedOrder) {
    if (onFile.has(tok) && !seen.has(tok)) {
      out.push(tok);
      seen.add(tok);
    }
  }
  for (const tok of DEFAULT_ORDER) {
    if (onFile.has(tok) && !seen.has(tok)) {
      out.push(tok);
      seen.add(tok);
    }
  }
  return out;
}

function getMethodMeta(token, methods) {
  switch (token) {
    case 'card':
      return {
        label: 'Card payments',
        sub: 'Apple Pay · Google Pay · credit',
        icon: '◎',
        tone: 'card',
      };
    case 'venmo':
      return {
        label: 'Venmo',
        sub: methods.venmo_handle ? `@${methods.venmo_handle}` : '',
        icon: 'V',
        tone: 'venmo',
      };
    case 'cashapp':
      return {
        label: 'Cash App',
        sub: methods.cashapp_handle ? `$${methods.cashapp_handle}` : '',
        icon: '$',
        tone: 'cashapp',
      };
    case 'paypal':
      return {
        label: 'PayPal',
        sub: methods.paypal_url ? methods.paypal_url.replace(/^https?:\/\//, '') : '',
        icon: 'P',
        tone: 'paypal',
      };
    case 'zelle':
      return {
        label: 'Zelle',
        sub: methods.zelle_handle || '',
        icon: 'Z',
        tone: 'zelle',
      };
    default:
      return { label: token, sub: '', icon: '·', tone: 'card' };
  }
}

async function copyToClipboard(url, toast) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      // Fallback for older browsers / non-secure contexts.
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    toast.success('Copied');
  } catch (err) {
    toast.error("Couldn't copy. Long-press the URL to copy by hand.");
  }
}

function stripScheme(url) {
  if (!url) return '';
  return String(url).replace(/^https?:\/\//, '');
}

// Keep entries whose tipped_at is within the last 7 days (rolling, not
// calendar-week). Endpoint is newest-first; we filter rather than walk so the
// caller doesn't depend on ordering.
function filterLast7Days(tips) {
  if (!Array.isArray(tips)) return [];
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return tips.filter((t) => {
    if (!t?.tipped_at) return false;
    const ts = new Date(t.tipped_at).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

function fmtRelDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff < 0 && diff >= -7) return `${-diff}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Inline icons (Lucide-style 1.75 stroke, matches StaffShell). ─────────

function GripIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="18" r="1" />
    </svg>
  );
}

function ArrowUpIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function ArrowDownIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ExternalIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 5H5v14h14v-5M14 4h6v6M20 4l-9 9" />
    </svg>
  );
}

function SendIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12 21 4l-7 17-3-7-7-2Z" />
    </svg>
  );
}

function CopyIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </svg>
  );
}

function QrIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3M21 14v7M14 21h3" />
    </svg>
  );
}

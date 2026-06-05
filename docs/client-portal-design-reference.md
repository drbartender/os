# Client Portal — Current-State Design Reference

> **What this is:** a self-contained snapshot of the *live* Dr. Bartender client portal —
> design tokens, screen structure, data shapes, and verbatim source for the two pages +
> styles. Paste this whole file into the design tool so the new build references exactly
> what exists today.
>
> **Generated:** 2026-05-31 from `main`. **Surface:** public marketing host (`drbartender.com`), not the admin app.

---

## 0. TL;DR

The portal is intentionally small and **read-only**: passwordless OTP login → a "My Proposals"
grid → per-proposal invoice dropdowns + a link out to the full proposal view. **Two screens.**

- **Login** — `/login` (public) or `/client-login` (admin host) → `ClientLogin.js`
- **Dashboard** — `/my-proposals` → `ClientDashboard.js`
- **"View Proposal"** leaves the portal into `/proposal/:token` (the big sign-and-pay surface — its own thing, already themed, out of scope here).

**Built:** Proposal list + status, totals/paid, invoice dropdowns.
**Advertised on the login page but NOT built:** **Menu** (Potion Planning Lab) and **Messages**. Those are the two obvious expansion slots.

---

## 1. Design system — "Apothecary Press"

Dark apothecary canvas, paper cards, antique-brass hairlines, a teal wax "Rx" seal, and a
serif display face. The whole portal is built from global CSS custom properties (no inline
theme). Token values below are the live `:root` definitions.

### Palette
| Token | Value | Role |
|---|---|---|
| `--chalkboard` | `#12161C` | **Page canvas** (near-black). `body` background. |
| `--dark-ink` | `#1E242B` | Secondary dark surface |
| `--paper` | `#EDE6D6` | Card surface (top of gradient) |
| `--card-bg` | `#E6DDCC` | Card surface (bottom of gradient) |
| `--parchment` | `#E6DDCC` | Parchment fills |
| `--cream-text` | `#F0E8D6` | Text on dark canvas |
| `--deep-brown` | `#1C1610` | Text on paper cards |
| `--text-muted` | `#5A5048` | Muted labels / subtitles |
| `--amber` | `#1D8C89` | **Primary CTA** — note: the token is *named* "amber" but the value is **Deep Apothecary Teal** |
| `--warm-brown` | `#134544` | CTA hover (deepened teal) |
| `--brass` | `#B8924A` | Hairlines, frames, links (e.g. "resend code") |
| `--brass-bright` | `#D6AE65` | Brass hover highlight |
| `--forest` | `#1D5A4A` | Accent green |
| `--border-dark` | `#313842` | Input borders |
| `--error` | `#8B2020` | Error text |
| `--success` | `#2D6B5A` | Success text |

### Type & shape
| Token | Value |
|---|---|
| `--font-display` | `'IM Fell English SC', 'IM Fell English', Georgia, serif` (headings, labels, buttons) |
| `--font-body` | `'IM Fell English', Georgia, serif` |
| `--radius` | `6px` |

Micro-labels are uppercase, letter-spaced `0.18em`. Subtitles are italic.

### Signature motif — the wax seal (CSS-only)
```css
background: radial-gradient(circle at 35% 30%, #2FA7A0 0%, #1D8C89 45%, #0E4F4D 100%);
/* + dashed cream inner ring (inset 6px), + italic serif "Rx", + deep drop shadow */
```

### Voice / copy motifs
Prescription & lab metaphor throughout: *"Open the prescription."*, *"What's inside the
prescription."*, kicker **`Lab Access · No. 06`**, **Potion Planning Lab**, the **Rx** seal.

### Status badge classes (global, reused on the dashboard)
`badge-inprogress`, `badge-submitted`, `badge-approved` — mapped from proposal status
(draft/modified → inprogress, sent/viewed → submitted, accepted → approved).

---

## 2. Screens & flows

### Login (`ClientLogin.js`)
Two-column on desktop (≥1024px), stacked on mobile.
- **Left — benefits ledger.** Kicker `Lab Access · No. 06`, headline *"What's inside the
  prescription."*, intro line, then a 4-item feature list with circular brass icons:
  **📋 Proposal · 🥃 Menu · 💰 Payments · 💬 Messages.**
- **Right — login stack.** Teal **wax-seal Rx medallion** above a cream card: *"Open the
  prescription."*
- **Step 1:** email field → "Send Login Code".
- **Step 2:** six single-digit OTP boxes (paste-aware, auto-advance, backspace-to-prev,
  `one-time-code` autocomplete) → "Verify & Enter" + a "Send a new code" resend link.
- Enumeration-safe: request always shows the same neutral success message.

### Dashboard (`ClientDashboard.js`)
- Header: *"Welcome back, {name}"* + **Log Out** (outline button).
- **Responsive card grid** (`repeat(auto-fill, minmax(280px, 1fr))`), one card per proposal:
  client name · event-type label + date · **status badge** · then **Event Date / Total /
  Paid** rows · an **InvoiceDropdown** · a **"View Proposal"** primary button → `/proposal/:token`.
- States: loading spinner, empty ("No Proposals Yet"), error alert.

### InvoiceDropdown (`InvoiceDropdown.js`)
Collapsible "Invoices (N)" toggle → list of rows (`invoice_number · label`, amount + Paid /
Partial / Due status), each linking to `/invoice/:token` in a new tab. Renders nothing if a
proposal has no invoices.
> ⚠️ Minor pre-existing note: invoice status colors use `hsl(var(--ok-h) …)` / `--danger-h`,
> which are defined in the staff-v2 theme scope — so on the public client dashboard those
> greens/bordeaux may fall back rather than render as intended. Worth re-tokenizing in the redesign.

---

## 3. Data the UI receives (API response shapes)

**Auth — `/api/client-auth`**
- `POST /request` `{ email }` → always `{ success: true }` (neutral). Emails a 6-digit code (15-min expiry).
- `POST /verify` `{ email, otp }` → `{ token, client: { id, name, email, phone } }` (JWT, 7-day).
- `GET /me` (Bearer) → `{ client: { id, name, email, phone } }`.
- Client JWT stored in `localStorage` as **`db_client_token`**.

**Portal — `/api/client-portal`** (all require client JWT, scoped to the caller's `client_id`)
- `GET /proposals` → list (what the dashboard grid renders):
  ```json
  { "proposals": [
    { "id", "token", "event_type", "event_type_custom", "event_date",
      "status", "total_price", "amount_paid", "created_at", "client_name" }
  ] }
  ```
- `GET /proposals/:token` → **rich detail the dashboard does NOT use yet** (no new backend
  needed to enrich the UI): event start time, duration, location, guest count, package
  (name/category/`includes`), `pricing_snapshot`, deposit/`balance_due_date`, autopay,
  signature state, plus `addons[]` and full `payments[]` history.

**Invoices — `/api/invoices/client/:proposalToken`** (client JWT) → 
```json
{ "invoices": [
  { "id", "token", "invoice_number", "label", "amount_due",
    "amount_paid", "status", "due_date" }
] }
```
Money fields are **integer cents** (the dropdown divides by 100).

---

## 4. Built vs. aspirational (redesign opportunity map)

| Login panel promises | Reality in the portal today |
|---|---|
| **Proposal** | ✅ List + status; full view lives in `/proposal/:token` (separate page) |
| **Payments** | ✅ Total / Paid on cards + invoice dropdown |
| **Menu** (Potion Planning Lab) | ❌ Not in the portal — aspirational copy |
| **Messages** | ❌ Not in the portal — aspirational copy |

Other low-cost wins the data already supports: a real proposal **detail** view inside the
portal (everything above is already returned), a payment/deposit progress bar, balance-due
dates, and event logistics (time/location/guest count).

---

## 5. Source — `client/src/pages/public/ClientLogin.js`

```jsx
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import { useToast } from '../../context/ToastContext';
import { useClientAuth } from '../../context/ClientAuthContext';
import { API_BASE_URL } from '../../utils/api';

const OTP_LENGTH = 6;

export default function ClientLogin() {
  const { isClientAuthenticated, clientLogin } = useClientAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [otpDigits, setOtpDigits] = useState(Array(OTP_LENGTH).fill(''));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const otpRefs = useRef([]);

  const otp = otpDigits.join('');

  useEffect(() => {
    if (isClientAuthenticated) navigate('/my-proposals', { replace: true });
  }, [isClientAuthenticated, navigate]);

  // When stepping into OTP, focus the first box.
  useEffect(() => {
    if (step === 2 && otpRefs.current[0]) {
      otpRefs.current[0].focus();
    }
  }, [step]);

  const parseError = async (res) => {
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    const message = data.error || 'Something went wrong. Please try again.';
    const err = new Error(message);
    err.fieldErrors = data.fieldErrors;
    err.code = data.code;
    return err;
  };

  const handleRequestOtp = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE_URL}/client-auth/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw await parseError(res);
      toast.success('If an account exists for this email, a login code has been sent.');
      setStep(2);
    } catch (err) {
      setError(err.message);
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE_URL}/client-auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp }),
      });
      if (!res.ok) throw await parseError(res);
      const data = await res.json();
      clientLogin(data.token, data.client);
      navigate('/my-proposals', { replace: true });
    } catch (err) {
      setError(err.message);
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError('');
    setFieldErrors({});
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/client-auth/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw await parseError(res);
      toast.success('A new code has been sent to your email.');
      setOtpDigits(Array(OTP_LENGTH).fill(''));
      otpRefs.current[0]?.focus();
    } catch (err) {
      setError(err.message || 'Failed to resend code. Please try again.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setLoading(false);
    }
  };

  const handleOtpChange = (idx, raw) => {
    const digit = raw.replace(/\D/g, '').slice(0, 1);
    const next = [...otpDigits];
    next[idx] = digit;
    setOtpDigits(next);
    if (digit && idx < OTP_LENGTH - 1) {
      otpRefs.current[idx + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (idx, e) => {
    if (e.key === 'Backspace' && !otpDigits[idx] && idx > 0) {
      e.preventDefault();
      const next = [...otpDigits];
      next[idx - 1] = '';
      setOtpDigits(next);
      otpRefs.current[idx - 1]?.focus();
    }
  };

  const handleOtpPaste = (e) => {
    const pasted = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!pasted) return;
    e.preventDefault();
    const next = Array(OTP_LENGTH).fill('');
    for (let i = 0; i < pasted.length; i += 1) next[i] = pasted[i];
    setOtpDigits(next);
    const focusIndex = Math.min(pasted.length, OTP_LENGTH - 1);
    otpRefs.current[focusIndex]?.focus();
  };

  if (isClientAuthenticated) return null;

  return (
    <PublicLayout>
      <section className="client-login-section">
        {/* ── Left: ledger card with benefits ─────────────────── */}
        <aside className="client-login-benefits">
          <span className="kicker">Lab Access · No. 06</span>
          <h2>What's inside the prescription.</h2>
          <p className="client-login-benefits-intro">
            Your event proposal, menu, payments, and team — all in one calm portal.
          </p>
          <ul className="client-login-features">
            <li>
              <span className="client-feature-icon" aria-hidden="true">📋</span>
              <div>
                <strong>Proposal</strong>
                <span>Review, sign, and pay your custom event proposal.</span>
              </div>
            </li>
            <li>
              <span className="client-feature-icon" aria-hidden="true">🥃</span>
              <div>
                <strong>Menu</strong>
                <span>Build your drink menu in the Potion Planning Lab.</span>
              </div>
            </li>
            <li>
              <span className="client-feature-icon" aria-hidden="true">💰</span>
              <div>
                <strong>Payments</strong>
                <span>Track balances, deposits, and final invoices.</span>
              </div>
            </li>
            <li>
              <span className="client-feature-icon" aria-hidden="true">💬</span>
              <div>
                <strong>Messages</strong>
                <span>Stay in touch with your bartending team.</span>
              </div>
            </li>
          </ul>
        </aside>

        {/* ── Right: wax-seal medallion + login card ────────── */}
        <div className="client-login-stack">
          <div className="wax-seal" aria-hidden="true">
            <span className="wax-seal-rx">Rx</span>
          </div>

          <div className="card client-login-card">
            <h2>Open the prescription.</h2>
            <p className="client-login-subtitle">
              {step === 1
                ? "Enter your email and we'll send a one-time code to access your proposal."
                : `Enter the 6-digit code we sent to ${email || 'your email'}.`}
            </p>

            {step === 1 ? (
              <form onSubmit={handleRequestOtp}>
                <label className="client-label" htmlFor="client-login-email">Email Address</label>
                <input
                  id="client-login-email"
                  type="email"
                  autoComplete="email"
                  className="client-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  autoFocus
                />
                <FieldError error={fieldErrors.email} />
                <FormBanner error={error} fieldErrors={fieldErrors} />
                <button type="submit" className="btn client-btn-primary" disabled={loading}>
                  {loading ? 'Sending…' : 'Send Login Code'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleVerifyOtp}>
                <label className="client-label">Login Code</label>
                <div
                  className="client-otp-grid"
                  role="group"
                  aria-label="Six-digit login code"
                  onPaste={handleOtpPaste}
                >
                  {otpDigits.map((digit, idx) => (
                    <input
                      key={idx}
                      ref={(el) => { otpRefs.current[idx] = el; }}
                      type="text"
                      inputMode="numeric"
                      autoComplete={idx === 0 ? 'one-time-code' : 'off'}
                      pattern="[0-9]*"
                      maxLength={1}
                      className="client-input client-otp-input"
                      value={digit}
                      onChange={(e) => handleOtpChange(idx, e.target.value)}
                      onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                      onFocus={(e) => e.target.select()}
                      aria-invalid={!!error}
                      aria-label={`Digit ${idx + 1} of 6`}
                    />
                  ))}
                </div>
                <FieldError error={fieldErrors.otp} />
                <FormBanner error={error} fieldErrors={fieldErrors} />
                <button
                  type="submit"
                  className="btn client-btn-primary"
                  disabled={loading || otp.length !== OTP_LENGTH}
                >
                  {loading ? 'Verifying…' : 'Verify & Enter'}
                </button>
                <button type="button" className="client-resend-link" onClick={handleResend} disabled={loading}>
                  Send a new code
                </button>
              </form>
            )}
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
```

---

## 6. Source — `client/src/pages/public/ClientDashboard.js`

```jsx
import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import PublicLayout, { clientLoginPath } from '../../components/PublicLayout';
import { useClientAuth } from '../../context/ClientAuthContext';
import api from '../../utils/api';
import InvoiceDropdown from '../../components/InvoiceDropdown';
import { useToast } from '../../context/ToastContext';
import { getEventTypeLabel } from '../../utils/eventTypes';

const STATUS_LABELS = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  modified: 'Modified',
  accepted: 'Accepted',
};

const STATUS_CLASSES = {
  draft: 'badge-inprogress',
  sent: 'badge-submitted',
  viewed: 'badge-submitted',
  modified: 'badge-inprogress',
  accepted: 'badge-approved',
};

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatCurrency(amount) {
  const num = Number(amount ?? 0);
  return num.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export default function ClientDashboard() {
  const { clientUser, clientLoading, clientLogout, isClientAuthenticated } = useClientAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!clientLoading && !isClientAuthenticated) {
      navigate(clientLoginPath(), { replace: true });
    }
  }, [clientLoading, isClientAuthenticated, navigate]);

  useEffect(() => {
    if (clientLoading) return;
    if (!isClientAuthenticated) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const clientToken = localStorage.getItem('db_client_token');
        const { data } = await api.get('/client-portal/proposals', {
          headers: clientToken ? { Authorization: `Bearer ${clientToken}` } : {},
        });
        if (cancelled) return;
        const list = Array.isArray(data) ? data : (data?.proposals ?? []);
        setProposals(list);
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to load client proposals:', err);
        setError('Could not load your proposals. Please try again.');
        toast.error('Failed to load your proposals. Try refreshing.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [clientLoading, isClientAuthenticated, toast]);

  if (clientLoading) {
    return (
      <PublicLayout>
        <section className="client-dashboard-section">
          <div className="loading"><div className="spinner" />Loading...</div>
        </section>
      </PublicLayout>
    );
  }

  if (!isClientAuthenticated) return null;

  return (
    <PublicLayout>
      <section className="client-dashboard-section">
        <div className="client-dashboard-header">
          <h2>Welcome back, {clientUser?.name || 'Client'}</h2>
          <button className="btn client-btn-outline" onClick={() => { clientLogout(); navigate(clientLoginPath()); }}>
            Log Out
          </button>
        </div>

        {error && <div className="client-alert client-alert-error">{error}</div>}

        {loading ? (
          <div className="loading"><div className="spinner" />Loading proposals...</div>
        ) : proposals.length === 0 ? (
          <div className="card client-empty-card">
            <h3>No Proposals Yet</h3>
            <p>When we create a proposal for your event, it will appear here.</p>
          </div>
        ) : (
          <div className="client-proposals-grid">
            {proposals.map(p => (
              <div key={p.id} className="card client-proposal-card">
                <div className="client-proposal-card-header">
                  <h3>{p.client_name || 'Event'}</h3>
                  <div style={{ fontSize: '0.9rem', color: 'var(--text-muted, #888)' }}>
                    {getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}
                    {p.event_date && ` · ${new Date(p.event_date.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
                  </div>
                  <span className={`badge ${STATUS_CLASSES[p.status] || 'badge-inprogress'}`}>
                    {STATUS_LABELS[p.status] || p.status}
                  </span>
                </div>
                <div className="client-proposal-card-details">
                  <div className="client-proposal-detail">
                    <span className="client-detail-label">Event Date</span>
                    <span>{formatDate(p.event_date)}</span>
                  </div>
                  <div className="client-proposal-detail">
                    <span className="client-detail-label">Total</span>
                    <span>{formatCurrency(p.total_price)}</span>
                  </div>
                  <div className="client-proposal-detail">
                    <span className="client-detail-label">Paid</span>
                    <span>{formatCurrency(p.amount_paid)}</span>
                  </div>
                </div>
                <InvoiceDropdown
                  proposalToken={p.token}
                  isClient={true}
                  clientToken={localStorage.getItem('db_client_token')}
                />
                <Link to={`/proposal/${p.token}`} className="btn client-btn-primary client-btn-view">
                  View Proposal
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>
    </PublicLayout>
  );
}
```

---

## 7. Source — `client/src/components/InvoiceDropdown.js`

```jsx
import React, { useState, useEffect } from 'react';
import api from '../utils/api';

function formatCurrency(cents) {
  if (cents == null) return '$0.00';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/**
 * Dropdown showing invoices for a proposal.
 * @param {number|string} props.proposalId - The proposal ID (admin mode)
 * @param {string} [props.proposalToken] - The proposal token (client mode)
 * @param {boolean} [props.isClient] - If true, uses client auth endpoint
 * @param {string} [props.clientToken] - JWT for client auth header
 */
export default function InvoiceDropdown({ proposalId, proposalToken, isClient = false, clientToken }) {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchInvoices = async () => {
      try {
        let res;
        if (isClient && proposalToken) {
          const headers = clientToken ? { Authorization: `Bearer ${clientToken}` } : {};
          res = await api.get(`/invoices/client/${proposalToken}`, { headers });
        } else if (proposalId) {
          res = await api.get(`/invoices/proposal/${proposalId}`);
        } else {
          setLoading(false);
          return;
        }
        if (!cancelled) setInvoices(res.data.invoices || []);
      } catch (err) {
        console.error('Failed to load invoices:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchInvoices();
    return () => { cancelled = true; };
  }, [proposalId, proposalToken, isClient, clientToken]);

  if (loading || invoices.length === 0) return null;

  return (
    <div className="invoice-dropdown-wrapper">
      <button
        className="section-toggle"
        onClick={() => setOpen(!open)}
        style={{ marginTop: '0.75rem' }}
      >
        {open ? 'Hide Invoices' : `Invoices (${invoices.length})`}
      </button>
      {open && (
        <div className="invoice-dropdown-list" style={{ marginTop: '0.5rem' }}>
          {invoices.map(inv => {
            const isPaid = inv.status === 'paid';
            const isPartial = inv.status === 'partially_paid';
            const color = isPaid ? 'hsl(var(--ok-h) var(--ok-s) 52%)' : 'hsl(var(--danger-h) var(--danger-s) 65%)';
            const statusLabel = isPaid ? 'Paid' : isPartial ? 'Partial' : 'Due';
            const displayAmount = isPaid ? inv.amount_paid : inv.amount_due;

            return (
              <a
                key={inv.id}
                href={`/invoice/${inv.token}`}
                target="_blank"
                rel="noopener noreferrer"
                className="invoice-dropdown-item"
                style={{ color, textDecoration: 'none' }}
              >
                <span className="invoice-dropdown-number">
                  {inv.invoice_number} · {inv.label}
                </span>
                <span className="invoice-dropdown-amount">
                  {formatCurrency(displayAmount)} — {statusLabel}
                </span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

---

## 8. Source — Portal CSS (`client/src/index.css`, the `/* === CLIENT PORTAL === */` block)

```css
/* === CLIENT PORTAL === */

/* ═══════════════════════════════════════════════════════════
   CLIENT LOGIN — Apothecary Press (money-flow handoff)
   Two-column desktop: benefits ledger + wax-seal stack with login card.
   Mobile: stacked, wax-seal above card, benefits drawer below.
   ═══════════════════════════════════════════════════════════ */
.client-login-section {
  max-width: 1240px;
  margin: 0 auto;
  padding: 56px clamp(20px, 4vw, 40px) 80px;
  display: grid;
  grid-template-columns: 1fr;
  gap: 40px;
  align-items: start;
}
@media (min-width: 1024px) {
  .client-login-section {
    grid-template-columns: 1fr 1fr;
    gap: 80px;
    align-items: center;
  }
}

.client-login-benefits {
  order: 2;
}
@media (min-width: 1024px) {
  .client-login-benefits { order: 1; }
}

.client-login-benefits .kicker {
  margin-bottom: 14px;
}
.client-login-benefits h2 {
  font-family: var(--font-display);
  color: var(--cream-text);
  font-size: clamp(1.75rem, 3.2vw, 2.4rem);
  margin: 0 0 12px;
  line-height: 1.05;
  letter-spacing: 0.015em;
  font-weight: 400;
}
.client-login-benefits-intro {
  color: rgba(240, 232, 214, 0.78);
  font-size: 1rem;
  line-height: 1.55;
  margin-bottom: 24px;
  max-width: 460px;
}
.client-login-features {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.client-login-features li {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding-bottom: 18px;
  border-bottom: 1px solid rgba(184, 146, 74, 0.25);
}
.client-login-features li:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.client-feature-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1.25rem;
  border-radius: 50%;
  border: 1px solid rgba(184, 146, 74, 0.5);
  background: rgba(184, 146, 74, 0.08);
}
.client-login-features li strong {
  display: block;
  color: var(--cream-text);
  font-family: var(--font-display);
  font-size: 1.05rem;
  margin-bottom: 4px;
  letter-spacing: 0.015em;
}
.client-login-features li span:last-child {
  color: rgba(240, 232, 214, 0.72);
  font-size: 0.9rem;
  line-height: 1.5;
}

/* ── Login stack (medallion + card) ───────────────────── */
.client-login-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 22px;
  order: 1;
}
@media (min-width: 1024px) {
  .client-login-stack { order: 2; }
}

/* Wax-seal medallion — CSS-only (radial teal + dashed inner ring + Rx) */
.wax-seal {
  width: 88px;
  height: 88px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #2FA7A0 0%, #1D8C89 45%, #0E4F4D 100%);
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5), inset 0 -4px 10px rgba(0, 0, 0, 0.35);
  flex-shrink: 0;
}
.wax-seal::before {
  content: "";
  position: absolute;
  inset: 6px;
  border: 1px dashed rgba(240, 232, 214, 0.55);
  border-radius: 50%;
  pointer-events: none;
}
.wax-seal-rx {
  font-family: var(--font-display);
  font-style: italic;
  font-size: 30px;
  color: var(--cream-text);
  letter-spacing: 0.02em;
  line-height: 1;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  position: relative;
  z-index: 1;
}
.wax-seal.lg { width: 110px; height: 110px; }
.wax-seal.lg .wax-seal-rx { font-size: 38px; }

.client-login-card {
  width: 100%;
  max-width: 460px;
  padding: 36px 36px 30px;
  text-align: center;
  margin-bottom: 0;
}
.client-login-card h2 {
  font-family: var(--font-display);
  color: var(--deep-brown);
  font-size: 1.75rem;
  margin: 0 0 8px;
  font-weight: 400;
  letter-spacing: 0.015em;
}
.client-login-subtitle {
  color: var(--text-muted);
  margin-bottom: 22px;
  font-size: 0.95rem;
  font-style: italic;
  line-height: 1.5;
}

.client-label {
  display: block;
  text-align: left;
  font-family: var(--font-display);
  font-size: 0.78rem;
  color: var(--text-muted);
  margin-bottom: 8px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.client-input {
  width: 100%;
  padding: 12px 14px;
  font-family: var(--font-body);
  font-size: 1rem;
  border: 1px solid var(--border-dark);
  border-radius: 6px;
  background: var(--paper);
  color: var(--deep-brown);
  margin-bottom: 14px;
  transition: border-color 0.18s, box-shadow 0.18s, padding 0.18s;
}
.client-input:focus {
  outline: none;
  border: 2px solid var(--amber);
  padding: 11px 13px;
  box-shadow: 0 0 0 3px rgba(29, 140, 137, 0.18);
}

/* Six-box OTP grid */
.client-otp-grid {
  display: flex;
  gap: 8px;
  justify-content: center;
  margin-bottom: 14px;
}
.client-otp-input {
  flex: 1 1 0;
  min-width: 0;
  max-width: 56px;
  height: 54px;
  padding: 0;
  margin: 0;
  text-align: center;
  font-family: var(--font-display);
  font-size: 1.6rem;
  font-weight: 400;
  letter-spacing: 0;
  border-radius: 6px;
}
.client-otp-input:focus {
  border-width: 2px;
  padding: 0;
}

.client-btn-primary {
  width: 100%;
  background: var(--amber);
  color: var(--cream-text);
  border: none;
  padding: 14px 20px;
  font-family: var(--font-display);
  font-size: 0.95rem;
  letter-spacing: 0.06em;
  font-weight: 500;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.18s, transform 0.18s, box-shadow 0.18s;
  text-align: center;
  display: block;
  text-decoration: none;
  position: relative;
  isolation: isolate;
  box-shadow: 0 2px 10px rgba(29, 140, 137, 0.32);
  margin-top: 4px;
}
.client-btn-primary:hover:not(:disabled) {
  background: var(--warm-brown);
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(29, 140, 137, 0.32), 0 0 0 2px rgba(240, 232, 214, 0.04);
}
.client-btn-primary:disabled { opacity: 0.55; cursor: not-allowed; }

@media (max-width: 640px) {
  .client-login-section {
    padding: 32px 18px 56px;
    gap: 32px;
  }
  .client-login-card {
    padding: 24px 22px 22px;
  }
  .client-otp-input {
    max-width: 48px;
    height: 48px;
    font-size: 1.4rem;
  }
}

.client-btn-outline {
  background: transparent;
  color: var(--cream-text);
  border: 1px solid var(--cream-text);
  padding: 0.5rem 1.25rem;
  font-family: var(--font-display);
  font-size: 0.85rem;
  border-radius: var(--radius);
  cursor: pointer;
  transition: background 0.2s, color 0.2s;
}

.client-btn-outline:hover {
  background: var(--cream-text);
  color: var(--deep-brown);
}

.client-resend-link {
  background: none;
  border: none;
  color: var(--brass);
  font-family: var(--font-display);
  font-size: 0.78rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  cursor: pointer;
  margin-top: 14px;
  display: block;
  width: 100%;
  text-align: center;
  padding: 8px;
}
.client-resend-link:hover { color: var(--brass-bright); }
.client-resend-link:disabled { opacity: 0.5; cursor: not-allowed; }

.client-alert {
  padding: 0.75rem 1rem;
  border-radius: var(--radius);
  margin-bottom: 1rem;
  font-size: 0.9rem;
}

.client-alert-error {
  background: #fdf2f2;
  color: var(--error);
  border: 1px solid #e8b4b4;
}

.client-alert-success {
  background: #f2fdf4;
  color: var(--success);
  border: 1px solid #b4e8bb;
}

/* Client Dashboard */

.client-dashboard-section {
  max-width: 900px;
  margin: 0 auto;
  padding: 2.5rem 1.5rem;
}

.client-dashboard-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2rem;
}

.client-dashboard-header h2 {
  font-family: var(--font-display);
  color: var(--cream-text);
  margin: 0;
}

.client-proposals-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1.25rem;
}

.client-proposal-card {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.client-proposal-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
}

.client-proposal-card-header h3 {
  font-family: var(--font-display);
  color: var(--deep-brown);
  margin: 0;
  font-size: 1.1rem;
}

.client-proposal-card-details {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.client-proposal-detail {
  display: flex;
  justify-content: space-between;
  font-size: 0.9rem;
  color: var(--deep-brown);
}

.client-detail-label {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.client-btn-view {
  margin-top: auto;
}

.client-empty-card {
  text-align: center;
  padding: 3rem 2rem;
}

.client-empty-card h3 {
  color: var(--deep-brown);
  margin-bottom: 0.5rem;
}

@media (max-width: 768px) {
  .client-login-section {
    flex-direction: column;
    gap: 2rem;
    padding: 2rem 1.25rem;
  }
  .client-login-benefits {
    max-width: 100%;
    text-align: center;
  }
  .client-login-features li {
    text-align: left;
  }
}

@media (max-width: 600px) {
  .client-dashboard-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.75rem;
  }
  .client-proposals-grid {
    grid-template-columns: 1fr;
  }
  .client-login-card {
    padding: 2rem 1.25rem;
  }
}
```

---

## 9. Shared shell context (so designs sit in the right frame)

- Both pages render inside **`PublicLayout`** (public marketing header/footer). The login
  path is host-aware via `clientLoginPath()` — `/client-login` on the admin host, `/login`
  on the public site; both land on `/my-proposals` after auth.
- `.card` (used by the login + proposal + empty cards) is the global paper card:
  `linear-gradient(180deg, var(--paper) 0%, var(--card-bg) 100%)`, `--radius` corners.
- Auth state comes from **`ClientAuthContext`** (`clientUser`, `db_client_token`,
  `clientLogin`/`clientLogout`) — wholly separate from staff/admin auth.
```

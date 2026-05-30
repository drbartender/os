import React from 'react';

/**
 * TeamRosterCard — "On the team" card for the staff portal ShiftDetail
 * page (spec §6.4, §6.18).
 *
 * Consumes the `team_roster[]` projection from GET /api/beo/:proposalId.
 * Each roster row is a server-derived shape:
 *   { user_id, display_name, initials, is_me, role,
 *     phone (string|null — gated by viewer's approved status),
 *     needs_cover (boolean) }
 *
 * Render rules (mirror the design source details.jsx, On-the-team card):
 *   - Only renders when team_roster.length > 0
 *   - Each row: avatar (initials) + display name + role (when applicable)
 *   - The viewer's own row carries an inline "You" pill and shows neither
 *     role label nor contact actions
 *   - Non-self rows show call + text icon buttons, but ONLY when phone is
 *     non-null (phone gating happens server-side per spec §6.18; here we
 *     just hide the actions when the projection is null)
 *   - "Needs cover" indicator below the name when needs_cover is true
 *
 * Props:
 *   teamRoster — array of roster rows from the BEO projection.
 */
export default function TeamRosterCard({ teamRoster }) {
  if (!Array.isArray(teamRoster) || teamRoster.length === 0) return null;

  return (
    <div className="sp-card tight">
      <div className="sp-card-head">
        <div className="sp-card-title">On the team</div>
        <span className="sp-roster-count">
          {teamRoster.length} bartender{teamRoster.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="sp-roster">
        {teamRoster.map((m) => (
          <RosterRow key={m.user_id} member={m} />
        ))}
      </div>
    </div>
  );
}

function RosterRow({ member }) {
  const { display_name, initials, is_me, role, phone, needs_cover } = member;
  const phoneHref = phoneTelHref(phone);
  const smsHref = phoneSmsHref(phone);

  return (
    <div className={'sp-roster-row' + (is_me ? ' me' : '')}>
      <div className="sp-avatar sp-roster-av">{initials || '??'}</div>
      <div className="sp-roster-l">
        <div className="sp-roster-name">
          {display_name}
          {is_me ? <span className="sp-roster-me">You</span> : null}
        </div>
        {!is_me && role && <div className="sp-roster-role">{role}</div>}
        {needs_cover && (
          <div className="sp-roster-cover">
            <AlertIcon size={11} />
            Needs cover
          </div>
        )}
      </div>
      {!is_me && phone && (
        <div className="sp-roster-acts">
          <a
            className="sp-icon-btn"
            href={phoneHref}
            title={`Call ${display_name}`}
            aria-label={`Call ${display_name}`}
          >
            <PhoneIcon size={13} />
          </a>
          <a
            className="sp-icon-btn"
            href={smsHref}
            title={`Text ${display_name}`}
            aria-label={`Text ${display_name}`}
          >
            <MailIcon size={13} />
          </a>
        </div>
      )}
    </div>
  );
}

// ── Phone helpers ────────────────────────────────────────────────────────
//
// Bartender phones are stored E.164 (e.g. +15555550199). Both `tel:` and
// `sms:` accept E.164 as-is, so we hand them through unchanged when they
// look like one and otherwise strip non-digits and prefix +1 (US-only —
// the rest of the staff portal already assumes a US workforce). This
// matches the existing client/server convention.
function phoneTelHref(phone) {
  if (!phone) return undefined;
  const e164 = normalizePhone(phone);
  return e164 ? `tel:${e164}` : undefined;
}

function phoneSmsHref(phone) {
  if (!phone) return undefined;
  const e164 = normalizePhone(phone);
  return e164 ? `sms:${e164}` : undefined;
}

function normalizePhone(phone) {
  const trimmed = String(phone).trim();
  if (/^\+\d{8,}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

// ── Inline icons (Lucide-style strokes at 1.75, matches StaffShell) ──────
function PhoneIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />
    </svg>
  );
}

function MailIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

function AlertIcon({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

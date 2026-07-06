# Presence Tracker: Dibs (Fallback-Owner Lead Override)

Date: 2026-07-06
Status: approved in brainstorm (section-by-section), pre-plan
Delta to: `2026-07-02-presence-tracker-design.md` (shipped 2026-07-03). This doc
changes only the lead-pointer derivation, the toggle's online default for the
fallback owner, and adds a two-edge Telegram notification. Everything else in the
original spec stands.

## Summary

Dallas (the fallback owner: highest `presence_lead_rank`, today rank 2) gets the
leads pill on his own strip row. Turning it on is "dibs": the lead pointer moves to
him even while Zul is online and taking leads, and holds until he toggles it off or
goes away (manual or auto-flip). Zul gets a Telegram ping on both edges, but only
when the pointer actually moves for her: when his grab takes it off her, and when
his release hands it back.

No schema change. `presence_taking_leads`, `presence_lead_rank`, and the nudge
channel columns already exist; the server already accepts the fallback owner's
toggle (`setTakingLeads` has no rank check); it is currently inert in
`derivePointer` and hidden in the UI.

## Pointer derivation (changes `derivePointer`, `server/utils/presence.js:16`)

Current rule: lowest-rank eligible wins; nobody eligible falls back to the
highest-rank tracked user. New rule, still pure and rank-generalized:

```
eligible = tracked users where state != 'away' AND taking_leads = true
owner    = fallback owner, if the fallback owner is in eligible   (dibs)
           else the eligible user with the LOWEST rank            (chain, unchanged)
           else the fallback owner                                (unchanged)
fallback owner = tracked user with the HIGHEST rank
```

The only behavioral difference from today is the first line: the fallback owner
online-and-taking now beats the chain instead of being unreachable. For everyone
except the fallback owner the toggle keeps its existing meaning (opt in or out of
the chain). A third tracked admin someday still slots in by rank with no code
change.

Because the fallback owner's online default is off (next section), the
both-eligible case only ever occurs by his deliberate grab; Zul's day-to-day
behavior is untouched.

## Toggle semantics (changes `leadsAfterTransition`, `server/utils/presence.js:32`)

The transition rules become rank-aware in exactly one cell:

- away -> desk/available: resets to **true** for chain users (unchanged), to
  **false** for the fallback owner. He never takes dibs just by sitting down.
- desk <-> available: preserved for everyone (dibs survives desk/available moves,
  matching "holds until toggle off or away").
- to away: forced false for everyone (unchanged); this is a release.
- Explicit toggle: allowed in desk and available, rejected in away, for everyone
  (this is already the server behavior; only the UI hid the pill).

`leadsAfterTransition(prevState, nextState, currentTaking)` gains an
`isFallbackOwner` argument. Its one call site (`presenceStore.transitionState`,
`server/utils/presenceStore.js:50`) learns the caller's fallback-owner-ness by
adding `presence_lead_rank = (SELECT MAX(presence_lead_rank) FROM users WHERE
presence_lead_rank IS NOT NULL)` to the existing FOR UPDATE select.

## Dibs-edge notification

New util `server/utils/presenceNotify.js` exporting
`notifyDibsEdge({ actorId, before, after })`, where `before` and `after` are strip
payloads (`getStripPayload()` results) captured around a committed mutation. Rules,
in order:

1. `before.lead_owner_id === after.lead_owner_id`: nothing.
2. Actor is not the fallback owner (max rank among `after.users`): nothing. So
   Zul's own actions never ping anyone: her going away silently falls the pointer
   to Dallas, exactly as today.
3. Grab (`after.lead_owner_id === actorId`): recipient is `before.lead_owner_id`.
   Copy: `"<Actor first name> called dibs on leads."`
4. Release (`before.lead_owner_id === actorId`): recipient is
   `after.lead_owner_id`. Copy: `"<Actor first name> released leads. You're up."`
5. Recipient must differ from actor (implied by 1, kept as an explicit guard).

A recipient is by construction online-and-taking (the pointer just moved off or
onto them), so there is no separate online check. If Zul is away when he grabs,
rule 1 already yields nothing (the pointer was his via fallback).

Delivery: by the recipient's `presence_nudge_channel`, exactly like the stale-desk
nudge sender (`presenceScheduler.nudge`): telegram sends via `sendTelegramMessage`
to `TELEGRAM_ALLOWED_USER_ID`; sms sends via `sendSMS` to `presence_nudge_phone`.
In practice the recipient is always Zul (telegram, free); the channel dispatch is
shared/mirrored rather than hardcoding her. The plan may extract the scheduler's
channel-dispatch into a small shared helper rather than duplicating it; the nudge
path keeps its confirmed-send detection (it stamps `nudged_at`), while the dibs
path is fire-and-forget.

Failure posture: the notification fires after COMMIT, is awaited nowhere on the
mutation's critical path, and never blocks or fails the state change. A skipped or
failed send logs console.warn + Sentry capture (mirroring `reportUndelivered`) and
is NOT retried; there is no stamp to reconcile. `notificationsEnabled()` gating
lives inside the send utils already, so dev sends are log-and-skip. Missing a
release ping is the worst case (leads sit unanswered while Zul assumes Dallas has
them); accepted, with Sentry as the alarm, same posture as the nudge sender.

Runaway guard: an edge requires a pointer change caused by the fallback owner, and
the strip serializes his mutations per user (FOR UPDATE); the realistic ceiling is
a handful of pings a day. No dedupe table needed.

### Hook points (three, exhaustive)

The two mutation routes and the auto-flip are the only writers that can move the
pointer via the fallback owner:

1. `POST /api/admin/presence/state` and `POST /api/admin/presence/leads`
   (`server/routes/admin/presence.js`): capture `before = getStripPayload()`
   before the store call; the routes already fetch the after-payload for the
   response. Call `notifyDibsEdge` fire-and-forget with actor `req.user.id`.
   One extra two-row SELECT per rare mutation; negligible.
2. Auto-flip in `sweepPresence` (`server/utils/presenceScheduler.js`): when the
   row being flipped belongs to the fallback owner, capture `before`, run
   `applyAutoFlip`, and on a true return capture `after` and call
   `notifyDibsEdge` with actor = the flipped user. A 3am auto-flip while he holds
   dibs therefore wakes her up with "You're up" instead of leads silently sitting.
   Zul's own auto-flip stays silent (rule 2).

Before/after captures are not transactional with the mutation; with two users and
FOR UPDATE serialization the worst interleaving is one spurious or missed ping.
Accepted.

## UI (`client/src/components/adminos/PresenceStrip.js`)

- The leads pill renders on every tracked row (drop the `u.rank < maxRank`
  condition at PresenceStrip.js:93). Same pill component, same self-only +
  not-away click rules, same busy-disable.
- On the fallback owner's row the lit pill reads "dibs" (title: "Dibs on leads");
  unlit reads as today (title: "Not taking leads"). Zul glancing at the strip sees
  a lit "dibs" pill on Dallas's row and the pointer line agreeing.
- The pointer line ("Leads -> ...") and rail mode need no changes; they render the
  derived owner and already handle either user.
- No drawer changes: intervals already record `taking_leads`, so his dibs stints
  appear in the history as leads-on intervals.

## Error handling

- No new client-visible errors. The toggle route's existing validations
  (boolean, tracked, not away) already cover the fallback owner.
- Notification failures: console.warn + Sentry, never a request failure, never a
  scheduler crash (wrapped like the nudge sender's send path).

## Testing

Server (node:test, per-suite, `node -r dotenv/config`):

- `server/utils/presence.test.js` additions: derivePointer dibs matrix (owner
  eligible beats chain; owner not taking leaves chain unchanged; owner away falls
  back; both away unchanged), leadsAfterTransition asymmetric online default
  (chain user true, fallback owner false; desk<->available preserves dibs; away
  wipes).
- New `server/utils/presenceNotify.test.js` (deps-injected sends): grab edge
  notifies before-owner with grab copy; release edge (toggle-off and to-away)
  notifies after-owner with release copy; no-pointer-change is silent; non-owner
  actor is silent; send failure is swallowed and reported.
- `server/routes/admin/presence.test.js` additions: fallback owner's toggle now
  moves `lead_owner_id` in the response while the chain user is online-and-taking;
  release restores it; notification hook fires on grab (injected deps observe it).
- Scheduler test addition: auto-flip of the dibs-holding owner emits the release
  notification; auto-flip of the chain user emits nothing.

Client: manual verification in both skins + rail mode (pill on both rows, dibs
label, pointer follows grab/release), per usual admin-shell practice.

## Docs (same change, per CLAUDE.md)

- `README.md`: folder tree gains `presenceNotify.js`.
- `ARCHITECTURE.md`: presence section notes the dibs override + notification.
- No env, schema, or CLAUDE.md changes.

## Review level

No sensitive paths: schema.sql, sms.js, telegram.js, and middleware/auth.js are
untouched (the telegram/sms send utils are called, not modified). Lead routing is
business-important but moves no money. Per-lane review scaled accordingly:
code-review + consistency-check, plus security-review because this adds an
outbound-send path keyed off user rows. Push-time rules unchanged.

## Rollout

1. No schema application step (behavior-only change).
2. Deploy edge: his `users` row may still hold `presence_taking_leads = true`
   from the old uniform online default. If he is online at deploy, the pointer
   will show him with dibs until he taps the pill off or next goes away (away
   wipes it); no notification fires because no mutation occurs. One-time,
   self-healing, accepted. Post-deploy check: glance at the strip; if the dibs
   pill is lit unintentionally, tap it off.
3. Smoke: grab while Zul is online-and-taking (pointer moves, she gets the dibs
   Telegram), release (pointer returns, she gets "You're up"), grab while she is
   away (no ping, pointer already his).

## Explicit decisions (from brainstorm 2026-07-06)

- Dibs beats the chain: owner online-and-taking wins even against Zul at desk.
- Dibs holds across desk<->available; ends only by toggle-off or away (manual or
  auto-flip). If Zul comes online mid-dibs, he keeps it; she sees the strip.
- Owner's online default is OFF (asymmetric with the chain's ON) so sitting down
  never steals leads.
- Both edges notify Zul via Telegram; only when the pointer actually moves for
  her. Her own actions never generate pings in either direction.
- Auto-flip counts as a release and pings her.
- Fire-and-forget delivery; no retry, Sentry is the alarm. SMS-channel recipients
  would work but are out of scope in practice (recipient is always Zul today).
- No schema change; no backfill; deploy-edge stale `taking_leads = true` on his
  row is accepted as one-time and self-healing.

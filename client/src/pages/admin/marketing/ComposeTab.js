import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import RecipientPicker from './RecipientPicker';
import { errorText } from './marketingFormat';

/**
 * Write a campaign, pick who gets it, send it.
 *
 * Two steps (Design, Recipients) per the approved design, with the send
 * confirmation living in the "Before you send" rail beside the recipient
 * list. The recipient count stays visible while writing via the live count
 * in the Recipients step label — which is the reason the earlier revision
 * kept everything on one screen, so the step control satisfies that
 * requirement rather than reversing it. BOTH steps stay mounted (inactive
 * one hidden) so the picker's audience/search/page state survives switching.
 *
 * The Send rail deliberately shows what the server will do BEFORE it does it,
 * and the server re-checks anyway. Both matter. The preview is so an operator
 * is never surprised by the number; the re-check is because the preview is a
 * snapshot and somebody may be excluded in between.
 */
const RESUME_KEY = 'mkt-compose-resume';

/**
 * A retryable run (quota stop, per-recipient failures) must survive an unmount:
 * both server duplicate defenses (the already-sent set and the send-once index)
 * are keyed on campaign_id, so "run it again tomorrow" is only safe if tomorrow
 * reuses the SAME campaign. The id, draft, and selection persist here from the
 * moment a send starts until a run completes clean (push-review 2026-08-13).
 * Best-effort on purpose: blocked storage degrades to same-mount resume, which
 * is the old behavior, never an operator-visible error.
 */
function readResume() {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    const r = raw ? JSON.parse(raw) : null;
    return r && r.campaignId ? r : null;
  } catch {
    return null;
  }
}

/** Email preview on the DS drawer chrome (same .open dance as ContactDrawer). */
function PreviewDrawer({ html, onClose }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <>
      <div className={`drawer-scrim${open ? ' open' : ''}`} onClick={onClose} />
      <aside className={`drawer${open ? ' open' : ''}`} role="dialog" aria-modal="true" aria-label="Email preview">
        <div className="drawer-head">
          <span className="crumb">Marketing · Email preview</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
        <div className="drawer-body" style={{ display: 'flex' }}>
          {/* The preview is server-rendered from the same wrapper the send
              uses, and the body is admin-authored and server-sanitized. */}
          {/* sandbox="" with no allow-scripts. A srcDoc frame is same-origin,
              so anything scriptable inside it could reach this app's JWT in
              localStorage. The server already sanitizes the body; this makes
              that sanitizer defense-in-depth rather than load-bearing. */}
          <iframe title="Email preview" srcDoc={html} sandbox="" className="mkt-preview-frame" />
        </div>
      </aside>
    </>
  );
}

export default function ComposeTab() {
  const toast = useToast();
  const { overview, refresh } = useOutletContext();
  // Lazy initializer so the storage read happens once, not on every render.
  const [restored] = useState(readResume);
  const [audiences, setAudiences] = useState([]);
  const [campaignId, setCampaignId] = useState(restored ? restored.campaignId : null);
  const [subject, setSubject] = useState(restored ? restored.subject || '' : '');
  const [body, setBody] = useState(restored ? restored.body || '' : '');
  const [selected, setSelected] = useState(() => new Set(restored ? restored.selected || [] : []));
  const [resuming, setResuming] = useState(Boolean(restored));
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const inFlight = useRef(false);
  // Overview's "Review recipients" deep-links here with the moment's audience
  // already chosen. Without honoring it the button would drop the operator into
  // an unfiltered list and quietly lose the one decision the moment had made.
  const [searchParams] = useSearchParams();
  // SEAM between two lanes: mkt-h added this deep link (Overview's "Review
  // recipients" carries the moment's audience) while another window added the
  // localStorage resume above. When both apply, the RESUME wins. An unfinished
  // retryable run is the stronger intent, and filtering the picker to a
  // different audience would hide already-selected people, making the selection
  // look smaller than it is right before somebody presses Send.
  const initialAudience = restored ? '' : (searchParams.get('audience') || '');
  // Arriving to review a moment's recipients opens the Recipients step; an
  // in-progress draft (resumed or fresh) starts where the writing happens.
  const [step, setStep] = useState(initialAudience ? 'recipients' : 'design');

  const loadAudiences = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.get('/marketing/audiences');
      setAudiences(res.data);
    } catch (err) {
      setLoadError(errorText(err, 'Could not load audiences.'));
    }
  }, []);
  useEffect(() => { loadAudiences(); }, [loadAudiences]);

  /** Campaigns are rows, so the draft has to exist before it can be sent. */
  const saveDraft = async () => {
    if (!subject.trim() || !body.trim()) {
      toast.error('A subject and some content are needed before saving.');
      return null;
    }
    setSaving(true);
    try {
      if (campaignId) {
        await api.put(`/email-marketing/campaigns/${campaignId}`, {
          subject: subject.trim(), html_body: body,
        });
        toast.success('Draft saved.');
        return campaignId;
      }
      const res = await api.post('/email-marketing/campaigns', {
        name: subject.trim().slice(0, 100),
        type: 'blast',
        subject: subject.trim(),
        html_body: body,
      });
      setCampaignId(res.data.id);
      toast.success('Draft saved.');
      return res.data.id;
    } catch (err) {
      toast.error(errorText(err, 'Could not save the draft.'));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const showPreview = async () => {
    try {
      const res = await api.post('/email-marketing/preview', { html_body: body });
      setPreview(res.data.html);
    } catch (err) {
      toast.error(errorText(err, 'Could not render the preview.'));
    }
  };

  const persistResume = (id) => {
    try {
      localStorage.setItem(RESUME_KEY, JSON.stringify({
        campaignId: id, subject, body, selected: [...selected],
      }));
    } catch { /* storage blocked: same-mount resume still works */ }
  };
  const clearResume = () => {
    try { localStorage.removeItem(RESUME_KEY); } catch { /* nothing to clear */ }
  };

  /** Abandon a restored run on purpose: new campaign id, blank slate. */
  const startFresh = () => {
    clearResume();
    setResuming(false);
    setCampaignId(null);
    setSubject('');
    setBody('');
    setSelected(new Set());
    setResult(null);
  };

  const doSend = async () => {
    // setSending FIRST, before any await. It used to sit after saveDraft(),
    // which left the confirm button live for the whole round trip: two clicks
    // both entered with campaignId still null, both created a campaign, and the
    // send-once index — keyed on (campaign_id, client_id) — never collided
    // because the campaign ids differed. Everyone got the email twice.
    // A ref, not the state flag. `sending` is read from a render closure, and
    // this guard is the ONLY thing between a double-click and two campaigns
    // (two campaign ids mean the send-once index cannot collide and the server
    // has no defense). A ref is render-timing independent.
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setConfirming(false);
    const id = await saveDraft();
    if (!id) { inFlight.current = false; setSending(false); return; }
    // Persist BEFORE the request: a refresh during the multi-minute send loses
    // this mount, and the restored id is what lets the operator resume instead
    // of minting a duplicate campaign.
    persistResume(id);
    try {
      const res = await api.post(`/marketing/campaigns/${id}/send`, {
        client_ids: [...selected],
      });
      setResult(res.data);
      // eligible < requested is the suppression working. Surface it rather than
      // let the operator wonder why 40 became 37.
      // Suppression and dedupe are different facts; only one of them means
      // somebody was held back.
      const heldBack = res.data.requested - res.data.eligible - (res.data.deduped || 0);
      if (res.data.stopped_early === 'quota') {
        toast.error(`Sent ${res.data.sent}, then stopped: the daily quota was reached.`);
      } else if (heldBack > 0) {
        toast.success(`Sent ${res.data.sent}. ${heldBack} held back.`);
      } else {
        toast.success(`Sent ${res.data.sent}.`);
      }
      // Start a NEW campaign next time ONLY if this run finished. Keeping the
      // id after a completed send meant the second email of the day was PUT
      // over the first one, which had already gone out.
      //
      // But clearing it after a QUOTA STOP is worse, and is what the panel
      // right below promises against: both duplicate defenses are keyed on
      // campaign_id (the address-level already-sent set and the send-once
      // index), so a fresh campaign id makes both empty and tomorrow's re-run
      // mails everyone who already received it a second time. Resuming means
      // re-sending the SAME campaign.
      // KEEP THE CAMPAIGN WHENEVER ANYTHING IS RETRYABLE, which is the rule
      // both halves of this needed. A quota stop is retryable; so is a run that
      // completed with failures, because the claim reclaims a 'failed' row and
      // the already-sent set deliberately excludes 'failed'. Clearing the id in
      // either case makes the operator's natural next action — re-select and
      // send again — mint a NEW campaign, and both duplicate defenses are keyed
      // on campaign_id, so the blast radius is not the failures: it is everyone
      // in the run, mailed twice.
      const retryable = res.data.stopped_early || res.data.failed > 0;
      if (!retryable) {
        clearResume();
        setResuming(false);
        setCampaignId(null);
        setSelected(new Set());
      }
    } catch (err) {
      toast.error(errorText(err, 'The send failed.'));
    } finally {
      inFlight.current = false;
      setSending(false);
      // The shell's budget meter and subtitle read the layout's overview
      // fetch, which otherwise runs once per visit; a send attempt may have
      // consumed budget even on a failure path, so re-read it either way
      // (fire-and-forget; refresh never rejects, the layout owns its errors).
      refresh();
    }
  };

  const canSend = subject.trim() && body.trim() && selected.size > 0 && !sending;
  const budget = overview?.send_budget;
  const thisSend = budget ? Math.min(selected.size, Math.max(0, budget.cap - budget.used)) : 0;
  const usedPct = budget && budget.cap > 0 ? Math.min(100, Math.round((budget.used / budget.cap) * 100)) : 0;
  const sendPct = budget && budget.cap > 0 ? Math.min(100 - usedPct, Math.round((thisSend / budget.cap) * 100)) : 0;
  const heldBackCount = result ? result.requested - result.eligible - (result.deduped || 0) : 0;

  return (
    <div>
      {loadError && (
        <div className="mkt-state mkt-state-error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={loadAudiences}>Try again</button>
        </div>
      )}
      {resuming && (
        <div className="mkt-resume" role="status">
          <p>
            Resuming campaign #{campaignId}. Your draft and selection were restored,
            and anyone this campaign already reached is skipped automatically.
          </p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={startFresh}>
            Start fresh instead
          </button>
        </div>
      )}

      <div className="mkt-compose-head">
        <div className="seg">
          <button type="button" className={step === 'design' ? 'active' : undefined}
            onClick={() => setStep('design')}>
            Design
          </button>
          <button type="button" className={step === 'recipients' ? 'active' : undefined}
            onClick={() => setStep('recipients')}>
            Recipients<span className="muted" style={{ marginLeft: 6 }}>{selected.size}</span>
          </button>
        </div>
        <span className="muted tiny">
          {saving ? 'Saving…' : campaignId ? `Draft #${campaignId}` : 'Not saved yet'}
        </span>
        <div className="spacer" />
      </div>

      <div hidden={step !== 'design'}>
        <div className="mkt-design-well">
          <div className="mkt-design-col">
            <label htmlFor="cmp-subject">Subject</label>
            <input
              id="cmp-subject" className="input" type="text" value={subject} maxLength={200}
              onChange={e => setSubject(e.target.value)}
              placeholder="Planning your holiday party?"
            />
            <label htmlFor="cmp-body">Body</label>
            <textarea
              id="cmp-body" className="mkt-textarea" rows={10} value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="<p>Write the email here. Basic HTML is fine.</p>"
            />
            <div className="mkt-design-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={saveDraft} disabled={saving}>
                {saving ? 'Saving…' : campaignId ? 'Save draft' : 'Create draft'}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={showPreview} disabled={!body.trim()}>
                Preview
              </button>
              <div className="spacer" />
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setStep('recipients')}>
                Continue to recipients
              </button>
            </div>
          </div>
        </div>
      </div>

      <div hidden={step !== 'recipients'}>
        <div className="mkt-recipients-grid">
          <div className="card">
            <div className="card-head">
              <h3>Recipients</h3>
              <span className="k num">{selected.size} selected</span>
            </div>
            <div className="card-body">
              <p className="muted tiny" style={{ marginTop: 0 }}>
                Only contacts who can be emailed are listed. Anyone unsubscribed, bounced,
                or on the do-not-contact list is already out, and the send re-checks.
              </p>
              <RecipientPicker
                audiences={audiences}
                selected={selected}
                onChange={setSelected}
                initialAudience={initialAudience}
              />
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>Before you send</h3></div>
            <div className="card-body" style={{ display: 'grid', gap: 14 }}>
              <div className="mkt-rail-count">
                <span>Recipients</span>
                <span className="num">{selected.size}</span>
              </div>

              {budget && (
                <div>
                  <div className="mkt-railbar-head">
                    <span>Daily send budget</span>
                    <span className="num">{Math.min(budget.cap, budget.used + thisSend)} / {budget.cap}</span>
                  </div>
                  <div className="mkt-railbar">
                    <div className="mkt-railbar-used" style={{ width: `${usedPct}%` }} />
                    <div className="mkt-railbar-send" style={{ width: `${sendPct}%` }} />
                  </div>
                  <div className="mkt-legend">
                    <span><span className="mkt-legend-dot mkt-railbar-used" />{budget.used} sent today</span>
                    <span><span className="mkt-legend-dot mkt-railbar-send" />{thisSend} this send</span>
                  </div>
                </div>
              )}

              <div className="mkt-rail-rule">
                {!confirming ? (
                  <button type="button" className="btn btn-primary btn-full"
                    onClick={() => setConfirming(true)} disabled={!canSend}>
                    Send campaign
                  </button>
                ) : (
                  <div className="mkt-dnc-prompt">
                    <p className="mkt-dnc-confirm">
                      Send &quot;{subject.trim()}&quot; to {selected.size}{' '}
                      {selected.size === 1 ? 'person' : 'people'}? This cannot be undone.
                    </p>
                    <div className="mkt-dnc-actions">
                      <button type="button" className="btn btn-secondary btn-sm"
                        onClick={() => setConfirming(false)} disabled={sending}>
                        Not yet
                      </button>
                      <button type="button" className="btn btn-danger btn-sm"
                        onClick={doSend} disabled={sending || saving}>
                        {sending ? 'Sending…' : 'Send it'}
                      </button>
                    </div>
                  </div>
                )}
                <div className="mkt-rail-note">Goes out at once. No scheduling yet.</div>
              </div>

              {result && (
                <div className="mkt-send-result mkt-rail-rule">
                  <h3>Sent</h3>
                  <ul className="mkt-heldback-list">
                    <li><span>Delivered to Resend</span><span>{result.sent}</span></li>
                    {heldBackCount > 0 && (
                      <li>
                        <span>Held back by suppression</span>
                        <span>{heldBackCount}</span>
                      </li>
                    )}
                    {result.deduped > 0 && (
                      <li><span>Duplicate rows for one person</span><span>{result.deduped}</span></li>
                    )}
                    {result.skipped_already_sent > 0 && (
                      <li><span>Already had this campaign</span><span>{result.skipped_already_sent}</span></li>
                    )}
                    {result.failed > 0 && (
                      <li><span className="mkt-warn">Failed</span><span className="mkt-warn">{result.failed}</span></li>
                    )}
                  </ul>
                  {result.failed > 0 && !result.stopped_early && (
                    <p className="muted tiny">
                      Press Send again to retry just the failures. Everyone already delivered is
                      skipped, so nobody receives it twice.
                    </p>
                  )}
                  {result.stopped_early === 'quota' && (
                    <p className="mkt-warn" style={{ fontSize: 11.5 }}>
                      Stopped early: the daily sending quota was reached. Nobody remaining was
                      charged a send, so running this again tomorrow picks up exactly who is left.
                      Your draft and selection are saved on this device, so it is safe to leave
                      this page.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {preview && <PreviewDrawer html={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

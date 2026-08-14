import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import RecipientPicker from './RecipientPicker';
import { errorText } from './marketingFormat';

/**
 * Write a campaign, pick who gets it, send it.
 *
 * Three steps in one screen rather than a wizard, because the operator needs to
 * see the recipient count while writing: "125 people" and "3 people" are
 * different emails.
 *
 * The Send step deliberately shows what the server will do BEFORE it does it,
 * and the server re-checks anyway. Both matter. The preview is so an operator
 * is never surprised by the number; the re-check is because the preview is a
 * snapshot and somebody may be excluded in between.
 */
export default function ComposeTab() {
  const toast = useToast();
  const [audiences, setAudiences] = useState([]);
  const [campaignId, setCampaignId] = useState(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const inFlight = useRef(false);

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
        setCampaignId(null);
        setSelected(new Set());
      }
    } catch (err) {
      toast.error(errorText(err, 'The send failed.'));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  const canSend = subject.trim() && body.trim() && selected.size > 0 && !sending;

  return (
    <div className="mkt-compose">
      {loadError && (
        <div className="mkt-state mkt-state-error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn-secondary" onClick={loadAudiences}>Try again</button>
        </div>
      )}

      <section className="mkt-compose-section">
        <h2>Write it</h2>
        <label htmlFor="cmp-subject">Subject</label>
        <input
          id="cmp-subject" type="text" value={subject} maxLength={200}
          onChange={e => setSubject(e.target.value)}
          placeholder="Planning your holiday party?"
        />
        <label htmlFor="cmp-body">Body</label>
        <textarea
          id="cmp-body" rows={10} value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="<p>Write the email here. Basic HTML is fine.</p>"
        />
        <div className="mkt-compose-actions">
          <button type="button" className="btn-secondary" onClick={saveDraft} disabled={saving}>
            {saving ? 'Saving…' : campaignId ? 'Save draft' : 'Create draft'}
          </button>
          <button type="button" className="btn-secondary" onClick={showPreview} disabled={!body.trim()}>
            Preview
          </button>
        </div>
      </section>

      <section className="mkt-compose-section">
        <h2>Who gets it</h2>
        <p className="mkt-muted">
          Only contacts who can be emailed are listed. Anyone unsubscribed, bounced,
          or on the do-not-contact list is already out, and the send re-checks.
        </p>
        <RecipientPicker audiences={audiences} selected={selected} onChange={setSelected} />
      </section>

      <section className="mkt-compose-section">
        <h2>Send it</h2>
        {!confirming ? (
          <>
            <p><strong>{selected.size}</strong> {selected.size === 1 ? 'person' : 'people'} selected.</p>
            <button type="button" className="btn-primary" onClick={() => setConfirming(true)} disabled={!canSend}>
              Send campaign
            </button>
          </>
        ) : (
          <div className="mkt-dnc-prompt">
            <p className="mkt-dnc-confirm">
              Send &quot;{subject.trim()}&quot; to {selected.size}{' '}
              {selected.size === 1 ? 'person' : 'people'}? This cannot be undone.
            </p>
            <div className="mkt-dnc-actions">
              <button type="button" className="btn-secondary" onClick={() => setConfirming(false)} disabled={sending}>
                Not yet
              </button>
              <button type="button" className="btn-danger" onClick={doSend} disabled={sending || saving}>
                {sending ? 'Sending…' : 'Send it'}
              </button>
            </div>
          </div>
        )}

        {result && (
          <div className="mkt-send-result">
            <h3>Sent</h3>
            <ul className="mkt-heldback-list">
              <li><span>Delivered to Resend</span><span>{result.sent}</span></li>
              {result.requested - result.eligible - (result.deduped || 0) > 0 && (
                <li>
                  <span>Held back by suppression</span>
                  <span>{result.requested - result.eligible - (result.deduped || 0)}</span>
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
              <p className="mkt-muted">
                Press Send again to retry just the failures. Everyone already delivered is
                skipped, so nobody receives it twice.
              </p>
            )}
            <ul className="mkt-heldback-list">
            </ul>
            {result.stopped_early === 'quota' && (
              <p className="mkt-warn">
                Stopped early: the daily sending quota was reached. Nobody remaining was
                charged a send, so running this again tomorrow picks up exactly who is left.
              </p>
            )}
          </div>
        )}
      </section>

      {preview && (
        <div className="mkt-drawer-backdrop" onClick={() => setPreview(null)}>
          <aside className="mkt-drawer" role="dialog" aria-modal="true" aria-label="Email preview"
            onClick={e => e.stopPropagation()}>
            <div className="mkt-drawer-head">
              <h2>Preview</h2>
              <button type="button" className="btn-link" onClick={() => setPreview(null)}>Close</button>
            </div>
            {/* The preview is server-rendered from the same wrapper the send
                uses, and the body is admin-authored and server-sanitized. */}
            {/* sandbox="" with no allow-scripts. A srcDoc frame is same-origin,
                so anything scriptable inside it could reach this app's JWT in
                localStorage. The server already sanitizes the body; this makes
                that sanitizer defense-in-depth rather than load-bearing. */}
            <iframe title="Email preview" srcDoc={preview} sandbox="" className="mkt-preview-frame" />
          </aside>
        </div>
      )}
    </div>
  );
}

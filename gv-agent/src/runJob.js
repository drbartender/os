// The per-job runner (plan Task 15): the fixed order of one GV post, with every
// dependency injected so the order and the exception rule are unit tested.
//
//   1. classify the page (a Google interstitial fails here)
//   2. open the existing conversation, if any (wrong_thread fails here)
//   3. a link in that thread the box did not post (pasteInThread, against the
//      job's prior_bodies): skipped_already_posted, no journal, no click
//   4. compose to the number
//   5. the same paste rule on the composed view, before the body is filled (a
//      thread the list scan missed shows here, and nothing of ours is in the
//      box yet, so only real messages can hold the token)
//   6. fill and check the body
//   7. past the job budget: failed_preclick timeout
//   8. the server's pre-click check (spec law 6): anything but a go skips
//   9. the before read: the composed view's messages holding the token,
//      counted only (never the paste rule: a filled box may show its own link)
//  10. journal the id (a throw here means no click)
//  11. click Send
//  12. poll the verify read for up to 20 s: sent only when that count went up
//
// The exception rule (plan decision 10) wraps it all: a throw before the
// journal is written is failed_preclick ui_error_before_send, a throw after it
// is clicked_unverified. Every definitive failure captures a diag.
//
// The outcome is recorded (deps.record, the loop's marker write) the moment the
// job settles, before the diag, the composer clear and the browser close, any
// of which a kill can cut short: a found skipped_already_posted survives that,
// rather than degrading to the exception rule's toll-free text.
const { underBudget, finalResult } = require('./decide');
const { verifyDecision, pasteInThread } = require('./pageLogic');
const { proposalToken, priorBodies } = require('./validate');
const { readCurrentJob, writeCurrentJob, clearCurrentJob } = require('./journal');

const VERIFY_WINDOW_MS = 20000;
const VERIFY_POLL_MS = 1000;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const preclick = (reason) => ({ outcome: 'failed_preclick', reason });

// What the pre-click check said. Only an explicit go clicks. The server
// answers timeout once the sweep has moved the row to unknown (plan Task 7).
function precheckVerdict(res) {
  if (res && res.go === true) return null;
  if (res && res.outcome === 'skipped_already_posted') return { outcome: 'skipped_already_posted' };
  if (res && res.outcome === 'timeout') return preclick('timeout');
  return preclick('ui_error_before_send');
}

// deps: { page, flow, journal: { has, write }, api: { precheck }, classify,
// diag, startMs, now, budgetMs }, plus optional sleep, log and record (tests
// and the loop). Returns { outcome, reason? }.
async function runJob(job, deps) {
  const { page, flow, journal, api, classify, diag, startMs, now, budgetMs } = deps;
  const sleep = deps.sleep || realSleep;
  const log = deps.log || (() => {});
  const record = deps.record || (() => {});
  let journaled = false;
  let filled = false;

  const done = async (result) => {
    // static-checks: allow swallowed-catch, the loop's record logs its own failure; the result stands
    try { await record(result); } catch { /* never changes the result; the loop still reports it */ }
    if (result.outcome !== 'sent' && result.outcome !== 'skipped_already_posted') {
      // static-checks: allow swallowed-catch, captureDiag logs nothing by design and a capture is best effort
      try { await diag(page, job.id, result.reason || result.outcome); } catch { /* best effort */ }
    }
    // No click happened: leave no filled draft behind for a later session.
    if (filled && !journaled) {
      try {
        await flow.clearComposer(page);
      } catch (err) {
        log(`job ${job.id}: composer not cleared (${(err && (err.code || err.name)) || 'error'})`);
      }
    }
    return result;
  };

  // Law 4 belt and braces: decideJob already reported any journaled id.
  if (journal.has(job.id)) return { outcome: 'clicked_unverified' };
  try {
    const token = proposalToken(job.body);
    if (!token) return await done(preclick('invalid_body')); // decideJob validated it already

    const pageState = await classify(page);
    if (pageState !== 'ok') return await done(preclick(pageState));

    const thread = await flow.openThreadIfAny(page, job.phone, job.negotiation_id);
    if (!thread || !thread.ok) return await done(preclick((thread && thread.reason) || 'ui_error_before_send'));

    // A resend arrives with the box's own earlier post in the thread; only a
    // token-holding message the prior list does not account for is a paste.
    if (thread.existed) {
      const inThread = await flow.readTokenMessages(page, token);
      if (!Array.isArray(inThread)) return await done(preclick('ui_error_before_send'));
      if (pasteInThread(inThread, priorBodies(job.prior_bodies))) return await done({ outcome: 'skipped_already_posted' });
    }

    const composed = await flow.composeTo(page, job.phone);
    if (!composed || !composed.ok) return await done(preclick((composed && composed.reason) || 'ui_error_before_send'));

    // Step 3 checks only a thread the list scan found; one it missed (deeper
    // than the scroll, archived, not yet rendered) shows on the composed view.
    // Read before the fill: once the body is in, a link preview or a mirror of
    // the box could show the token, and every first send would skip.
    const onCompose = await flow.readTokenMessages(page, token);
    if (!Array.isArray(onCompose)) return await done(preclick('ui_error_before_send'));
    if (pasteInThread(onCompose, priorBodies(job.prior_bodies))) return await done({ outcome: 'skipped_already_posted' });

    filled = true;
    const checked = await flow.fillAndCheck(page, job.body);
    if (!checked || !checked.ok) return await done(preclick((checked && checked.reason) || 'ui_error_before_send'));

    if (!underBudget(startMs, now(), budgetMs)) return await done(preclick('timeout'));

    const verdict = precheckVerdict(await api.precheck(job.id));
    if (verdict) return await done(verdict);

    // The before read, ahead of the journal and counted only: a read that
    // fails here is a pre-click failure, never a guess about what the click did.
    const beforeRead = await flow.readTokenMessages(page, token);
    if (!Array.isArray(beforeRead)) return await done(preclick('ui_error_before_send'));
    const before = beforeRead.length;

    try {
      journal.write(job.id);
    } catch (err) {
      log(`job ${job.id}: journal write failed (${err.message}); not clicking`);
      return await done(preclick('ui_error_before_send'));
    }
    journaled = true;

    await flow.clickSend(page);

    const deadline = now() + VERIFY_WINDOW_MS;
    for (;;) {
      const v = await flow.readVerify(page, token);
      const after = v && v.tokenCount;
      if (verifyDecision({ before, after, boxEmpty: v && v.boxEmpty }) === 'sent') return await done({ outcome: 'sent' });
      if (now() >= deadline) break;
      await sleep(VERIFY_POLL_MS);
    }
    return await done({ outcome: 'clicked_unverified' });
  } catch (err) {
    log(`job ${job.id}: threw ${journaled ? 'after' : 'before'} the journal (${(err && err.message) || err})`);
    return done(journaled ? { outcome: 'clicked_unverified' } : preclick('ui_error_before_send'));
  }
}

// A current-job marker left by a crash, or by a report that never landed. Its
// recorded outcome is re-sent as itself; a marker with none is settled by the
// journal (decision 10). The outcome is recorded before the report, so a retry
// never counts a click twice. Returns null (no marker) or { id, result, delivery }.
async function reconcileMarker({ markerFile, journal, report, onClick = () => {} }) {
  const marker = readCurrentJob(markerFile);
  if (!marker) return null;
  const result = finalResult(marker.outcome ? marker : null, journal.has(marker.id));
  if (!marker.outcome) {
    // static-checks: allow swallowed-catch, no logger here and the report still goes; a later start re-settles it
    try { writeCurrentJob(markerFile, marker.id, result); } catch { /* the report still goes */ }
    if (result.outcome === 'sent' || result.outcome === 'clicked_unverified') onClick();
  }
  const delivery = await report(marker.id, result);
  if (delivery !== 'undelivered') clearCurrentJob(markerFile);
  return { id: marker.id, result, delivery };
}

module.exports = { runJob, reconcileMarker };

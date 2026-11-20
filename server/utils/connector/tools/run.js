'use strict';

// One connector tool call from start to answer: the hold read once, the tool, the tripwire for detail tools, the withheld log, the call-log row and the plain error.
//
// Order per call (spec 2026-11-19 laws 1, 2, 6, 8 and section 7.6):
//   1. legalHold.holdExclusion(), read ONCE and handed to the tool, which
//      passes that one object to every shared read it calls. A hold list that
//      cannot be read fails the call with a plain "unavailable" and nothing
//      else (spec section 8).
//   2. The tool builds its result from its field lists, through one text
//      guard (text.js). A ToolNotFound answers one plain not-found per tool,
//      the same for a held record and a missing one; a ToolInputError answers
//      its own plain message; anything else answers a fixed failure.
//   3. A detail tool's subject passes the tripwire (tripwire.js) or the call
//      is refused, nothing returned.
//   4. The withheld pieces are logged (and emailed once each, detached); a
//      flagged piece is named in this call's own row (record_ids "flagged:..."),
//      emailing no one.
//   5. The never-list check (fields.assertSafe), then this call's row is
//      written BEFORE the answer goes out (ctx.logged), so the tripwire's log
//      read never waits on a row written after a response.
// Sentry gets the tool name and an error descriptor (the error's class and a
// code shaped like an identifier), never the arguments, the result or the
// error's own message, which can quote an argument.

const tripwire = require('../tripwire');
const { recordWithheld } = require('../withheld');
const { assertSafe } = require('../fields');
const { createTextGuard } = require('./text');
const { getToolDeps } = require('./deps');

class ToolNotFound extends Error {
  constructor(message, recordIds = []) {
    super(message);
    this.name = 'ToolNotFound';
    this.recordIds = recordIds;
  }
}
class ToolInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolInputError';
  }
}

const UNAVAILABLE = 'The OS cannot answer right now (unavailable). Try again in a few minutes, or look in the OS directly.';
const FAILED = 'That lookup failed in the OS. Try again, or look in the OS directly.';
const KNOWN_CLASSES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'DatabaseError', 'AggregateError']);

/** The error's class and code, each only when it looks like an identifier. */
function descriptor(err) {
  const cls = err && err.constructor && typeof err.constructor.name === 'string' ? err.constructor.name : 'Error';
  const code = err && typeof err.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(err.code) ? err.code : null;
  return { error_class: KNOWN_CLASSES.has(cls) || /^[A-Z][A-Za-z]{2,40}Error$/.test(cls) ? cls : 'Error', error_code: code };
}

function report(toolName, stage, err) {
  const d = descriptor(err);
  try {
    getToolDeps().captureMessage('connector_tool_failed', {
      level: 'error',
      tags: { component: 'connector', tool: toolName, stage, error_class: d.error_class, error_code: d.error_code || 'none' },
    });
  } catch (_) { /* telemetry must never break a tool call; static-checks: allow swallowed-catch */ }
  console.error(`[connector] tool ${toolName} failed at ${stage}: ${d.error_class}${d.error_code ? ` ${d.error_code}` : ''}`);
}

/**
 * The refusal while the tripwire holds: the read limit was reached, what is
 * counted, and that the owner is being notified only when notifications are
 * on (never a claim that the email went out).
 */
function tripwireRefusal(capN, notificationsOn) {
  return `Detail lookups are paused: the read limit of ${capN} different records in an hour (a client, or a thread or `
    + 'booking with no client) was reached. They resume on their own an hour after the pause began; the lists still '
    + `answer.${notificationsOn ? ' The owner is being notified.' : ''}`;
}

const errorResult = (text) => ({ isError: true, content: [{ type: 'text', text }] });

function readExclusionShape(ex) {
  const ok = (list) => Array.isArray(list) && list.every((n) => Number.isInteger(n) && n > 0);
  if (!ex || !ok(ex.proposalIds) || !ok(ex.clientIds)) throw new TypeError('connector: the hold exclusion is malformed');
  return ex;
}

/**
 * Run one tool for one MCP call. Never throws: resolves an MCP tool result.
 * @param {{name: string, detail: boolean, run: Function}} tool
 * @param {object} args the SDK-validated arguments
 * @param {object} ctx the call's context (connectorMcp.js buildMcpServer)
 */
async function runTool(tool, args, ctx) {
  const started = Date.now();
  const d = getToolDeps();
  const now = d.now();
  const row = { recordIds: [], clientId: null, resultCount: null };
  const finish = async (outcome) => {
    ctx.logged = true;
    ctx.outcome = outcome;
    await d.recordCall({
      grantId: ctx.grantId,
      callerAddress: ctx.callerAddress,
      method: 'tools/call',
      toolName: tool.name,
      recordIds: row.recordIds,
      clientId: row.clientId,
      resultCount: row.resultCount,
      durationMs: Date.now() - started,
      outcome,
    });
  };

  let exclude;
  try {
    exclude = readExclusionShape(await d.holdExclusion());
  } catch (err) {
    report(tool.name, 'hold', err);
    await finish('error');
    return errorResult(UNAVAILABLE);
  }

  const guard = createTextGuard();
  let out;
  try {
    out = await tool.run({ args: args || {}, exclude, guard, ctx, deps: d, now });
  } catch (err) {
    if (err instanceof ToolNotFound) {
      row.recordIds = err.recordIds;
      await finish('not_found');
      return errorResult(err.message);
    }
    if (err instanceof ToolInputError) {
      await finish('error');
      return errorResult(err.message);
    }
    report(tool.name, 'read', err);
    await finish('error');
    return errorResult(FAILED);
  }

  try {
    row.recordIds = Array.isArray(out.recordIds) ? out.recordIds.map(String) : [];
    row.clientId = Number.isInteger(out.clientId) ? out.clientId : null;
    row.resultCount = Number.isInteger(out.resultCount) ? out.resultCount : null;
    if (tool.detail) {
      const subject = tripwire.subjectOf({ toolName: tool.name, clientId: row.clientId, recordId: row.recordIds[0] });
      const gate = await tripwire.admit({ grantId: ctx.grantId, userId: ctx.userId, subject, now });
      if (!gate.allowed) {
        // The refused row names its trip's start, which a restart reads back.
        if (Number.isFinite(gate.since)) row.recordIds.push(`trip:${new Date(gate.since).toISOString()}`);
        await finish('refused_tripwire');
        return errorResult(tripwireRefusal(gate.cap, Boolean(d.notificationsOn())));
      }
    }
    assertSafe(out.result);
    const text = JSON.stringify(out.result);
    if (guard.withheld.length) await recordWithheld(ctx, { toolName: tool.name, pieces: guard.withheld, clientId: row.clientId, now });
    for (const label of guard.flagged) row.recordIds.push(`flagged:${label}`);
    // Every piece this call held back is named on its own row, so the
    // settings block shows it whether or not its email went out.
    for (const piece of guard.withheld) row.recordIds.push(`withheld:${piece.ref}`);
    await finish('ok');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    report(tool.name, 'answer', err);
    await finish('error');
    return errorResult(FAILED);
  }
}

module.exports = { runTool, ToolNotFound, ToolInputError, UNAVAILABLE, FAILED, descriptor, tripwireRefusal };

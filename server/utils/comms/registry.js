'use strict';

// Comms action registry (spec 4.1). Auto-discovers every module in ./actions
// at require time so downstream lanes ADD an action file without editing this
// one (the lane model forbids cross-lane edits to shared files).
//
// Action contract — each actions/*.js exports:
//   key             string, e.g. 'shopping_list_approve'
//   messageType     message_log.message_type written by dispatch
//   defaultChannels { email: boolean, sms: boolean }
//   resolveRecipient(entityId) -> { name, email, phone, source, warnings,
//                                   channels: { email: {available, default, unavailable_reason},
//                                               sms:   {available, default, unavailable_reason} } }
//   buildMessages(entityId)    -> { email: {subject, heading, bodyText, cta}, sms: {body} }
//   ensureSideEffects(entityId, ctx) -> { applied: boolean }   // idempotent; 2nd call no-ops
//   dispatch(entityId, message, channels, ctx) -> { email, sms, skip_reasons, ... }
//   minRole      optional 'admin': actions ported from adminOnly legacy routes
//                declare it so /api/comms cannot widen access to managers
//   dispatchWithoutSideEffects  optional boolean: true for resend-type actions
//                whose ensureSideEffects is validate-only (always applied:false);
//                exempts them from the route's concurrent-confirm dispatch guard
const fs = require('fs');
const path = require('path');

const ACTIONS_DIR = path.join(__dirname, 'actions');
const actions = {};

for (const file of fs.readdirSync(ACTIONS_DIR).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))) {
  const mod = require(path.join(ACTIONS_DIR, file));
  if (!mod.key || typeof mod.resolveRecipient !== 'function' || typeof mod.dispatch !== 'function') {
    throw new Error(`comms action ${file} does not satisfy the action contract`);
  }
  if (actions[mod.key]) throw new Error(`duplicate comms action key: ${mod.key}`);
  actions[mod.key] = mod;
}

function getAction(key) {
  // hasOwnProperty guard: a prototype key ('__proto__', 'constructor') must
  // resolve to null (clean 400 upstream), not a truthy non-action (500).
  return Object.prototype.hasOwnProperty.call(actions, key) ? actions[key] : null;
}

function listActionKeys() {
  return Object.keys(actions).sort();
}

module.exports = { getAction, listActionKeys };

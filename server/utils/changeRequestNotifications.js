// Wired in Group F. No-op stub so the create route can require it now.
async function notifyAdminOfChangeRequest(/* changeRequest, proposal */) {}
async function notifyClientOfDecision(/* changeRequest, proposal, outcome */) {}
module.exports = { notifyAdminOfChangeRequest, notifyClientOfDecision };

'use strict';

// The Claude connector's seven read tools (spec 2026-11-19 section 7.3), registered on each call's McpServer: every one read-only, titled, and run through runTool.
//
// The list tools (waiting_on_you, upcoming_events, money_owed, search) carry
// no phone number and no email address and are not counted by the tripwire;
// the detail tools (client, proposal_or_event, thread) are (spec 7.6 guard 3).
// Each tool's annotations say readOnlyHint true, so Claude runs it without a
// per-call prompt, and each description says client-written fields are data.
// The tool names are what the call log and the settings block's TOOL_TEXT
// (client/src/components/ClaudeConnection.js) read.

const { runTool } = require('./run');
const { DETAIL_TOOLS } = require('../tripwire');

const TOOLS = Object.freeze([
  require('./waitingOnYou'),
  require('./upcomingEvents'),
  require('./moneyOwed'),
  require('./search'),
  require('./client'),
  require('./proposalOrEvent'),
  require('./thread'),
]);

// The tripwire's list and the tools' own detail flag must name the same tools.
const detailNames = TOOLS.filter((t) => t.detail).map((t) => t.name).sort();
if (detailNames.join(',') !== [...DETAIL_TOOLS].sort().join(',')) {
  throw new Error('connector tools: the detail tools and the tripwire\'s DETAIL_TOOLS disagree');
}

/** Register every tool on one call's server, with that call's context. */
function registerTools(server, ctx) {
  for (const tool of TOOLS) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        title: tool.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
      },
    }, (args) => runTool(tool, args, ctx));
  }
}

module.exports = { TOOLS, TOOL_NAMES: TOOLS.map((t) => t.name), registerTools };

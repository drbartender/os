'use strict';

// Whether THIS server process registered the GV post sweep (spec
// docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md, laws 2
// and 5). The sweep is the only thing that moves a queued post the box never
// leased to the toll-free text, and the only source of the no-lease outage
// email, so the router (queue.js) queues nothing in a process that does not
// run it: with RUN_GV_POST_SWEEP_SCHEDULER or RUN_SCHEDULERS off and the box
// down, a queued post would otherwise sit forever with no text and no alert.
//
// A fact about the process, set once by server/index.js where it registers
// the sweep, never an env read of its own: the scheduler gate lives in one
// place. A second instance that runs no schedulers therefore texts as today.

let registered = false;

/** Called by server/index.js right where it schedules the sweep. */
function markGvSweepRegistered() { registered = true; }

/** True when this process scheduled the sweep. */
function gvSweepRegistered() { return registered; }

module.exports = { markGvSweepRegistered, gvSweepRegistered };

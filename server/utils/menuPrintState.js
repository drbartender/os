// The menu print state of an event (spec 2026-10-01 section 8, amended by spec
// 2026-10-19 section 10.3 for the held file and its release), split from the
// read model (menuDraftRead.js, which re-exports both). Pure.
//
// readPrintState({ menuPrintKey, menuNotRequired, draft, plannerImageKey, latestProof })
// -> { state, live }: state one of PRINT_STATES, the first that applies; live
// is 'none' or 'previous' in the held state (whether staff still have an older
// released file), else null.
//   not_required           the event is marked no menu needed (with or without a draft)
//   none                   no draft, or none of the rows below (spec 10.3 calls it pending)
//   held                   an approved file waits on its release: approved_print_key set
//                          and not the released key, the latest proof is for the approved
//                          pair and not withdrawn, and menu_print_key is null (live none)
//                          or the released key (live previous)
//   approved               Released: menu_print_key is the released key, or (a menu
//                          approved under v1, before releases existed) the approved key
//                          with no released key
//   edited_since_approval  as approved, but the version, art_version or (logo role) the
//                          planner image moved since the approved pair, or the released
//                          file staff have is an older one than the approved file
//   replaced               menu_print_key is set and is neither: an admin upload
//   removed                menu_print_key is null with a released key, or (v1) an
//                          approved key with no release and no proof: Put it back for
//                          staff re-posts that key (menuRelease.restoreReleasedPrint)
// derivePrintState(args) is readPrintState(args).state.
// draft carries version, art_version, approved_version, approved_art_version,
// approved_print_key, approved_planner_image_key, released_print_key and
// inputs.planner_image_role; plannerImageKey is the plan's current one;
// latestProof is the draft's latest proof ({ version, art_version,
// withdrawn_at }) or null. isHeldFile is the held test without the live key,
// which the release helper's guard 3 shares.

const PRINT_STATES = Object.freeze({
  NOT_REQUIRED: 'not_required',
  HELD: 'held',
  REPLACED: 'replaced',
  REMOVED: 'removed',
  EDITED: 'edited_since_approval',
  APPROVED: 'approved',
  NONE: 'none',
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// An approved file that was never released, whose latest proof is for its pair
// and still out (spec 10.3, release guard 3).
function isHeldFile(draft, latestProof) {
  if (!isObject(draft)) return false;
  const approvedKey = draft.approved_print_key || null;
  if (!approvedKey || approvedKey === (draft.released_print_key || null)) return false;
  return isObject(latestProof) && !latestProof.withdrawn_at
    && latestProof.version === draft.approved_version && latestProof.art_version === draft.approved_art_version;
}

function readPrintState({
  menuPrintKey = null, menuNotRequired = false, draft = null, plannerImageKey = null, latestProof = null,
} = {}) {
  if (menuNotRequired) return { state: PRINT_STATES.NOT_REQUIRED, live: null };
  if (!isObject(draft)) return { state: PRINT_STATES.NONE, live: null };
  const printKey = menuPrintKey || null;
  const approvedKey = draft.approved_print_key || null;
  const releasedKey = draft.released_print_key || null;
  if (isHeldFile(draft, latestProof) && (printKey === null || printKey === releasedKey)) {
    return { state: PRINT_STATES.HELD, live: printKey === null ? 'none' : 'previous' };
  }
  const v1Live = releasedKey === null && approvedKey !== null && printKey === approvedKey;
  if (printKey !== null && (printKey === releasedKey || v1Live)) {
    const versionMoved = draft.version !== draft.approved_version || draft.art_version !== draft.approved_art_version;
    const role = isObject(draft.inputs) ? draft.inputs.planner_image_role : null;
    const logoMoved = role === 'logo' && (plannerImageKey || null) !== (draft.approved_planner_image_key || null);
    const olderFile = releasedKey !== null && releasedKey !== approvedKey;
    return { state: versionMoved || logoMoved || olderFile ? PRINT_STATES.EDITED : PRINT_STATES.APPROVED, live: null };
  }
  if (printKey !== null) return { state: PRINT_STATES.REPLACED, live: null };
  if (releasedKey !== null || (approvedKey !== null && !isObject(latestProof))) return { state: PRINT_STATES.REMOVED, live: null };
  return { state: PRINT_STATES.NONE, live: null };
}

function derivePrintState(args) {
  return readPrintState(args).state;
}

module.exports = { derivePrintState, readPrintState, isHeldFile, PRINT_STATES };

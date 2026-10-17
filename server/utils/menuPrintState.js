// The menu print state of an event (spec 2026-10-01 section 8), split from
// the read model (menuDraftRead.js, which re-exports both). Pure.
//
// derivePrintState({ menuPrintKey, menuNotRequired, draft, plannerImageKey })
// -> one of PRINT_STATES, the first that applies:
//   not_required           the event is marked no menu needed (with or without a draft)
//   none                   no draft, or a draft that was never approved and no print file
//   replaced               the print file is not the approved one: a manual upload is
//                          in use, whether or not this draft was ever approved
//   removed                the approved file was removed and nothing replaced it
//   edited_since_approval  the approved file is in use, but version or art_version
//                          moved, or the role is logo and the planner image changed
//   approved               the approved file is in use and nothing moved
// draft carries version, art_version, approved_version, approved_art_version,
// approved_print_key, approved_planner_image_key and inputs.planner_image_role;
// plannerImageKey is the plan's current one.

const PRINT_STATES = Object.freeze({
  NOT_REQUIRED: 'not_required',
  REPLACED: 'replaced',
  REMOVED: 'removed',
  EDITED: 'edited_since_approval',
  APPROVED: 'approved',
  NONE: 'none',
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function derivePrintState({ menuPrintKey = null, menuNotRequired = false, draft = null, plannerImageKey = null } = {}) {
  if (menuNotRequired) return PRINT_STATES.NOT_REQUIRED;
  if (!isObject(draft)) return PRINT_STATES.NONE;
  const printKey = menuPrintKey || null;
  const approvedKey = draft.approved_print_key || null;
  if (printKey && printKey !== approvedKey) return PRINT_STATES.REPLACED;
  if (!printKey && approvedKey) return PRINT_STATES.REMOVED;
  if (!printKey) return PRINT_STATES.NONE;
  const versionMoved = draft.version !== draft.approved_version || draft.art_version !== draft.approved_art_version;
  const role = isObject(draft.inputs) ? draft.inputs.planner_image_role : null;
  const logoMoved = role === 'logo' && (plannerImageKey || null) !== (draft.approved_planner_image_key || null);
  return versionMoved || logoMoved ? PRINT_STATES.EDITED : PRINT_STATES.APPROVED;
}

module.exports = { derivePrintState, PRINT_STATES };

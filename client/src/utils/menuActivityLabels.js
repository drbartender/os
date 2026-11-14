// The menu review's activity rows by name, and the page a client's came from: one map shared by the proposal
// page's activity rail and full log and the event page's Activity card.
//
// The rows are the ones Approve and send, the release, Close request and the
// client's proof page write (spec 2026-10-19 sections 10 to 12; lane
// menu-approve-send). activityLabel(action) is the menu review's label for its
// own actions, and the action itself for every other row, as it printed
// before; isMenuActivity(action) whether it is one of them; clientSource(action)
// the source line of a row the client wrote: the menu proof page for these,
// the proposal page for any other.

const MENU_ACTIVITY = new Map([
  ['menu_approved', 'Menu approved'],
  ['menu_proof_sent', 'Menu proof sent'],
  ['menu_released', 'Menu released for printing'],
  ['menu_proof_approved', 'Client said the menu looks great'],
  ['menu_proof_changes', 'Client asked for menu changes'],
  ['menu_proof_closed', 'Menu change request closed'],
]);

export const isMenuActivity = (action) => MENU_ACTIVITY.has(action);

export const activityLabel = (action) => MENU_ACTIVITY.get(action) || action;

export const clientSource = (action) => (isMenuActivity(action) ? 'Menu proof page' : 'Proposal page');

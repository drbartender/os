// proposals.* = DOLLARS; invoices.* / proposal_payments.amount = CENTS. Never crossed.
// One module-scope formatter — toLocaleString-with-options builds an Intl
// formatter on every call, so reuse a single instance instead.
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd = (n) => USD.format(Number(n || 0));
export const formatDollars = (dollars) => usd(dollars);
export const formatCents = (cents) => usd(Number(cents || 0) / 100);

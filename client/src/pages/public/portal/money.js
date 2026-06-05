// proposals.* = DOLLARS; invoices.* / proposal_payments.amount = CENTS. Never crossed.
const usd = (n) => Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
export const formatDollars = (dollars) => usd(dollars);
export const formatCents = (cents) => usd(Number(cents || 0) / 100);

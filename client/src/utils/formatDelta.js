// Shared change-request dollar-delta formatter (admin queue/card + public portal form)

export const formatMoneyDelta = (n) => `$${Number(n || 0).toFixed(2)}`;

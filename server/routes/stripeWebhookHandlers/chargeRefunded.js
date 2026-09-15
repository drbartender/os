// stripeWebhook concern: charge.refunded. TIP CLAWBACK ONLY since 2026-09-15.
//
// This handler used to reconcile the refund against the proposal as well, by
// reading `charge.refunds.data[0]`. That stopped working silently: the live
// endpoint runs API version 2025-01-27.acacia, and from that version the Charge
// object carries no `refunds` list at all, so the read was `undefined` and the
// handler no-oped on every delivery. Proposal 784's dashboard refund of a
// duplicate bank debit is the prod case that exposed it. Reconciliation now
// lives in refundCreated.js, whose payload IS the Refund object (Stripe's own
// guidance: "Listen to refund.created for information about the refund").
//
// What stays here is the payroll tip clawback, which reads
// `charge.amount_refunded` — a top-level Charge field under every API version —
// and is cumulative, so an at-least-once redelivery moves nothing (the delta is
// zero). No res used; falls through to the dispatcher's ack.
const { clawbackTipByPaymentIntent } = require('../../utils/payrollClawback');

module.exports = async function handleChargeRefunded(event) {
    const charge = event.data.object;
    const paymentIntentId = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;
    // No-ops when the intent is not a tip.
    await clawbackTipByPaymentIntent(paymentIntentId, Number(charge.amount_refunded || 0));
};

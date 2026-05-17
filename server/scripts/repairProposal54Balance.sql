-- One-off, guarded balance correction — proposal 54 (Ketan Patel).
--
-- Root cause: payment_type='invoice' had no webhook branch, so the $550 invoice
-- payment (pi_3TXo3wAZrfv5tWfN34hdR4EK, succeeded) marked INV-0009 paid but
-- never rolled up to the proposal. Combined with the $100 deposit
-- (pi_3TXUZxAZrfv5tWfN3zAHPFoo, succeeded) the client has paid $650 = full total.
--
-- RUN ONLY AFTER the Task 1 code fix is deployed to production.
-- Guarded WHERE makes this a strict no-op unless the exact buggy state is present;
-- safe to re-run.

BEGIN;

UPDATE proposals
   SET amount_paid = 650.00,
       status = 'balance_paid',
       autopay_status = NULL
 WHERE id = 54
   AND amount_paid = 100.00
   AND status = 'deposit_paid';

INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
SELECT 54, 'balance_correction', 'system',
       '{"reason":"invoice-payment roll-up bug (no invoice branch in payment_intent.succeeded); pi_3TXUZxAZrfv5tWfN3zAHPFoo ($100 deposit) + pi_3TXo3wAZrfv5tWfN34hdR4EK ($550 invoice) both succeeded = $650 full total","amount_paid_before":100.00,"amount_paid_after":650.00,"status_after":"balance_paid"}'::jsonb
WHERE EXISTS (
  SELECT 1 FROM proposals WHERE id = 54 AND amount_paid = 650.00 AND status = 'balance_paid'
)
AND NOT EXISTS (
  SELECT 1 FROM proposal_activity_log WHERE proposal_id = 54 AND action = 'balance_correction'
);

SELECT id, total_price, amount_paid, status, autopay_status FROM proposals WHERE id = 54;

COMMIT;

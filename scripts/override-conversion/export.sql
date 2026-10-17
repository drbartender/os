-- The override conversion's export (plan 2026-10-16-price-override-removal, Task V1
-- step 2; spec section 8.5). Two statements, run by export.js in ONE read-only
-- REPEATABLE READ transaction against a Neon branch, never prod itself. Ids only
-- first; the legal-hold seam drops held ids in export.js before the second
-- statement, so no held booking's row is ever read. No names, emails or phones.

-- @@ candidates: every booking with an override, and every booking with a
-- succeeded contract-scope refund. Ids only.
SELECT id FROM proposals WHERE total_price_override IS NOT NULL
UNION
SELECT proposal_id FROM proposal_refunds WHERE status = 'succeeded' AND total_scope = 'contract'
ORDER BY 1;

-- @@ rows: $1 = the candidate ids that passed the seam. Money columns as exact
-- text; money_md5 is the guard the forward block checks (shared.js MONEY_MD5_EXPR).
SELECT p.id,
       p.status,
       p.total_price::text AS total_price,
       p.amount_paid::text AS amount_paid,
       p.total_price_override::text AS total_price_override,
       p.adjustments,
       jsonb_typeof(p.adjustments) AS adjustments_type,
       p.pricing_snapshot,
       p.package_id,
       p.num_bars,
       p.num_bartenders,
       p.event_duration_hours::text AS event_duration_hours,
       p.gratuity_rate::text AS gratuity_rate,
       p.tip_jar,
       p.gratuity_floor_rate::text AS gratuity_floor_rate,
       md5(row(total_price, amount_paid, status, total_price_override, adjustments, pricing_snapshot)::text) AS money_md5,
       COALESCE((SELECT json_agg(json_build_object(
                   'id', r.id, 'amount', r.amount, 'total_scope', r.total_scope,
                   'total_price_before', r.total_price_before::text, 'total_price_after', r.total_price_after::text,
                   'created_at', r.created_at) ORDER BY r.created_at, r.id)
                   FROM proposal_refunds r WHERE r.proposal_id = p.id AND r.status = 'succeeded'), '[]'::json) AS refunds,
       COALESCE((SELECT json_agg(json_build_object(
                   'id', a.id, 'addon_id', a.addon_id, 'addon_name', a.addon_name, 'billing_type', a.billing_type,
                   'rate', a.rate::text, 'quantity', a.quantity::text, 'line_total', a.line_total::text) ORDER BY a.id)
                   FROM proposal_addons a WHERE a.proposal_id = p.id), '[]'::json) AS addons,
       COALESCE((SELECT json_agg(json_build_object(
                   'id', i.id, 'created_at', i.created_at, 'amount_due', i.amount_due, 'status', i.status) ORDER BY i.created_at, i.id)
                   FROM invoices i WHERE i.proposal_id = p.id AND i.label = 'Additional Services'), '[]'::json) AS additional_services_invoices,
       COALESCE((SELECT json_agg(json_build_object('id', c.id, 'created_at', c.created_at) ORDER BY c.created_at, c.id)
                   FROM proposal_change_requests c WHERE c.proposal_id = p.id AND c.status = 'pending'), '[]'::json) AS pending_change_requests
  FROM proposals p
 WHERE p.id = ANY($1::int[])
 ORDER BY p.id;

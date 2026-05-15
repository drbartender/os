-- One-time pre-launch production data scrub.
-- Spec: docs/superpowers/specs/2026-05-15-prelaunch-data-scrub-design.md
-- Plan: docs/superpowers/plans/2026-05-15-prelaunch-data-scrub.md
--
-- Run as ONE transaction. Rehearse on a Neon branch before production.
-- The final DO block RAISEs on any post-condition failure -> full ROLLBACK.
--
-- Cutoff: only rows created before 2026-05-16Z are eligible for deletion;
-- anything newer (live traffic after analysis) is preserved automatically.
--
-- Keep-sets: users {1,2,12,15,16,19}  proposals {21,25,30,51,52}
--   clients {has thumbtack_leads link} U {21,26,31,80,83}  email_leads {44,46}

BEGIN;

-- Baseline snapshot of tables that MUST NOT change, so asserts can prove
-- zero collateral damage (auto-adapts to any live growth in tt_* tables).
CREATE TEMP TABLE _baseline ON COMMIT DROP AS
SELECT 'service_packages'      t, COUNT(*) n FROM service_packages
UNION ALL SELECT 'service_addons',       COUNT(*) FROM service_addons
UNION ALL SELECT 'cocktails',            COUNT(*) FROM cocktails
UNION ALL SELECT 'cocktail_categories',  COUNT(*) FROM cocktail_categories
UNION ALL SELECT 'mocktails',            COUNT(*) FROM mocktails
UNION ALL SELECT 'mocktail_categories',  COUNT(*) FROM mocktail_categories
UNION ALL SELECT 'app_settings',         COUNT(*) FROM app_settings
UNION ALL SELECT 'blog_posts',           COUNT(*) FROM blog_posts
UNION ALL SELECT 'thumbtack_leads',      COUNT(*) FROM thumbtack_leads
UNION ALL SELECT 'thumbtack_messages',   COUNT(*) FROM thumbtack_messages
UNION ALL SELECT 'thumbtack_reviews',    COUNT(*) FROM thumbtack_reviews
UNION ALL SELECT 'email_campaigns',      COUNT(*) FROM email_campaigns
UNION ALL SELECT 'email_sequence_steps', COUNT(*) FROM email_sequence_steps;

-- 1. Invoices for non-kept proposals (FK is RESTRICT -> must precede proposals).
--    Cascades invoice_line_items, invoice_payments.
DELETE FROM invoices
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND (proposal_id IS NULL OR proposal_id NOT IN (21,25,30,51,52));

-- 2. Shifts for non-kept proposals. Cascades shift_requests.
DELETE FROM shifts
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND (proposal_id IS NULL OR proposal_id NOT IN (21,25,30,51,52));

-- 3. Non-kept proposals. Cascades proposal_addons, proposal_activity_log,
--    proposal_payments, stripe_sessions, drink_plans.
DELETE FROM proposals
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND id NOT IN (21,25,30,51,52);

-- 4. Sequence enrollments for non-kept leads.
DELETE FROM email_sequence_enrollments
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND (lead_id IS NULL OR lead_id NOT IN (44,46));

-- 5. Quote drafts for non-kept leads.
DELETE FROM quote_drafts
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND (lead_id IS NULL OR lead_id NOT IN (44,46));

-- 6. Non-kept email leads.
DELETE FROM email_leads
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND id NOT IN (44,46);

-- 7. Test SMS (the lone 2026-03-21 row; sender/recipient are kept users).
DELETE FROM sms_messages
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00';

-- 8. Non-kept clients. After proposals: every kept proposal points only to a
--    kept client, so no surviving FK is severed. tt-linked clients are always
--    kept, so no thumbtack_leads link is broken.
DELETE FROM clients c
 WHERE c.created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND NOT (
     EXISTS (SELECT 1 FROM thumbtack_leads tl WHERE tl.client_id = c.id)
     OR c.id IN (21,26,31,80,83)
   );

-- 9. Non-kept users. Cascades agreements, applications, contractor_profiles,
--    onboarding_progress, interview_notes, interview_scores, payment_profiles,
--    shift_requests, application_activity, password_reset_tokens.
DELETE FROM users
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND id NOT IN (1,2,12,15,16,19);

-- == Post-condition asserts. Any failure RAISEs -> whole transaction ROLLBACK ==
DO $$
DECLARE drift TEXT;
BEGIN
  -- 9a. Deletes fully applied (no pre-cutoff non-kept survivors).
  IF EXISTS (SELECT 1 FROM users
             WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
               AND id NOT IN (1,2,12,15,16,19))
  THEN RAISE EXCEPTION 'users: pre-cutoff non-kept rows survived'; END IF;

  IF EXISTS (SELECT 1 FROM proposals
             WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
               AND id NOT IN (21,25,30,51,52))
  THEN RAISE EXCEPTION 'proposals: pre-cutoff non-kept rows survived'; END IF;

  IF EXISTS (SELECT 1 FROM clients c
             WHERE c.created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
               AND NOT (EXISTS (SELECT 1 FROM thumbtack_leads tl WHERE tl.client_id=c.id)
                        OR c.id IN (21,26,31,80,83)))
  THEN RAISE EXCEPTION 'clients: pre-cutoff non-kept rows survived'; END IF;

  IF EXISTS (SELECT 1 FROM email_leads
             WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
               AND id NOT IN (44,46))
  THEN RAISE EXCEPTION 'email_leads: pre-cutoff non-kept rows survived'; END IF;

  -- 9b. No kept-set row was destroyed.
  IF (SELECT COUNT(*) FROM users WHERE id IN (1,2,12,15,16,19)) <> 6
  THEN RAISE EXCEPTION 'users: a kept account is missing'; END IF;
  IF (SELECT COUNT(*) FROM proposals WHERE id IN (21,25,30,51,52)) <> 5
  THEN RAISE EXCEPTION 'proposals: a kept proposal is missing'; END IF;
  IF (SELECT COUNT(*) FROM clients WHERE id IN (21,26,31,80,83)) <> 5
  THEN RAISE EXCEPTION 'clients: a kept proposal-client is missing'; END IF;
  IF (SELECT COUNT(*) FROM email_leads WHERE id IN (44,46)) <> 2
  THEN RAISE EXCEPTION 'email_leads: a kept lead is missing'; END IF;

  -- 9c. Referential integrity.
  IF EXISTS (SELECT 1 FROM proposals p
             WHERE p.id IN (21,25,30,51,52)
               AND (p.client_id IS NULL
                    OR NOT EXISTS (SELECT 1 FROM clients c WHERE c.id=p.client_id)))
  THEN RAISE EXCEPTION 'a kept proposal lost its client'; END IF;

  IF EXISTS (SELECT 1 FROM thumbtack_leads tl
             WHERE tl.client_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id=tl.client_id))
  THEN RAISE EXCEPTION 'a thumbtack_lead was orphaned by a client delete'; END IF;

  -- 9d. Untouched tables unchanged vs. baseline.
  SELECT string_agg(b.t, ', ') INTO drift
  FROM _baseline b
  JOIN (
    SELECT 'service_packages' t, COUNT(*) n FROM service_packages
    UNION ALL SELECT 'service_addons',       COUNT(*) FROM service_addons
    UNION ALL SELECT 'cocktails',            COUNT(*) FROM cocktails
    UNION ALL SELECT 'cocktail_categories',  COUNT(*) FROM cocktail_categories
    UNION ALL SELECT 'mocktails',            COUNT(*) FROM mocktails
    UNION ALL SELECT 'mocktail_categories',  COUNT(*) FROM mocktail_categories
    UNION ALL SELECT 'app_settings',         COUNT(*) FROM app_settings
    UNION ALL SELECT 'blog_posts',           COUNT(*) FROM blog_posts
    UNION ALL SELECT 'thumbtack_leads',      COUNT(*) FROM thumbtack_leads
    UNION ALL SELECT 'thumbtack_messages',   COUNT(*) FROM thumbtack_messages
    UNION ALL SELECT 'thumbtack_reviews',    COUNT(*) FROM thumbtack_reviews
    UNION ALL SELECT 'email_campaigns',      COUNT(*) FROM email_campaigns
    UNION ALL SELECT 'email_sequence_steps', COUNT(*) FROM email_sequence_steps
  ) a ON a.t=b.t AND a.n<>b.n;
  IF drift IS NOT NULL
  THEN RAISE EXCEPTION 'untouched tables changed: %', drift; END IF;

  RAISE NOTICE 'prelaunch-data-scrub: all asserts passed';
END $$;

COMMIT;

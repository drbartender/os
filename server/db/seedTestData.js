const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const bcrypt = require('bcryptjs');
const { pool } = require('./index');

async function seedTestData() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const hash = await bcrypt.hash('TestPass123!', 12);

    // ─── STAFF in different onboarding stages ────────────────────────

    // 1. Staff who just created account (in_progress)
    const { rows: [staff1] } = await client.query(`
      INSERT INTO users (email, password_hash, role, onboarding_status)
      VALUES ('jake.rivers@test.com', $1, 'staff', 'in_progress')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id
    `, [hash]);
    await client.query(`
      INSERT INTO onboarding_progress (user_id, account_created, last_completed_step)
      VALUES ($1, true, 'account_created')
      ON CONFLICT (user_id) DO NOTHING
    `, [staff1.id]);

    // 2. Staff who completed field guide
    const { rows: [staff2] } = await client.query(`
      INSERT INTO users (email, password_hash, role, onboarding_status)
      VALUES ('maria.santos@test.com', $1, 'staff', 'in_progress')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id
    `, [hash]);
    await client.query(`
      INSERT INTO onboarding_progress (user_id, account_created, welcome_viewed, field_guide_completed, last_completed_step)
      VALUES ($1, true, true, true, 'field_guide_completed')
      ON CONFLICT (user_id) DO NOTHING
    `, [staff2.id]);

    // 3. Staff fully onboarded (approved)
    const { rows: [staff3] } = await client.query(`
      INSERT INTO users (email, password_hash, role, onboarding_status)
      VALUES ('tony.kim@test.com', $1, 'staff', 'approved')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id
    `, [hash]);
    await client.query(`
      INSERT INTO onboarding_progress (user_id, account_created, welcome_viewed, field_guide_completed,
        agreement_completed, contractor_profile_completed, payday_protocols_completed, onboarding_completed, last_completed_step)
      VALUES ($1, true, true, true, true, true, true, true, 'onboarding_completed')
      ON CONFLICT (user_id) DO NOTHING
    `, [staff3.id]);
    await client.query(`
      INSERT INTO contractor_profiles (user_id, preferred_name, phone, email, city, state, travel_distance,
        reliable_transportation, equipment_portable_bar, equipment_cooler, lat, lng, hire_date)
      VALUES ($1, 'Tony', '3125551234', 'tony.kim@test.com', 'Chicago', 'IL', '30 miles',
        'yes', true, true, 41.8781, -87.6298, '2025-06-01')
      ON CONFLICT (user_id) DO NOTHING
    `, [staff3.id]);
    await client.query(`
      INSERT INTO agreements (user_id, full_name, email, phone, sms_consent, acknowledged_field_guide,
        agreed_non_solicitation, signature_data, signature_method, signed_at)
      VALUES ($1, 'Tony Kim', 'tony.kim@test.com', '3125551234', true, true, true, 'data:image/png;base64,test', 'draw', NOW())
      ON CONFLICT (user_id) DO NOTHING
    `, [staff3.id]);
    await client.query(`
      INSERT INTO payment_profiles (user_id, preferred_payment_method, payment_username)
      VALUES ($1, 'venmo', '@tony-kim')
      ON CONFLICT (user_id) DO NOTHING
    `, [staff3.id]);

    // 4. Another approved staff (for shift assignments)
    const { rows: [staff4] } = await client.query(`
      INSERT INTO users (email, password_hash, role, onboarding_status)
      VALUES ('lisa.chen@test.com', $1, 'staff', 'approved')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id
    `, [hash]);
    await client.query(`
      INSERT INTO onboarding_progress (user_id, account_created, welcome_viewed, field_guide_completed,
        agreement_completed, contractor_profile_completed, payday_protocols_completed, onboarding_completed, last_completed_step)
      VALUES ($1, true, true, true, true, true, true, true, 'onboarding_completed')
      ON CONFLICT (user_id) DO NOTHING
    `, [staff4.id]);
    await client.query(`
      INSERT INTO contractor_profiles (user_id, preferred_name, phone, email, city, state, travel_distance,
        reliable_transportation, equipment_portable_bar, equipment_table_with_spandex, lat, lng, hire_date)
      VALUES ($1, 'Lisa', '7735559876', 'lisa.chen@test.com', 'Naperville', 'IL', '50 miles',
        'yes', true, true, 41.7508, -88.1535, '2025-03-15')
      ON CONFLICT (user_id) DO NOTHING
    `, [staff4.id]);
    await client.query(`
      INSERT INTO agreements (user_id, full_name, email, phone, sms_consent, acknowledged_field_guide,
        agreed_non_solicitation, signature_data, signature_method, signed_at)
      VALUES ($1, 'Lisa Chen', 'lisa.chen@test.com', '7735559876', true, true, true, 'data:image/png;base64,test', 'draw', NOW())
      ON CONFLICT (user_id) DO NOTHING
    `, [staff4.id]);
    await client.query(`
      INSERT INTO payment_profiles (user_id, preferred_payment_method, payment_username)
      VALUES ($1, 'zelle', 'lisa.chen@test.com')
      ON CONFLICT (user_id) DO NOTHING
    `, [staff4.id]);

    // 5. Deactivated staff
    await client.query(`
      INSERT INTO users (email, password_hash, role, onboarding_status)
      VALUES ('mark.jones@test.com', $1, 'staff', 'deactivated')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id
    `, [hash]);

    console.log('  ✓ 5 staff members (various onboarding stages)');

    // ─── APPLICANTS in different stages ──────────────────────────────

    // Applicant 1: Just applied
    const { rows: [app1] } = await client.query(`
      INSERT INTO users (email, password_hash, role, onboarding_status)
      VALUES ('sam.williams@test.com', $1, 'staff', 'applied')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id
    `, [hash]);
    await client.query(`
      INSERT INTO applications (user_id, full_name, phone, city, state, travel_distance,
        reliable_transportation, positions_interested, has_bartending_experience,
        bartending_experience_description, why_dr_bartender, setup_confidence)
      VALUES ($1, 'Sam Williams', '3125557777', 'Evanston', 'IL', '20 miles',
        'yes', 'bartender', true,
        '2 years at a craft cocktail bar downtown', 'Love the brand and want to grow with the team', 4)
      ON CONFLICT (user_id) DO NOTHING
    `, [app1.id]);

    // Applicant 2: Interviewing
    const { rows: [app2] } = await client.query(`
      INSERT INTO users (email, password_hash, role, onboarding_status)
      VALUES ('rachel.green@test.com', $1, 'staff', 'interviewing')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id
    `, [hash]);
    await client.query(`
      INSERT INTO applications (user_id, full_name, phone, city, state, travel_distance,
        reliable_transportation, positions_interested, has_bartending_experience,
        bartending_experience_description, why_dr_bartender, setup_confidence,
        comfortable_working_alone, customer_service_approach)
      VALUES ($1, 'Rachel Green', '8475553333', 'Oak Park', 'IL', '30 miles',
        'yes', 'bartender,barback', true,
        '5 years experience including weddings and corporate events',
        'I want to bring creativity and professionalism to every event', 5,
        'yes', 'Always greet with a smile, anticipate needs, and make every guest feel like a VIP')
      ON CONFLICT (user_id) DO NOTHING
    `, [app2.id]);
    // Add an interview note
    const adminResult = await client.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
    const adminId = adminResult.rows[0]?.id;
    if (adminId) {
      await client.query(`
        INSERT INTO interview_notes (user_id, admin_id, note, note_type)
        VALUES ($1, $2, 'Great phone screen. Very personable, strong cocktail knowledge. Scheduling in-person.', 'note')
      `, [app2.id, adminId]);
    }

    // Applicant 3: Rejected
    const { rows: [app3] } = await client.query(`
      INSERT INTO users (email, password_hash, role, onboarding_status)
      VALUES ('dave.miller@test.com', $1, 'staff', 'rejected')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id
    `, [hash]);
    await client.query(`
      INSERT INTO applications (user_id, full_name, phone, city, state, travel_distance,
        reliable_transportation, positions_interested, has_bartending_experience,
        why_dr_bartender, setup_confidence)
      VALUES ($1, 'Dave Miller', '3125552222', 'Milwaukee', 'WI', '10 miles',
        'no', 'bartender', false,
        'Saw an ad online', 2)
      ON CONFLICT (user_id) DO NOTHING
    `, [app3.id]);

    // Applicant 4: Another fresh applicant
    const { rows: [app4] } = await client.query(`
      INSERT INTO users (email, password_hash, role, onboarding_status)
      VALUES ('nina.patel@test.com', $1, 'staff', 'applied')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id
    `, [hash]);
    await client.query(`
      INSERT INTO applications (user_id, full_name, phone, city, state, travel_distance,
        reliable_transportation, positions_interested, has_bartending_experience,
        bartending_experience_description, why_dr_bartender, setup_confidence,
        tools_mixing_tins, tools_strainer, tools_bar_spoon, tools_ice_scoop)
      VALUES ($1, 'Nina Patel', '6305554444', 'Aurora', 'IL', '40 miles',
        'yes', 'bartender,server', true,
        'Bartended at private events for 3 years, BASSET certified',
        'Looking for flexible event work that values quality', 4,
        true, true, true, true)
      ON CONFLICT (user_id) DO NOTHING
    `, [app4.id]);

    console.log('  ✓ 4 applicants (applied, interviewing, rejected, applied)');

    // ─── CLIENTS ─────────────────────────────────────────────────────

    const { rows: [client1] } = await client.query(`
      INSERT INTO clients (name, email, phone, source, notes)
      VALUES ('Sarah & Mike Thompson', 'sarah.thompson@test.com', '3125550101', 'website', 'Wedding couple, June 2026. Very organized.')
      ON CONFLICT ON CONSTRAINT clients_pkey DO NOTHING
      RETURNING id
    `);
    const { rows: [client2] } = await client.query(`
      INSERT INTO clients (name, email, phone, source, notes)
      VALUES ('Acme Corp - Jennifer Walsh', 'jwalsh@acmecorp.test.com', '3125550202', 'referral', 'Annual corporate holiday party. Budget ~$5k.')
      ON CONFLICT ON CONSTRAINT clients_pkey DO NOTHING
      RETURNING id
    `);
    const { rows: [client3] } = await client.query(`
      INSERT INTO clients (name, email, phone, source, notes)
      VALUES ('Diego Ramirez', 'diego.r@test.com', '7735550303', 'thumbtack', '40th birthday party')
      ON CONFLICT ON CONSTRAINT clients_pkey DO NOTHING
      RETURNING id
    `);
    const { rows: [client4] } = await client.query(`
      INSERT INTO clients (name, email, phone, source, notes)
      VALUES ('Priya Sharma', 'priya.sharma@test.com', '8475550404', 'direct', 'Baby shower, wants mocktail bar only')
      ON CONFLICT ON CONSTRAINT clients_pkey DO NOTHING
      RETURNING id
    `);
    const { rows: [client5] } = await client.query(`
      INSERT INTO clients (name, email, phone, source, notes)
      VALUES ('The Lincoln Park Community Center', 'events@lpcc.test.com', '3125550505', 'website', 'Non-profit fundraiser gala')
      ON CONFLICT ON CONSTRAINT clients_pkey DO NOTHING
      RETURNING id
    `);

    console.log('  ✓ 5 clients');

    // ─── GET PACKAGE IDS ─────────────────────────────────────────────

    const pkgResult = await client.query(`SELECT id, slug FROM service_packages`);
    const pkgs = {};
    pkgResult.rows.forEach(r => { pkgs[r.slug] = r.id; });

    // ─── PROPOSALS in different statuses ─────────────────────────────

    // Proposal 1: Draft (wedding)
    if (client1) {
      await client.query(`
        INSERT INTO proposals (client_id, event_name, event_date, event_start_time, event_duration_hours,
          event_location, guest_count, package_id, num_bars, num_bartenders, total_price, status,
          pricing_snapshot, created_by)
        VALUES ($1, 'Thompson Wedding Reception', '2026-06-20', '5:00 PM', 5,
          '1234 Lakeview Blvd, Chicago, IL 60614', 150, $2, 2, 2, 4950.00, 'draft',
          '{"package_total":3300,"bartender_total":600,"bar_fee_total":150,"addon_total":900}',
          $3)
        RETURNING id
      `, [client1.id, pkgs['the-midrange-reaction'], adminId]);
    }

    // Proposal 2: Sent (corporate)
    if (client2) {
      const { rows: [p2] } = await client.query(`
        INSERT INTO proposals (client_id, event_name, event_date, event_start_time, event_duration_hours,
          event_location, guest_count, package_id, num_bars, num_bartenders, total_price, status,
          pricing_snapshot, created_by)
        VALUES ($1, 'Acme Corp Holiday Party', '2026-12-12', '7:00 PM', 4,
          '500 N Michigan Ave, Chicago, IL 60611', 100, $2, 1, 1, 2800.00, 'sent',
          '{"package_total":2200,"bartender_total":0,"bar_fee_total":50,"addon_total":550}',
          $3)
        RETURNING id
      `, [client2.id, pkgs['the-enhanced-solution'], adminId]);
      await client.query(`
        INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
        VALUES ($1, 'sent', 'admin', $2, '{"method":"email"}')
      `, [p2.id, adminId]);
    }

    // Proposal 3: Accepted + deposit paid (birthday)
    if (client3) {
      const { rows: [p3] } = await client.query(`
        INSERT INTO proposals (client_id, event_name, event_date, event_start_time, event_duration_hours,
          event_location, guest_count, package_id, num_bars, num_bartenders, total_price, status,
          amount_paid, deposit_amount, payment_type, view_count,
          client_signed_name, client_signed_at, client_signature_method,
          pricing_snapshot, created_by)
        VALUES ($1, 'Diego''s 40th Birthday Bash', '2026-07-18', '8:00 PM', 4,
          '2200 W Fullerton Ave, Chicago, IL 60647', 60, $2, 1, 1, 1380.00, 'deposit_paid',
          100.00, 100.00, 'deposit', 5,
          'Diego Ramirez', NOW() - INTERVAL '3 days', 'type',
          '{"package_total":1380,"bartender_total":0,"bar_fee_total":50,"addon_total":0}',
          $3)
        RETURNING id
      `, [client3.id, pkgs['the-midrange-reaction'], adminId]);
      await client.query(`
        INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
        VALUES ($1, 'sent', 'admin', '{"method":"email"}'),
               ($1, 'viewed', 'client', '{}'),
               ($1, 'accepted', 'client', '{}'),
               ($1, 'deposit_paid', 'system', '{"amount":10000}')
      `, [p3.id]);
      await client.query(`
        INSERT INTO proposal_payments (proposal_id, payment_type, amount, status)
        VALUES ($1, 'deposit', 10000, 'succeeded')
      `, [p3.id]);
      // Create a shift linked to this proposal
      await client.query(`
        INSERT INTO shifts (event_name, event_date, start_time, end_time, location,
          positions_needed, status, proposal_id, created_by)
        VALUES ('Diego''s 40th Birthday Bash', '2026-07-18', '8:00 PM', '12:00 AM',
          '2200 W Fullerton Ave, Chicago, IL 60647',
          $1, 'open', $2, $3)
      `, [JSON.stringify([{ position: 'bartender', count: 1 }]), p3.id, adminId]);
    }

    // Proposal 4: Confirmed / balance paid (mocktail bar)
    if (client4) {
      const { rows: [p4] } = await client.query(`
        INSERT INTO proposals (client_id, event_name, event_date, event_start_time, event_duration_hours,
          event_location, guest_count, package_id, num_bars, num_bartenders, total_price, status,
          amount_paid, deposit_amount, payment_type, view_count,
          client_signed_name, client_signed_at, client_signature_method,
          pricing_snapshot, created_by)
        VALUES ($1, 'Priya''s Baby Shower', '2026-05-10', '2:00 PM', 3,
          '890 Elm St, Winnetka, IL 60093', 40, $2, 1, 1, 720.00, 'confirmed',
          720.00, 100.00, 'deposit', 8,
          'Priya Sharma', NOW() - INTERVAL '14 days', 'draw',
          '{"package_total":720,"bartender_total":0,"bar_fee_total":50,"addon_total":0}',
          $3)
        RETURNING id
      `, [client4.id, pkgs['the-clear-reaction'], adminId]);
      await client.query(`
        INSERT INTO proposal_payments (proposal_id, payment_type, amount, status)
        VALUES ($1, 'deposit', 10000, 'succeeded'),
               ($1, 'balance', 62000, 'succeeded')
      `, [p4.id]);
      // Create a shift with an assigned bartender
      const { rows: [shift4] } = await client.query(`
        INSERT INTO shifts (event_name, event_date, start_time, end_time, location,
          positions_needed, status, proposal_id, created_by)
        VALUES ('Priya''s Baby Shower', '2026-05-10', '2:00 PM', '5:00 PM',
          '890 Elm St, Winnetka, IL 60093',
          $1, 'confirmed', $2, $3)
        RETURNING id
      `, [JSON.stringify([{ position: 'bartender', count: 1 }]), p4.id, adminId]);
      await client.query(`
        INSERT INTO shift_requests (shift_id, user_id, position, status)
        VALUES ($1, $2, 'bartender', 'approved')
      `, [shift4.id, staff3.id]);
    }

    // Proposal 5: Viewed but not accepted (fundraiser gala)
    if (client5) {
      const { rows: [p5] } = await client.query(`
        INSERT INTO proposals (client_id, event_name, event_date, event_start_time, event_duration_hours,
          event_location, guest_count, package_id, num_bars, num_bartenders, total_price, status,
          view_count, last_viewed_at,
          pricing_snapshot, created_by)
        VALUES ($1, 'Lincoln Park Fundraiser Gala', '2026-09-05', '6:00 PM', 5,
          '2045 N Lincoln Park West, Chicago, IL 60614', 200, $2, 2, 3, 10800.00, 'viewed',
          3, NOW() - INTERVAL '1 day',
          '{"package_total":8000,"bartender_total":1200,"bar_fee_total":250,"addon_total":1350}',
          $3)
        RETURNING id
      `, [client5.id, pkgs['the-grand-experiment'], adminId]);
      await client.query(`
        INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
        VALUES ($1, 'sent', 'admin', '{"method":"email"}'),
               ($1, 'viewed', 'client', '{}'),
               ($1, 'viewed', 'client', '{}'),
               ($1, 'viewed', 'client', '{}')
      `, [p5.id]);
    }

    console.log('  ✓ 5 proposals (draft, sent, deposit_paid, confirmed, viewed)');

    // ─── EXTRA SHIFTS (standalone, not linked to proposals) ──────────

    const { rows: [shift1] } = await client.query(`
      INSERT INTO shifts (event_name, event_date, start_time, end_time, location,
        positions_needed, status, created_by)
      VALUES ('Smith Anniversary Party', '2026-05-24', '6:00 PM', '10:00 PM',
        '1500 W Division St, Chicago, IL 60642',
        $1, 'open', $2)
      RETURNING id
    `, [JSON.stringify([{ position: 'bartender', count: 2 }]), adminId]);
    // Staff3 requested this shift
    await client.query(`
      INSERT INTO shift_requests (shift_id, user_id, position, status)
      VALUES ($1, $2, 'bartender', 'pending')
    `, [shift1.id, staff3.id]);
    // Staff4 also requested
    await client.query(`
      INSERT INTO shift_requests (shift_id, user_id, position, status)
      VALUES ($1, $2, 'bartender', 'pending')
    `, [shift1.id, staff4.id]);

    await client.query(`
      INSERT INTO shifts (event_name, event_date, start_time, end_time, location,
        positions_needed, status, created_by)
      VALUES ('Completed: Johnson Graduation', '2026-03-15', '3:00 PM', '7:00 PM',
        '500 S State St, Chicago, IL 60605',
        $1, 'confirmed', $2)
    `, [JSON.stringify([{ position: 'bartender', count: 1 }]), adminId]);

    console.log('  ✓ 2 standalone shifts');

    // ─── DRINK PLANS ─────────────────────────────────────────────────

    await client.query(`
      INSERT INTO drink_plans (client_name, client_email, event_name, event_date, status,
        serving_type, selections, submitted_at)
      VALUES ('Diego Ramirez', 'diego.r@test.com', 'Diego''s 40th Birthday Bash', '2026-07-18',
        'submitted', 'full_bar',
        '{"cocktails":["margarita","old-fashioned","moscow-mule"],"mocktails":["virgin-mojito"]}',
        NOW() - INTERVAL '2 days')
    `);
    await client.query(`
      INSERT INTO drink_plans (client_name, client_email, event_name, event_date, status,
        serving_type, selections)
      VALUES ('Sarah Thompson', 'sarah.thompson@test.com', 'Thompson Wedding Reception', '2026-06-20',
        'pending', 'full_bar', '{}')
    `);

    console.log('  ✓ 2 drink plans (submitted, pending)');

    await client.query('COMMIT');
    console.log('\n✅ Test data seeded successfully!');
    console.log('   All test accounts use password: TestPass123!');
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed error:', err);
    process.exit(1);
  }
}

seedTestData();

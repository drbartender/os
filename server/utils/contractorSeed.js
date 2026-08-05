const { refreshDisplayName } = require('./refreshDisplayName');

/**
 * Seed (or update) a contractor_profiles row from the user's applications row.
 *
 * Used by:
 *   - PUT /api/admin/users/:id/status  (admin "Hire" button — application exists)
 *   - POST /api/application            (pre_hired flow — flips status to 'hired' on submit)
 *
 * Idempotent: ON CONFLICT updates existing fields except hire_date, which is
 * preserved when already set (re-hire / status-toggle case). Pass `existingHireDate`
 * to keep an earlier hire date; pass null for a fresh hire (defaults to CURRENT_DATE).
 *
 * Must be called inside a transaction (caller owns the client).
 *
 * KEEP IN SYNC WITH schema.sql contractor_profiles + PUT /api/admin/users/:id/profile.
 */
async function seedContractorProfileFromApplication(client, userId, existingHireDate = null) {
  // Captured BEFORE the upsert (same transaction client): the upsert below
  // overwrites preferred_name from the application, and refreshDisplayName
  // needs the prior value to decide whether the §3.5 review stamp must clear.
  const prevRes = await client.query(
    'SELECT preferred_name FROM contractor_profiles WHERE user_id = $1', [userId]
  );
  const prevPreferredName = prevRes.rows[0]?.preferred_name ?? null;

  await client.query(`
    INSERT INTO contractor_profiles (
      user_id, preferred_name, phone, email, birth_month, birth_day, birth_year,
      street_address, city, state, zip_code,
      travel_distance, reliable_transportation,
      equipment_portable_bar, equipment_cooler, equipment_table_with_spandex,
      equipment_none_but_open, equipment_no_space,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
      alcohol_certification_file_url, alcohol_certification_filename,
      resume_file_url, resume_filename,
      headshot_file_url, headshot_filename,
      hire_date
    )
    SELECT
      u.id, a.full_name, a.phone, u.email, a.birth_month, a.birth_day, a.birth_year,
      a.street_address, a.city, a.state, a.zip_code,
      a.travel_distance, a.reliable_transportation,
      COALESCE(a.equipment_portable_bar, false), COALESCE(a.equipment_cooler, false),
      COALESCE(a.equipment_table_with_spandex, false), COALESCE(a.equipment_none_but_open, false),
      COALESCE(a.equipment_no_space, false),
      a.emergency_contact_name, a.emergency_contact_phone, a.emergency_contact_relationship,
      a.basset_file_url, a.basset_filename,
      a.resume_file_url, a.resume_filename,
      a.headshot_file_url, a.headshot_filename,
      COALESCE($2::date, CURRENT_DATE)
    FROM users u
    JOIN applications a ON a.user_id = u.id
    WHERE u.id = $1
    ON CONFLICT (user_id) DO UPDATE SET
      preferred_name = EXCLUDED.preferred_name,
      phone = EXCLUDED.phone,
      email = EXCLUDED.email,
      birth_month = EXCLUDED.birth_month,
      birth_day = EXCLUDED.birth_day,
      birth_year = EXCLUDED.birth_year,
      street_address = EXCLUDED.street_address,
      city = EXCLUDED.city,
      state = EXCLUDED.state,
      zip_code = EXCLUDED.zip_code,
      travel_distance = EXCLUDED.travel_distance,
      reliable_transportation = EXCLUDED.reliable_transportation,
      equipment_portable_bar = EXCLUDED.equipment_portable_bar,
      equipment_cooler = EXCLUDED.equipment_cooler,
      equipment_table_with_spandex = EXCLUDED.equipment_table_with_spandex,
      equipment_none_but_open = EXCLUDED.equipment_none_but_open,
      equipment_no_space = EXCLUDED.equipment_no_space,
      emergency_contact_name = EXCLUDED.emergency_contact_name,
      emergency_contact_phone = EXCLUDED.emergency_contact_phone,
      emergency_contact_relationship = EXCLUDED.emergency_contact_relationship,
      -- Documents: never let a NULL from the application erase one already on
      -- the profile. Same protective shape as hire_date below.
      --
      -- These were a plain EXCLUDED assignment while POST /api/application refused any
      -- submission missing a resume or certification, which guaranteed the
      -- application columns were non-null whenever this ran for a pre-hire.
      -- Once a pre-hire may submit without files (2026-07-26), that guarantee is
      -- gone: a pre-hire who uploads at /contractor-profile first (RequireHired
      -- admits 'in_progress') and then submits a fileless application had both
      -- documents destroyed here, and was then told by the outstanding-documents
      -- notice to re-upload what they had already uploaded.
      --
      -- COALESCE per column is safe because every writer sets each url/filename
      -- pair together; splitting them would otherwise strand a URL with a null
      -- filename. This also closes the pre-existing headshot case, which could
      -- always be wiped because a headshot was always optional.
      alcohol_certification_file_url = COALESCE(EXCLUDED.alcohol_certification_file_url, contractor_profiles.alcohol_certification_file_url),
      alcohol_certification_filename = COALESCE(EXCLUDED.alcohol_certification_filename, contractor_profiles.alcohol_certification_filename),
      resume_file_url = COALESCE(EXCLUDED.resume_file_url, contractor_profiles.resume_file_url),
      resume_filename = COALESCE(EXCLUDED.resume_filename, contractor_profiles.resume_filename),
      headshot_file_url = COALESCE(EXCLUDED.headshot_file_url, contractor_profiles.headshot_file_url),
      headshot_filename = COALESCE(EXCLUDED.headshot_filename, contractor_profiles.headshot_filename),
      -- Preserve any existing hire_date over EXCLUDED. Callers pass the
      -- previous hire_date explicitly via $2 to keep re-hires anchored to
      -- the original date; if a caller forgets, fall back to the row's
      -- existing value before defaulting to CURRENT_DATE. This makes the
      -- helper internally robust against future misuse.
      hire_date = COALESCE(EXCLUDED.hire_date, contractor_profiles.hire_date, CURRENT_DATE)
  `, [userId, existingHireDate]);

  // ONE call, here rather than in the callers. All three of them (the admin Hire
  // path, the pre-hired application submit, the register-with-application path)
  // are covered by this, and all three hold their own transaction, so the
  // caller's client is threaded through instead of a second pool checkout.
  //
  // previousPreferredName is passed because the upsert above is a real
  // preferred_name WRITER (preferred_name = EXCLUDED.preferred_name, sourced
  // from the application's full_name) — in fact the one writer that always
  // can change the name. Without it, a re-hire that overwrites a reviewed
  // "Tony" back to the legal "Anthony" would keep the old review stamp and
  // revert the person's client-facing name with no notice ever raised.
  await refreshDisplayName(userId, client, { previousPreferredName: prevPreferredName });
}

module.exports = { seedContractorProfileFromApplication };

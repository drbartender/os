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
      alcohol_certification_file_url = EXCLUDED.alcohol_certification_file_url,
      alcohol_certification_filename = EXCLUDED.alcohol_certification_filename,
      resume_file_url = EXCLUDED.resume_file_url,
      resume_filename = EXCLUDED.resume_filename,
      headshot_file_url = EXCLUDED.headshot_file_url,
      headshot_filename = EXCLUDED.headshot_filename,
      -- Preserve any existing hire_date over EXCLUDED. Callers pass the
      -- previous hire_date explicitly via $2 to keep re-hires anchored to
      -- the original date; if a caller forgets, fall back to the row's
      -- existing value before defaulting to CURRENT_DATE. This makes the
      -- helper internally robust against future misuse.
      hire_date = COALESCE(EXCLUDED.hire_date, contractor_profiles.hire_date, CURRENT_DATE)
  `, [userId, existingHireDate]);
}

module.exports = { seedContractorProfileFromApplication };

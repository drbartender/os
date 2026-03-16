-- Dr. Bartender Onboarding Database Schema

-- Updated timestamp trigger function (must be defined before any triggers use it)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'staff' CHECK (role IN ('staff', 'admin')),
  onboarding_status VARCHAR(50) DEFAULT 'in_progress',
  notifications_opt_in BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Expand status constraint to include application statuses
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_onboarding_status_check;
ALTER TABLE users ADD CONSTRAINT users_onboarding_status_check
  CHECK (onboarding_status IN ('in_progress','applied','interviewing','hired','rejected','submitted','reviewed','approved','deactivated'));

CREATE TABLE IF NOT EXISTS onboarding_progress (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  account_created BOOLEAN DEFAULT true,
  welcome_viewed BOOLEAN DEFAULT false,
  field_guide_completed BOOLEAN DEFAULT false,
  agreement_completed BOOLEAN DEFAULT false,
  contractor_profile_completed BOOLEAN DEFAULT false,
  payday_protocols_completed BOOLEAN DEFAULT false,
  onboarding_completed BOOLEAN DEFAULT false,
  last_completed_step VARCHAR(50) DEFAULT 'account_created',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contractor_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  preferred_name VARCHAR(255),
  phone VARCHAR(50),
  email VARCHAR(255),
  birth_month INTEGER CHECK (birth_month BETWEEN 1 AND 12),
  birth_day INTEGER CHECK (birth_day BETWEEN 1 AND 31),
  birth_year INTEGER CHECK (birth_year BETWEEN 1900 AND 2010),
  city VARCHAR(255),
  state VARCHAR(100),
  travel_distance VARCHAR(50),
  reliable_transportation VARCHAR(20),
  equipment_portable_bar BOOLEAN DEFAULT false,
  equipment_cooler BOOLEAN DEFAULT false,
  equipment_table_with_spandex BOOLEAN DEFAULT false,
  equipment_none_but_open BOOLEAN DEFAULT false,
  equipment_no_space BOOLEAN DEFAULT false,
  alcohol_certification_file_url VARCHAR(500),
  alcohol_certification_filename VARCHAR(255),
  resume_file_url VARCHAR(500),
  resume_filename VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add new columns to contractor_profiles for integrated application data
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS street_address VARCHAR(500);
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS zip_code VARCHAR(20);
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS emergency_contact_name VARCHAR(255);
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS emergency_contact_phone VARCHAR(50);
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS emergency_contact_relationship VARCHAR(100);
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS headshot_file_url VARCHAR(500);
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS headshot_filename VARCHAR(255);

CREATE TABLE IF NOT EXISTS agreements (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  full_name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(50),
  sms_consent BOOLEAN DEFAULT false,
  acknowledged_field_guide BOOLEAN DEFAULT false,
  agreed_non_solicitation BOOLEAN DEFAULT false,
  signature_data TEXT,
  signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  preferred_payment_method VARCHAR(100),
  payment_username VARCHAR(255),
  routing_number VARCHAR(20),
  account_number VARCHAR(30),
  w9_file_url VARCHAR(500),
  w9_filename VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add Direct Deposit columns to existing deployments
ALTER TABLE payment_profiles ADD COLUMN IF NOT EXISTS routing_number VARCHAR(20);
ALTER TABLE payment_profiles ADD COLUMN IF NOT EXISTS account_number VARCHAR(30);

-- Applications table (replaces Google Form)
CREATE TABLE IF NOT EXISTS applications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  full_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  favorite_color VARCHAR(100),
  -- Address
  street_address VARCHAR(500),
  city VARCHAR(255) NOT NULL,
  state VARCHAR(100) NOT NULL,
  zip_code VARCHAR(20),
  -- DOB (for 21+ age validation)
  birth_month INTEGER CHECK (birth_month BETWEEN 1 AND 12),
  birth_day INTEGER CHECK (birth_day BETWEEN 1 AND 31),
  birth_year INTEGER CHECK (birth_year BETWEEN 1900 AND 2010),
  -- Travel
  travel_distance VARCHAR(50) NOT NULL,
  reliable_transportation VARCHAR(20) NOT NULL,
  -- Experience
  has_bartending_experience BOOLEAN DEFAULT false,
  bartending_experience_description TEXT,
  last_bartending_time VARCHAR(50),
  experience_types TEXT,
  positions_interested TEXT NOT NULL,
  -- Availability
  available_saturdays VARCHAR(20),
  other_commitments VARCHAR(255),
  -- Bar tools
  tools_none_will_start BOOLEAN DEFAULT false,
  tools_mixing_tins BOOLEAN DEFAULT false,
  tools_strainer BOOLEAN DEFAULT false,
  tools_ice_scoop BOOLEAN DEFAULT false,
  tools_bar_spoon BOOLEAN DEFAULT false,
  tools_tongs BOOLEAN DEFAULT false,
  tools_ice_bin BOOLEAN DEFAULT false,
  tools_bar_mats BOOLEAN DEFAULT false,
  tools_bar_towels BOOLEAN DEFAULT false,
  -- Equipment
  equipment_portable_bar BOOLEAN DEFAULT false,
  equipment_cooler BOOLEAN DEFAULT false,
  equipment_table_with_spandex BOOLEAN DEFAULT false,
  equipment_none_but_open BOOLEAN DEFAULT false,
  equipment_no_space BOOLEAN DEFAULT false,
  -- Skills
  setup_confidence INTEGER CHECK (setup_confidence BETWEEN 1 AND 5),
  comfortable_working_alone VARCHAR(20),
  customer_service_approach TEXT,
  why_dr_bartender TEXT NOT NULL,
  additional_info TEXT,
  -- Emergency Contact
  emergency_contact_name VARCHAR(255),
  emergency_contact_phone VARCHAR(50),
  emergency_contact_relationship VARCHAR(100),
  -- Files
  resume_file_url VARCHAR(500),
  resume_filename VARCHAR(255),
  headshot_file_url VARCHAR(500),
  headshot_filename VARCHAR(255),
  basset_file_url VARCHAR(500),
  basset_filename VARCHAR(255),
  --
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Interview notes (admin can add multiple notes per applicant)
CREATE TABLE IF NOT EXISTS interview_notes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  admin_id INTEGER REFERENCES users(id),
  note TEXT NOT NULL,
  note_type VARCHAR(20) DEFAULT 'note',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Add note_type to existing deployments
ALTER TABLE interview_notes ADD COLUMN IF NOT EXISTS note_type VARCHAR(20) DEFAULT 'note';

-- Add bartending years to applications
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bartending_years VARCHAR(50);

-- ─── Manager / Permissions support ───────────────────────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('staff', 'admin', 'manager'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_hire BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_staff BOOLEAN DEFAULT false;

-- ─── Shifts ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  event_name VARCHAR(255) NOT NULL,
  event_date DATE NOT NULL,
  start_time VARCHAR(50),
  end_time VARCHAR(50),
  location VARCHAR(500),
  positions_needed TEXT DEFAULT '[]',
  notes TEXT,
  status VARCHAR(20) DEFAULT 'open',
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_shifts_updated_at ON shifts;
CREATE TRIGGER update_shifts_updated_at BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Shift Requests ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shift_requests (
  id SERIAL PRIMARY KEY,
  shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  position VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(shift_id, user_id)
);

DROP TRIGGER IF EXISTS update_shift_requests_updated_at ON shift_requests;
CREATE TRIGGER update_shift_requests_updated_at BEFORE UPDATE ON shift_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_onboarding_progress_updated_at ON onboarding_progress;
CREATE TRIGGER update_onboarding_progress_updated_at BEFORE UPDATE ON onboarding_progress
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_contractor_profiles_updated_at ON contractor_profiles;
CREATE TRIGGER update_contractor_profiles_updated_at BEFORE UPDATE ON contractor_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_agreements_updated_at ON agreements;
CREATE TRIGGER update_agreements_updated_at BEFORE UPDATE ON agreements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_payment_profiles_updated_at ON payment_profiles;
CREATE TRIGGER update_payment_profiles_updated_at BEFORE UPDATE ON payment_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_applications_updated_at ON applications;
CREATE TRIGGER update_applications_updated_at BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Drink Plans (client questionnaire) ─────────────────────────
CREATE TABLE IF NOT EXISTS drink_plans (
  id SERIAL PRIMARY KEY,
  token UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  client_name VARCHAR(255),
  client_email VARCHAR(255),
  event_name VARCHAR(255),
  event_date DATE,
  status VARCHAR(20) DEFAULT 'pending'
    CHECK (status IN ('pending','draft','submitted','reviewed')),
  serving_type VARCHAR(100),
  selections JSONB DEFAULT '{}',
  admin_notes TEXT,
  created_by INTEGER REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_drink_plans_updated_at ON drink_plans;
CREATE TRIGGER update_drink_plans_updated_at BEFORE UPDATE ON drink_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Cocktail Menu ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cocktail_categories (
  id VARCHAR(100) PRIMARY KEY,
  label VARCHAR(255) NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cocktails (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  category_id VARCHAR(100) REFERENCES cocktail_categories(id) ON DELETE SET NULL,
  emoji VARCHAR(20),
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_cocktail_categories_updated_at ON cocktail_categories;
CREATE TRIGGER update_cocktail_categories_updated_at BEFORE UPDATE ON cocktail_categories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_cocktails_updated_at ON cocktails;
CREATE TRIGGER update_cocktails_updated_at BEFORE UPDATE ON cocktails
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

INSERT INTO cocktail_categories (id, label, sort_order) VALUES
  ('crowd-favorites',  'Crowd Favorites',    1),
  ('light-refreshing', 'Light & Refreshing', 2),
  ('classic',          'Classic',            3),
  ('bold',             'Bold',               4),
  ('bartenders-picks', 'Bartender''s Picks', 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO cocktails (id, name, category_id, emoji, description, sort_order) VALUES
  ('vodka-berry-lemonade','Berry Vodka Lemonade','crowd-favorites','🍓','Bright vodka lemonade with mixed berries and a pop of pink.',1),
  ('moscow-mule','Moscow Mule','crowd-favorites','🫙','Vodka, ginger beer, and lime — crisp and refreshing.',2),
  ('margarita','Margarita','crowd-favorites','🍋','Tequila, lime, and orange liqueur — balanced and citrusy.',3),
  ('espresso-martini','Espresso Martini','crowd-favorites','☕','Vodka and espresso with a smooth, velvety finish.',4),
  ('old-fashioned','Old Fashioned','crowd-favorites','🥃','Whiskey with sugar and bitters — bold and timeless.',5),
  ('cosmopolitan','Cosmopolitan','light-refreshing','🍸','Vodka, cranberry, and a splash of citrus — bright and balanced.',1),
  ('aperol-spritz','Aperol Spritz','light-refreshing','🍊','Aperol, prosecco, and soda — light, bubbly, and bittersweet.',2),
  ('paloma','Paloma','light-refreshing','🌸','Tequila and grapefruit soda — refreshing with a citrus bite.',3),
  ('mojito','Mojito','light-refreshing','🌿','Rum, mint, lime, and soda — cool and herbaceous.',4),
  ('french-75','French 75','light-refreshing','🥂','Gin, lemon, and champagne — elegant and effervescent.',5),
  ('daiquiri','Daiquiri','classic','🍹','Rum, lime, and simple syrup — a perfectly balanced classic.',1),
  ('sidecar','Sidecar','classic','🍋','Cognac, orange liqueur, and lemon — rich and smooth.',2),
  ('martini','Martini','classic','🍸','Gin or vodka with dry vermouth — timeless sophistication.',3),
  ('manhattan','Manhattan','classic','🍒','Whiskey, sweet vermouth, and bitters — deep and aromatic.',4),
  ('negroni','Negroni','classic','🔴','Gin, Campari, and sweet vermouth — bitter and complex.',5),
  ('amaretto-sour','Amaretto Sour','bold','🌰','Amaretto and citrus with a foamy top — nutty and smooth.',1),
  ('smokey-pina','Smokey Piña','bold','🍍','Mezcal, pineapple, and lime — tropical with a smoky kick.',2),
  ('boulevardier','Boulevardier','bold','🥃','Bourbon, Campari, and sweet vermouth — a whiskey Negroni.',3),
  ('black-manhattan','Black Manhattan','bold','🖤','Bourbon and amaro — dark, rich, and herbal.',4),
  ('sazerac','Sazerac','bold','⚜️','Rye, absinthe rinse, and Peychaud''s bitters — a New Orleans legend.',5),
  ('whiskey-sour','Whiskey Sour','bartenders-picks','🍋','Bourbon, lemon, and simple — classic with optional egg white.',1),
  ('mai-tai','Mai Tai','bartenders-picks','🌺','Rum, orgeat, and citrus — tropical and layered.',2),
  ('paper-plane','Paper Plane','bartenders-picks','✈️','Bourbon, Aperol, Amaro, and lemon — equal parts perfection.',3),
  ('corpse-reviver','Corpse Reviver No. 2','bartenders-picks','💀','Gin, Lillet, Cointreau, lemon, and absinthe — hauntingly good.',4),
  ('last-word','Last Word','bartenders-picks','🟢','Gin, green Chartreuse, maraschino, and lime — herbaceous and bold.',5)
ON CONFLICT (id) DO NOTHING;

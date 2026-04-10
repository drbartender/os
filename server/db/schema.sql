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
  signature_method VARCHAR(10),
  signature_ip VARCHAR(45),
  signature_user_agent TEXT,
  signature_document_version VARCHAR(50),
  signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE agreements ADD COLUMN IF NOT EXISTS signature_method VARCHAR(10);
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS signature_ip VARCHAR(45);
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS signature_user_agent TEXT;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS signature_document_version VARCHAR(50);

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
  admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_token UUID UNIQUE DEFAULT gen_random_uuid();
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_token_created_at TIMESTAMPTZ DEFAULT NOW();

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

-- proposal_id FK moved after CREATE TABLE proposals (see below)

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
    CHECK (status IN ('pending','draft','exploration_saved','submitted','reviewed')),
  exploration_submitted_at TIMESTAMPTZ,
  serving_type VARCHAR(100),
  selections JSONB DEFAULT '{}',
  admin_notes TEXT,
  proposal_id INTEGER,  -- FK added after CREATE TABLE proposals (see below)
  created_by INTEGER REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- proposal_id FK added after CREATE TABLE proposals (see below)

-- Migrations for existing tables
ALTER TABLE drink_plans ADD COLUMN IF NOT EXISTS exploration_submitted_at TIMESTAMPTZ;
ALTER TABLE drink_plans DROP CONSTRAINT IF EXISTS drink_plans_status_check;
ALTER TABLE drink_plans ADD CONSTRAINT drink_plans_status_check
  CHECK (status IN ('pending', 'draft', 'exploration_saved', 'submitted', 'reviewed'));

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

-- Add base_spirit column (idempotent)
ALTER TABLE cocktails ADD COLUMN IF NOT EXISTS base_spirit VARCHAR(100);

-- Add ingredients column for shopping list generation (idempotent)
ALTER TABLE cocktails ADD COLUMN IF NOT EXISTS ingredients JSONB DEFAULT '[]';

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
  ('whiskey-sour','Whiskey Sour','bartenders-picks','🍋','Bourbon, lemon, and simple — classic with optional egg white or blackberry.',1),
  ('mai-tai','Mai Tai','bartenders-picks','🌺','Rum, orgeat, and citrus — tropical and layered.',2),
  ('paper-plane','Paper Plane','bartenders-picks','✈️','Bourbon, Aperol, Amaro, and lemon — equal parts perfection.',3),
  ('corpse-reviver','Corpse Reviver No. 2','bartenders-picks','💀','Gin, Lillet, Cointreau, lemon, and absinthe — hauntingly good.',4),
  ('last-word','Last Word','bartenders-picks','🟢','Gin, green Chartreuse, maraschino, and lime — herbaceous and bold.',5)
ON CONFLICT (id) DO NOTHING;

-- Backfill base_spirit for existing cocktails
UPDATE cocktails SET base_spirit = CASE id
  WHEN 'vodka-berry-lemonade' THEN 'Vodka'
  WHEN 'moscow-mule'          THEN 'Vodka'
  WHEN 'margarita'             THEN 'Tequila'
  WHEN 'espresso-martini'      THEN 'Vodka'
  WHEN 'old-fashioned'         THEN 'Whiskey'
  WHEN 'cosmopolitan'          THEN 'Vodka'
  WHEN 'aperol-spritz'         THEN 'Aperol'
  WHEN 'paloma'                THEN 'Tequila'
  WHEN 'mojito'                THEN 'Rum'
  WHEN 'french-75'             THEN 'Gin'
  WHEN 'daiquiri'              THEN 'Rum'
  WHEN 'sidecar'               THEN 'Cognac'
  WHEN 'martini'               THEN 'Gin'
  WHEN 'manhattan'             THEN 'Whiskey'
  WHEN 'negroni'               THEN 'Gin'
  WHEN 'amaretto-sour'         THEN 'Amaretto'
  WHEN 'smokey-pina'           THEN 'Mezcal'
  WHEN 'boulevardier'          THEN 'Whiskey'
  WHEN 'black-manhattan'       THEN 'Whiskey'
  WHEN 'sazerac'               THEN 'Whiskey'
  WHEN 'whiskey-sour'          THEN 'Whiskey'
  WHEN 'mai-tai'               THEN 'Rum'
  WHEN 'paper-plane'           THEN 'Whiskey'
  WHEN 'corpse-reviver'        THEN 'Gin'
  WHEN 'last-word'             THEN 'Gin'
END
WHERE base_spirit IS NULL;

-- ─── Mocktail Menu ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mocktail_categories (
  id VARCHAR(100) PRIMARY KEY,
  label VARCHAR(255) NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mocktails (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  category_id VARCHAR(100) REFERENCES mocktail_categories(id) ON DELETE SET NULL,
  emoji VARCHAR(20),
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_mocktail_categories_updated_at ON mocktail_categories;
CREATE TRIGGER update_mocktail_categories_updated_at BEFORE UPDATE ON mocktail_categories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_mocktails_updated_at ON mocktails;
CREATE TRIGGER update_mocktails_updated_at BEFORE UPDATE ON mocktails
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

INSERT INTO mocktail_categories (id, label, sort_order) VALUES
  ('fruity-refreshing',  'Fruity & Refreshing',  1),
  ('creamy-sweet',       'Creamy & Sweet',        2),
  ('sparkling-light',    'Sparkling & Light',     3),
  ('bold-complex',       'Bold & Complex',        4)
ON CONFLICT (id) DO NOTHING;

INSERT INTO mocktails (id, name, category_id, emoji, description, sort_order) VALUES
  ('virgin-mojito',             'Virgin Mojito',              'fruity-refreshing', '🌿', 'Fresh mint, lime, and soda — cool and herbaceous, no rum needed.', 1),
  ('strawberry-basil-lemonade', 'Strawberry Basil Lemonade',  'fruity-refreshing', '🍓', 'Sweet strawberry meets fresh basil in a tangy lemonade.', 2),
  ('tropical-sunrise',          'Tropical Sunrise',           'fruity-refreshing', '🌅', 'Mango, orange, and grenadine layered like a sunset.', 3),
  ('mango-tango',               'Mango Tango',                'fruity-refreshing', '🥭', 'Ripe mango blended with lime and a hint of chili.', 4),
  ('virgin-pina-colada',        'Virgin Piña Colada',         'creamy-sweet',      '🍍', 'Creamy coconut and pineapple — tropical paradise in a glass.', 1),
  ('shirley-temple-deluxe',     'Shirley Temple Deluxe',      'creamy-sweet',      '🍒', 'Classic grenadine and ginger ale with a cherry twist.', 2),
  ('lavender-cream-soda',       'Lavender Cream Soda',        'creamy-sweet',      '💜', 'Floral lavender syrup with vanilla cream soda.', 3),
  ('chocolate-mint-shake',      'Chocolate Mint Shake',        'creamy-sweet',      '🍫', 'Rich chocolate and cool mint blended to perfection.', 4),
  ('cucumber-spritz',           'Cucumber Spritz',            'sparkling-light',   '🥒', 'Muddled cucumber, elderflower, and sparkling water.', 1),
  ('elderflower-fizz',          'Elderflower Fizz',           'sparkling-light',   '🌼', 'Elderflower cordial with soda and a squeeze of lemon.', 2),
  ('ginger-peach-sparkler',     'Ginger Peach Sparkler',      'sparkling-light',   '🍑', 'Fresh peach purée with spicy ginger and bubbles.', 3),
  ('citrus-cooler',             'Citrus Cooler',              'sparkling-light',   '🍊', 'A blend of orange, lemon, and lime with sparkling water.', 4),
  ('virgin-espresso-tonic',     'Virgin Espresso Tonic',      'bold-complex',      '☕', 'Chilled espresso over tonic water — bold and surprising.', 1),
  ('spiced-cider-mule',         'Spiced Apple Cider Mule',    'bold-complex',      '🍎', 'Apple cider, ginger beer, and warm spices.', 2),
  ('hibiscus-ginger-punch',     'Hibiscus Ginger Punch',      'bold-complex',      '🌺', 'Tart hibiscus tea with fresh ginger and honey.', 3),
  ('smoky-pineapple-sour',      'Smoky Pineapple Sour',       'bold-complex',      '🍍', 'Charred pineapple juice with lemon and smoked salt rim.', 4)
ON CONFLICT (id) DO NOTHING;

-- ─── Service Packages (proposal pricing) ────────────────────────────

CREATE TABLE IF NOT EXISTS service_packages (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(50) NOT NULL CHECK (category IN ('byob', 'hosted')),
  pricing_type VARCHAR(20) DEFAULT 'flat' CHECK (pricing_type IN ('flat', 'per_guest')),
  base_rate_3hr NUMERIC(10,2),
  base_rate_4hr NUMERIC(10,2),
  extra_hour_rate NUMERIC(10,2),
  min_guests INTEGER DEFAULT 50,
  base_rate_3hr_small NUMERIC(10,2),
  base_rate_4hr_small NUMERIC(10,2),
  extra_hour_rate_small NUMERIC(10,2),
  bartenders_included INTEGER DEFAULT 1,
  guests_per_bartender INTEGER DEFAULT 100,
  extra_bartender_hourly NUMERIC(10,2) DEFAULT 40,
  first_bar_fee NUMERIC(10,2) DEFAULT 50,
  additional_bar_fee NUMERIC(10,2) DEFAULT 100,
  includes JSONB DEFAULT '[]',
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  min_total NUMERIC(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS min_total NUMERIC(10,2);

DROP TRIGGER IF EXISTS update_service_packages_updated_at ON service_packages;
CREATE TRIGGER update_service_packages_updated_at BEFORE UPDATE ON service_packages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS bar_type VARCHAR(50) DEFAULT 'full_bar' CHECK (bar_type IN ('full_bar', 'beer_and_wine', 'mocktail', 'service_only', 'class'));

INSERT INTO service_packages (slug, name, description, category, pricing_type, base_rate_3hr, base_rate_4hr, extra_hour_rate, min_guests, base_rate_3hr_small, base_rate_4hr_small, extra_hour_rate_small, bartenders_included, bar_type, min_total, includes, sort_order) VALUES
  ('the-core-reaction', 'The Core Reaction', 'Service-only. Built to flex. Our most budget-friendly Dry Lab setup. You provide the alcohol and supplies — or grab exactly what we recommend from our customized shopping list. We show up with the know-how, the setup, and the steady hands.', 'byob', 'flat',
    NULL, 350, 100, NULL, NULL, NULL, NULL, 1, 'service_only', NULL,
    '["{bartenders} professional bartender{bartenders_s}","Setup & breakdown","Cooler","Bar tools + clean service layout","Menu planning session","Precise, event-specific alcohol shopping list","Bespoke menu graphic","$2 million liquor liability insurance"]', 1),
  ('the-doctors-orders', 'The Doctor''s Orders', 'Our signature Mixology Lab. Stir, shake, and serve with flair. This hands-on session includes everything you need to learn and create — shakers, tools, mixers, juices, garnishes — everything but the liquor.', 'byob', 'flat',
    300, NULL, 100, NULL, NULL, NULL, NULL, 1, 'class', NULL,
    '["{bartenders} professional instructor{bartenders_s}","Setup & breakdown","Cooler","Menu planning session","Precise alcohol shopping list","Custom menu graphic","Digital Curriculum (recipes & instructions)","Up to {hours} hours of service","$2 million liquor liability insurance"]', 2),
  ('the-base-compound', 'The Base Compound', 'Minimal inputs. Maximum efficiency. A stripped-down formula ideal for casual environments and efficient service — delivering a solid range without experimental overload.', 'hosted', 'per_guest',
    NULL, 18, 5, 50, NULL, 23, 5, 1, 'full_bar', 500,
    '["Two Signature Cocktails — Pre-formulated in our lab for rapid, reliable deployment","Miller Lite","Michelob Ultra","One Red Wine — balanced, medium-bodied","One White Wine — bright and approachable","Bottled Water","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 3),
  ('the-midrange-reaction', 'The Midrange Reaction', 'More variables. Still controlled. This formula expands the spirit selection and mixer profile, offering crowd-pleasing flexibility while staying efficient and focused. Ideal for weddings, milestone events, and hosts who want to level up without losing control of the experiment.', 'hosted', 'per_guest',
    NULL, 22, 6, 50, NULL, 27, 6, 1, 'full_bar', 600,
    '["Svedka Vodka","New Amsterdam Gin","Bacardi Superior Rum","Jim Beam Bourbon","Margaritaville Tequila","Dewar''s Scotch","Miller Lite, Michelob Ultra","One Red Wine, One White Wine","Coke, Diet Coke, Sprite","Soda Water & Tonic","Cranberry, Orange & Pineapple Juices","Bottled Water","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 4),
  ('the-enhanced-solution', 'The Enhanced Solution', 'Refined inputs. Amplified output. Premium spirits with expanded modifiers.', 'hosted', 'per_guest',
    NULL, 28, 8, 50, NULL, 33, 8, 1, 'full_bar', 700,
    '["Six premium spirits","Three beers","Four wines","Sparkling wine","Expanded mixers/modifiers including bitters and citrus juices","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 5),
  ('formula-no-5', 'Formula No. 5', 'Precision over excess. Five spirits. Fully dialed. This tier is about clean lines, deliberate choices, and confident pours. Premium ingredients, zero clutter. A high-end setup for hosts who want quality without overstock.', 'hosted', 'per_guest',
    NULL, 33, 9, 50, NULL, 39, 9, 1, 'full_bar', 850,
    '["Grey Goose Vodka","Hendrick''s Gin","Appleton Estate Rum","Casamigos Tequila","Bulleit Bourbon","Stella Artois","One Red Wine & One White Wine","Coke, Diet Coke, Sprite","Ginger Ale, Soda, Tonic","Orange, Cranberry & Pineapple Juices","Simple Syrup & Bitters","Bottled Water","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 6),
  ('the-grand-experiment', 'The Grand Experiment', 'No corners cut. No questions unanswered. Apex formula with celebrated spirits and comprehensive bar experience.', 'hosted', 'per_guest',
    NULL, 40, 11.25, 50, NULL, 46, 11.25, 1, 'full_bar', 1000,
    '["Nine spirits","Three beers","Four premium wines","Sparkling wine","Craft beer selection","Full mixer/modifier range including fresh citrus","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 7),
  ('the-clear-reaction', 'The Clear Reaction', 'Mocktail Bar. Perfect for corporate, baby showers, religious/cultural events, or sober-curious crowds.', 'hosted', 'per_guest',
    NULL, 14, 4, 50, NULL, 18, 4, 1, 'mocktail', 400,
    '["3-4 signature mocktail recipes","All mixers, garnishes, syrups","Premium presentation","Full bar setup","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 8),
  ('the-primary-culture', 'The Primary Culture', 'Bare Bones. Fully Functional. A simple yet stable foundation. Great for casual parties and backyard weddings where beer and wine get the job done.', 'hosted', 'per_guest',
    NULL, 12, 4, 50, NULL, 17, 4, 1, 'beer_and_wine', 400,
    '["Miller Lite","Michelob Ultra","One Red Wine & One White Wine","Infused Water Station — citrus, cucumber, or herbs depending on season","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 9),
  ('the-refined-reaction', 'The Refined Reaction', 'A polished experiment in crowd-pleasing sophistication. Still streamlined, but with a noticeable bump in quality — perfect for weddings, cocktail hours, and milestone celebrations.', 'hosted', 'per_guest',
    NULL, 14, 5, 50, NULL, 19, 5, 1, 'beer_and_wine', 400,
    '["Stella Artois","Corona Extra","One Red & One White Wine","Sparkling Wine","Bottled Water","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 10),
  ('the-carbon-suspension', 'The Carbon Suspension', 'Expanded range. Zero pretense. For bigger crowds or events that need a little more variety — without drifting into fancy territory. Balanced. Approachable. Ready to pour.', 'hosted', 'per_guest',
    NULL, 15, 5.75, 50, NULL, 20, 5.75, 1, 'beer_and_wine', 425,
    '["Miller Lite","Michelob Ultra","Yuengling Lager","Rotating Seltzer flavors","Two Red Wines & Two White Wines","Bottled Water","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 11),
  ('the-cultivated-complex', 'The Cultivated Complex', 'Curated elegance. Lab-certified crowd-pleaser. Designed for hosts who want elevated beer and wine service with enough sparkle, variety, and quality to make it feel like the full experience — minus the liquor cabinet.', 'hosted', 'per_guest',
    NULL, 17, 6.25, 50, NULL, 22, 6.25, 1, 'beer_and_wine', 450,
    '["Miller Lite","Michelob Ultra","Yuengling Lager","Two Rotating Craft or Local Beers","Seasonal Seltzer","Two Premium Red Wines & Two Premium White Wines","Sparkling Wine","Bottled Water","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 12)
ON CONFLICT (slug) DO UPDATE SET
  description = EXCLUDED.description,
  bar_type = EXCLUDED.bar_type,
  min_total = EXCLUDED.min_total,
  includes = EXCLUDED.includes;

-- ─── Service Add-ons ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS service_addons (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  billing_type VARCHAR(20) NOT NULL CHECK (billing_type IN ('per_guest', 'per_hour', 'flat', 'per_guest_timed', 'per_staff', 'per_100_guests')),
  rate NUMERIC(10,2) NOT NULL,
  extra_hour_rate NUMERIC(10,2),
  applies_to VARCHAR(20) DEFAULT 'all' CHECK (applies_to IN ('byob', 'hosted', 'all')),
  is_default BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE service_addons ADD COLUMN IF NOT EXISTS minimum_hours NUMERIC(4,1);
ALTER TABLE service_addons ADD COLUMN IF NOT EXISTS category VARCHAR(50);
ALTER TABLE service_addons ADD COLUMN IF NOT EXISTS requires_addon_slug VARCHAR(100);

DROP TRIGGER IF EXISTS update_service_addons_updated_at ON service_addons;
CREATE TRIGGER update_service_addons_updated_at BEFORE UPDATE ON service_addons
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

INSERT INTO service_addons (slug, name, description, billing_type, rate, extra_hour_rate, applies_to, sort_order) VALUES
  ('the-foundation', 'The Foundation', 'Ice delivery, bottled water service, premium cups, napkins, stir sticks. No mixers, no garnishes.', 'per_guest_timed', 3.00, 0.75, 'byob', 1),
  ('the-formula', 'The Formula', 'Everything in The Foundation plus mixers for signature cocktails, basic garnishes, simple syrup, bitters.', 'per_guest_timed', 5.50, 1.25, 'byob', 2),
  ('the-full-compound', 'The Full Compound', 'Everything in The Foundation plus complete mixer selection, premium garnish package, simple syrup, bitters.', 'per_guest_timed', 8.00, 2.00, 'byob', 3),
  ('ice-delivery-only', 'Ice Delivery', 'Ice delivery for the event.', 'per_guest', 2.00, NULL, 'byob', 4),
  ('cups-disposables-only', 'Cups & Disposables', 'Premium cups, napkins, stir sticks, straws.', 'per_guest', 1.50, NULL, 'byob', 5),
  ('bottled-water-only', 'Bottled Water', 'Bottled water service.', 'per_guest', 0.50, NULL, 'byob', 6),
  ('signature-mixers-only', 'Signature Mixers', 'Mixers for signature cocktails only. Does not include Foundation items.', 'per_guest', 2.00, NULL, 'byob', 7),
  ('full-mixers-only', 'Full Mixers', 'Complete mixer selection. Does not include Foundation items.', 'per_guest', 4.50, NULL, 'byob', 8),
  ('garnish-package-only', 'Garnish Package', 'Premium garnish package (lemons, limes, oranges, cherries, olives).', 'per_100_guests', 50.00, NULL, 'byob', 9),
  ('champagne-toast', 'Champagne Toast', 'Champagne toast for all guests.', 'per_guest', 2.50, NULL, 'all', 10),
  ('soft-drink-addon', 'Soft Drink Add-On', 'Soft drinks for all guests.', 'per_guest', 3.00, NULL, 'all', 20),
  ('pre-batched-mocktail', 'Pre-Batched Mocktail', 'A pre-batched non-alcoholic cocktail ready to pour. Great for events where you want a sophisticated NA option without the complexity of a full mocktail bar. Add more for variety.', 'per_guest', 1.50, NULL, 'all', 21),
  ('mocktail-bar', 'Mocktail Bar', 'Full mocktail bar with signature recipes.', 'per_guest_timed', 7.50, 2.00, 'all', 22),
  ('banquet-server', 'Banquet Server', 'Professional banquet server.', 'per_hour', 75.00, NULL, 'all', 41),
  ('flavor-blaster-rental', 'Flavor Blaster Rental', 'Flavor blaster equipment rental.', 'flat', 150.00, NULL, 'all', 35),
  ('handcrafted-syrups', 'Handcrafted Syrups', 'Single 750ml bottle of handcrafted syrup.', 'flat', 30.00, NULL, 'all', 30),
  ('handcrafted-syrups-3pack', 'Handcrafted Syrups 3-Pack', 'Three 750ml bottles of handcrafted syrups.', 'flat', 75.00, NULL, 'all', 31),
  ('parking-fee', 'Parking Fee', 'Parking fee per staff member.', 'per_staff', 20.00, NULL, 'all', 51)
ON CONFLICT (slug) DO NOTHING;

-- New add-ons (April 2026)
INSERT INTO service_addons (slug, name, description, billing_type, rate, extra_hour_rate, applies_to, sort_order, minimum_hours, category, requires_addon_slug) VALUES
  ('champagne-coupe-upgrade', 'Coupe Glass Upgrade', 'Upgrade your champagne toast from disposable flutes to real coupe glasses.', 'per_guest', 2.00, NULL, 'all', 11, NULL, 'premium', 'champagne-toast'),
  ('real-glassware', 'Real Glassware Upgrade', 'Elevate your event with actual glassware instead of plastic. Includes rocks glasses, coupes, and stemless wine glasses. Delivery, setup, bar-side rinse station, and takeaway included.', 'per_guest', 5.00, NULL, 'all', 12, NULL, 'premium', NULL),
  ('house-made-ginger-beer', 'House-Made Ginger Beer', 'Fresh-pressed ginger, citrus, and cane sugar, carbonated live at the bar. A craft upgrade for Moscow Mules, Dark ''n'' Stormys, or enjoyed on its own. Made to order for your event, never from a can.', 'per_guest', 2.50, NULL, 'all', 32, NULL, 'craft_ingredients', NULL),
  ('carbonated-cocktails', 'Carbonated Cocktails', 'Select up to 2 signature carbonated cocktails, made to order with fresh carbonation at the bar. Available alongside your regular menu.', 'per_guest', 2.00, NULL, 'all', 33, NULL, 'craft_ingredients', NULL),
  ('smoked-cocktail-kit', 'Smoked Cocktail Kit', 'We bring the torch and wood chips to smoke cocktails on demand at the bar. Available for any drink your guests want, but pairs especially well with Old Fashioneds, whiskey cocktails, and darker spirits.', 'flat', 75.00, NULL, 'all', 34, NULL, 'craft_ingredients', NULL),
  ('barback', 'Barback', 'Dedicated support to keep the bar running smoothly. Handles restocking, ice runs, bussing, cleanup, and general bar maintenance so your bartender never has to leave the station. Ideal for high-volume events or multi-bar setups. Gratuity included.', 'per_hour', 75.00, NULL, 'all', 40, 4, 'staffing', NULL),
  ('additional-bartender', 'Additional Bartender', 'Request an extra bartender beyond what your guest count requires. We recommend 1 bartender per 100 guests, but you can add more for faster service or multiple bar stations.', 'per_hour', 40.00, NULL, 'all', 42, NULL, 'staffing', NULL)
ON CONFLICT (slug) DO NOTHING;

-- Set categories on existing add-ons
UPDATE service_addons SET category = 'byob_support' WHERE slug IN ('the-foundation','the-formula','the-full-compound','ice-delivery-only','cups-disposables-only','bottled-water-only','signature-mixers-only','full-mixers-only');
UPDATE service_addons SET category = 'premium' WHERE slug IN ('champagne-toast');
UPDATE service_addons SET category = 'beverage' WHERE slug IN ('soft-drink-addon','pre-batched-mocktail','mocktail-bar');
UPDATE service_addons SET category = 'craft_ingredients' WHERE slug IN ('handcrafted-syrups','handcrafted-syrups-3pack','house-made-ginger-beer','carbonated-cocktails','smoked-cocktail-kit','flavor-blaster-rental');
UPDATE service_addons SET category = 'staffing' WHERE slug IN ('banquet-server','barback');
UPDATE service_addons SET category = 'byob_support' WHERE slug = 'garnish-package-only';
UPDATE service_addons SET category = 'logistics' WHERE slug = 'parking-fee';

-- Update prices to match spec
UPDATE service_addons SET rate = 3.50 WHERE slug = 'soft-drink-addon';
UPDATE service_addons SET rate = 2.00 WHERE slug = 'pre-batched-mocktail';

-- Update descriptions to match spec
UPDATE service_addons SET description = 'Ice delivery, bottled water service, and premium cups and napkins. The essential bar setup for BYOB events. No mixers or garnishes included. Straws available upon request.' WHERE slug = 'the-foundation';
UPDATE service_addons SET description = 'Everything in The Foundation, plus mixers and garnishes for your signature cocktails, along with simple syrup and bitters. Covers a standard signature menu.' WHERE slug = 'the-formula';
UPDATE service_addons SET description = 'Everything in The Foundation, plus our complete mixer selection (all sodas, tonics, and juices) and premium garnish package (lemons, limes, oranges, cherries, olives). Gives your bartender the flexibility to craft any classic cocktail on request. Garnishes included for up to 75 guests; add $50 for 76+ guests.' WHERE slug = 'the-full-compound';
UPDATE service_addons SET description = 'All the ice you need for drinks and chilling, delivered directly to your venue. Includes both cubed ice for drinks and ice for keeping bottles cold.' WHERE slug = 'ice-delivery-only';
UPDATE service_addons SET description = 'Premium clear plastic cups, cocktail napkins. Everything your guests need for a polished bar experience without the hassle of glassware. Straws available upon request.' WHERE slug = 'cups-disposables-only';
UPDATE service_addons SET description = 'Individual bottled water for your guests. Easier and more sanitary than a water station, and guests can take them on the go.' WHERE slug = 'bottled-water-only';
UPDATE service_addons SET description = 'Add a celebratory champagne toast to your event with champagne and disposable flutes. Perfect for weddings, anniversaries, or any milestone moment. We coordinate the toast timing with your event flow.' WHERE slug = 'champagne-toast';
UPDATE service_addons SET description = 'A simpler mocktail option — one pre-batched non-alcoholic cocktail that is ready to pour. Great for events where you want a sophisticated NA option without the complexity of a full mocktail bar.' WHERE slug = 'pre-batched-mocktail';
UPDATE service_addons SET description = 'For designated drivers, kids, and anyone skipping the spirits but still sipping. Includes Coke, Diet Coke, Sprite, OJ, cranberry juice, pineapple juice, soda water, tonic water, and grenadine. Required for hosted parties expecting more than 10 non-drinkers.' WHERE slug = 'soft-drink-addon';
UPDATE service_addons SET description = 'Add a dedicated mocktail menu to your bar service. We craft sophisticated non-alcoholic cocktails with the same care and presentation as our regular cocktails — premium juices, house-made syrups, fresh garnishes, unique sodas, and flavor infusions. Available with all hosted packages and BYOB packages with The Formula or The Full Compound.' WHERE slug = 'mocktail-bar';
UPDATE service_addons SET description = 'Professional server to circulate drinks, bus glasses, assist with setup/breakdown, maintain buffet stations, handle drop-off catering, or provide additional hospitality support. Great for cocktail hours, tray-passed service, or events where you want white-glove attention to detail. 4-hour minimum per server. Gratuity included.' WHERE slug = 'banquet-server';
UPDATE service_addons SET description = 'A showstopper. We top your cocktails with aromatic flavor bubbles that burst with fragrance right as your guests take their first sip. Includes all supplies and a trained bartender who knows how to put on a show. Works best paired with Real Glassware Upgrade.' WHERE slug = 'flavor-blaster-rental';
UPDATE service_addons SET description = 'Housemade cocktail syrups crafted with real ingredients. Choose from over 25 flavors across fruit, heat, botanical, and specialty categories. Each 750ml bottle makes approximately 30-40 cocktails.' WHERE slug = 'handcrafted-syrups';
UPDATE service_addons SET description = 'Three bottles at a savings. Mix and match any flavors from our full syrup menu.' WHERE slug = 'handcrafted-syrups-3pack';
UPDATE service_addons SET description = 'Lemons, limes, oranges, cherries, and olives — everything your bartender needs to garnish properly.' WHERE slug = 'garnish-package-only';
UPDATE service_addons SET description = 'Covers parking costs when your venue charges for staff parking or is in a metered/paid parking area. Applied per staff member working your event (bartenders, barbacks, servers).' WHERE slug = 'parking-fee';
UPDATE service_addons SET description = 'A pre-batched non-alcoholic cocktail ready to pour. Great for events where you want a sophisticated NA option without the complexity of a full mocktail bar. Add more for variety.' WHERE slug = 'pre-batched-mocktail';

-- Rename à la carte items (remove "Only") and fix mocktail name
UPDATE service_addons SET name = 'Ice Delivery' WHERE slug = 'ice-delivery-only';
UPDATE service_addons SET name = 'Cups & Disposables' WHERE slug = 'cups-disposables-only';
UPDATE service_addons SET name = 'Bottled Water' WHERE slug = 'bottled-water-only';
UPDATE service_addons SET name = 'Signature Mixers' WHERE slug = 'signature-mixers-only';
UPDATE service_addons SET name = 'Full Mixers' WHERE slug = 'full-mixers-only';
UPDATE service_addons SET name = 'Garnish Package' WHERE slug = 'garnish-package-only';
UPDATE service_addons SET name = 'Pre-Batched Mocktail' WHERE slug = 'pre-batched-mocktail';

-- Banquet server: 4-hour minimum
UPDATE service_addons SET minimum_hours = 4 WHERE slug = 'banquet-server';

-- Widen billing_type constraint for new types
ALTER TABLE service_addons DROP CONSTRAINT IF EXISTS service_addons_billing_type_check;
ALTER TABLE service_addons ADD CONSTRAINT service_addons_billing_type_check
  CHECK (billing_type IN ('per_guest', 'per_hour', 'flat', 'per_guest_timed', 'per_staff', 'per_100_guests'));

-- Parking: per staff member ($20/staff)
UPDATE service_addons SET billing_type = 'per_staff' WHERE slug = 'parking-fee';

-- Garnish: per 100 guests ($50/100 guests)
UPDATE service_addons SET billing_type = 'per_100_guests' WHERE slug = 'garnish-package-only';

-- ─── Clients ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  source VARCHAR(50) DEFAULT 'direct' CHECK (source IN ('direct', 'thumbtack', 'referral', 'website')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_clients_updated_at ON clients;
CREATE TRIGGER update_clients_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Proposals ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS proposals (
  id SERIAL PRIMARY KEY,
  token UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  event_name VARCHAR(255),
  event_date DATE,
  event_start_time VARCHAR(20),
  event_duration_hours NUMERIC(4,1) NOT NULL DEFAULT 4,
  event_location TEXT,
  guest_count INTEGER NOT NULL DEFAULT 50,
  package_id INTEGER REFERENCES service_packages(id),
  num_bars INTEGER DEFAULT 1,
  num_bartenders INTEGER,
  pricing_snapshot JSONB NOT NULL DEFAULT '{}',
  total_price NUMERIC(10,2),
  status VARCHAR(30) DEFAULT 'draft'
    CHECK (status IN ('draft','sent','viewed','modified','accepted','deposit_paid','confirmed')),
  last_viewed_at TIMESTAMPTZ,
  view_count INTEGER DEFAULT 0,
  admin_notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_proposals_updated_at ON proposals;
CREATE TRIGGER update_proposals_updated_at BEFORE UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Deferred FKs: shifts & drink_plans → proposals ────────────────
-- These were deferred because shifts and drink_plans are created before proposals.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_shifts_proposal_id ON shifts(proposal_id);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'drink_plans_proposal_id_fkey' AND table_name = 'drink_plans'
  ) THEN
    ALTER TABLE drink_plans ADD CONSTRAINT drink_plans_proposal_id_fkey
      FOREIGN KEY (proposal_id) REFERENCES proposals(id);
  END IF;
END $$;

-- ─── Proposal Add-ons ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS proposal_addons (
  id SERIAL PRIMARY KEY,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE CASCADE,
  addon_id INTEGER REFERENCES service_addons(id),
  addon_name VARCHAR(255),
  billing_type VARCHAR(20),
  rate NUMERIC(10,2),
  quantity INTEGER,
  line_total NUMERIC(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(proposal_id, addon_id)
);

-- ─── Proposal Activity Log ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS proposal_activity_log (
  id SERIAL PRIMARY KEY,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL,
  actor_type VARCHAR(20) DEFAULT 'system',
  actor_id INTEGER,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Proposal Client Signature ─────────────────────────────────────

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS client_signed_name VARCHAR(255);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS client_signature_data TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS client_signed_at TIMESTAMPTZ;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS client_signature_method VARCHAR(10);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS client_signature_ip VARCHAR(45);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS client_signature_user_agent TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS client_signature_document_version VARCHAR(50);

-- ─── Stripe Payment Sessions ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS stripe_sessions (
  id SERIAL PRIMARY KEY,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE CASCADE,
  stripe_payment_intent_id VARCHAR(255) UNIQUE,
  stripe_payment_link_id VARCHAR(255),
  amount INTEGER DEFAULT 10000,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Proposal Payment Options & Autopay ──────────────────────────

ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_status_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_status_check
  CHECK (status IN ('draft','sent','viewed','modified','accepted','deposit_paid','balance_paid','confirmed','completed'));

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS payment_type VARCHAR(20) DEFAULT 'deposit';
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS autopay_enrolled BOOLEAN DEFAULT false;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS stripe_payment_method_id VARCHAR(255);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(10,2) DEFAULT 100.00;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(10,2) DEFAULT 0;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS balance_due_date DATE;

-- Drop old check if it exists from initial CREATE TABLE, then re-add with payment_type
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'proposals' AND constraint_name = 'proposals_payment_type_check'
  ) THEN
    ALTER TABLE proposals ADD CONSTRAINT proposals_payment_type_check
      CHECK (payment_type IN ('deposit', 'full'));
  END IF;
END $$;

-- ─── Proposal Payments (tracks individual payment records) ───────

CREATE TABLE IF NOT EXISTS proposal_payments (
  id SERIAL PRIMARY KEY,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE CASCADE,
  stripe_payment_intent_id VARCHAR(255),
  payment_type VARCHAR(20) NOT NULL CHECK (payment_type IN ('deposit', 'balance', 'full')),
  amount INTEGER NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Performance Indexes ─────────────────────────────────────────

-- Users
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_onboarding_status ON users(onboarding_status);

-- Applications
CREATE INDEX IF NOT EXISTS idx_applications_user_id ON applications(user_id);

-- Contractor Profiles
CREATE INDEX IF NOT EXISTS idx_contractor_profiles_user_id ON contractor_profiles(user_id);

-- Agreements
CREATE INDEX IF NOT EXISTS idx_agreements_user_id ON agreements(user_id);

-- Payment Profiles
CREATE INDEX IF NOT EXISTS idx_payment_profiles_user_id ON payment_profiles(user_id);

-- Interview Notes
CREATE INDEX IF NOT EXISTS idx_interview_notes_user_id ON interview_notes(user_id);

-- Proposals
CREATE INDEX IF NOT EXISTS idx_proposals_client_id ON proposals(client_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_token ON proposals(token);
CREATE INDEX IF NOT EXISTS idx_proposals_created_by ON proposals(created_by);
CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON proposals(created_at);

-- Proposal Activity Log
CREATE INDEX IF NOT EXISTS idx_proposal_activity_log_proposal_id ON proposal_activity_log(proposal_id);

-- Proposal Payments
CREATE INDEX IF NOT EXISTS idx_proposal_payments_proposal_id ON proposal_payments(proposal_id);

-- Shifts
CREATE INDEX IF NOT EXISTS idx_shifts_event_date ON shifts(event_date);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);
CREATE INDEX IF NOT EXISTS idx_shifts_created_by ON shifts(created_by);

-- Shift Requests
CREATE INDEX IF NOT EXISTS idx_shift_requests_shift_id ON shift_requests(shift_id);
CREATE INDEX IF NOT EXISTS idx_shift_requests_user_id ON shift_requests(user_id);

-- ─── SMS Messages ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_messages (
  id SERIAL PRIMARY KEY,
  group_id UUID NOT NULL DEFAULT gen_random_uuid(),
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recipient_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recipient_phone VARCHAR(50) NOT NULL,
  recipient_name VARCHAR(255),
  body TEXT NOT NULL,
  message_type VARCHAR(20) DEFAULT 'general'
    CHECK (message_type IN ('general', 'invitation', 'reminder', 'announcement')),
  shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  twilio_sid VARCHAR(100),
  status VARCHAR(20) DEFAULT 'sent'
    CHECK (status IN ('sent', 'failed', 'queued')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_messages_group_id ON sms_messages(group_id);
CREATE INDEX IF NOT EXISTS idx_sms_messages_created_at ON sms_messages(created_at DESC);

-- Drink Plans
CREATE INDEX IF NOT EXISTS idx_drink_plans_token ON drink_plans(token);
CREATE INDEX IF NOT EXISTS idx_drink_plans_proposal_id ON drink_plans(proposal_id);

-- ─── FK Migrations (idempotent) ─────────────────────────────────

-- Fix interview_notes.admin_id FK to SET NULL on delete (for existing deployments)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'interview_notes_admin_id_fkey' AND table_name = 'interview_notes'
  ) THEN
    ALTER TABLE interview_notes DROP CONSTRAINT interview_notes_admin_id_fkey;
    ALTER TABLE interview_notes ADD CONSTRAINT interview_notes_admin_id_fkey
      FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ─── Auto-Assign: contractor_profiles additions ──────────────────
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS seniority_adjustment INTEGER DEFAULT 0;
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS hire_date DATE;
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS equipment_will_pickup BOOLEAN DEFAULT false;

-- ─── Auto-Assign: shifts additions ───────────────────────────────
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS equipment_required TEXT DEFAULT '[]';
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS auto_assign_days_before INTEGER;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS auto_assigned_at TIMESTAMPTZ;

-- ─── Auto-Assign: app settings ──────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO app_settings (key, value) VALUES
  ('auto_assign_default_days_before', '3'),
  ('seniority_weight_events', '0.7'),
  ('seniority_weight_tenure', '0.3'),
  ('geo_max_distance_miles', '100')
ON CONFLICT (key) DO NOTHING;

-- ─── Auto-Assign: indexes ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_contractor_profiles_lat_lng ON contractor_profiles(lat, lng);
CREATE INDEX IF NOT EXISTS idx_shifts_auto_assign ON shifts(event_date, auto_assign_days_before);

-- ─── Event Detail Redesign ──────────────────────────────────────

-- Setup time (default 1 hour before event start)
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS setup_minutes_before INTEGER DEFAULT 60;

-- Add 'completed' to proposal status
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_status_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_status_check
  CHECK (status IN ('draft','sent','viewed','modified','accepted','deposit_paid','balance_paid','confirmed','completed'));

-- Feedback tracking (fields only, feature built later)
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS feedback_request_sent_at TIMESTAMPTZ;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS feedback_status VARCHAR(20) DEFAULT 'none';

-- Event type (structured selector replaces free-text event_name)
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS event_type VARCHAR(100);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS event_type_category VARCHAR(50);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS event_type_custom VARCHAR(255);

-- ─── Blog Posts ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS blog_posts (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT,
  body TEXT NOT NULL,
  cover_image_url TEXT,
  published BOOLEAN DEFAULT false,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_blog_posts_updated_at ON blog_posts;
CREATE TRIGGER update_blog_posts_updated_at
  BEFORE UPDATE ON blog_posts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Password Reset Tokens ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Client Auth (OTP login) ────────────────────────────────────────
ALTER TABLE clients ADD COLUMN IF NOT EXISTS auth_token TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS auth_token_expires_at TIMESTAMPTZ;

-- Missing indexes identified by database review
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_email_unique ON clients(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clients_created_at ON clients(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_posts_published_at ON blog_posts(published_at DESC) WHERE published = true;
CREATE INDEX IF NOT EXISTS idx_blog_posts_slug ON blog_posts(slug);
CREATE INDEX IF NOT EXISTS idx_proposals_event_date ON proposals(event_date);
CREATE INDEX IF NOT EXISTS idx_proposals_autopay ON proposals(autopay_enrolled, status) WHERE autopay_enrolled = true;
CREATE INDEX IF NOT EXISTS idx_users_calendar_token ON users(calendar_token);
CREATE INDEX IF NOT EXISTS idx_sms_messages_recipient_id ON sms_messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_interview_notes_admin_id ON interview_notes(admin_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at);

-- ─── Email Marketing: Leads ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_leads (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  company VARCHAR(255),
  event_type VARCHAR(100),
  location VARCHAR(255),
  lead_source VARCHAR(100) DEFAULT 'manual'
    CHECK (lead_source IN ('manual','csv_import','website','thumbtack','referral','instagram','facebook','google','other')),
  notes TEXT,
  status VARCHAR(30) DEFAULT 'active'
    CHECK (status IN ('active','unsubscribed','bounced','complained')),
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_leads_email ON email_leads(email);
CREATE INDEX IF NOT EXISTS idx_email_leads_status ON email_leads(status);
CREATE INDEX IF NOT EXISTS idx_email_leads_lead_source ON email_leads(lead_source);

DROP TRIGGER IF EXISTS update_email_leads_updated_at ON email_leads;
CREATE TRIGGER update_email_leads_updated_at BEFORE UPDATE ON email_leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Quote Wizard Drafts ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quote_drafts (
  id SERIAL PRIMARY KEY,
  token UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  lead_id INTEGER REFERENCES email_leads(id) ON DELETE SET NULL,
  email VARCHAR(255) NOT NULL,
  form_state JSONB NOT NULL DEFAULT '{}',
  current_step INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) DEFAULT 'draft'
    CHECK (status IN ('draft', 'completed', 'expired')),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quote_drafts_active_email
  ON quote_drafts(email) WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS idx_quote_drafts_token ON quote_drafts(token);
CREATE INDEX IF NOT EXISTS idx_quote_drafts_lead_id ON quote_drafts(lead_id);

DROP TRIGGER IF EXISTS update_quote_drafts_updated_at ON quote_drafts;
CREATE TRIGGER update_quote_drafts_updated_at BEFORE UPDATE ON quote_drafts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Email Marketing: Campaigns ────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_campaigns (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'blast'
    CHECK (type IN ('blast','sequence')),
  subject VARCHAR(500),
  html_body TEXT,
  text_body TEXT,
  from_email VARCHAR(255),
  reply_to VARCHAR(255),
  status VARCHAR(20) DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','sending','sent','active','paused','archived')),
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  target_sources JSONB,
  target_event_types JSONB,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_email_campaigns_updated_at ON email_campaigns;
CREATE TRIGGER update_email_campaigns_updated_at BEFORE UPDATE ON email_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Email Marketing: Sequence Steps ───────────────────────────────

CREATE TABLE IF NOT EXISTS email_sequence_steps (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL DEFAULT 1,
  subject VARCHAR(500) NOT NULL,
  html_body TEXT NOT NULL,
  text_body TEXT,
  delay_days INTEGER NOT NULL DEFAULT 0,
  delay_hours INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(campaign_id, step_order)
);

DROP TRIGGER IF EXISTS update_email_sequence_steps_updated_at ON email_sequence_steps;
CREATE TRIGGER update_email_sequence_steps_updated_at BEFORE UPDATE ON email_sequence_steps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Email Marketing: Sequence Enrollments ─────────────────────────

CREATE TABLE IF NOT EXISTS email_sequence_enrollments (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES email_leads(id) ON DELETE CASCADE,
  current_step INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active'
    CHECK (status IN ('active','completed','paused','unsubscribed')),
  enrolled_at TIMESTAMPTZ DEFAULT NOW(),
  last_step_sent_at TIMESTAMPTZ,
  next_step_due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(campaign_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_next_due
  ON email_sequence_enrollments(next_step_due_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_enrollments_campaign ON email_sequence_enrollments(campaign_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_lead ON email_sequence_enrollments(lead_id);

-- ─── Email Marketing: Sends ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_sends (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER REFERENCES email_campaigns(id) ON DELETE SET NULL,
  sequence_step_id INTEGER REFERENCES email_sequence_steps(id) ON DELETE SET NULL,
  lead_id INTEGER NOT NULL REFERENCES email_leads(id) ON DELETE CASCADE,
  resend_id VARCHAR(255),
  subject VARCHAR(500),
  status VARCHAR(20) DEFAULT 'queued'
    CHECK (status IN ('queued','sent','delivered','opened','clicked','bounced','complained','failed')),
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  bounced_at TIMESTAMPTZ,
  complained_at TIMESTAMPTZ,
  error_message TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_sends_resend_id ON email_sends(resend_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_campaign ON email_sends(campaign_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_lead ON email_sends(lead_id);

-- ─── Email Marketing: Conversations ────────────────────────────────

CREATE TABLE IF NOT EXISTS email_conversations (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES email_leads(id) ON DELETE CASCADE,
  email_send_id INTEGER REFERENCES email_sends(id) ON DELETE SET NULL,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound','outbound')),
  subject VARCHAR(500),
  body_text TEXT,
  body_html TEXT,
  resend_id VARCHAR(255),
  admin_id INTEGER REFERENCES users(id),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_conversations_lead ON email_conversations(lead_id);

-- ─── Email Marketing: Webhook Events ───────────────────────────────

CREATE TABLE IF NOT EXISTS email_webhook_events (
  id SERIAL PRIMARY KEY,
  resend_id VARCHAR(255),
  event_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  processed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_resend_id ON email_webhook_events(resend_id);

-- ─── Additional Performance Indexes ─────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_shift_requests_status ON shift_requests(status);
CREATE INDEX IF NOT EXISTS idx_email_sends_status ON email_sends(status);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_type ON email_campaigns(type);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_status ON email_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_sms_messages_sender_id ON sms_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_sms_messages_shift_id ON sms_messages(shift_id);
CREATE INDEX IF NOT EXISTS idx_contractor_profiles_hire_date ON contractor_profiles(hire_date);

-- ─── Shopping List persistence ─────────────────────────────────────
ALTER TABLE drink_plans ADD COLUMN IF NOT EXISTS shopping_list JSONB;

-- ─── Manual Event Creation (shifts without proposals) ────────────
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS client_name VARCHAR(255);
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS client_email VARCHAR(255);
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS client_phone VARCHAR(50);
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS guest_count INTEGER;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS event_duration_hours NUMERIC(4,1);

-- ─── FK ON DELETE Behavior Fixes ─────────────────────────────────
DO $$ BEGIN
  -- created_by columns → SET NULL (user deletion shouldn't fail)
  ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_created_by_fkey;
  ALTER TABLE shifts ADD CONSTRAINT shifts_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

  ALTER TABLE drink_plans DROP CONSTRAINT IF EXISTS drink_plans_created_by_fkey;
  ALTER TABLE drink_plans ADD CONSTRAINT drink_plans_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

  ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_created_by_fkey;
  ALTER TABLE proposals ADD CONSTRAINT proposals_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

  -- package_id and addon_id → SET NULL (pricing_snapshot has the data)
  ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_package_id_fkey;
  ALTER TABLE proposals ADD CONSTRAINT proposals_package_id_fkey FOREIGN KEY (package_id) REFERENCES service_packages(id) ON DELETE SET NULL;

  ALTER TABLE proposal_addons DROP CONSTRAINT IF EXISTS proposal_addons_addon_id_fkey;
  ALTER TABLE proposal_addons ADD CONSTRAINT proposal_addons_addon_id_fkey FOREIGN KEY (addon_id) REFERENCES service_addons(id) ON DELETE SET NULL;

  -- drink_plans.proposal_id → CASCADE (deleting proposal cleans up drink plans)
  ALTER TABLE drink_plans DROP CONSTRAINT IF EXISTS drink_plans_proposal_id_fkey;
  ALTER TABLE drink_plans ADD CONSTRAINT drink_plans_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE;

  -- email marketing FKs → SET NULL
  ALTER TABLE email_campaigns DROP CONSTRAINT IF EXISTS email_campaigns_created_by_fkey;
  ALTER TABLE email_campaigns ADD CONSTRAINT email_campaigns_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

  ALTER TABLE email_conversations DROP CONSTRAINT IF EXISTS email_conversations_admin_id_fkey;
  ALTER TABLE email_conversations ADD CONSTRAINT email_conversations_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FK migration: %', SQLERRM;
END $$;

-- ─── CHECK Constraints on Status Columns ─────────────────────────
DO $$ BEGIN
  ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_status_check;
  ALTER TABLE shifts ADD CONSTRAINT shifts_status_check CHECK (status IN ('open', 'filled', 'completed', 'cancelled'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE shift_requests DROP CONSTRAINT IF EXISTS shift_requests_status_check;
  ALTER TABLE shift_requests ADD CONSTRAINT shift_requests_status_check CHECK (status IN ('pending', 'approved', 'denied'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE stripe_sessions DROP CONSTRAINT IF EXISTS stripe_sessions_status_check;
  ALTER TABLE stripe_sessions ADD CONSTRAINT stripe_sessions_status_check CHECK (status IN ('pending', 'succeeded', 'failed'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE proposal_payments DROP CONSTRAINT IF EXISTS proposal_payments_status_check;
  ALTER TABLE proposal_payments ADD CONSTRAINT proposal_payments_status_check CHECK (status IN ('pending', 'succeeded', 'failed'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- ─── Performance Indexes ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_proposals_status_financial ON proposals(status) WHERE status IN ('deposit_paid', 'balance_paid', 'confirmed', 'completed');
CREATE INDEX IF NOT EXISTS idx_proposals_autopay_balance ON proposals(balance_due_date) WHERE status = 'deposit_paid' AND autopay_enrolled = true;
CREATE INDEX IF NOT EXISTS idx_email_webhook_events_resend_type ON email_webhook_events(resend_id, event_type);
CREATE INDEX IF NOT EXISTS idx_email_conversations_unread ON email_conversations(read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shifts_open_upcoming ON shifts(event_date) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_clients_email_lower ON clients(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_shift_requests_shift_status ON shift_requests(shift_id, status);
CREATE INDEX IF NOT EXISTS idx_email_sends_campaign_status ON email_sends(campaign_id, status);

-- ─── Drop Redundant Index ────────────────────────────────────────
-- UNIQUE constraint on blog_posts.slug already creates an implicit index
DROP INDEX IF EXISTS idx_blog_posts_slug;

-- ─── Seed: Abandoned Quote Followup Campaign ────────────────────
-- Plain SQL with WHERE NOT EXISTS — safe with the semicolon-based statement splitter in db/index.js.
-- Dollar-quoted strings ($body$...$body$) avoid apostrophe escaping issues.

INSERT INTO email_campaigns (name, type, subject, status, from_email, reply_to)
SELECT 'Abandoned Quote Followup', 'sequence', 'Still planning your event?', 'active', 'hello@drbartender.com', 'hello@drbartender.com'
WHERE NOT EXISTS (SELECT 1 FROM email_campaigns WHERE name = 'Abandoned Quote Followup' AND type = 'sequence');

INSERT INTO email_sequence_steps (campaign_id, step_order, subject, html_body, text_body, delay_days, delay_hours)
SELECT c.id, 1,
  'Still thinking about your event? Your quote is waiting',
  $body$<h2 style="color:#3b2314;margin-top:0;">Pick Up Where You Left Off</h2>
<p>Hi {{name}},</p>
<p>We noticed you started putting together a quote for your event but didn't finish. No worries — your progress is saved and ready whenever you are!</p>
<p style="text-align:center;margin:2rem 0;">
  <a href="{{resume_url}}" style="display:inline-block;padding:14px 32px;background:#3b2314;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;font-size:16px;">Continue Your Quote</a>
</p>
<p>If you have any questions about our services, just reply to this email — we'd love to help.</p>
<p>Cheers,<br/>The Dr. Bartender Team</p>$body$,
  $txt$Hi {{name}}, you started a quote but didn't finish. Your progress is saved! Continue here: {{resume_url}} — The Dr. Bartender Team$txt$,
  0, 2
FROM email_campaigns c
WHERE c.name = 'Abandoned Quote Followup' AND c.type = 'sequence'
  AND NOT EXISTS (SELECT 1 FROM email_sequence_steps WHERE campaign_id = c.id AND step_order = 1);

INSERT INTO email_sequence_steps (campaign_id, step_order, subject, html_body, text_body, delay_days, delay_hours)
SELECT c.id, 2,
  'Your quote is still waiting — let us make your event unforgettable',
  $body$<h2 style="color:#3b2314;margin-top:0;">We Saved Your Spot</h2>
<p>Hi {{name}},</p>
<p>Just a friendly reminder that your custom quote is still saved and ready to go. Whether it's a wedding, birthday, or corporate event, we'd love to help make it memorable.</p>
<p style="text-align:center;margin:2rem 0;">
  <a href="{{resume_url}}" style="display:inline-block;padding:14px 32px;background:#3b2314;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;font-size:16px;">Finish Your Quote</a>
</p>
<p>Have questions? Reply here or give us a call — we're happy to walk you through everything.</p>
<p>Cheers,<br/>The Dr. Bartender Team</p>$body$,
  $txt$Hi {{name}}, your custom quote is still saved. Finish it here: {{resume_url}} — The Dr. Bartender Team$txt$,
  2, 0
FROM email_campaigns c
WHERE c.name = 'Abandoned Quote Followup' AND c.type = 'sequence'
  AND NOT EXISTS (SELECT 1 FROM email_sequence_steps WHERE campaign_id = c.id AND step_order = 2);

-- ─── Thumbtack Integration ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS thumbtack_leads (
  id SERIAL PRIMARY KEY,
  negotiation_id VARCHAR(100) UNIQUE NOT NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  customer_id VARCHAR(100),
  customer_name VARCHAR(255),
  customer_phone VARCHAR(50),
  category VARCHAR(255),
  description TEXT,
  location_city VARCHAR(255),
  location_state VARCHAR(50),
  location_zip VARCHAR(20),
  location_address TEXT,
  event_date TIMESTAMPTZ,
  event_duration INTEGER,
  guest_count INTEGER,
  lead_type VARCHAR(50),
  lead_price VARCHAR(50),
  charge_state VARCHAR(50),
  status VARCHAR(30) DEFAULT 'new'
    CHECK (status IN ('new','contacted','converted','lost')),
  raw_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_thumbtack_leads_client_id ON thumbtack_leads(client_id);
CREATE INDEX IF NOT EXISTS idx_thumbtack_leads_status ON thumbtack_leads(status);

DROP TRIGGER IF EXISTS update_thumbtack_leads_updated_at ON thumbtack_leads;
CREATE TRIGGER update_thumbtack_leads_updated_at BEFORE UPDATE ON thumbtack_leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS thumbtack_messages (
  id SERIAL PRIMARY KEY,
  message_id VARCHAR(100) UNIQUE NOT NULL,
  negotiation_id VARCHAR(100) REFERENCES thumbtack_leads(negotiation_id) ON DELETE CASCADE,
  from_type VARCHAR(20),
  sender_name VARCHAR(255),
  text TEXT,
  sent_at TIMESTAMPTZ,
  raw_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_thumbtack_messages_negotiation ON thumbtack_messages(negotiation_id);

CREATE TABLE IF NOT EXISTS thumbtack_reviews (
  id SERIAL PRIMARY KEY,
  review_id VARCHAR(100) UNIQUE NOT NULL,
  negotiation_id VARCHAR(100),
  rating NUMERIC(2,1),
  review_text TEXT,
  reviewer_name VARCHAR(255),
  raw_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

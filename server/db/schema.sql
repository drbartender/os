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

ALTER TABLE shifts ADD COLUMN IF NOT EXISTS proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_shifts_proposal_id ON shifts(proposal_id);

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
  proposal_id INTEGER REFERENCES proposals(id),
  created_by INTEGER REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE drink_plans ADD COLUMN IF NOT EXISTS proposal_id INTEGER REFERENCES proposals(id);

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
  ('whiskey-sour','Whiskey Sour','bartenders-picks','🍋','Bourbon, lemon, and simple — classic with optional egg white.',1),
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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_service_packages_updated_at ON service_packages;
CREATE TRIGGER update_service_packages_updated_at BEFORE UPDATE ON service_packages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS bar_type VARCHAR(50) DEFAULT 'full_bar' CHECK (bar_type IN ('full_bar', 'beer_and_wine', 'mocktail', 'service_only', 'class'));

INSERT INTO service_packages (slug, name, description, category, pricing_type, base_rate_3hr, base_rate_4hr, extra_hour_rate, min_guests, base_rate_3hr_small, base_rate_4hr_small, extra_hour_rate_small, bartenders_included, bar_type, includes, sort_order) VALUES
  ('the-core-reaction', 'The Core Reaction', 'Service-only. Built to flex. Our most budget-friendly Dry Lab setup. You provide the alcohol and supplies — or grab exactly what we recommend from our customized shopping list. We show up with the know-how, the setup, and the steady hands.', 'byob', 'flat',
    NULL, 350, 100, NULL, NULL, NULL, NULL, 1, 'service_only',
    '["{bartenders} professional bartender{bartenders_s}","Setup & breakdown","Cooler","Bar tools + clean service layout","Menu planning session","Precise, event-specific alcohol shopping list","Bespoke menu graphic","$2 million liquor liability insurance"]', 1),
  ('the-doctors-orders', 'The Doctor''s Orders', 'Our signature Mixology Lab. Stir, shake, and serve with flair. This hands-on session includes everything you need to learn and create — shakers, tools, mixers, juices, garnishes — everything but the liquor.', 'byob', 'flat',
    300, NULL, 100, NULL, NULL, NULL, NULL, 1, 'class',
    '["{bartenders} professional instructor{bartenders_s}","Setup & breakdown","Cooler","Menu planning session","Precise alcohol shopping list","Custom menu graphic","Digital Curriculum (recipes & instructions)","Up to {hours} hours of service","$2 million liquor liability insurance"]', 2),
  ('the-base-compound', 'The Base Compound', 'Minimal inputs. Maximum efficiency. A stripped-down formula ideal for casual environments and efficient service — delivering a solid range without experimental overload.', 'hosted', 'per_guest',
    NULL, 18, 5, 50, NULL, 23, 5, 1, 'full_bar',
    '["Two Signature Cocktails — Pre-formulated in our lab for rapid, reliable deployment","Miller Lite","Michelob Ultra","One Red Wine — balanced, medium-bodied","One White Wine — bright and approachable","Bottled Water","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 3),
  ('the-midrange-reaction', 'The Midrange Reaction', 'More variables. Still controlled. This formula expands the spirit selection and mixer profile, offering crowd-pleasing flexibility while staying efficient and focused. Ideal for weddings, milestone events, and hosts who want to level up without losing control of the experiment.', 'hosted', 'per_guest',
    NULL, 22, 6, 50, NULL, 27, 6, 1, 'full_bar',
    '["Svedka Vodka","New Amsterdam Gin","Bacardi Superior Rum","Jim Beam Bourbon","Margaritaville Tequila","Dewar''s Scotch","Miller Lite, Michelob Ultra","One Red Wine, One White Wine","Coke, Diet Coke, Sprite","Soda Water & Tonic","Cranberry, Orange & Pineapple Juices","Bottled Water","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 4),
  ('the-enhanced-solution', 'The Enhanced Solution', 'Refined inputs. Amplified output. Premium spirits with expanded modifiers.', 'hosted', 'per_guest',
    NULL, 28, 8, 50, NULL, 33, 8, 1, 'full_bar',
    '["Six premium spirits","Three beers","Four wines","Sparkling wine","Expanded mixers/modifiers including bitters and citrus juices","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 5),
  ('formula-no-5', 'Formula No. 5', 'Precision over excess. Five spirits. Fully dialed. This tier is about clean lines, deliberate choices, and confident pours. Premium ingredients, zero clutter. A high-end setup for hosts who want quality without overstock.', 'hosted', 'per_guest',
    NULL, 33, 9, 50, NULL, 39, 9, 1, 'full_bar',
    '["Grey Goose Vodka","Hendrick''s Gin","Appleton Estate Rum","Casamigos Tequila","Bulleit Bourbon","Stella Artois","One Red Wine & One White Wine","Coke, Diet Coke, Sprite","Ginger Ale, Soda, Tonic","Orange, Cranberry & Pineapple Juices","Simple Syrup & Bitters","Bottled Water","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 6),
  ('the-grand-experiment', 'The Grand Experiment', 'No corners cut. No questions unanswered. Apex formula with celebrated spirits and comprehensive bar experience.', 'hosted', 'per_guest',
    NULL, 40, 11.25, 50, NULL, 46, 11.25, 1, 'full_bar',
    '["Nine spirits","Three beers","Four premium wines","Sparkling wine","Craft beer selection","Full mixer/modifier range including fresh citrus","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 7),
  ('the-clear-reaction', 'The Clear Reaction', 'Mocktail Bar. Perfect for corporate, baby showers, religious/cultural events, or sober-curious crowds.', 'hosted', 'per_guest',
    NULL, 14, 4, 50, NULL, 18, 4, 1, 'mocktail',
    '["3-4 signature mocktail recipes","All mixers, garnishes, syrups","Premium presentation","Full bar setup","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 8),
  ('the-primary-culture', 'The Primary Culture', 'Bare Bones. Fully Functional. A simple yet stable foundation. Great for casual parties and backyard weddings where beer and wine get the job done.', 'hosted', 'per_guest',
    NULL, 12, 4, 50, NULL, 17, 4, 1, 'beer_and_wine',
    '["Miller Lite","Michelob Ultra","One Red Wine & One White Wine","Infused Water Station — citrus, cucumber, or herbs depending on season","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 9),
  ('the-refined-reaction', 'The Refined Reaction', 'A polished experiment in crowd-pleasing sophistication. Still streamlined, but with a noticeable bump in quality — perfect for weddings, cocktail hours, and milestone celebrations.', 'hosted', 'per_guest',
    NULL, 14, 5, 50, NULL, 19, 5, 1, 'beer_and_wine',
    '["Stella Artois","Corona Extra","One Red & One White Wine","Sparkling Wine","Bottled Water","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 10),
  ('the-carbon-suspension', 'The Carbon Suspension', 'Expanded range. Zero pretense. For bigger crowds or events that need a little more variety — without drifting into fancy territory. Balanced. Approachable. Ready to pour.', 'hosted', 'per_guest',
    NULL, 15, 5.75, 50, NULL, 20, 5.75, 1, 'beer_and_wine',
    '["Miller Lite","Michelob Ultra","Yuengling Lager","Rotating Seltzer flavors","Two Red Wines & Two White Wines","Bottled Water","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 11),
  ('the-cultivated-complex', 'The Cultivated Complex', 'Curated elegance. Lab-certified crowd-pleaser. Designed for hosts who want elevated beer and wine service with enough sparkle, variety, and quality to make it feel like the full experience — minus the liquor cabinet.', 'hosted', 'per_guest',
    NULL, 17, 6.25, 50, NULL, 22, 6.25, 1, 'beer_and_wine',
    '["Miller Lite","Michelob Ultra","Yuengling Lager","Two Rotating Craft or Local Beers","Seasonal Seltzer","Two Premium Red Wines & Two Premium White Wines","Sparkling Wine","Bottled Water","Up to {hours} hours of bar service","{bartenders} professional bartender{bartenders_s}","Full setup and breakdown","Cooler","Custom menu graphic","$2 million liquor liability insurance"]', 12)
ON CONFLICT (slug) DO UPDATE SET
  description = EXCLUDED.description,
  bar_type = EXCLUDED.bar_type,
  includes = EXCLUDED.includes;

-- ─── Service Add-ons ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS service_addons (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  billing_type VARCHAR(20) NOT NULL CHECK (billing_type IN ('per_guest', 'per_hour', 'flat', 'per_guest_timed')),
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

DROP TRIGGER IF EXISTS update_service_addons_updated_at ON service_addons;
CREATE TRIGGER update_service_addons_updated_at BEFORE UPDATE ON service_addons
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

INSERT INTO service_addons (slug, name, description, billing_type, rate, extra_hour_rate, applies_to, sort_order) VALUES
  ('the-foundation', 'The Foundation', 'Ice delivery, bottled water service, premium cups, napkins, stir sticks. No mixers, no garnishes.', 'per_guest_timed', 3.00, 0.75, 'byob', 1),
  ('the-formula', 'The Formula', 'Everything in The Foundation plus mixers for signature cocktails, basic garnishes, simple syrup, bitters.', 'per_guest_timed', 5.50, 1.25, 'byob', 2),
  ('the-full-compound', 'The Full Compound', 'Everything in The Foundation plus complete mixer selection, premium garnish package, simple syrup, bitters.', 'per_guest_timed', 8.00, 2.00, 'byob', 3),
  ('ice-delivery-only', 'Ice Delivery Only', 'Ice delivery for the event.', 'per_guest', 2.00, NULL, 'byob', 4),
  ('cups-disposables-only', 'Cups & Disposables Only', 'Premium cups, napkins, stir sticks, straws.', 'per_guest', 1.50, NULL, 'byob', 5),
  ('bottled-water-only', 'Bottled Water Only', 'Bottled water service.', 'per_guest', 0.50, NULL, 'byob', 6),
  ('signature-mixers-only', 'Signature Mixers Only', 'Mixers for signature cocktails only. Does not include Foundation items.', 'per_guest', 2.00, NULL, 'byob', 7),
  ('full-mixers-only', 'Full Mixers Only', 'Complete mixer selection. Does not include Foundation items.', 'per_guest', 4.50, NULL, 'byob', 8),
  ('garnish-package-only', 'Garnish Package Only', 'Premium garnish package (lemons, limes, oranges, cherries, olives).', 'flat', 50.00, NULL, 'byob', 9),
  ('champagne-toast', 'Champagne Toast', 'Champagne toast for all guests.', 'per_guest', 2.50, NULL, 'all', 10),
  ('pre-batched-mocktail', 'Single Pre-Batched Mocktail Add-On', 'One pre-batched mocktail option for all guests.', 'per_guest', 1.50, NULL, 'all', 11),
  ('soft-drink-addon', 'Soft Drink Add-On', 'Soft drinks for all guests.', 'per_guest', 3.00, NULL, 'all', 12),
  ('mocktail-bar', 'Mocktail Bar', 'Full mocktail bar with signature recipes.', 'per_guest_timed', 7.50, 2.00, 'all', 13),
  ('banquet-server', 'Banquet Server', 'Professional banquet server.', 'per_hour', 75.00, NULL, 'all', 14),
  ('flavor-blaster-rental', 'Flavor Blaster Rental', 'Flavor blaster equipment rental.', 'flat', 150.00, NULL, 'all', 15),
  ('handcrafted-syrups', 'Handcrafted Syrups', 'Single 750ml bottle of handcrafted syrup.', 'flat', 30.00, NULL, 'all', 16),
  ('handcrafted-syrups-3pack', 'Handcrafted Syrups 3-Pack', 'Three 750ml bottles of handcrafted syrups.', 'flat', 75.00, NULL, 'all', 17),
  ('parking-fee', 'Parking Fee', 'Parking fee per bartender.', 'flat', 20.00, NULL, 'all', 18)
ON CONFLICT (slug) DO NOTHING;

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

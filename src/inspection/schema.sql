-- Inspection product (Приёмка). Idempotent. Do not drop existing Naryad tables.

CREATE TABLE IF NOT EXISTS billing_products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_rub INTEGER NOT NULL CHECK (price_rub >= 0),
  unit TEXT NOT NULL DEFAULT 'object'
);

CREATE TABLE IF NOT EXISTS billing_entitlements (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  product_id TEXT NOT NULL REFERENCES billing_products (id),
  subject_type TEXT NOT NULL,
  subject_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  provider_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id, subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS billing_payment_events (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  product_id TEXT REFERENCES billing_products (id),
  subject_type TEXT,
  subject_id INTEGER,
  payload JSONB NOT NULL DEFAULT '{}',
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS client_operations (
  operation_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  op_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checklist_templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  property_type TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checklist_template_versions (
  id SERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES checklist_templates (id),
  version INTEGER NOT NULL,
  frozen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

CREATE TABLE IF NOT EXISTS checklist_sections (
  id SERIAL PRIMARY KEY,
  version_id INTEGER NOT NULL REFERENCES checklist_template_versions (id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id SERIAL PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES checklist_sections (id),
  title TEXT NOT NULL,
  instruction TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL CHECK (scope IN ('PROJECT', 'ROOM')),
  finish_tags TEXT[] NOT NULL DEFAULT '{}',
  requires_measurement BOOLEAN NOT NULL DEFAULT FALSE,
  severity_default TEXT NOT NULL DEFAULT 'MINOR'
    CHECK (severity_default IN ('INFO', 'MINOR', 'MAJOR', 'CRITICAL'))
);

CREATE INDEX IF NOT EXISTS checklist_items_section_idx ON checklist_items (section_id, sort_order, id);

CREATE TABLE IF NOT EXISTS defect_templates (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS inspection_projects (
  id SERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users (id),
  organization_id INTEGER,
  title TEXT NOT NULL,
  address TEXT NOT NULL,
  building TEXT NOT NULL DEFAULT '',
  apartment_number TEXT NOT NULL DEFAULT '',
  floor TEXT NOT NULL DEFAULT '',
  total_floors TEXT NOT NULL DEFAULT '',
  area_m2 NUMERIC(10, 2),
  rooms_count_declared INTEGER,
  property_type TEXT NOT NULL
    CHECK (property_type IN ('APARTMENT', 'APARTMENT_STUDIO', 'HOUSE', 'OFFICE', 'COMMERCIAL', 'OTHER')),
  finish_type TEXT NOT NULL
    CHECK (finish_type IN ('NO_FINISH', 'WHITE_BOX', 'ROUGH', 'FINISHED', 'DESIGNER', 'OTHER')),
  developer TEXT NOT NULL DEFAULT '',
  residential_complex TEXT NOT NULL DEFAULT '',
  contract_number TEXT NOT NULL DEFAULT '',
  inspection_date DATE,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'FOLLOW_UP', 'ARCHIVED')),
  opened_unpaid BOOLEAN NOT NULL DEFAULT FALSE,
  checklist_template_version_id INTEGER REFERENCES checklist_template_versions (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inspection_projects_owner_idx
  ON inspection_projects (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS inspection_rooms (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES inspection_projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN (
      'hallway', 'kitchen', 'living', 'bedroom', 'kids',
      'bathroom', 'wc', 'wardrobe', 'balcony', 'loggia', 'other'
    )),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS inspection_rooms_project_idx ON inspection_rooms (project_id, sort_order, id);

CREATE TABLE IF NOT EXISTS inspections (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES inspection_projects (id) ON DELETE CASCADE,
  parent_inspection_id INTEGER REFERENCES inspections (id),
  checklist_template_version_id INTEGER NOT NULL REFERENCES checklist_template_versions (id),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'FOLLOW_UP', 'ARCHIVED')),
  mode TEXT NOT NULL DEFAULT 'BEGINNER' CHECK (mode IN ('BEGINNER', 'EXPERT')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inspections_project_idx ON inspections (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS inspection_item_results (
  id SERIAL PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections (id) ON DELETE CASCADE,
  checklist_item_id INTEGER NOT NULL REFERENCES checklist_items (id),
  room_id INTEGER REFERENCES inspection_rooms (id) ON DELETE CASCADE,
  result TEXT NOT NULL DEFAULT 'UNCHECKED'
    CHECK (result IN ('UNCHECKED', 'OK', 'DEFECT', 'NA')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS inspection_item_results_project_scope_uidx
  ON inspection_item_results (inspection_id, checklist_item_id)
  WHERE room_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS inspection_item_results_room_scope_uidx
  ON inspection_item_results (inspection_id, checklist_item_id, room_id)
  WHERE room_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS inspection_item_results_insp_idx
  ON inspection_item_results (inspection_id, room_id);

CREATE TABLE IF NOT EXISTS defects (
  id SERIAL PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections (id) ON DELETE CASCADE,
  room_id INTEGER REFERENCES inspection_rooms (id) ON DELETE SET NULL,
  checklist_item_id INTEGER REFERENCES checklist_items (id),
  item_result_id INTEGER REFERENCES inspection_item_results (id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'MINOR'
    CHECK (severity IN ('INFO', 'MINOR', 'MAJOR', 'CRITICAL')),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'CONFIRMED', 'FIXED', 'RECHECK_REQUIRED', 'CLOSED', 'WONT_FIX')),
  location_description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS defects_inspection_idx ON defects (inspection_id, created_at);

CREATE TABLE IF NOT EXISTS defect_photos (
  id SERIAL PRIMARY KEY,
  defect_id INTEGER NOT NULL REFERENCES defects (id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (kind IN ('OVERVIEW', 'CLOSEUP', 'SCALE', 'OTHER')),
  stored_name TEXT NOT NULL,
  thumb_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_operation_id TEXT
);

CREATE INDEX IF NOT EXISTS defect_photos_defect_idx ON defect_photos (defect_id, created_at);

CREATE TABLE IF NOT EXISTS defect_measurements (
  id SERIAL PRIMARY KEY,
  defect_id INTEGER NOT NULL REFERENCES defects (id) ON DELETE CASCADE,
  measure_type TEXT NOT NULL
    CHECK (measure_type IN ('LENGTH', 'WIDTH', 'HEIGHT', 'DEPTH', 'DEVIATION', 'TEMPERATURE', 'HUMIDITY', 'OTHER')),
  value_numeric NUMERIC(12, 3) NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('mm', 'cm', 'm', 'C', 'pct', 'other')),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inspection_history (
  id SERIAL PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections (id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users (id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inspection_history_insp_idx ON inspection_history (inspection_id, created_at);

CREATE TABLE IF NOT EXISTS inspection_reports (
  id SERIAL PRIMARY KEY,
  inspection_id INTEGER NOT NULL UNIQUE REFERENCES inspections (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inspection_report_versions (
  id SERIAL PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES inspection_reports (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  format TEXT NOT NULL DEFAULT 'html',
  storage_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (report_id, version)
);

CREATE TABLE IF NOT EXISTS inspection_shares (
  id SERIAL PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS follow_up_links (
  id SERIAL PRIMARY KEY,
  parent_inspection_id INTEGER NOT NULL REFERENCES inspections (id) ON DELETE CASCADE,
  child_inspection_id INTEGER NOT NULL UNIQUE REFERENCES inspections (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO billing_products (id, name, price_rub, unit)
VALUES ('inspection_object', 'Приёмка объекта', 990, 'object')
ON CONFLICT (id) DO NOTHING;

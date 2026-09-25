CREATE TABLE IF NOT EXISTS session (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('client', 'foreman', 'master', 'inspector')),
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  specialty TEXT CHECK (specialty IN ('plumber', 'electrician', 'washer')),
  accepting_orders BOOLEAN NOT NULL DEFAULT FALSE,
  orders_opened_unpaid BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Existing DBs created before «Приёмка»: widen role check without recreating users.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('client', 'foreman', 'master', 'inspector'));

CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL CHECK (kind IN ('apartment', 'plumber', 'electrician', 'washer')),
  address TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'offered', 'accepted', 'in_progress', 'done', 'cancelled')),
  status_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS requests_client_idx ON requests (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS objects (
  id SERIAL PRIMARY KEY,
  foreman_id INTEGER NOT NULL REFERENCES users (id),
  request_id INTEGER UNIQUE REFERENCES requests (id),
  address TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_phone TEXT NOT NULL,
  opened_unpaid BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS objects_foreman_idx ON objects (foreman_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stages (
  id SERIAL PRIMARY KEY,
  object_id INTEGER NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'done')),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS stages_object_idx ON stages (object_id, sort_order, id);

CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  object_id INTEGER NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount_rub INTEGER NOT NULL CHECK (amount_rub >= 0 AND amount_rub <= 100000000),
  charged_to_client BOOLEAN NOT NULL DEFAULT TRUE,
  settled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS purchases_object_idx ON purchases (object_id, created_at);

CREATE TABLE IF NOT EXISTS photos (
  id SERIAL PRIMARY KEY,
  object_id INTEGER NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
  room TEXT NOT NULL CHECK (room IN ('kitchen', 'bathroom', 'room', 'hallway', 'balcony', 'other')),
  stored_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS photos_object_idx ON photos (object_id, room, created_at DESC);

CREATE TABLE IF NOT EXISTS offers (
  id SERIAL PRIMARY KEY,
  specialty TEXT NOT NULL CHECK (specialty IN ('plumber', 'electrician', 'washer')),
  request_id INTEGER REFERENCES requests (id),
  object_id INTEGER REFERENCES objects (id),
  summary TEXT NOT NULL,
  address TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'cancelled')),
  job_status TEXT NOT NULL DEFAULT 'pending' CHECK (job_status IN ('pending', 'accepted', 'in_progress', 'done')),
  master_id INTEGER REFERENCES users (id),
  status_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  CONSTRAINT offers_source CHECK (request_id IS NOT NULL OR object_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  foreman_id INTEGER NOT NULL REFERENCES users (id),
  specialty TEXT NOT NULL CHECK (specialty IN ('plumber', 'electrician', 'washer')),
  address TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_foreman_idx ON tasks (foreman_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_specialty_idx ON tasks (specialty, created_at DESC);

CREATE TABLE IF NOT EXISTS task_responses (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  master_id INTEGER NOT NULL REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, master_id)
);

CREATE INDEX IF NOT EXISTS task_responses_task_idx ON task_responses (task_id, created_at);
CREATE INDEX IF NOT EXISTS task_responses_master_idx ON task_responses (master_id, created_at DESC);

CREATE INDEX IF NOT EXISTS offers_open_idx ON offers (specialty, status, created_at DESC);
CREATE INDEX IF NOT EXISTS offers_master_idx ON offers (master_id, created_at DESC);
CREATE INDEX IF NOT EXISTS offers_object_idx ON offers (object_id);
CREATE INDEX IF NOT EXISTS offers_request_idx ON offers (request_id);

CREATE TABLE IF NOT EXISTS master_bookings (
  id SERIAL PRIMARY KEY,
  master_id INTEGER NOT NULL REFERENCES users (id),
  client_name TEXT NOT NULL,
  client_phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  visit_on DATE NOT NULL,
  visit_time TIME,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'done', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS master_bookings_master_day_idx
  ON master_bookings (master_id, visit_on, visit_time NULLS LAST, id);

CREATE TABLE IF NOT EXISTS master_guarantees (
  id SERIAL PRIMARY KEY,
  master_id INTEGER NOT NULL REFERENCES users (id),
  booking_id INTEGER REFERENCES master_bookings (id) ON DELETE SET NULL,
  client_name TEXT NOT NULL,
  work_title TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  months INTEGER NOT NULL CHECK (months >= 1 AND months <= 120),
  started_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS master_guarantees_master_idx
  ON master_guarantees (master_id, ends_on DESC, id DESC);

CREATE TABLE IF NOT EXISTS master_client_dues (
  id SERIAL PRIMARY KEY,
  master_id INTEGER NOT NULL REFERENCES users (id),
  booking_id INTEGER REFERENCES master_bookings (id) ON DELETE SET NULL,
  client_name TEXT NOT NULL,
  title TEXT NOT NULL,
  amount_rub INTEGER NOT NULL CHECK (amount_rub >= 0 AND amount_rub <= 100000000),
  settled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS master_client_dues_master_idx
  ON master_client_dues (master_id, settled, created_at DESC);

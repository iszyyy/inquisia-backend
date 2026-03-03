-- ============================================================
-- Inquisia Database Schema
-- Run on: PostgreSQL (db: inquisia, user: inquisia)
-- ============================================================

-- ── Extensions ──────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- trigram search on title/abstract

-- ── Enums ───────────────────────────────────────────────────
CREATE TYPE user_role      AS ENUM ('student', 'supervisor', 'admin', 'public');
CREATE TYPE account_status AS ENUM ('active', 'warned', 'restricted', 'banned');
CREATE TYPE project_status AS ENUM ('pending', 'approved', 'changes_requested', 'rejected');
CREATE TYPE change_request_status AS ENUM ('pending', 'approved', 'denied');
CREATE TYPE notification_type AS ENUM (
  'project_approved',
  'changes_requested',
  'project_rejected',
  'new_comment',
  'change_request_approved',
  'change_request_denied',
  'teammate_added'
);

-- ── Users ────────────────────────────────────────────────────
CREATE TABLE users (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT          NOT NULL UNIQUE,
  password_hash    TEXT          NOT NULL,
  role             user_role     NOT NULL DEFAULT 'public',
  full_name        TEXT,
  display_name     TEXT,
  bio              TEXT,
  links            JSONB         NOT NULL DEFAULT '[]',   -- UserLink[]
  matric_no        TEXT,
  staff_id         TEXT,
  degrees          TEXT,
  level            TEXT,                                  -- '100','200','300','400','500'
  department_id    UUID,
  is_verified      BOOLEAN       NOT NULL DEFAULT false,
  is_active        BOOLEAN       NOT NULL DEFAULT true,
  account_status   account_status NOT NULL DEFAULT 'active',
  status_reason    TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email          ON users(email);
CREATE INDEX idx_users_role           ON users(role);
CREATE INDEX idx_users_matric_no      ON users(matric_no) WHERE matric_no IS NOT NULL;
CREATE INDEX idx_users_department     ON users(department_id);

-- ── Departments ──────────────────────────────────────────────
CREATE TABLE departments (
  id         UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT  NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- FK now that departments table exists
ALTER TABLE users ADD CONSTRAINT fk_users_department
  FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;

-- ── AI Categories ────────────────────────────────────────────
-- Stored as strings (no UUID PK — frontend uses `name` as the identifier)
CREATE TABLE ai_categories (
  name       TEXT        PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Projects ─────────────────────────────────────────────────
CREATE TABLE projects (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  title               TEXT          NOT NULL,
  abstract            TEXT          NOT NULL,
  pdf_text            TEXT,                              -- extracted text from PDF
  student_tags        TEXT[]        NOT NULL DEFAULT '{}',
  ai_tags             TEXT[]        NOT NULL DEFAULT '{}',
  ai_category         TEXT          REFERENCES ai_categories(name) ON DELETE SET NULL,
  department_id       UUID          REFERENCES departments(id) ON DELETE SET NULL,
  year                INTEGER       NOT NULL DEFAULT EXTRACT(YEAR FROM NOW()),
  status              project_status NOT NULL DEFAULT 'pending',
  plagiarism_score    NUMERIC(5,2),
  similar_project_id  UUID          REFERENCES projects(id) ON DELETE SET NULL,
  similarity_reason   TEXT,
  github_url          TEXT,
  live_url            TEXT,
  report_url          TEXT,                              -- path/URL of current PDF
  download_count      INTEGER       NOT NULL DEFAULT 0,
  supervisor_id       UUID          REFERENCES users(id) ON DELETE SET NULL,
  ai_summary          TEXT,
  ai_analysis         JSONB,                             -- AIAnalysis object
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  approved_at         TIMESTAMPTZ
);

CREATE INDEX idx_projects_status        ON projects(status);
CREATE INDEX idx_projects_supervisor    ON projects(supervisor_id);
CREATE INDEX idx_projects_department    ON projects(department_id);
CREATE INDEX idx_projects_ai_category   ON projects(ai_category);
CREATE INDEX idx_projects_year          ON projects(year);
CREATE INDEX idx_projects_approved_at   ON projects(approved_at DESC) WHERE status = 'approved';
-- Full-text trigram search
CREATE INDEX idx_projects_title_trgm    ON projects USING GIN (title gin_trgm_ops);
CREATE INDEX idx_projects_abstract_trgm ON projects USING GIN (abstract gin_trgm_ops);

-- ── Project Authors (many-to-many: project ↔ student users) ──
CREATE TABLE project_authors (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id          UUID    NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  role_description TEXT,                                    -- "Team Lead", custom note
  is_lead          BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (project_id, user_id)
);

CREATE INDEX idx_project_authors_project ON project_authors(project_id);
CREATE INDEX idx_project_authors_user    ON project_authors(user_id);

-- ── Project Versions ─────────────────────────────────────────
CREATE TABLE project_versions (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_number      INTEGER       NOT NULL,
  status              project_status NOT NULL,
  supervisor_feedback TEXT,
  report_url          TEXT,
  plagiarism_score    NUMERIC(5,2),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, version_number)
);

CREATE INDEX idx_versions_project ON project_versions(project_id);

-- ── Supervisor Departments (supervisor can belong to multiple depts) ──
CREATE TABLE supervisor_departments (
  supervisor_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id  UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (supervisor_id, department_id)
);

-- ── Comments ─────────────────────────────────────────────────
CREATE TABLE comments (
  id         UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    UUID  NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  content    TEXT  NOT NULL,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  parent_id  UUID  REFERENCES comments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_comments_project   ON comments(project_id);
CREATE INDEX idx_comments_parent    ON comments(parent_id) WHERE parent_id IS NOT NULL;

-- ── Bookmarks ─────────────────────────────────────────────────
CREATE TABLE bookmarks (
  user_id    UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, project_id)
);

-- ── Notifications ─────────────────────────────────────────────
CREATE TABLE notifications (
  id         UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID              NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       notification_type NOT NULL,
  title      TEXT              NOT NULL,
  message    TEXT              NOT NULL,
  is_read    BOOLEAN           NOT NULL DEFAULT false,
  link       TEXT,
  created_at TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user    ON notifications(user_id);
CREATE INDEX idx_notifications_unread  ON notifications(user_id) WHERE is_read = false;

-- ── Change Requests ───────────────────────────────────────────
CREATE TABLE change_requests (
  id            UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID                  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  student_id    UUID                  NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  fields        TEXT[]                NOT NULL,            -- e.g. ['title','abstract']
  reason        TEXT                  NOT NULL,
  proposed_data JSONB                 NOT NULL DEFAULT '{}',
  status        change_request_status NOT NULL DEFAULT 'pending',
  response      TEXT,
  report_file_url TEXT,                                    -- optional new PDF
  created_at    TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ           NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cr_project  ON change_requests(project_id);
CREATE INDEX idx_cr_student  ON change_requests(student_id);
CREATE INDEX idx_cr_status   ON change_requests(status);

-- ── Session store (connect-pg-simple) ─────────────────────────
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR      NOT NULL COLLATE "default",
  sess   JSON         NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);

-- ── Trigger: auto-update updated_at ──────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_comments_updated_at
  BEFORE UPDATE ON comments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_change_requests_updated_at
  BEFORE UPDATE ON change_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Seed: default departments ────────────────────────────────
INSERT INTO departments (name) VALUES
  ('Computer Science'),
  ('Information Technology'),
  ('Software Engineering'),
  ('Cyber Security'),
  ('Management Information Systems'),
  ('Electrical Engineering'),
  ('Mechanical Engineering'),
  ('Business Administration')
ON CONFLICT (name) DO NOTHING;

-- ── Seed: default AI categories ──────────────────────────────
INSERT INTO ai_categories (name) VALUES
  ('Machine Learning'),
  ('Web Development'),
  ('Mobile Development'),
  ('Data Science'),
  ('Cybersecurity'),
  ('Networking'),
  ('Database Systems'),
  ('Software Engineering'),
  ('Artificial Intelligence'),
  ('Computer Vision'),
  ('Natural Language Processing'),
  ('Internet of Things'),
  ('Blockchain'),
  ('Cloud Computing'),
  ('Embedded Systems')
ON CONFLICT (name) DO NOTHING;

-- Family Tree: skema awal (11 tabel + indeks).
-- Rekaman dari skema yang sudah berjalan di D1 `family-tree-db`, diambil dari sqlite_master pada 2026-11-18.
-- Aman dijalankan ulang: semuanya memakai IF NOT EXISTS.
-- Isolasi antar pohon: foreign key komposit (id, tree_id) mencegah relasi lintas pohon.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  google_sub TEXT UNIQUE,
  display_name TEXT,
  language TEXT NOT NULL DEFAULT 'id' CHECK (language IN ('id','en')),
  text_size INTEGER NOT NULL DEFAULT 100 CHECK (text_size IN (100,125,150,200)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS family_trees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memberships (
  tree_id TEXT NOT NULL REFERENCES family_trees(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL CHECK (role IN ('owner','admin','contributor','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','removed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tree_id, account_id)
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL REFERENCES family_trees(id),
  display_name TEXT NOT NULL,
  nickname TEXT,
  birth_date TEXT,
  birth_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (birth_precision IN ('full','year','approx','unknown')),
  birth_visibility TEXT NOT NULL DEFAULT 'year' CHECK (birth_visibility IN ('full','year','hidden')),
  death_date TEXT,
  death_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (death_precision IN ('full','year','approx','unknown')),
  confirmation TEXT NOT NULL DEFAULT 'unverified' CHECK (confirmation IN ('unverified','confirmed')),
  source_note TEXT CHECK (source_note IS NULL OR length(source_note) <= 500),
  is_placeholder INTEGER NOT NULL DEFAULT 0,
  placeholder_of TEXT,
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES accounts(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (id, tree_id)
);

CREATE TABLE IF NOT EXISTS name_variants (
  id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  FOREIGN KEY (person_id, tree_id) REFERENCES people (id, tree_id)
);

CREATE TABLE IF NOT EXISTS parent_child_edges (
  id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('biological','adoptive','step','guardian','custom')),
  custom_label TEXT,
  parent_role TEXT NOT NULL DEFAULT 'parent' CHECK (parent_role IN ('father','mother','parent')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (parent_id <> child_id),
  UNIQUE (parent_id, child_id, relation_type),
  FOREIGN KEY (parent_id, tree_id) REFERENCES people (id, tree_id),
  FOREIGN KEY (child_id, tree_id) REFERENCES people (id, tree_id)
);

CREATE TABLE IF NOT EXISTS partnerships (
  id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL,
  person_a TEXT NOT NULL,
  person_b TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('married','divorced','separated','partner_deceased','unknown')),
  start_year INTEGER,
  end_year INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (person_a <> person_b),
  FOREIGN KEY (person_a, tree_id) REFERENCES people (id, tree_id),
  FOREIGN KEY (person_b, tree_id) REFERENCES people (id, tree_id)
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL REFERENCES family_trees(id),
  kind TEXT NOT NULL CHECK (kind IN ('person_edit','person_create','partnership','parent_child','archive','archive_restore','merge','unmerge')),
  target_person_id TEXT,
  before_json TEXT,
  after_json TEXT NOT NULL,
  source_note TEXT,
  proposer_id TEXT NOT NULL REFERENCES accounts(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled','expired','stale')),
  rejection_reason TEXT CHECK (rejection_reason IS NULL OR length(rejection_reason) <= 300),
  decided_by TEXT REFERENCES accounts(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL REFERENCES family_trees(id),
  actor_id TEXT REFERENCES accounts(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  before_json TEXT,
  after_json TEXT,
  approval_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL REFERENCES family_trees(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('contributor','viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES accounts(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','awaiting_approval','accepted','expired','cancelled')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_person_links (
  tree_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  person_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active')),
  PRIMARY KEY (tree_id, account_id),
  UNIQUE (tree_id, person_id),
  FOREIGN KEY (person_id, tree_id) REFERENCES people (id, tree_id)
);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events (tree_id, actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events (tree_id, created_at);
CREATE INDEX IF NOT EXISTS idx_edges_child ON parent_child_edges (tree_id, child_id);
CREATE INDEX IF NOT EXISTS idx_edges_parent ON parent_child_edges (tree_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_invites_tree ON invitations (tree_id, status);
CREATE INDEX IF NOT EXISTS idx_memberships_account ON memberships (account_id, status);
CREATE INDEX IF NOT EXISTS idx_partner_a ON partnerships (tree_id, person_a);
CREATE INDEX IF NOT EXISTS idx_partner_b ON partnerships (tree_id, person_b);
CREATE INDEX IF NOT EXISTS idx_people_name ON people (tree_id, display_name);
CREATE INDEX IF NOT EXISTS idx_people_nick ON people (tree_id, nickname);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals (tree_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_variants ON name_variants (tree_id, variant);

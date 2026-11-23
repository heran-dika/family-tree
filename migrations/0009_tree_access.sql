-- Jalur B (PRD A1): kode pohon + permintaan bergabung.
-- Kode: acak 256 bit, hanya hash yang disimpan; satu kode aktif per pohon (membuat baru = mengganti, mencabut = menutup).
CREATE TABLE IF NOT EXISTS tree_access_codes (
  id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL REFERENCES family_trees(id),
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_access_code_active ON tree_access_codes (tree_id) WHERE revoked_at IS NULL;

-- Permintaan bergabung: pemohon BELUM anggota sampai Owner/Admin menyetujui (baru saat itu baris memberships dibuat).
CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL REFERENCES family_trees(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  message TEXT CHECK (message IS NULL OR length(message) <= 200),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  role TEXT CHECK (role IS NULL OR role IN ('viewer','contributor')),
  decided_by TEXT REFERENCES accounts(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_join_pending ON join_requests (tree_id, account_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_join_tree ON join_requests (tree_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_join_account ON join_requests (account_id, status);

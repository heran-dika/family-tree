-- Sesi login. id = SHA-256 (hex) dari token acak di cookie; token mentah tidak pernah disimpan.
-- Kedaluwarsa mutlak (tanpa perpanjangan otomatis) supaya tidak ada tulis per permintaan.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id, expires_at);

-- Login lewat link sekali pakai (tanpa email), untuk anggota yang tidak punya akun Google. Sudah diterapkan di D1.
ALTER TABLE accounts ADD COLUMN login_link INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS guest_tokens (id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES family_trees(id), account_id TEXT NOT NULL REFERENCES accounts(id), token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL REFERENCES accounts(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT);
CREATE INDEX IF NOT EXISTS idx_guest_account ON guest_tokens (account_id);

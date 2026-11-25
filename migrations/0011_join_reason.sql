-- Alasan tolak permintaan bergabung (maks 300 karakter). Sudah diterapkan di D1.
ALTER TABLE join_requests ADD COLUMN reason TEXT CHECK (reason IS NULL OR length(reason) <= 300);

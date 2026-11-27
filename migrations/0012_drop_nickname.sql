-- Nama panggilan dibuang (PRD v1.4, T1). Kolom tidak berisi data saat dibuang. Sudah diterapkan di D1.
DROP INDEX IF EXISTS idx_people_nick;
ALTER TABLE people DROP COLUMN nickname;

-- Jenis kelamin (opsional). Hanya dipakai untuk urutan kiri/kanan pasangan di diagram pohon.
-- NULL = tidak diisi. Urutan pasangan yang tidak diisi mengikuti tahun mulai hubungan.
ALTER TABLE people ADD COLUMN gender TEXT CHECK (gender IS NULL OR gender IN ('male','female'));

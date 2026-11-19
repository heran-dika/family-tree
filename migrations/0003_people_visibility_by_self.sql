-- Penanda: 1 bila pengaturan privasi tanggal lahir dipilih oleh orangnya sendiri (sebagai dewasa).
-- Tanpa ini, pengaturan lama yang dibuat wali tidak bisa dibedakan dari pilihan sendiri, padahal
-- PRD P1-5 melarang pengaturan lama otomatis membuka data saat anak berusia 18 tahun.
ALTER TABLE people ADD COLUMN visibility_by_self INTEGER NOT NULL DEFAULT 0 CHECK (visibility_by_self IN (0,1));

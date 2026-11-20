-- Alur undangan (jalur A).
-- accepted_by: akun yang mengajukan bergabung memakai undangan ini (diisi saat undangan dipakai).
ALTER TABLE invitations ADD COLUMN accepted_by TEXT REFERENCES accounts(id);
-- Satu undangan aktif (menunggu atau menunggu persetujuan) per email per pohon.
-- Kirim ulang = membatalkan yang menunggu lalu membuat yang baru dalam satu batch.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invite_active
  ON invitations (tree_id, lower(email))
  WHERE status IN ('pending','awaiting_approval');

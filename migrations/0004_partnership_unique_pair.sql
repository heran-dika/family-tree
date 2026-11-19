-- Satu catatan pasangan per pasangan orang; urutan A/B tidak berpengaruh.
-- Pernikahan ulang dicatat dengan mengubah catatan yang sama (status dan tahun), bukan menambah baris.
-- Penegakan di level database: pada batch yang gagal karena ini, seluruh batch (termasuk penutupan usulan) dibatalkan.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_pair
  ON partnerships (tree_id, min(person_a, person_b), max(person_a, person_b));

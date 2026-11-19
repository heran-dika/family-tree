-- Satu relasi orang tua-anak per pasangan (orang tua, anak), apa pun jenisnya.
-- Mengubah jenis relasi (mis. angkat menjadi kandung) dilakukan dengan mengubah relasi yang sama.
CREATE UNIQUE INDEX IF NOT EXISTS uq_edge_pair ON parent_child_edges (tree_id, parent_id, child_id);

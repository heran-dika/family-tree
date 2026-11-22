-- Kuota pohon per akun (PRD A3: satu pohon per akun, dihitung dari family_trees.created_by).
-- Bawaan 1; kasus sah dua pohon (garis ayah dan ibu) dinaikkan manual per akun:
--   UPDATE accounts SET tree_quota = 2 WHERE email = '...';
ALTER TABLE accounts ADD COLUMN tree_quota INTEGER NOT NULL DEFAULT 1 CHECK (tree_quota >= 0);

-- 0006_node_embedding.sql
-- Optional embedding vector per node (stored as float8[]; cosine computed in app).
-- Nullable: nodes created without an embeddings key simply have no vector and fall back to keyword.
alter table knowledge_node add column if not exists embedding double precision[];

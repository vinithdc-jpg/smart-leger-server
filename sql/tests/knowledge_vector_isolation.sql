-- Run after knowledge_docs_pgvector.sql in a non-production database with two clubs.
-- All fixture inserts are rolled back when the script completes.
BEGIN;

DO $$
DECLARE
  club_a text;
  club_b text;
  document_a text := 'vector_isolation_a_' || txid_current()::text;
  document_b text := 'vector_isolation_b_' || txid_current()::text;
  test_embedding vector(384);
BEGIN
  SELECT club_id::text INTO club_a FROM clubs ORDER BY club_id LIMIT 1;
  SELECT club_id::text INTO club_b FROM clubs ORDER BY club_id OFFSET 1 LIMIT 1;

  IF club_a IS NULL OR club_b IS NULL THEN
    RAISE EXCEPTION 'Isolation test requires at least two clubs';
  END IF;

  test_embedding := (
    '[' || array_to_string(array_fill(0::real, ARRAY[384]), ',') || ']'
  )::vector(384);

  INSERT INTO knowledge_docs (
    id, club_id, source_type, source_id, title, category, content,
    metadata, embedding, source, approved
  ) VALUES
    (document_a, club_a, 'general', document_a, 'Club A fixture', 'general',
     'Club A isolation fixture', '{}'::jsonb, test_embedding, 'test', true),
    (document_b, club_b, 'general', document_b, 'Club B fixture', 'general',
     'Club B isolation fixture', '{}'::jsonb, test_embedding, 'test', true);

  IF NOT EXISTS (
    SELECT 1 FROM match_documents(test_embedding, 0, 20, club_a)
    WHERE id = document_a AND club_id = club_a
  ) THEN
    RAISE EXCEPTION 'Club A could not retrieve its own vector document';
  END IF;

  IF EXISTS (
    SELECT 1 FROM match_documents(test_embedding, 0, 20, club_a)
    WHERE id = document_b OR club_id <> club_a
  ) THEN
    RAISE EXCEPTION 'Club A retrieved a vector document belonging to another club';
  END IF;

  RAISE NOTICE 'PASS: Club A retrieves its own document and cannot retrieve Club B documents';
END;
$$;

ROLLBACK;

-- Run once in the Supabase SQL editor. Existing knowledge_docs records remain in place.
CREATE EXTENSION IF NOT EXISTS vector;

-- Xenova/all-MiniLM-L6-v2 produces 384-dimensional embeddings.
ALTER TABLE knowledge_docs
	ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
	ADD COLUMN IF NOT EXISTS approved boolean NOT NULL DEFAULT true,
	ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'general',
	ADD COLUMN IF NOT EXISTS source_id text,
	ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE knowledge_docs
SET source_id = id::text,
		source_type = CASE
			WHEN LOWER(COALESCE(category, '')) IN ('policy', 'faq', 'procedure', 'transaction', 'payment', 'member', 'ai_chat')
				THEN LOWER(category)
			ELSE 'general'
		END
WHERE source_id IS NULL;

-- Retain legacy unowned content, but it must not remain searchable as a vector.
UPDATE knowledge_docs
SET embedding = NULL
WHERE club_id IS NULL AND embedding IS NOT NULL;

ALTER TABLE knowledge_docs
	ALTER COLUMN source_id SET NOT NULL;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_docs_source_type_check'
	) THEN
		ALTER TABLE knowledge_docs
			ADD CONSTRAINT knowledge_docs_source_type_check
			CHECK (source_type IN ('policy', 'faq', 'procedure', 'transaction', 'payment', 'member', 'ai_chat', 'general'));
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_docs_club_id_required'
	) THEN
		ALTER TABLE knowledge_docs
			ADD CONSTRAINT knowledge_docs_club_id_required
			CHECK (club_id IS NOT NULL) NOT VALID;
	END IF;
END;
$$;

-- Existing unowned legacy rows are retained but cannot be queried by the RPC.
-- The NOT VALID check still rejects any new row with no club_id.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_docs_source_identity_idx
	ON knowledge_docs (club_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS knowledge_docs_approved_club_idx
	ON knowledge_docs (club_id, approved);

CREATE INDEX IF NOT EXISTS knowledge_docs_embedding_idx
	ON knowledge_docs USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS ai_chat_logs (
	id bigserial PRIMARY KEY,
	club_id text NOT NULL,
	staff_id text NOT NULL,
	member_id text,
	question text NOT NULL,
	answer text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_chat_logs_club_created_idx
	ON ai_chat_logs (club_id, created_at DESC);

ALTER TABLE knowledge_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_chat_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE knowledge_docs, ai_chat_logs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE knowledge_docs, ai_chat_logs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE ai_chat_logs_id_seq TO service_role;

DROP POLICY IF EXISTS knowledge_docs_service_role_all ON knowledge_docs;
CREATE POLICY knowledge_docs_service_role_all ON knowledge_docs
	FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ai_chat_logs_service_role_all ON ai_chat_logs;
CREATE POLICY ai_chat_logs_service_role_all ON ai_chat_logs
	FOR ALL TO service_role USING (true) WITH CHECK (true);

-- The caller supplies the authenticated club scope. Filtering occurs in SQL
-- before vector ranking; there is deliberately no NULL-club fallback.
CREATE OR REPLACE FUNCTION match_documents(
	query_embedding vector(384),
	match_threshold real,
	match_count integer,
	filter_club_id text
)
RETURNS TABLE (
	id text,
	club_id text,
	source_type text,
	source_id text,
	title text,
	category text,
	content text,
	metadata jsonb,
	similarity double precision
)
LANGUAGE sql
STABLE
AS $$
	SELECT
		d.id::text,
		d.club_id::text,
		d.source_type,
		d.source_id,
		d.title::text,
		d.category::text,
		d.content::text,
		d.metadata,
		(1 - (d.embedding <=> query_embedding))::double precision AS similarity
	FROM knowledge_docs AS d
	WHERE d.club_id::text = filter_club_id
		AND d.approved = true
		AND d.embedding IS NOT NULL
		AND 1 - (d.embedding <=> query_embedding) >= match_threshold
	ORDER BY d.embedding <=> query_embedding
	LIMIT LEAST(GREATEST(COALESCE(match_count, 5), 1), 20);
$$;

REVOKE ALL ON FUNCTION match_documents(vector, real, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION match_documents(vector, real, integer, text) TO service_role;
-- ============================================
-- Treelogy Wellness Truth Engine — Database Schema
-- Run this in your Supabase SQL Editor
-- ============================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Knowledge chunks table with vector embeddings
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  embedding VECTOR(384), -- all-MiniLM-L6-v2 outputs 384 dimensions
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create HNSW index for fast similarity search
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
  ON knowledge_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Index on metadata for filtered queries
CREATE INDEX IF NOT EXISTS knowledge_chunks_metadata_idx
  ON knowledge_chunks USING GIN (metadata);

-- RPC function for cosine similarity search
CREATE OR REPLACE FUNCTION match_knowledge_chunks(
  query_embedding VECTOR(384),
  match_threshold FLOAT DEFAULT 0.5,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  id BIGINT,
  content TEXT,
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.content,
    kc.metadata,
    1 - (kc.embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks kc
  WHERE 1 - (kc.embedding <=> query_embedding) > match_threshold
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Audit logs table
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT,
  source_type VARCHAR(20), -- 'internal', 'web', 'none'
  confidence FLOAT,
  verified BOOLEAN,
  sources JSONB DEFAULT '[]',
  user_id VARCHAR(255) DEFAULT 'anonymous',
  response_time_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for audit log queries
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_source_type_idx ON audit_logs (source_type);
CREATE INDEX IF NOT EXISTS audit_logs_verified_idx ON audit_logs (verified);

-- Row-Level Security (enable but allow service role full access)
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to knowledge_chunks"
  ON knowledge_chunks FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access to audit_logs"
  ON audit_logs FOR ALL
  USING (auth.role() = 'service_role');

const supabase = require('../config/supabase');
const { generateEmbedding, generateEmbeddings } = require('./embeddings');

const TABLE_NAME = 'knowledge_chunks';

/**
 * Store document chunks with their embeddings in Supabase pgvector.
 */
async function storeChunks(chunks) {
  const texts = chunks.map((c) => c.content);
  const embeddings = await generateEmbeddings(texts);

  const rows = chunks.map((chunk, i) => ({
    content: chunk.content,
    embedding: embeddings[i],
    metadata: chunk.metadata,
  }));

  // Insert in batches of 50 to avoid payload limits
  const batchSize = 50;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(TABLE_NAME).insert(batch);
    if (error) throw new Error(`Vector store insert failed: ${error.message}`);
  }

  return rows.length;
}

/**
 * Semantic search: find the most relevant chunks for a query.
 * Uses pgvector's cosine similarity via a Supabase RPC function.
 */
async function searchSimilar(query, topK = 5) {
  const queryEmbedding = await generateEmbedding(query);

  const { data, error } = await supabase.rpc('match_knowledge_chunks', {
    query_embedding: queryEmbedding,
    match_threshold: 0.5,
    match_count: topK,
  });

  if (error) throw new Error(`Vector search failed: ${error.message}`);

  return data.map((row) => ({
    content: row.content,
    similarity: row.similarity,
    metadata: row.metadata,
  }));
}

/**
 * Clear all stored chunks (for re-ingestion).
 */
async function clearStore() {
  const { error } = await supabase.from(TABLE_NAME).delete().neq('id', 0);
  if (error) throw new Error(`Clear store failed: ${error.message}`);
}

module.exports = { storeChunks, searchSimilar, clearStore };

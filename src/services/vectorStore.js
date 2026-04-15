const crypto = require('crypto');
const supabase = require('../config/supabase');
const { generateEmbedding, generateEmbeddings } = require('./embeddings');

/**
 * Register a document in knowledge_documents, returning its ID.
 */
async function registerDocument({ filename, fileSize, mimeType, pageCount, uploadedBy, fileHash }) {
  const { data, error } = await supabase
    .from('knowledge_documents')
    .insert({
      filename,
      file_size: fileSize || 0,
      mime_type: mimeType || 'application/pdf',
      page_count: pageCount || 0,
      status: 'processing',
      file_hash: fileHash || null,
      uploaded_by: uploadedBy || null,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Document registration failed: ${error.message}`);
  return data.id;
}

/**
 * Update document status and chunk_count after processing.
 */
async function finalizeDocument(documentId, { chunkCount, status = 'ready', errorMessage = null }) {
  const { error } = await supabase
    .from('knowledge_documents')
    .update({
      chunk_count: chunkCount || 0,
      status,
      error_message: errorMessage,
    })
    .eq('id', documentId);

  if (error) throw new Error(`Document finalize failed: ${error.message}`);
}

/**
 * Check if a document with the same hash already exists.
 */
async function findDocumentByHash(fileBuffer) {
  const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const { data } = await supabase
    .from('knowledge_documents')
    .select('id, filename, status')
    .eq('file_hash', hash)
    .eq('status', 'ready')
    .limit(1);

  return { hash, existing: data?.[0] || null };
}

/**
 * Store document chunks with their embeddings in Supabase pgvector.
 * Now linked to a parent document via document_id.
 */
async function storeChunks(chunks, documentId) {
  const texts = chunks.map((c) => c.content);
  const embeddings = await generateEmbeddings(texts);

  const rows = chunks.map((chunk, i) => ({
    document_id: documentId,
    content: chunk.content,
    embedding: embeddings[i],
    chunk_index: i,
    page_number: chunk.metadata?.page || null,
    section_title: chunk.metadata?.section || null,
    token_count: Math.ceil(chunk.content.length / 4), // rough estimate
    metadata: chunk.metadata || {},
  }));

  // Insert in batches of 50 to avoid payload limits
  const batchSize = 50;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from('knowledge_chunks').insert(batch);
    if (error) throw new Error(`Vector store insert failed: ${error.message}`);
  }

  return rows.length;
}

/**
 * Semantic search: find the most relevant chunks for a query.
 * Uses pgvector's cosine similarity via the match_knowledge_chunks RPC.
 *
 * Threshold is relaxed at DB level (0.30) so the orchestrator can apply
 * hybrid re-ranking (keyword + MMR) on a broader candidate pool.
 */
async function searchSimilar(query, topK = 5) {
  const queryEmbedding = await generateEmbedding(query);

  const { data, error } = await supabase.rpc('match_knowledge_chunks', {
    query_embedding: queryEmbedding,
    match_threshold: 0.30,
    match_count: Math.max(topK * 3, 15),
  });

  if (error) throw new Error(`Vector search failed: ${error.message}`);

  return data.map((row) => ({
    content: row.content,
    similarity: row.similarity,
    metadata: row.metadata,
    pageNumber: row.page_number,
    sectionTitle: row.section_title,
    documentId: row.document_id,
  }));
}

/**
 * Keyword search: ILIKE-based fallback for exact-term matches
 * (product names, ingredient names, SKUs, Indonesian-specific terms)
 * that pure vector similarity can miss.
 */
async function keywordSearch(keywords, topK = 10) {
  if (!keywords || keywords.length === 0) return [];

  // Build an OR filter of ILIKE patterns
  const orFilter = keywords
    .filter((k) => k && k.length >= 3)
    .slice(0, 8)
    .map((k) => `content.ilike.%${k.replace(/[%_,]/g, ' ')}%`)
    .join(',');

  if (!orFilter) return [];

  const { data, error } = await supabase
    .from('knowledge_chunks')
    .select('content, metadata, page_number, section_title, document_id')
    .or(orFilter)
    .limit(topK);

  if (error) return [];

  return (data || []).map((row) => ({
    content: row.content,
    similarity: 0, // unknown — orchestrator will score by keyword overlap
    metadata: row.metadata,
    pageNumber: row.page_number,
    sectionTitle: row.section_title,
    documentId: row.document_id,
    keywordHit: true,
  }));
}

/**
 * Get all documents in the knowledge base.
 */
async function listDocuments() {
  const { data, error } = await supabase
    .from('knowledge_documents')
    .select('id, filename, file_size, page_count, chunk_count, status, created_at')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`List documents failed: ${error.message}`);
  return data;
}

/**
 * Delete a single document and its chunks (CASCADE handles chunks).
 */
async function deleteDocument(documentId) {
  const { error } = await supabase
    .from('knowledge_documents')
    .delete()
    .eq('id', documentId);

  if (error) throw new Error(`Delete document failed: ${error.message}`);
}

/**
 * Clear all stored documents and chunks.
 */
async function clearStore() {
  const { error } = await supabase
    .from('knowledge_documents')
    .delete()
    .neq('status', '___never___');

  if (error) throw new Error(`Clear store failed: ${error.message}`);
}

/**
 * Get knowledge base stats via the get_knowledge_stats() RPC.
 */
async function getKnowledgeStats() {
  const { data, error } = await supabase.rpc('get_knowledge_stats');
  if (error) throw new Error(`Stats query failed: ${error.message}`);
  return data;
}

module.exports = {
  registerDocument,
  finalizeDocument,
  findDocumentByHash,
  storeChunks,
  searchSimilar,
  keywordSearch,
  listDocuments,
  deleteDocument,
  clearStore,
  getKnowledgeStats,
};

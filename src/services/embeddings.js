const { hf } = require('../config/huggingface');

const EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';

/**
 * Generate embeddings for a single text string.
 */
async function generateEmbedding(text) {
  const result = await hf.featureExtraction({
    model: EMBEDDING_MODEL,
    inputs: text,
  });
  return Array.from(result);
}

/**
 * Generate embeddings for multiple texts in batch.
 */
async function generateEmbeddings(texts) {
  const results = await Promise.all(
    texts.map((text) => generateEmbedding(text))
  );
  return results;
}

module.exports = { generateEmbedding, generateEmbeddings, EMBEDDING_MODEL };

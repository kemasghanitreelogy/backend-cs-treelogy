#!/usr/bin/env node

/**
 * CLI script to ingest all documents (PDF + DOCX) from data/documents/ into the vector store.
 * Usage: npm run ingest [--clear]
 */

require('dotenv').config();

const path = require('path');
const { loadDirectory, SUPPORTED_EXTENSIONS } = require('../src/services/documentLoader');
const { semanticChunk } = require('../src/services/chunker');
const { storeChunks, clearStore } = require('../src/services/vectorStore');

const DOCS_DIR = path.resolve(__dirname, '../data/documents');

async function main() {
  const args = process.argv.slice(2);
  const shouldClear = args.includes('--clear');

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Treelogy Knowledge Ingestion Pipeline      ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`Supported formats: ${SUPPORTED_EXTENSIONS.join(', ')}\n`);

  if (shouldClear) {
    console.log('[1/4] Clearing existing knowledge store...');
    await clearStore();
    console.log('       Store cleared.\n');
  } else {
    console.log('[1/4] Skipping store clear (use --clear to wipe first).\n');
  }

  console.log(`[2/4] Loading documents from ${DOCS_DIR}...`);
  let documents;
  try {
    documents = await loadDirectory(DOCS_DIR);
  } catch (err) {
    console.error(`       Error: ${err.message}`);
    console.error(`       Make sure data/documents/ exists and contains ${SUPPORTED_EXTENSIONS.join(' or ')} files.`);
    process.exit(1);
  }

  if (documents.length === 0) {
    console.error(`       No supported files found. Place your documents (${SUPPORTED_EXTENSIONS.join(', ')}) in data/documents/`);
    process.exit(1);
  }

  console.log(`       Found ${documents.length} document(s).\n`);

  console.log('[3/4] Chunking documents semantically...');
  const allChunks = [];
  for (const doc of documents) {
    const chunks = semanticChunk(doc.text, doc.metadata);
    allChunks.push(...chunks);
    const pageInfo = doc.metadata.pages ? `${doc.metadata.pages} pages` : doc.metadata.type;
    console.log(`       "${doc.metadata.name}" (${pageInfo}): ${chunks.length} chunks`);
  }
  console.log(`       Total: ${allChunks.length} chunks\n`);

  console.log('[4/4] Generating embeddings and storing in vector database...');
  const stored = await storeChunks(allChunks);
  console.log(`       Stored ${stored} chunks successfully.\n`);

  console.log('Done. Your knowledge base is ready.');
}

main().catch((err) => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});

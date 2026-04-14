const fs = require('fs');
const path = require('path');
const { loadPDF, loadDirectory } = require('../services/documentLoader');
const { semanticChunk } = require('../services/chunker');
const { storeChunks, clearStore } = require('../services/vectorStore');

/**
 * POST /api/ingest/file
 * Ingest a single uploaded PDF into the vector store.
 */
async function handleFileIngest(req, res) {
  try {
    const filePath = req.file.path;
    const document = await loadPDF(filePath);
    const chunks = semanticChunk(document.text, document.metadata);
    const stored = await storeChunks(chunks);

    // Clean up the temp upload
    fs.unlinkSync(filePath);

    res.json({
      message: `Successfully ingested "${document.metadata.name}"`,
      chunks: stored,
      pages: document.metadata.pages,
    });
  } catch (err) {
    console.error('[IngestionController] File error:', err);
    res.status(500).json({ error: 'Failed to ingest document.', details: err.message });
  }
}

/**
 * POST /api/ingest/directory
 * Ingest all PDFs from the data/documents directory.
 */
async function handleDirectoryIngest(req, res) {
  try {
    const dirPath = path.resolve(__dirname, '../../data/documents');

    if (!fs.existsSync(dirPath)) {
      return res.status(404).json({ error: 'Documents directory not found.' });
    }

    const documents = await loadDirectory(dirPath);

    if (documents.length === 0) {
      return res.status(404).json({ error: 'No PDF files found in documents directory.' });
    }

    let totalChunks = 0;
    const results = [];

    for (const doc of documents) {
      const chunks = semanticChunk(doc.text, doc.metadata);
      const stored = await storeChunks(chunks);
      totalChunks += stored;
      results.push({
        file: doc.metadata.name,
        chunks: stored,
        pages: doc.metadata.pages,
      });
    }

    res.json({
      message: `Ingested ${documents.length} documents with ${totalChunks} total chunks.`,
      documents: results,
    });
  } catch (err) {
    console.error('[IngestionController] Directory error:', err);
    res.status(500).json({ error: 'Failed to ingest directory.', details: err.message });
  }
}

/**
 * DELETE /api/ingest
 * Clear the entire vector store for re-ingestion.
 */
async function handleClearStore(req, res) {
  try {
    await clearStore();
    res.json({ message: 'Knowledge store cleared successfully.' });
  } catch (err) {
    console.error('[IngestionController] Clear error:', err);
    res.status(500).json({ error: 'Failed to clear store.', details: err.message });
  }
}

module.exports = { handleFileIngest, handleDirectoryIngest, handleClearStore };

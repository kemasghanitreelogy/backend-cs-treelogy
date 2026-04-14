const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadDocument, loadDirectory } = require('../services/documentLoader');
const { semanticChunk } = require('../services/chunker');
const {
  registerDocument,
  finalizeDocument,
  findDocumentByHash,
  storeChunks,
  clearStore,
  listDocuments,
  deleteDocument,
  getKnowledgeStats,
} = require('../services/vectorStore');

/**
 * POST /api/ingest/file
 * Ingest a single uploaded document into the vector store.
 * Now tracks the document lifecycle in knowledge_documents.
 */
async function handleFileIngest(req, res) {
  let documentId = null;

  try {
    const filePath = req.file.path;
    const originalExt = path.extname(req.file.originalname).toLowerCase();
    const targetPath = filePath + originalExt;

    fs.renameSync(filePath, targetPath);

    // Check for duplicate by file hash
    const fileBuffer = fs.readFileSync(targetPath);
    const { hash, existing } = await findDocumentByHash(fileBuffer);

    if (existing) {
      fs.unlinkSync(targetPath);
      return res.status(409).json({
        error: 'Duplicate document',
        message: `"${existing.filename}" already exists in the knowledge base.`,
        existingDocumentId: existing.id,
      });
    }

    // Parse the document
    const document = await loadDocument(targetPath);

    // Register in knowledge_documents
    documentId = await registerDocument({
      filename: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype || 'application/pdf',
      pageCount: document.metadata.pages || 0,
      uploadedBy: req.headers['x-user-id'] || null,
      fileHash: hash,
    });

    // Chunk and embed
    const chunks = semanticChunk(document.text, document.metadata);
    const stored = await storeChunks(chunks, documentId);

    // Mark document as ready
    await finalizeDocument(documentId, { chunkCount: stored, status: 'ready' });

    fs.unlinkSync(targetPath);

    res.json({
      message: `Successfully ingested "${document.metadata.name}"`,
      documentId,
      chunks: stored,
      type: document.metadata.type,
      pages: document.metadata.pages || null,
    });
  } catch (err) {
    console.error('[IngestionController] File error:', err);

    // Mark document as failed if it was registered
    if (documentId) {
      await finalizeDocument(documentId, { status: 'failed', errorMessage: err.message }).catch(() => {});
    }

    res.status(500).json({ error: 'Failed to ingest document.', details: err.message });
  }
}

/**
 * POST /api/ingest/directory
 * Ingest all documents from the data/documents directory.
 */
async function handleDirectoryIngest(req, res) {
  try {
    const dirPath = path.resolve(__dirname, '../../data/documents');

    if (!fs.existsSync(dirPath)) {
      return res.status(404).json({ error: 'Documents directory not found.' });
    }

    const documents = await loadDirectory(dirPath);

    if (documents.length === 0) {
      return res.status(404).json({ error: 'No supported documents found in documents directory.' });
    }

    let totalChunks = 0;
    const results = [];

    for (const doc of documents) {
      let docId = null;
      try {
        docId = await registerDocument({
          filename: doc.metadata.name,
          fileSize: doc.metadata.size || 0,
          mimeType: doc.metadata.type === 'pdf' ? 'application/pdf' : 'application/octet-stream',
          pageCount: doc.metadata.pages || 0,
        });

        const chunks = semanticChunk(doc.text, doc.metadata);
        const stored = await storeChunks(chunks, docId);
        totalChunks += stored;

        await finalizeDocument(docId, { chunkCount: stored, status: 'ready' });

        results.push({ file: doc.metadata.name, documentId: docId, chunks: stored, pages: doc.metadata.pages || null });
      } catch (docErr) {
        if (docId) await finalizeDocument(docId, { status: 'failed', errorMessage: docErr.message }).catch(() => {});
        results.push({ file: doc.metadata.name, error: docErr.message });
      }
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
 * GET /api/ingest/documents
 * List all documents in the knowledge base.
 */
async function handleListDocuments(req, res) {
  try {
    const documents = await listDocuments();
    const stats = await getKnowledgeStats();
    res.json({ documents, stats });
  } catch (err) {
    console.error('[IngestionController] List error:', err);
    res.status(500).json({ error: 'Failed to list documents.', details: err.message });
  }
}

/**
 * DELETE /api/ingest/:id
 * Delete a single document and its chunks.
 */
async function handleDeleteDocument(req, res) {
  try {
    await deleteDocument(req.params.id);
    res.json({ message: 'Document deleted successfully.' });
  } catch (err) {
    console.error('[IngestionController] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete document.', details: err.message });
  }
}

/**
 * DELETE /api/ingest
 * Clear the entire knowledge base.
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

module.exports = {
  handleFileIngest,
  handleDirectoryIngest,
  handleListDocuments,
  handleDeleteDocument,
  handleClearStore,
};

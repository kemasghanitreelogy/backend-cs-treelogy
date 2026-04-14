/**
 * Semantic Chunker
 *
 * Instead of splitting text at arbitrary character counts, this splitter
 * breaks text at natural semantic boundaries — paragraph breaks, section
 * headers, and topic shifts — to preserve context integrity.
 */

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z])/g;
const SECTION_BOUNDARY = /\n{2,}/g;

/**
 * Split text into semantically coherent chunks.
 * Priority: section breaks > paragraph breaks > sentence breaks > hard limit.
 */
function semanticChunk(text, metadata = {}) {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();

  // First, split by section boundaries (double newlines)
  const sections = cleaned.split(SECTION_BOUNDARY).filter((s) => s.trim());

  const chunks = [];
  let currentChunk = '';

  for (const section of sections) {
    // If adding this section would exceed chunk size, finalize current chunk
    if (currentChunk.length + section.length > CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push(createChunk(currentChunk, metadata, chunks.length));
      // Keep overlap from the end of the current chunk
      currentChunk = getOverlap(currentChunk);
    }

    // If a single section exceeds chunk size, split by sentences
    if (section.length > CHUNK_SIZE) {
      const sentences = section.split(SENTENCE_BOUNDARY);
      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length > CHUNK_SIZE && currentChunk.length > 0) {
          chunks.push(createChunk(currentChunk, metadata, chunks.length));
          currentChunk = getOverlap(currentChunk);
        }
        currentChunk += (currentChunk ? ' ' : '') + sentence.trim();
      }
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + section.trim();
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunks.push(createChunk(currentChunk, metadata, chunks.length));
  }

  return chunks;
}

function createChunk(text, metadata, index) {
  return {
    content: text.trim(),
    metadata: {
      ...metadata,
      chunkIndex: index,
      charCount: text.trim().length,
    },
  };
}

function getOverlap(text) {
  if (text.length <= CHUNK_OVERLAP) return text;
  const overlapText = text.slice(-CHUNK_OVERLAP);
  // Start from the nearest sentence boundary within the overlap
  const sentenceStart = overlapText.search(/(?<=[.!?])\s/);
  return sentenceStart > 0 ? overlapText.slice(sentenceStart).trim() : overlapText.trim();
}

module.exports = { semanticChunk, CHUNK_SIZE, CHUNK_OVERLAP };

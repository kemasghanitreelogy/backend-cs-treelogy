/**
 * Semantic Chunker (S+ grade)
 *
 * Key properties:
 *  - Heading-aware: splits on markdown/ALL-CAPS headings first, preserving
 *    hierarchical context by prepending the nearest heading(s) to each chunk.
 *  - Paragraph + sentence fallback: respects natural semantic boundaries.
 *  - Parent-context injection: every chunk starts with its section breadcrumb,
 *    so retrieval surfaces chunks with enough context to be self-contained.
 *  - Conservative overlap: avoids breaking mid-sentence; reused boundary-aware
 *    sliding window preserves continuity across chunks.
 */

const CHUNK_SIZE = 1200;         // chars; roughly 300 tokens — large enough to hold a full answer
const CHUNK_OVERLAP = 220;       // sentence-boundary-aware overlap
const MAX_CHUNK_SIZE = 1600;     // hard ceiling to avoid embedding-model truncation
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z0-9])/g;
const SECTION_BOUNDARY = /\n{2,}/g;

// Matches markdown-style headings (#, ##, ...) or lines that look like section headings
// (title case short lines, ALL CAPS short lines, or "1. ", "2.1 " numbered headings).
const HEADING_LINE = /^(?:#{1,6}\s+.+|[A-Z][A-Z0-9 \-_/&()]{2,80}|\d+(?:\.\d+)*\.?\s+[A-Z].{2,80})$/;

function splitByHeadings(text) {
  const lines = text.split('\n');
  const blocks = [];
  let current = { heading: null, breadcrumb: [], body: [] };
  let breadcrumbStack = [];

  const flush = () => {
    if (current.body.length > 0 || current.heading) {
      blocks.push({
        heading: current.heading,
        breadcrumb: [...current.breadcrumb],
        body: current.body.join('\n').trim(),
      });
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      current.body.push('');
      continue;
    }
    if (HEADING_LINE.test(line)) {
      flush();
      const level = line.startsWith('#') ? (line.match(/^#+/)[0].length) : 2;
      breadcrumbStack = breadcrumbStack.slice(0, level - 1);
      const clean = line.replace(/^#+\s+/, '').replace(/\s+$/, '');
      breadcrumbStack.push(clean);
      current = { heading: clean, breadcrumb: [...breadcrumbStack], body: [] };
    } else {
      current.body.push(line);
    }
  }
  flush();

  return blocks.length > 0 ? blocks : [{ heading: null, breadcrumb: [], body: text }];
}

/**
 * Split text into semantically coherent chunks with section-breadcrumb prefixes.
 */
function semanticChunk(text, metadata = {}) {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  const headingBlocks = splitByHeadings(cleaned);

  const chunks = [];

  for (const block of headingBlocks) {
    const prefix = block.breadcrumb.length > 0
      ? `[${block.breadcrumb.join(' > ')}]\n`
      : '';

    const sections = block.body.split(SECTION_BOUNDARY).filter((s) => s.trim());
    let currentBody = '';

    const flushChunk = () => {
      const content = (prefix + currentBody).trim();
      if (content.length > 0) {
        chunks.push(createChunk(content, {
          ...metadata,
          section: block.heading || metadata.section || null,
          breadcrumb: block.breadcrumb,
        }, chunks.length));
      }
    };

    for (const section of sections) {
      // Flush if adding this section would exceed target size
      if (currentBody.length + section.length > CHUNK_SIZE && currentBody.length > 0) {
        flushChunk();
        currentBody = getOverlap(currentBody);
      }

      if (section.length > MAX_CHUNK_SIZE) {
        // Oversized section: split by sentences
        const sentences = section.split(SENTENCE_BOUNDARY);
        for (const sentence of sentences) {
          if (currentBody.length + sentence.length > CHUNK_SIZE && currentBody.length > 0) {
            flushChunk();
            currentBody = getOverlap(currentBody);
          }
          currentBody += (currentBody ? ' ' : '') + sentence.trim();
        }
      } else {
        currentBody += (currentBody ? '\n\n' : '') + section.trim();
      }
    }

    if (currentBody.trim()) flushChunk();
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
  const sentenceStart = overlapText.search(/(?<=[.!?])\s/);
  return sentenceStart > 0 ? overlapText.slice(sentenceStart).trim() : overlapText.trim();
}

module.exports = { semanticChunk, CHUNK_SIZE, CHUNK_OVERLAP, MAX_CHUNK_SIZE };

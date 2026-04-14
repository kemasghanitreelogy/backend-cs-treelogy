const { searchSimilar } = require('./vectorStore');
const { searchMedical } = require('./tavilySearch');
const { generateResponse, streamResponse } = require('./llm');
const {
  buildRetrievalPrompt,
  buildFactCheckPrompt,
  buildFallbackPrompt,
} = require('../prompts/wellness');

const SIMILARITY_THRESHOLD = 0.75;
const MEDICAL_DISCLAIMER = `\n\n---\n**Disclaimer:** This information is provided for educational and wellness purposes only and does not constitute medical advice. Always consult a qualified healthcare professional before making health decisions. Treelogy does not diagnose, treat, or cure any medical condition.`;

/**
 * Full RAG pipeline:
 * 1. Semantic search against internal knowledge
 * 2. Confidence check against threshold
 * 3. Tavily fallback if confidence is low
 * 4. LLM generation with guardrail prompts
 * 5. Fact-check loop
 * 6. Citation + disclaimer attachment
 */
async function processQuery(question) {
  // Step 1: Semantic search
  const internalResults = await searchSimilar(question, 5);
  const bestScore = internalResults.length > 0 ? internalResults[0].similarity : 0;

  let context;
  let sourceType;
  let sources;

  // Step 2: Confidence check
  if (bestScore >= SIMILARITY_THRESHOLD && internalResults.length > 0) {
    // Internal knowledge is confident
    context = internalResults.map((r) => r.content);
    sources = internalResults.map((r) => r.metadata);
    sourceType = 'internal';
  } else {
    // Step 3: Tavily fallback
    const webResults = await searchMedical(question);
    if (webResults.length === 0) {
      return {
        answer: `I don't have enough information in our knowledge base or from authoritative medical sources to confidently answer this question. Please consult a healthcare professional for personalized guidance.${MEDICAL_DISCLAIMER}`,
        sources: [],
        sourceType: 'none',
        confidence: 0,
        verified: false,
      };
    }
    context = webResults.map((r) => r.content);
    sources = webResults.map((r) => ({ name: r.title, url: r.url }));
    sourceType = 'web';
  }

  // Step 4: Generate answer
  const prompt =
    sourceType === 'internal'
      ? buildRetrievalPrompt(question, context, sources)
      : buildFallbackPrompt(question, sources.map((s, i) => ({ ...s, content: context[i] })));

  const rawAnswer = await generateResponse(prompt);

  // Step 5: Fact-check loop
  const factCheckPrompt = buildFactCheckPrompt(rawAnswer, context, sources);
  const factCheckResult = await generateResponse(factCheckPrompt);

  const verified = factCheckResult.includes('VERIFIED: true');
  let finalAnswer = rawAnswer;

  if (!verified) {
    // Extract corrected answer if available
    const correctedMatch = factCheckResult.match(/CORRECTED_ANSWER:\s*([\s\S]+?)$/);
    if (correctedMatch && correctedMatch[1].trim() !== 'N/A') {
      finalAnswer = correctedMatch[1].trim();
    }
  }

  // Step 6: Attach disclaimer
  finalAnswer += MEDICAL_DISCLAIMER;

  return {
    answer: finalAnswer,
    sources: sources.map((s) => ({
      name: s.name || s.title || 'Unknown',
      reference: s.url || s.path || `Document: ${s.name}`,
    })),
    sourceType,
    confidence: bestScore,
    verified,
  };
}

/**
 * Streaming version of the RAG pipeline.
 * Performs retrieval and fact-check, then streams the final answer via SSE.
 */
async function* processQueryStream(question) {
  // Retrieval phase (non-streaming)
  const internalResults = await searchSimilar(question, 5);
  const bestScore = internalResults.length > 0 ? internalResults[0].similarity : 0;

  let context;
  let sourceType;
  let sources;

  if (bestScore >= SIMILARITY_THRESHOLD && internalResults.length > 0) {
    context = internalResults.map((r) => r.content);
    sources = internalResults.map((r) => r.metadata);
    sourceType = 'internal';
  } else {
    const webResults = await searchMedical(question);
    if (webResults.length === 0) {
      yield {
        type: 'error',
        data: 'Insufficient information available. Please consult a healthcare professional.',
      };
      return;
    }
    context = webResults.map((r) => r.content);
    sources = webResults.map((r) => ({ name: r.title, url: r.url }));
    sourceType = 'web';
  }

  // Emit metadata first
  yield {
    type: 'metadata',
    data: { sourceType, confidence: bestScore, sourceCount: sources.length },
  };

  // Build prompt and stream the answer
  const prompt =
    sourceType === 'internal'
      ? buildRetrievalPrompt(question, context, sources)
      : buildFallbackPrompt(question, sources.map((s, i) => ({ ...s, content: context[i] })));

  for await (const token of streamResponse(prompt)) {
    yield { type: 'token', data: token };
  }

  // Emit sources and disclaimer at the end
  yield {
    type: 'sources',
    data: sources.map((s) => ({
      name: s.name || s.title || 'Unknown',
      reference: s.url || s.path || `Document: ${s.name}`,
    })),
  };

  yield { type: 'disclaimer', data: MEDICAL_DISCLAIMER };
  yield { type: 'done', data: null };
}

module.exports = { processQuery, processQueryStream, SIMILARITY_THRESHOLD };

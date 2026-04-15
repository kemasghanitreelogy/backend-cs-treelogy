const { searchSimilar } = require('./vectorStore');
const { searchMedical } = require('./tavilySearch');
const { searchFaq, detectLanguage } = require('./faqKnowledge');
const { generateResponse, streamResponse } = require('./llm');
const {
  buildFaqPrompt,
  buildLayeredPrompt,
  buildRetrievalPrompt,
  buildFactCheckPrompt,
  buildFallbackPrompt,
} = require('../prompts/wellness');

// Thresholds
const FAQ_RELEVANCE_THRESHOLD = 15;    // Minimum FAQ relevance score to be considered a match
const VECTOR_SIMILARITY_THRESHOLD = 0.65; // Lowered to catch more document matches
const HIGH_CONFIDENCE_FAQ = 30;         // FAQ score above this = very confident match

const MEDICAL_DISCLAIMER_ID = `\n\n---\n**Disclaimer:** Informasi ini diberikan hanya untuk tujuan edukasi dan kesehatan umum, bukan merupakan saran medis. Selalu konsultasikan dengan tenaga kesehatan profesional sebelum mengambil keputusan kesehatan. Treelogy tidak mendiagnosis, mengobati, atau menyembuhkan kondisi medis apa pun.`;
const MEDICAL_DISCLAIMER_EN = `\n\n---\n**Disclaimer:** This information is provided for educational and wellness purposes only and does not constitute medical advice. Always consult a qualified healthcare professional before making health decisions. Treelogy does not diagnose, treat, or cure any medical condition.`;

/**
 * 3-Tier RAG Pipeline:
 *
 * TIER 1 (Highest Priority): FAQ Articles from Supabase
 *   → Curated, verified by Treelogy team. Most authoritative.
 *
 * TIER 2: Uploaded Documents (PDF/DOCX via vector store)
 *   → Brand knowledge base. Supplements FAQ.
 *
 * TIER 3 (Fallback): Tavily Web Search
 *   → Medical sources. Used only when Tier 1+2 insufficient.
 *
 * Every answer goes through a fact-check loop before delivery.
 */
async function processQuery(question) {
  const language = detectLanguage(question);
  const disclaimer = language === 'id' ? MEDICAL_DISCLAIMER_ID : MEDICAL_DISCLAIMER_EN;

  // === TIER 1: FAQ Search ===
  const faqResults = await searchFaq(question, 5);
  const bestFaqScore = faqResults.length > 0 ? faqResults[0].relevanceScore : 0;

  // === TIER 2: Document Vector Search (run in parallel with FAQ) ===
  const documentResults = await searchSimilar(question, 5);
  const bestDocScore = documentResults.length > 0 ? documentResults[0].similarity : 0;

  let prompt;
  let sourceType;
  let sources;
  let allContext;
  let confidence;

  // --- Decision Logic ---

  if (bestFaqScore >= HIGH_CONFIDENCE_FAQ) {
    // HIGH CONFIDENCE FAQ: FAQ alone is sufficient
    prompt = buildFaqPrompt(question, faqResults, language);
    sourceType = 'faq';
    sources = faqResults.map((f) => ({ name: 'Treelogy FAQ', type: 'faq', category: f.category }));
    allContext = faqResults.map((f) => f.content);
    confidence = Math.min(bestFaqScore / 100, 1);

  } else if (bestFaqScore >= FAQ_RELEVANCE_THRESHOLD && bestDocScore >= VECTOR_SIMILARITY_THRESHOLD) {
    // FAQ + Documents: Layered response
    const docContext = documentResults.map((r) => r.content);
    const docSources = documentResults.map((r) => r.metadata);
    prompt = buildLayeredPrompt(question, faqResults, docContext, docSources, language);
    sourceType = 'faq+documents';
    sources = [
      ...faqResults.map((f) => ({ name: 'Treelogy FAQ', type: 'faq', category: f.category })),
      ...docSources.map((s) => ({ name: s.name, type: 'document', path: s.path })),
    ];
    allContext = [...faqResults.map((f) => f.content), ...docContext];
    confidence = Math.max(bestFaqScore / 100, bestDocScore);

  } else if (bestFaqScore >= FAQ_RELEVANCE_THRESHOLD) {
    // FAQ only (moderate confidence)
    prompt = buildFaqPrompt(question, faqResults, language);
    sourceType = 'faq';
    sources = faqResults.map((f) => ({ name: 'Treelogy FAQ', type: 'faq', category: f.category }));
    allContext = faqResults.map((f) => f.content);
    confidence = bestFaqScore / 100;

  } else if (bestDocScore >= VECTOR_SIMILARITY_THRESHOLD) {
    // Documents only (no relevant FAQ)
    const docContext = documentResults.map((r) => r.content);
    const docSources = documentResults.map((r) => r.metadata);
    prompt = buildRetrievalPrompt(question, docContext, docSources);
    sourceType = 'documents';
    sources = docSources.map((s) => ({ name: s.name, type: 'document', path: s.path }));
    allContext = docContext;
    confidence = bestDocScore;

  } else {
    // === TIER 3: Web Search Fallback ===
    const webResults = await searchMedical(question);

    if (webResults.length === 0 && faqResults.length === 0 && documentResults.length === 0) {
      return {
        answer: language === 'id'
          ? `Maaf, kami tidak memiliki informasi yang cukup untuk menjawab pertanyaan ini dengan percaya diri. Silakan konsultasikan dengan tenaga kesehatan profesional untuk panduan yang lebih personal.${disclaimer}`
          : `I don't have enough information in our knowledge base or from authoritative medical sources to confidently answer this question. Please consult a healthcare professional for personalized guidance.${disclaimer}`,
        sources: [],
        sourceType: 'none',
        confidence: 0,
        verified: false,
        language,
      };
    }

    // Pass any partial FAQ/doc matches for context
    const partialFaq = faqResults.length > 0 ? faqResults : null;
    const partialDocs = documentResults.length > 0
      ? documentResults.map((r) => ({ content: r.content, metadata: r.metadata }))
      : null;

    prompt = buildFallbackPrompt(question, webResults, partialFaq, partialDocs, language);
    sourceType = 'web';

    sources = [];
    if (partialFaq) sources.push(...partialFaq.map((f) => ({ name: 'Treelogy FAQ (partial)', type: 'faq', category: f.category })));
    if (partialDocs) sources.push(...partialDocs.map((d) => ({ name: d.metadata?.name, type: 'document' })));
    sources.push(...webResults.map((r) => ({ name: r.title, type: 'web', url: r.url })));

    allContext = [
      ...(partialFaq ? partialFaq.map((f) => f.content) : []),
      ...(partialDocs ? partialDocs.map((d) => d.content) : []),
      ...webResults.map((r) => r.content),
    ];
    confidence = Math.max(bestFaqScore / 100, bestDocScore, webResults[0]?.score || 0);
  }

  // === Generate Answer ===
  const rawAnswer = await generateResponse(prompt);

  // === Fact-Check Loop (critical for health content) ===
  const factCheckSources = sources.map((s) => ({
    name: s.name || 'Unknown',
    type: s.type || sourceType,
    title: s.name,
  }));
  const factCheckPrompt = buildFactCheckPrompt(rawAnswer, allContext, factCheckSources, sourceType);
  const factCheckResult = await generateResponse(factCheckPrompt);

  const verified = factCheckResult.includes('VERIFIED: true');
  let finalAnswer = rawAnswer;

  if (!verified) {
    const correctedMatch = factCheckResult.match(/CORRECTED_ANSWER:\s*([\s\S]+?)$/);
    if (correctedMatch && correctedMatch[1].trim() !== 'N/A') {
      finalAnswer = correctedMatch[1].trim();
    }
  }

  // Attach disclaimer
  finalAnswer += disclaimer;

  return {
    answer: finalAnswer,
    sources: sources.map((s) => ({
      name: s.name || 'Unknown',
      type: s.type,
      reference: s.url || s.path || `${s.type}: ${s.name}`,
    })),
    sourceType,
    confidence,
    verified,
    language,
  };
}

/**
 * Streaming version of the 3-tier RAG pipeline.
 */
async function* processQueryStream(question) {
  // Announce the full pipeline plan up-front so the UI can render the layer list.
  const stagePlan = [
    { id: 'detect_language', label_en: 'Detecting language', label_id: 'Mendeteksi bahasa' },
    { id: 'search_faq', label_en: 'Searching FAQ knowledge base', label_id: 'Mencari basis pengetahuan FAQ' },
    { id: 'search_docs', label_en: 'Searching trusted documents', label_id: 'Mencari dokumen terpercaya' },
    { id: 'route', label_en: 'Selecting best answer strategy', label_id: 'Memilih strategi jawaban terbaik' },
    { id: 'generate', label_en: 'Generating answer', label_id: 'Menyusun jawaban' },
    { id: 'finalize', label_en: 'Finalizing & attaching sources', label_id: 'Menyelesaikan & melampirkan sumber' },
  ];
  yield { type: 'stages', data: stagePlan };

  yield { type: 'stage', data: { id: 'detect_language', status: 'active' } };
  const language = detectLanguage(question);
  const disclaimer = language === 'id' ? MEDICAL_DISCLAIMER_ID : MEDICAL_DISCLAIMER_EN;
  yield { type: 'stage', data: { id: 'detect_language', status: 'done' } };

  yield { type: 'stage', data: { id: 'search_faq', status: 'active' } };
  yield { type: 'stage', data: { id: 'search_docs', status: 'active' } };
  // Run Tier 1 + Tier 2 in parallel
  const [faqResults, documentResults] = await Promise.all([
    searchFaq(question, 5),
    searchSimilar(question, 5),
  ]);
  yield { type: 'stage', data: { id: 'search_faq', status: 'done' } };
  yield { type: 'stage', data: { id: 'search_docs', status: 'done' } };

  const bestFaqScore = faqResults.length > 0 ? faqResults[0].relevanceScore : 0;
  const bestDocScore = documentResults.length > 0 ? documentResults[0].similarity : 0;

  yield { type: 'stage', data: { id: 'route', status: 'active' } };

  let prompt;
  let sourceType;
  let sources;
  let confidence;

  if (bestFaqScore >= HIGH_CONFIDENCE_FAQ) {
    prompt = buildFaqPrompt(question, faqResults, language);
    sourceType = 'faq';
    sources = faqResults.map((f) => ({ name: 'Treelogy FAQ', type: 'faq', category: f.category }));
    confidence = Math.min(bestFaqScore / 100, 1);

  } else if (bestFaqScore >= FAQ_RELEVANCE_THRESHOLD && bestDocScore >= VECTOR_SIMILARITY_THRESHOLD) {
    const docContext = documentResults.map((r) => r.content);
    const docSources = documentResults.map((r) => r.metadata);
    prompt = buildLayeredPrompt(question, faqResults, docContext, docSources, language);
    sourceType = 'faq+documents';
    sources = [
      ...faqResults.map((f) => ({ name: 'Treelogy FAQ', type: 'faq', category: f.category })),
      ...docSources.map((s) => ({ name: s.name, type: 'document' })),
    ];
    confidence = Math.max(bestFaqScore / 100, bestDocScore);

  } else if (bestFaqScore >= FAQ_RELEVANCE_THRESHOLD) {
    prompt = buildFaqPrompt(question, faqResults, language);
    sourceType = 'faq';
    sources = faqResults.map((f) => ({ name: 'Treelogy FAQ', type: 'faq', category: f.category }));
    confidence = bestFaqScore / 100;

  } else if (bestDocScore >= VECTOR_SIMILARITY_THRESHOLD) {
    const docContext = documentResults.map((r) => r.content);
    const docSources = documentResults.map((r) => r.metadata);
    prompt = buildRetrievalPrompt(question, docContext, docSources);
    sourceType = 'documents';
    sources = docSources.map((s) => ({ name: s.name, type: 'document' }));
    confidence = bestDocScore;

  } else {
    // Insert a web-search stage into the plan now that we know we need it.
    yield {
      type: 'stage',
      data: {
        id: 'search_web',
        status: 'active',
        insertAfter: 'search_docs',
        label_en: 'Searching trusted medical sources on the web',
        label_id: 'Mencari sumber medis terpercaya di web',
      },
    };
    const webResults = await searchMedical(question);
    yield { type: 'stage', data: { id: 'search_web', status: 'done' } };

    if (webResults.length === 0 && faqResults.length === 0 && documentResults.length === 0) {
      yield {
        type: 'error',
        data: language === 'id'
          ? 'Informasi tidak cukup tersedia. Silakan konsultasikan dengan tenaga kesehatan profesional.'
          : 'Insufficient information available. Please consult a healthcare professional.',
      };
      return;
    }

    const partialFaq = faqResults.length > 0 ? faqResults : null;
    const partialDocs = documentResults.length > 0
      ? documentResults.map((r) => ({ content: r.content, metadata: r.metadata }))
      : null;

    prompt = buildFallbackPrompt(question, webResults, partialFaq, partialDocs, language);
    sourceType = 'web';
    sources = [];
    if (partialFaq) sources.push(...partialFaq.map((f) => ({ name: 'Treelogy FAQ (partial)', type: 'faq' })));
    if (partialDocs) sources.push(...partialDocs.map((d) => ({ name: d.metadata?.name, type: 'document' })));
    sources.push(...webResults.map((r) => ({ name: r.title, type: 'web', url: r.url })));
    confidence = Math.max(bestFaqScore / 100, bestDocScore, webResults[0]?.score || 0);
  }

  yield { type: 'stage', data: { id: 'route', status: 'done' } };

  // Emit metadata
  yield {
    type: 'metadata',
    data: { sourceType, confidence, language, sourceCount: sources.length },
  };

  yield { type: 'stage', data: { id: 'generate', status: 'active' } };
  // Stream the answer
  for await (const token of streamResponse(prompt)) {
    yield { type: 'token', data: token };
  }
  yield { type: 'stage', data: { id: 'generate', status: 'done' } };

  yield { type: 'stage', data: { id: 'finalize', status: 'active' } };
  // Emit sources and disclaimer
  yield {
    type: 'sources',
    data: sources.map((s) => ({
      name: s.name || 'Unknown',
      type: s.type,
      reference: s.url || `${s.type}: ${s.name}`,
    })),
  };

  yield { type: 'disclaimer', data: disclaimer };
  yield { type: 'stage', data: { id: 'finalize', status: 'done' } };
  yield { type: 'done', data: null };
}

module.exports = {
  processQuery,
  processQueryStream,
  FAQ_RELEVANCE_THRESHOLD,
  VECTOR_SIMILARITY_THRESHOLD,
  HIGH_CONFIDENCE_FAQ,
};

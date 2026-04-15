const { searchSimilar, keywordSearch } = require('./vectorStore');
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
const FAQ_RELEVANCE_THRESHOLD = 15;          // Minimum FAQ relevance score to be considered a match
const VECTOR_SIMILARITY_THRESHOLD = 0.55;    // Hard floor for docs-only answers (post-hybrid-rerank)
const DOC_SUPPLEMENT_THRESHOLD = 0.38;       // Looser floor for docs used as supplement to FAQ
const HIGH_CONFIDENCE_FAQ = 30;              // FAQ score above this = very confident match
const DEEP_SEARCH_TOP_K = 8;                 // Per-query top-k for document retrieval
const DEEP_SEARCH_FINAL_K = 6;               // Final chunks after dedupe + rerank

// --- Tokenization & scoring helpers ---

const STOPWORDS = new Set([
  // EN
  'the','a','an','is','are','was','were','be','been','being','of','to','in','on','for','and','or','but','at','by','with','from','as','it','this','that','these','those','i','you','we','they','he','she','do','does','did','not','no','yes','can','could','should','would','will','has','have','had','about','what','which','who','when','where','why','how',
  // ID
  'yang','dan','atau','di','ke','dari','untuk','pada','dengan','adalah','itu','ini','saya','kamu','kita','mereka','dia','apa','bagaimana','mengapa','kapan','dimana','siapa','bisa','bisakah','boleh','tidak','bukan','ya','sudah','belum','akan','sedang','agar','supaya','jadi','tapi','tetapi','juga','saja','kalau','jika','kenapa','ada','apakah',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function extractKeywords(question) {
  const tokens = tokenize(question);
  // Dedupe while preserving order
  return [...new Set(tokens)];
}

function keywordOverlapScore(queryTokens, chunkText) {
  if (queryTokens.length === 0) return 0;
  const chunkTokens = new Set(tokenize(chunkText));
  let hits = 0;
  for (const t of queryTokens) if (chunkTokens.has(t)) hits += 1;
  return hits / queryTokens.length;
}

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists into a single robust ranking.
 */
function reciprocalRankFusion(rankedLists, k = 60) {
  const scores = new Map();
  const items = new Map();

  for (const list of rankedLists) {
    list.forEach((item, rank) => {
      const key = (item.content || '').slice(0, 200);
      const prev = scores.get(key) || 0;
      scores.set(key, prev + 1 / (k + rank + 1));
      // Keep the variant with the highest known similarity
      const existing = items.get(key);
      if (!existing || (item.similarity || 0) > (existing.similarity || 0)) {
        items.set(key, item);
      }
    });
  }

  return [...items.entries()]
    .map(([key, item]) => ({ item, rrfScore: scores.get(key) }))
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map((x) => ({ ...x.item, rrfScore: x.rrfScore }));
}

/**
 * Maximal Marginal Relevance — diversify the final set so near-duplicate chunks
 * (common in uploaded docs with repeated sections) don't crowd out fresh info.
 */
function mmrSelect(candidates, finalK, lambda = 0.72) {
  const selected = [];
  const remaining = [...candidates];

  while (selected.length < finalK && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const relevance = cand._combinedScore ?? cand.similarity ?? cand.rrfScore ?? 0;

      let maxSimToSelected = 0;
      const candTokens = new Set(tokenize(cand.content));
      for (const sel of selected) {
        const selTokens = new Set(tokenize(sel.content));
        const inter = [...candTokens].filter((t) => selTokens.has(t)).length;
        const union = new Set([...candTokens, ...selTokens]).size || 1;
        const jaccard = inter / union;
        if (jaccard > maxSimToSelected) maxSimToSelected = jaccard;
      }

      const score = lambda * relevance - (1 - lambda) * maxSimToSelected;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

/**
 * S+ grade deep document search:
 *   1. Multi-query vector search (question + FAQ reformulations)
 *   2. Keyword ILIKE search for exact-term matches (product names, ingredients, SKUs)
 *   3. RRF fusion across all ranked lists
 *   4. Keyword-overlap boost (hybrid scoring)
 *   5. MMR diversification so the final set covers different facets
 *
 * This recovers document knowledge that single-query pure-vector search misses,
 * especially for Indonesian casual phrasing vs. formal document text.
 */
async function deepDocumentSearch(question, faqResults = []) {
  const queries = new Set([question]);
  faqResults.slice(0, 2).forEach((f) => {
    if (f.question_id) queries.add(f.question_id);
    if (f.question_en) queries.add(f.question_en);
  });

  const keywords = extractKeywords(question);

  const [vectorBatches, keywordHits] = await Promise.all([
    Promise.all(
      [...queries].map((q) => searchSimilar(q, DEEP_SEARCH_TOP_K).catch(() => []))
    ),
    keywordSearch(keywords, 12).catch(() => []),
  ]);

  // Sort each vector batch by similarity before RRF
  const sortedVectorLists = vectorBatches.map((b) =>
    [...b].sort((a, b2) => b2.similarity - a.similarity)
  );

  const fused = reciprocalRankFusion([...sortedVectorLists, keywordHits]);

  // Hybrid score: RRF + keyword overlap + raw similarity
  const queryTokens = keywords;
  const scored = fused.map((c) => {
    const overlap = keywordOverlapScore(queryTokens, c.content);
    const sim = c.similarity || 0;
    const rrf = c.rrfScore || 0;
    return {
      ...c,
      similarity: Math.max(sim, overlap * 0.9), // lift keyword-only hits
      _combinedScore: 0.55 * sim + 0.25 * overlap + 0.20 * rrf,
    };
  });

  scored.sort((a, b) => b._combinedScore - a._combinedScore);

  // Keep a generous candidate pool then MMR down to final K
  const pool = scored.slice(0, DEEP_SEARCH_FINAL_K * 3);
  return mmrSelect(pool, DEEP_SEARCH_FINAL_K);
}

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

  // === TIER 2: Deep Document Retrieval (query-expanded, deduped, re-ranked) ===
  const documentResults = await deepDocumentSearch(question, faqResults);
  const bestDocScore = documentResults.length > 0 ? documentResults[0].similarity : 0;

  let prompt;
  let sourceType;
  let sources;
  let allContext;
  let confidence;

  // --- Decision Logic ---
  // Always layer uploaded documents AFTER FAQ when they clear the supplement bar.

  if (bestFaqScore >= HIGH_CONFIDENCE_FAQ && bestDocScore >= DOC_SUPPLEMENT_THRESHOLD) {
    // HIGH CONFIDENCE FAQ + supporting docs: layered depth
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

  } else if (bestFaqScore >= HIGH_CONFIDENCE_FAQ) {
    // HIGH CONFIDENCE FAQ, no useful doc support: FAQ alone
    prompt = buildFaqPrompt(question, faqResults, language);
    sourceType = 'faq';
    sources = faqResults.map((f) => ({ name: 'Treelogy FAQ', type: 'faq', category: f.category }));
    allContext = faqResults.map((f) => f.content);
    confidence = Math.min(bestFaqScore / 100, 1);

  } else if (bestFaqScore >= FAQ_RELEVANCE_THRESHOLD && bestDocScore >= DOC_SUPPLEMENT_THRESHOLD) {
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
  // Run FAQ first so deep-doc search can use its top hits for query expansion
  const faqResults = await searchFaq(question, 5);
  yield { type: 'stage', data: { id: 'search_faq', status: 'done' } };

  yield { type: 'stage', data: { id: 'search_docs', status: 'active' } };
  const documentResults = await deepDocumentSearch(question, faqResults);
  yield { type: 'stage', data: { id: 'search_docs', status: 'done' } };

  const bestFaqScore = faqResults.length > 0 ? faqResults[0].relevanceScore : 0;
  const bestDocScore = documentResults.length > 0 ? documentResults[0].similarity : 0;

  yield { type: 'stage', data: { id: 'route', status: 'active' } };

  let prompt;
  let sourceType;
  let sources;
  let confidence;

  if (bestFaqScore >= HIGH_CONFIDENCE_FAQ && bestDocScore >= DOC_SUPPLEMENT_THRESHOLD) {
    const docContext = documentResults.map((r) => r.content);
    const docSources = documentResults.map((r) => r.metadata);
    prompt = buildLayeredPrompt(question, faqResults, docContext, docSources, language);
    sourceType = 'faq+documents';
    sources = [
      ...faqResults.map((f) => ({ name: 'Treelogy FAQ', type: 'faq', category: f.category })),
      ...docSources.map((s) => ({ name: s.name, type: 'document' })),
    ];
    confidence = Math.max(bestFaqScore / 100, bestDocScore);

  } else if (bestFaqScore >= HIGH_CONFIDENCE_FAQ) {
    prompt = buildFaqPrompt(question, faqResults, language);
    sourceType = 'faq';
    sources = faqResults.map((f) => ({ name: 'Treelogy FAQ', type: 'faq', category: f.category }));
    confidence = Math.min(bestFaqScore / 100, 1);

  } else if (bestFaqScore >= FAQ_RELEVANCE_THRESHOLD && bestDocScore >= DOC_SUPPLEMENT_THRESHOLD) {
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

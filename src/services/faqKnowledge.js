const supabase = require('../config/supabase');
const { generateEmbedding } = require('./embeddings');

/**
 * FAQ Knowledge Service
 *
 * Retrieves answers from the faq_articles table in Supabase.
 * This is the HIGHEST priority knowledge source — curated, bilingual Q&A
 * verified by the Treelogy team.
 *
 * Strategy:
 * 1. Text-based search using Postgres full-text + ILIKE for both ID/EN columns
 * 2. Semantic similarity via embedding comparison
 * 3. Combine and deduplicate results, ranked by relevance
 */

const FAQ_TABLE = 'faq_articles';

/**
 * Search FAQ articles using text matching across bilingual columns.
 * Returns matched articles sorted by relevance.
 */
async function searchFaqByText(query, limit = 10) {
  const searchTerm = `%${query.toLowerCase()}%`;

  const { data, error } = await supabase
    .from(FAQ_TABLE)
    .select('id, category_id, question_id, question_en, answer_id, answer_en')
    .or(
      `question_id.ilike.${searchTerm},question_en.ilike.${searchTerm},answer_id.ilike.${searchTerm},answer_en.ilike.${searchTerm}`
    )
    .limit(limit);

  if (error) {
    console.error('[FaqKnowledge] Text search error:', error.message);
    return [];
  }

  return data || [];
}

/**
 * Search FAQ articles using keyword extraction for more precise matching.
 * Splits query into significant words and matches against questions.
 */
async function searchFaqByKeywords(query, limit = 10) {
  // Extract meaningful keywords (remove common stop words)
  const stopWords = new Set([
    'apa', 'bagaimana', 'apakah', 'yang', 'dan', 'atau', 'untuk', 'dengan',
    'dari', 'di', 'ke', 'ini', 'itu', 'jika', 'bisa', 'saya', 'kita',
    'what', 'how', 'is', 'are', 'the', 'a', 'an', 'and', 'or', 'for',
    'with', 'from', 'in', 'to', 'this', 'that', 'if', 'can', 'do', 'does',
    'i', 'my', 'we', 'our', 'you', 'your',
  ]);

  const keywords = query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  if (keywords.length === 0) return [];

  // Build OR conditions for each keyword across bilingual columns
  const conditions = keywords
    .map((kw) => {
      const term = `%${kw}%`;
      return `question_id.ilike.${term},question_en.ilike.${term}`;
    })
    .join(',');

  const { data, error } = await supabase
    .from(FAQ_TABLE)
    .select('id, category_id, question_id, question_en, answer_id, answer_en')
    .or(conditions)
    .limit(limit);

  if (error) {
    console.error('[FaqKnowledge] Keyword search error:', error.message);
    return [];
  }

  return data || [];
}

/**
 * Detect the language of a query (simple heuristic).
 */
function detectLanguage(query) {
  const idIndicators = [
    'bagaimana', 'apakah', 'apa', 'mengapa', 'kapan', 'dimana', 'siapa',
    'bisa', 'cara', 'untuk', 'dengan', 'saya', 'kita', 'moringa',
    'kak', 'kakak', 'tolong', 'boleh', 'gimana', 'kenapa',
  ];

  const lower = query.toLowerCase();
  const idCount = idIndicators.filter((w) => lower.includes(w)).length;

  return idCount >= 1 ? 'id' : 'en';
}

/**
 * Score FAQ articles against the query for ranking.
 * Higher score = more relevant.
 */
function scoreFaqArticle(article, query, language) {
  const lower = query.toLowerCase();
  let score = 0;

  const questionField = language === 'id' ? 'question_id' : 'question_en';
  const answerField = language === 'id' ? 'answer_id' : 'answer_en';

  const question = (article[questionField] || '').toLowerCase();
  const answer = (article[answerField] || '').toLowerCase();

  // Exact question match (highest value)
  if (question === lower) score += 100;

  // Question contains full query
  if (question.includes(lower)) score += 50;

  // Query contains full question
  if (lower.includes(question) && question.length > 10) score += 40;

  // Keyword overlap scoring
  const queryWords = lower.split(/\s+/).filter((w) => w.length > 2);
  const questionWords = question.split(/\s+/).filter((w) => w.length > 2);
  const matchedWords = queryWords.filter((w) => questionWords.some((qw) => qw.includes(w) || w.includes(qw)));
  score += (matchedWords.length / Math.max(queryWords.length, 1)) * 30;

  // Answer relevance (lower weight — we prioritize question match)
  const answerMatchedWords = queryWords.filter((w) => answer.includes(w));
  score += (answerMatchedWords.length / Math.max(queryWords.length, 1)) * 10;

  return score;
}

/**
 * Main FAQ search: combines text search + keyword search, deduplicates, and ranks.
 * Returns the top results formatted for the RAG pipeline.
 */
async function searchFaq(query, topK = 5) {
  const [textResults, keywordResults] = await Promise.all([
    searchFaqByText(query, 15),
    searchFaqByKeywords(query, 15),
  ]);

  // Deduplicate by ID
  const seen = new Set();
  const allResults = [];
  for (const article of [...textResults, ...keywordResults]) {
    if (!seen.has(article.id)) {
      seen.add(article.id);
      allResults.push(article);
    }
  }

  if (allResults.length === 0) return [];

  const language = detectLanguage(query);

  // Score and rank
  const scored = allResults
    .map((article) => ({
      ...article,
      relevanceScore: scoreFaqArticle(article, query, language),
      language,
    }))
    .filter((a) => a.relevanceScore > 5) // Minimum relevance threshold
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, topK);

  // Format for the RAG pipeline
  return scored.map((article) => {
    const questionField = language === 'id' ? 'question_id' : 'question_en';
    const answerField = language === 'id' ? 'answer_id' : 'answer_en';

    return {
      content: `Q: ${article[questionField]}\nA: ${article[answerField]}`,
      question: article[questionField],
      answer: article[answerField],
      // Include both languages for cross-reference
      question_id: article.question_id,
      question_en: article.question_en,
      answer_id: article.answer_id,
      answer_en: article.answer_en,
      category: article.category_id,
      relevanceScore: article.relevanceScore,
      source: 'faq_articles',
      language,
    };
  });
}

/**
 * Get all FAQ articles (for full knowledge sync/ingestion).
 */
async function getAllFaqArticles() {
  const { data, error } = await supabase
    .from(FAQ_TABLE)
    .select('id, category_id, question_id, question_en, answer_id, answer_en')
    .order('category_id')
    .order('id');

  if (error) throw new Error(`Failed to fetch FAQ articles: ${error.message}`);
  return data || [];
}

module.exports = { searchFaq, getAllFaqArticles, detectLanguage };

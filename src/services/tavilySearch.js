const env = require('../config/env');

const TAVILY_BASE_URL = 'https://api.tavily.com';

/**
 * Authorized medical domains for Tavily search.
 * The system only retrieves from trusted health sources.
 */
const MEDICAL_DOMAINS = [
  'mayoclinic.org',
  'nih.gov',
  'who.int',
  'cdc.gov',
  'webmd.com',
  'healthline.com',
  'pubmed.ncbi.nlm.nih.gov',
  'medlineplus.gov',
  'clevelandclinic.org',
  'hopkinsmedicine.org',
];

/**
 * Perform an advanced Tavily search restricted to medical domains.
 */
async function searchMedical(query, maxResults = 5) {
  const response = await fetch(`${TAVILY_BASE_URL}/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: env.tavily.apiKey,
      query: `${query} health wellness`,
      search_depth: 'advanced',
      include_domains: MEDICAL_DOMAINS,
      max_results: maxResults,
      include_raw_content: false,
      include_answer: false,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Tavily search failed (${response.status}): ${errorBody}`);
  }

  const data = await response.json();

  return data.results.map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    score: r.score,
  }));
}

module.exports = { searchMedical, MEDICAL_DOMAINS };

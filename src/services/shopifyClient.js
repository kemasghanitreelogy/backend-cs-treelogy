const env = require('../config/env');

const SHOPIFY_ENDPOINT = () =>
  `https://${env.shopify.shopDomain}/admin/api/${env.shopify.apiVersion}/graphql.json`;

function isConfigured() {
  return Boolean(env.shopify.shopDomain && env.shopify.adminToken);
}

/**
 * Execute a Shopify Admin GraphQL query with basic retry on 429 / 5xx.
 */
async function shopifyGraphql(query, variables = {}, { retries = 2 } = {}) {
  if (!isConfigured()) {
    throw new Error('Shopify is not configured (missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_TOKEN)');
  }

  let attempt = 0;
  let lastErr;

  while (attempt <= retries) {
    try {
      const res = await fetch(SHOPIFY_ENDPOINT(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': env.shopify.adminToken,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (res.status === 429 || res.status >= 500) {
        // Transient — backoff and retry
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        attempt += 1;
        continue;
      }

      const json = await res.json();
      if (json.errors?.length) {
        throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
      }
      return json.data;
    } catch (err) {
      lastErr = err;
      attempt += 1;
    }
  }

  throw lastErr || new Error('Shopify GraphQL failed');
}

module.exports = { shopifyGraphql, isConfigured };

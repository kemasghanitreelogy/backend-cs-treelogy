const { shopifyGraphql, isConfigured } = require('./shopifyClient');

/**
 * Shopify product knowledge service for Treelogy.
 *
 * Fetches:
 *   - Title, description
 *   - Variants (price, stock, SKU, options)
 *   - Metafields:
 *       custom.product_timeline  → list of metaobject `timeline_benefit`
 *       custom.concerns          → list (or single) reference
 *       product.faq              → list of metaobject `faq_group`
 *       custom.product_detail    → list of metaobject `product_detail_list`
 */

const PRODUCT_SEARCH_QUERY = /* GraphQL */ `
  query ProductSearch($query: String!, $first: Int!) {
    products(first: $first, query: $query) {
      edges {
        node {
          id
          title
          handle
          descriptionHtml
          description
          productType
          tags
          vendor
          status
          onlineStoreUrl
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
          totalInventory
          featuredImage { url altText }
          variants(first: 30) {
            edges {
              node {
                id
                title
                sku
                price
                compareAtPrice
                inventoryQuantity
                availableForSale
                selectedOptions { name value }
              }
            }
          }
          timelineRef: metafield(namespace: "custom", key: "product_timeline") {
            type
            value
            references(first: 20) {
              edges {
                node {
                  ... on Metaobject {
                    id
                    type
                    handle
                    fields { key value type }
                  }
                }
              }
            }
          }
          concernsRef: metafield(namespace: "custom", key: "concerns") {
            type
            value
            references(first: 20) {
              edges {
                node {
                  ... on Metaobject {
                    id
                    type
                    handle
                    fields { key value type }
                  }
                }
              }
            }
          }
          faqRef: metafield(namespace: "product", key: "faq") {
            type
            value
            references(first: 30) {
              edges {
                node {
                  ... on Metaobject {
                    id
                    type
                    handle
                    fields { key value type }
                  }
                }
              }
            }
          }
          productDetailRef: metafield(namespace: "custom", key: "product_detail") {
            type
            value
            references(first: 30) {
              edges {
                node {
                  ... on Metaobject {
                    id
                    type
                    handle
                    fields { key value type }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseMetaobjectValue(field) {
  if (!field) return null;
  if (field.type === 'json' || field.type?.startsWith('list.')) {
    try {
      return JSON.parse(field.value);
    } catch {
      return field.value;
    }
  }
  return field.value;
}

function formatMetaobject(mo) {
  if (!mo?.fields) return null;
  const obj = { type: mo.type, handle: mo.handle };
  for (const f of mo.fields) {
    obj[f.key] = parseMetaobjectValue(f);
  }
  return obj;
}

function flattenRefs(metafield) {
  if (!metafield?.references?.edges) return [];
  return metafield.references.edges
    .map((e) => formatMetaobject(e.node))
    .filter(Boolean);
}

/**
 * Build a Shopify search query string from user keywords.
 * Uses Shopify's `query` syntax (https://shopify.dev/api/usage/search-syntax).
 */
function buildSearchQuery(keywords) {
  const clean = keywords
    .filter((k) => k && k.length >= 3)
    .slice(0, 6)
    .map((k) => k.replace(/[():*"]/g, ' ').trim())
    .filter(Boolean);

  if (clean.length === 0) return 'status:active';

  // OR across title, product_type, tag, vendor
  const parts = clean.flatMap((k) => [
    `title:*${k}*`,
    `product_type:*${k}*`,
    `tag:${k}`,
    `vendor:${k}`,
  ]);

  return `status:active AND (${parts.join(' OR ')})`;
}

/**
 * Public: search Shopify products by keywords.
 * Returns normalized products with metaobject references resolved.
 */
async function searchProducts(keywords, { first = 5 } = {}) {
  if (!isConfigured()) return [];

  const query = buildSearchQuery(keywords);

  try {
    const data = await shopifyGraphql(PRODUCT_SEARCH_QUERY, { query, first });
    return (data?.products?.edges || []).map(({ node }) => normalizeProduct(node));
  } catch (err) {
    console.warn('[shopifyProducts] search failed:', err.message);
    return [];
  }
}

function normalizeProduct(node) {
  const variants = (node.variants?.edges || []).map(({ node: v }) => ({
    id: v.id,
    title: v.title,
    sku: v.sku,
    price: v.price,
    compareAtPrice: v.compareAtPrice,
    inventory: v.inventoryQuantity,
    available: v.availableForSale,
    options: (v.selectedOptions || []).reduce((acc, o) => {
      acc[o.name] = o.value;
      return acc;
    }, {}),
  }));

  const priceMin = node.priceRangeV2?.minVariantPrice;
  const priceMax = node.priceRangeV2?.maxVariantPrice;

  return {
    id: node.id,
    title: node.title,
    handle: node.handle,
    url: node.onlineStoreUrl,
    productType: node.productType,
    vendor: node.vendor,
    tags: node.tags || [],
    status: node.status,
    image: node.featuredImage?.url,
    description: stripHtml(node.descriptionHtml || node.description),
    priceMin: priceMin ? { amount: priceMin.amount, currency: priceMin.currencyCode } : null,
    priceMax: priceMax ? { amount: priceMax.amount, currency: priceMax.currencyCode } : null,
    totalInventory: node.totalInventory,
    variants,
    timeline: flattenRefs(node.timelineRef),             // metaobject timeline_benefit[]
    concerns: flattenRefs(node.concernsRef),             // metaobject concerns[]
    faqs: flattenRefs(node.faqRef),                      // metaobject faq_group[]
    productDetails: flattenRefs(node.productDetailRef),  // metaobject product_detail_list[]
  };
}

/**
 * Format one product as a compact, LLM-friendly context block.
 * Used as part of the system prompt.
 */
function formatProductForPrompt(p) {
  const lines = [];
  lines.push(`=== PRODUCT: ${p.title} ===`);
  if (p.handle) lines.push(`Handle: ${p.handle}`);
  if (p.productType) lines.push(`Type: ${p.productType}`);
  if (p.vendor) lines.push(`Vendor: ${p.vendor}`);
  if (p.tags?.length) lines.push(`Tags: ${p.tags.join(', ')}`);

  if (p.priceMin) {
    const price = p.priceMax && p.priceMax.amount !== p.priceMin.amount
      ? `${p.priceMin.amount}–${p.priceMax.amount} ${p.priceMin.currency}`
      : `${p.priceMin.amount} ${p.priceMin.currency}`;
    lines.push(`Price: ${price}`);
  }

  if (typeof p.totalInventory === 'number') lines.push(`Total inventory: ${p.totalInventory}`);
  if (p.url) lines.push(`URL: ${p.url}`);

  if (p.description) {
    lines.push('\nDescription:');
    lines.push(p.description.slice(0, 1200));
  }

  if (p.variants?.length) {
    lines.push('\nVariants:');
    p.variants.forEach((v) => {
      const opts = Object.entries(v.options || {}).map(([k, val]) => `${k}=${val}`).join(', ');
      lines.push(`- ${v.title}${opts ? ` (${opts})` : ''} | SKU: ${v.sku || '-'} | Price: ${v.price} | Stock: ${v.inventory ?? '?'} | Available: ${v.available}`);
    });
  }

  if (p.timeline?.length) {
    lines.push('\nTimeline benefits (metaobject custom.product_timeline → timeline_benefit):');
    p.timeline.forEach((t, i) => lines.push(`  ${i + 1}. ${JSON.stringify(t)}`));
  }

  if (p.concerns?.length) {
    lines.push('\nConcerns (metaobject custom.concerns):');
    p.concerns.forEach((c, i) => lines.push(`  ${i + 1}. ${JSON.stringify(c)}`));
  }

  if (p.productDetails?.length) {
    lines.push('\nProduct details (metaobject custom.product_detail → product_detail_list):');
    p.productDetails.forEach((d, i) => lines.push(`  ${i + 1}. ${JSON.stringify(d)}`));
  }

  if (p.faqs?.length) {
    lines.push('\nProduct FAQs (metaobject product.faq → faq_group):');
    p.faqs.forEach((f, i) => lines.push(`  ${i + 1}. ${JSON.stringify(f)}`));
  }

  return lines.join('\n');
}

function formatProductsForPrompt(products) {
  return products.map(formatProductForPrompt).join('\n\n');
}

module.exports = {
  searchProducts,
  formatProductForPrompt,
  formatProductsForPrompt,
  isShopifyConfigured: isConfigured,
};

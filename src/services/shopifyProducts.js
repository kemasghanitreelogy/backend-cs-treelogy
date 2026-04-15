const { shopifyGraphql, isConfigured } = require('./shopifyClient');

// --- Smart nested-reference resolver ---

const GID_PATTERN = /^gid:\/\/shopify\/([A-Za-z]+)\/\d+$/;
const MAX_RESOLVE_DEPTH = 6;
const MAX_RESOLVE_IDS_PER_BATCH = 150; // Shopify hard limit is 250; stay conservative

const NODES_QUERY = /* GraphQL */ `
  query ResolveNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Metaobject {
        id
        type
        handle
        fields { key value type }
      }
      ... on MediaImage {
        id
        image { url altText width height }
      }
      ... on Video {
        id
        sources { url mimeType }
        preview { image { url } }
      }
      ... on GenericFile {
        id
        url
        mimeType
      }
      ... on Product {
        id
        title
        handle
      }
      ... on ProductVariant {
        id
        title
        sku
        price
      }
    }
  }
`;

function isGid(value) {
  return typeof value === 'string' && GID_PATTERN.test(value);
}

/**
 * Walk any nested structure and collect every unresolved GID string.
 * Skips GIDs already present in the resolved cache.
 */
function collectGids(node, acc, cache) {
  if (node == null) return;
  if (typeof node === 'string') {
    if (isGid(node) && !cache.has(node)) acc.add(node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v) => collectGids(v, acc, cache));
    return;
  }
  if (typeof node === 'object') {
    // Skip already-resolved metaobject bodies (they have __resolved marker)
    if (node.__resolved) return;
    for (const v of Object.values(node)) collectGids(v, acc, cache);
  }
}

/**
 * Replace every GID string in-place with its resolved object from the cache.
 * Leaves strings that didn't resolve untouched.
 */
function substituteGids(node, cache) {
  if (node == null) return node;
  if (typeof node === 'string') {
    if (isGid(node) && cache.has(node)) return cache.get(node);
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((v) => substituteGids(v, cache));
  }
  if (typeof node === 'object') {
    if (node.__resolved) return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = substituteGids(v, cache);
    return out;
  }
  return node;
}

/**
 * Convert a Shopify Node into a plain, LLM-friendly object.
 */
function shapeResolvedNode(n) {
  if (!n) return null;
  switch (n.__typename) {
    case 'Metaobject': {
      const obj = { __resolved: true, __kind: 'metaobject', type: n.type, handle: n.handle };
      for (const f of n.fields || []) {
        obj[f.key] = parseMetaobjectValue(f);
      }
      return obj;
    }
    case 'MediaImage':
      return { __resolved: true, __kind: 'image', url: n.image?.url, alt: n.image?.altText };
    case 'Video':
      return { __resolved: true, __kind: 'video', url: n.sources?.[0]?.url, poster: n.preview?.image?.url };
    case 'GenericFile':
      return { __resolved: true, __kind: 'file', url: n.url, mimeType: n.mimeType };
    case 'Product':
      return { __resolved: true, __kind: 'product', title: n.title, handle: n.handle };
    case 'ProductVariant':
      return { __resolved: true, __kind: 'variant', title: n.title, sku: n.sku, price: n.price };
    default:
      return { __resolved: true, __kind: (n.__typename || 'unknown').toLowerCase(), id: n.id };
  }
}

/**
 * Smart recursive resolver:
 *   1. Walk the tree, collect every unresolved GID.
 *   2. Batch-fetch via `nodes(ids:)`.
 *   3. Cache + substitute.
 *   4. Repeat until no new GIDs are found OR depth cap reached.
 *
 * Uses a shared cache across a whole product list so we never re-fetch.
 */
async function resolveAllReferences(root, cache = new Map()) {
  let current = root;
  for (let depth = 0; depth < MAX_RESOLVE_DEPTH; depth++) {
    const gids = new Set();
    collectGids(current, gids, cache);
    if (gids.size === 0) break;

    const ids = [...gids];
    for (let i = 0; i < ids.length; i += MAX_RESOLVE_IDS_PER_BATCH) {
      const batch = ids.slice(i, i + MAX_RESOLVE_IDS_PER_BATCH);
      try {
        const data = await shopifyGraphql(NODES_QUERY, { ids: batch });
        (data?.nodes || []).forEach((n) => {
          if (!n?.id) return;
          cache.set(n.id, shapeResolvedNode(n));
        });
      } catch (err) {
        // Mark failed ids so we stop retrying them
        batch.forEach((id) => cache.set(id, { __resolved: true, __kind: 'unresolved', id }));
      }
    }

    current = substituteGids(current, cache);
  }
  return current;
}

// --- Rich-text flattener (Shopify "rich_text_field" stores nested JSON) ---

function flattenRichText(value) {
  if (!value) return '';
  let node = value;
  if (typeof value === 'string') {
    try { node = JSON.parse(value); } catch { return value; }
  }
  const parts = [];
  const walk = (n) => {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n === 'string') { parts.push(n); return; }
    if (n.type === 'text' && typeof n.value === 'string') parts.push(n.value);
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Post-process a resolved tree to flatten any `description` / `value`
 * fields that contain rich-text JSON. Leaves everything else untouched.
 */
function flattenRichTextFields(node) {
  if (node == null) return node;
  if (Array.isArray(node)) return node.map(flattenRichTextFields);
  if (typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && v.startsWith('{"type":"root"')) {
      out[k] = flattenRichText(v);
    } else {
      out[k] = flattenRichTextFields(v);
    }
  }
  return out;
}

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
          }
          faqRef: metafield(namespace: "product", key: "faq") {
            type
            value
            reference {
              ... on Metaobject {
                id
                type
                handle
                fields { key value type }
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
 * Handle a single metaobject_reference (not list).
 * Returns [] or [metaobject] for consistency with flattenRefs.
 */
function singleRef(metafield) {
  if (!metafield?.reference) return [];
  const obj = formatMetaobject(metafield.reference);
  return obj ? [obj] : [];
}

/**
 * Handle list.single_line_text_field (just strings, no metaobject).
 * Returns a plain array of strings.
 */
function parseStringList(metafield) {
  if (!metafield?.value) return [];
  try {
    const parsed = JSON.parse(metafield.value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [metafield.value];
  }
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
    const products = (data?.products?.edges || []).map(({ node }) => normalizeProduct(node));

    // Smart recursive resolution — follow every nested GID (FAQ items, icons, etc.)
    // until fully materialized. One shared cache across all products.
    const cache = new Map();
    const resolved = await resolveAllReferences(products, cache);

    // Flatten rich-text JSON blobs into plain text so the LLM can read them directly.
    return flattenRichTextFields(resolved);
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
    concerns: parseStringList(node.concernsRef),         // list of plain strings
    faqs: singleRef(node.faqRef),                        // single metaobject faq_group
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

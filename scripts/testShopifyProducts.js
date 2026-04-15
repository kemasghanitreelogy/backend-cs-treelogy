#!/usr/bin/env node
/**
 * Test: verify Shopify integration returns every field we want.
 *
 * Usage:
 *   node scripts/testShopifyProducts.js            # list first 3 products
 *   node scripts/testShopifyProducts.js "joint"    # search by keyword
 *   node scripts/testShopifyProducts.js --full     # dump FULL JSON payload
 *
 * Reports a pass/fail checklist per product so you can see which fields
 * are populated vs. missing (title, description, variants, and each
 * metaobject-backed metafield).
 */

require('dotenv').config();

const { searchProducts, isShopifyConfigured } = require('../src/services/shopifyProducts');
const { shopifyGraphql } = require('../src/services/shopifyClient');

const args = process.argv.slice(2);
const fullDump = args.includes('--full');
const keywordArgs = args.filter((a) => !a.startsWith('--'));
const keywords = keywordArgs.length > 0 ? keywordArgs : ['treelogy'];

function status(ok) {
  return ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
}

function summarizeProduct(p) {
  const checks = {
    'title': !!p.title,
    'description': !!p.description && p.description.length > 10,
    'handle / URL': !!p.handle,
    'priceRange': !!p.priceMin,
    'variants (≥1)': Array.isArray(p.variants) && p.variants.length > 0,
    'variant.sku on at least one': p.variants?.some((v) => v.sku),
    'variant.inventoryQuantity on at least one': p.variants?.some((v) => typeof v.inventory === 'number'),
    'variant.selectedOptions on at least one': p.variants?.some((v) => v.options && Object.keys(v.options).length > 0),
    'metafield custom.product_timeline (timeline_benefit)': p.timeline?.length > 0,
    'metafield custom.concerns': p.concerns?.length > 0,
    'metafield product.faq (faq_group)': p.faqs?.length > 0,
    'metafield custom.product_detail (product_detail_list)': p.productDetails?.length > 0,
  };

  console.log(`\n──────────────────────────────────────────────────`);
  console.log(`📦 ${p.title}`);
  console.log(`   handle: ${p.handle}`);
  console.log(`   URL: ${p.url || '(not published to online store)'}`);
  console.log(`   price: ${p.priceMin?.amount ?? '?'} ${p.priceMin?.currency ?? ''}`);
  console.log(`   variants: ${p.variants?.length ?? 0}`);
  console.log(`──────────────────────────────────────────────────`);

  for (const [label, ok] of Object.entries(checks)) {
    console.log(`  ${status(!!ok)}  ${label}`);
  }

  if (p.variants?.length) {
    console.log(`\n  Variants:`);
    p.variants.slice(0, 5).forEach((v) => {
      const opts = Object.entries(v.options || {}).map(([k, val]) => `${k}=${val}`).join(', ');
      console.log(`    - ${v.title} ${opts ? `(${opts})` : ''} | SKU: ${v.sku || '-'} | Price: ${v.price} | Stock: ${v.inventory ?? '?'} | Avail: ${v.available}`);
    });
  }

  const showMetaSample = (label, arr) => {
    if (!arr?.length) return;
    console.log(`\n  ${label} (${arr.length}):`);
    console.log(`    first item keys: ${Object.keys(arr[0]).join(', ')}`);
    if (fullDump) {
      arr.forEach((it, i) => console.log(`    [${i}] ${JSON.stringify(it)}`));
    } else {
      console.log(`    sample: ${JSON.stringify(arr[0]).slice(0, 300)}${JSON.stringify(arr[0]).length > 300 ? '…' : ''}`);
    }
  };

  showMetaSample('timeline (custom.product_timeline → timeline_benefit)', p.timeline);
  showMetaSample('concerns (custom.concerns)', p.concerns);
  showMetaSample('faqs (product.faq → faq_group)', p.faqs);
  showMetaSample('productDetails (custom.product_detail → product_detail_list)', p.productDetails);

  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;
  console.log(`\n  → ${passed}/${total} field groups populated`);
  return { passed, total };
}

(async () => {
  if (!isShopifyConfigured()) {
    console.error('\x1b[31m✗ Shopify is NOT configured.\x1b[0m');
    console.error('Add SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_TOKEN to backend-cs-treelogy/.env then retry.');
    process.exit(1);
  }

  // 1. Sanity check: can we reach Shopify at all?
  console.log('🔌 Shopify connectivity check...');
  try {
    const data = await shopifyGraphql('{ shop { name primaryDomain { url } } }');
    console.log(`   ${status(true)} connected to: ${data.shop.name} (${data.shop.primaryDomain.url})\n`);
  } catch (err) {
    console.error(`   ${status(false)} connection FAILED:`, err.message);
    process.exit(1);
  }

  // 2. Product search
  console.log(`🔎 Searching products with keywords: [${keywords.join(', ')}]`);
  const products = await searchProducts(keywords, { first: 5 });

  if (products.length === 0) {
    console.log('\n\x1b[33m⚠ No products matched. Try a different keyword, e.g.:\x1b[0m');
    console.log('   node scripts/testShopifyProducts.js <product-name>');
    process.exit(0);
  }

  console.log(`   Found ${products.length} product(s).`);

  // 3. Per-product field report
  let totalPassed = 0;
  let totalChecks = 0;
  for (const p of products) {
    const { passed, total } = summarizeProduct(p);
    totalPassed += passed;
    totalChecks += total;
  }

  console.log(`\n══════════════════════════════════════════════════`);
  console.log(`OVERALL: ${totalPassed}/${totalChecks} field groups populated across ${products.length} products`);
  console.log(`══════════════════════════════════════════════════`);

  if (fullDump) {
    console.log('\n--- FULL JSON ---');
    console.log(JSON.stringify(products, null, 2));
  }
})().catch((err) => {
  console.error('\x1b[31mTest failed:\x1b[0m', err);
  process.exit(1);
});

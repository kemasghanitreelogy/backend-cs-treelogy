#!/usr/bin/env node
/**
 * List every product-level metafield definition in the Shopify store,
 * so we can confirm the exact namespace + key for each field we want.
 */
require('dotenv').config();
const { shopifyGraphql } = require('../src/services/shopifyClient');

const QUERY = /* GraphQL */ `
  {
    metafieldDefinitions(first: 100, ownerType: PRODUCT) {
      edges {
        node {
          namespace
          key
          name
          type { name }
          validations { name value }
        }
      }
    }
  }
`;

(async () => {
  const data = await shopifyGraphql(QUERY);
  const defs = data.metafieldDefinitions.edges.map((e) => e.node);
  if (defs.length === 0) {
    console.log('No product metafield definitions found.');
    return;
  }
  console.log(`\nFound ${defs.length} product metafield definitions:\n`);
  console.log('NAMESPACE.KEY'.padEnd(45) + 'TYPE'.padEnd(35) + 'NAME');
  console.log('-'.repeat(110));
  for (const d of defs) {
    const ref = d.validations.find((v) => v.name === 'metaobject_definition_id');
    const typeDisplay = ref ? `${d.type.name} → ${ref.value}` : d.type.name;
    console.log(`${(d.namespace + '.' + d.key).padEnd(45)}${typeDisplay.padEnd(35)}${d.name}`);
  }
})().catch((err) => { console.error(err); process.exit(1); });

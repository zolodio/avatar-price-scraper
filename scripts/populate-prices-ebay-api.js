#!/usr/bin/env node

/**
 * Avatar TCG Price Scraper → Supabase
 * Using official eBay Browse API (legitimate)
 * 
 * Requires environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   EBAY_CLIENT_ID
 *   EBAY_CLIENT_SECRET
 */

const axios = require('axios');
const Papa = require('papaparse');
const { createClient } = require('@supabase/supabase-js');

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

// eBay API endpoints
const EBAY_AUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_BROWSE_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';

let ebayToken = null;
let tokenExpiry = 0;

// Logging with timestamp
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Validate configuration
if (!SUPABASE_URL || !SUPABASE_KEY) {
  log('❌ Error: Missing Supabase environment variables');
  log('Required: SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
  log('❌ Error: Missing eBay environment variables');
  log('Required: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET');
  process.exit(1);
}

log('✓ Supabase configured');
log('✓ eBay API configured');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Get OAuth token from eBay
 */
async function getEbayToken() {
  if (ebayToken && Date.now() < tokenExpiry) {
    return ebayToken;
  }

  try {
    const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
    
    const response = await axios.post(EBAY_AUTH_URL, 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope', {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000
    });

    ebayToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000; // Refresh 1 min before expiry
    
    return ebayToken;
  } catch (err) {
    log(`❌ Failed to get eBay token: ${err.message}`);
    throw err;
  }
}

/**
 * Search eBay for sold listings of a card
 */
async function searchEbayPrices(cardName, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const token = await getEbayToken();
      
      const searchQuery = `Avatar Quick Strike ${cardName}`;
      
      const response = await axios.get(EBAY_BROWSE_URL, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        },
        params: {
          q: searchQuery,
          filter: 'buyingOptions:{AUCTION|FIXED_PRICE},conditions:{USED|NEW}',
          sort: 'newlyListed',
          limit: 50,
          fieldgroups: 'MATCHING_ITEMS'
        },
        timeout: 10000
      });

      const prices = [];

      if (response.data.itemSummaries && response.data.itemSummaries.length > 0) {
        response.data.itemSummaries.forEach(item => {
          // Look for price in different formats
          let price = null;
          
          if (item.price && item.price.value) {
            price = parseFloat(item.price.value);
          } else if (item.buyingOptions && item.buyingOptions[0]) {
            // Sometimes price is in buyingOptions
            price = parseFloat(item.buyingOptions[0].price?.value || 0);
          }

          if (price && !isNaN(price) && price > 0 && price < 10000) {
            prices.push(price);
          }
        });
      }

      return prices;
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
      }
    }
  }

  return [];
}

/**
 * Upload aggregated prices to Supabase
 */
async function uploadPriceToSupabase(cardNumber, prices) {
  if (prices.length === 0) return null;

  try {
    const priceValues = prices;
    const avg = parseFloat((priceValues.reduce((a, b) => a + b, 0) / priceValues.length).toFixed(2));
    const low = parseFloat(Math.min(...priceValues).toFixed(2));
    const high = parseFloat(Math.max(...priceValues).toFixed(2));
    const sales = prices.length;

    const { error } = await supabase
      .from('prices')
      .upsert({
        card_number: cardNumber,
        low: low,
        avg: avg,
        high: high,
        sales: sales,
        updated_at: new Date().toISOString()
      }, { onConflict: 'card_number' });

    if (error) {
      log(`  ⚠️  [${cardNumber}] Supabase error: ${error.message}`);
      return false;
    }

    return true;
  } catch (err) {
    log(`  ⚠️  [${cardNumber}] Upload error: ${err.message}`);
    return false;
  }
}

/**
 * Load cards from CSV
 */
async function loadCardsFromCSV() {
  log('📥 Loading cards from GitHub CSV...');
  try {
    const response = await axios.get(
      'https://raw.githubusercontent.com/zolodio/Avatar-TCG-Database/refs/heads/TESTING-STOREFRONT/Avatar%20Quick%20Strike%20TCG%20Database%20GitHub.csv',
      { timeout: 15000 }
    );
    
    return new Promise((resolve, reject) => {
      Papa.parse(response.data, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const cards = results.data
            .filter(row => row.Name && row.Number)
            .map(row => ({
              number: row.Number.trim(),
              name: row.Name.trim(),
              rarity: row.Rarity || ''
            }));
          log(`✓ Loaded ${cards.length} cards`);
          resolve(cards);
        },
        error: reject
      });
    });
  } catch (err) {
    log(`❌ Failed to load CSV: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Main scraping loop
 */
async function main() {
  const startTime = Date.now();
  log('🛍️  Avatar TCG Price Scraper Started (eBay API)\n');
  
  const cards = await loadCardsFromCSV();
  
  log(`🔍 Searching eBay API for ${cards.length} cards...\n`);
  
  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const progress = `[${(i + 1).toString().padStart(3)}/${cards.length}]`;
    
    try {
      const prices = await searchEbayPrices(card.name);
      
      if (prices.length === 0) {
        log(`${progress} ${card.number.padEnd(8)} ${card.name.substring(0, 35).padEnd(35)} ⊘ No listings`);
        skipped++;
      } else {
        const avg = (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2);
        const low = Math.min(...prices).toFixed(2);
        const high = Math.max(...prices).toFixed(2);
        
        const uploaded = await uploadPriceToSupabase(card.number, prices);
        
        if (uploaded) {
          log(`${progress} ${card.number.padEnd(8)} ${card.name.substring(0, 35).padEnd(35)} ✓ $${low}–$${high} (avg $${avg}, ${prices.length} listings)`);
          synced++;
        } else {
          log(`${progress} ${card.number.padEnd(8)} ${card.name.substring(0, 35).padEnd(35)} ⚠️  Upload failed`);
          failed++;
        }
      }
    } catch (err) {
      log(`${progress} ${card.number.padEnd(8)} ${card.name.substring(0, 35).padEnd(35)} ✗ Error: ${err.message.substring(0, 30)}`);
      failed++;
    }
    
    // Small delay between requests (API is official, so no aggressive rate limiting needed)
    if (i < cards.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 300));
    }
  }
  
  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  
  log('\n' + '━'.repeat(100));
  log(`\n📊 Scrape Complete (${duration} minutes):`);
  log(`  ✓ Synced:  ${synced}`);
  log(`  ⊘ Skipped: ${skipped} (no listings found)`);
  log(`  ✗ Failed:  ${failed}`);
  log(`\n✅ Prices table updated in Supabase!`);
  log('💾 Refresh your browser to see the prices.\n');
  
  process.exit(0);
}

main().catch(err => {
  log(`\n❌ Fatal error: ${err.message}`);
  process.exit(1);
});

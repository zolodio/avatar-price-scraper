#!/usr/bin/env node

/**
 * Avatar TCG Price Scraper → Supabase
 * 
 * Works in:
 * - Local environment: node populate-prices.js
 * - GitHub Actions: Automatically triggered
 * 
 * Requires environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

const axios = require('axios');
const cheerio = require('cheerio');
const Papa = require('papaparse');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Log with timestamp
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Validate configuration
if (!SUPABASE_URL || !SUPABASE_KEY) {
  log('❌ Error: Missing environment variables');
  log('Required: SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

log('✓ Supabase configured');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

async function scrapeEbayPrices(cardName, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const searchUrl = `https://www.ebay.com/sch/i.html?_nkw=Avatar+Quick+Strike+${encodeURIComponent(cardName)}&LH_Sold=1&LH_Complete=1`;
      
      const response = await axios.get(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        },
        timeout: 8000
      });
      
      const $ = cheerio.load(response.data);
      const prices = [];
      
      $('div.s-item').slice(0, 15).each((i, elem) => {
        const priceText = $(elem).find('.s-item__price').text();
        const priceMatch = priceText.match(/\$[\d,]+\.?\d*/);
        
        if (priceMatch) {
          const price = parseFloat(priceMatch[0].replace(/[$,]/g, ''));
          if (!isNaN(price) && price > 0) {
            prices.push(price);
          }
        }
      });
      
      return prices;
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
  }
  
  return [];
}

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

async function main() {
  const startTime = Date.now();
  log('🛍️  Avatar TCG Price Scraper Started\n');
  
  const cards = await loadCardsFromCSV();
  
  log(`🔍 Scraping eBay prices for ${cards.length} cards...\n`);
  
  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const progress = `[${(i + 1).toString().padStart(3)}/${cards.length}]`;
    
    try {
      const prices = await scrapeEbayPrices(card.name);
      
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
      log(`${progress} ${card.number.padEnd(8)} ${card.name.substring(0, 35).padEnd(35)} ✗ Error`);
      failed++;
    }
    
    // Rate limit: 800ms between eBay requests
    if (i < cards.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 800));
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

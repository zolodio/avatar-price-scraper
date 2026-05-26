const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const Database = require('better-sqlite3');
const Papa = require('papaparse');
const app = express();

app.use(cors());
app.use(express.json());

// Initialize database
const db = new Database('avatar-prices.db');
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    number TEXT,
    name TEXT NOT NULL,
    type TEXT,
    rarity TEXT,
    set_name TEXT,
    imageLink TEXT
  );

  CREATE TABLE IF NOT EXISTS prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cardId TEXT NOT NULL,
    price REAL NOT NULL,
    source TEXT,
    date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(cardId) REFERENCES cards(id)
  );
`);

// Load CSV data on startup
async function loadCSV() {
  try {
    const response = await axios.get(
      'https://raw.githubusercontent.com/zolodio/Avatar-TCG-Database/refs/heads/TESTING-STOREFRONT/Avatar%20Quick%20Strike%20TCG%20Database%20GitHub.csv'
    );
    
    Papa.parse(response.data, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        // Clear old data
        db.prepare('DELETE FROM cards').run();
        
        // Insert new cards
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO cards 
          (id, number, name, type, rarity, set_name, imageLink) 
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        
        results.data.forEach((row) => {
          if (row.Name) {
            const id = `${row.Number || row.Name}`;
            stmt.run(
              id,
              row.Number || '',
              row.Name,
              row.Type || '',
              row.Rarity || '',
              row.Set || '',
              row['Image Link'] || ''
            );
          }
        });
        
        console.log(`✓ Loaded ${results.data.length} cards from CSV`);
      }
    });
  } catch (err) {
    console.error('Error loading CSV:', err.message);
  }
}

// Scrape eBay for Avatar Quick Strike prices
async function scrapeEbayPrices(cardName) {
  try {
    const searchUrl = `https://www.ebay.com/sch/i.html?_nkw=Avatar+Quick+Strike+${encodeURIComponent(cardName)}&LH_Sold=1&LH_Complete=1`;
    
    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });
    
    const $ = cheerio.load(response.data);
    const prices = [];
    
    // Get first 10 sold listings
    $('div.s-item').slice(0, 10).each((i, elem) => {
      const priceText = $(elem).find('.s-item__price').text();
      const titleText = $(elem).find('.s-item__title').text();
      const linkText = $(elem).find('.s-item__link').attr('href');
      
      const priceMatch = priceText.match(/\$[\d,]+\.?\d*/);
      const price = priceMatch ? parseFloat(priceMatch[0].replace(/[$,]/g, '')) : null;
      
      if (price && titleText) {
        prices.push({
          title: titleText.trim(),
          price: price,
          url: linkText
        });
      }
    });
    
    return prices;
  } catch (err) {
    console.error('Scrape error:', err.message);
    return [];
  }
}

// GET all cards
app.get('/api/cards', (req, res) => {
  const cards = db.prepare('SELECT * FROM cards ORDER BY number').all();
  res.json(cards);
});

// GET specific card with price history
app.get('/api/card/:cardId', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.cardId);
  const prices = db.prepare(`
    SELECT price, source, date FROM prices 
    WHERE cardId = ? 
    ORDER BY date DESC 
    LIMIT 50
  `).all(req.params.cardId);
  
  res.json({ card, prices });
});

// GET prices for a card
app.get('/api/prices/:cardId', async (req, res) => {
  const cardId = req.params.cardId;
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  
  if (!card) {
    return res.status(404).json({ error: 'Card not found' });
  }
  
  const prices = await scrapeEbayPrices(card.name);
  
  if (prices.length === 0) {
    return res.json({ 
      card,
      prices: [], 
      message: 'No sold listings found' 
    });
  }
  
  // Calculate stats
  const priceValues = prices.map(p => p.price);
  const avgPrice = (priceValues.reduce((a, b) => a + b, 0) / priceValues.length).toFixed(2);
  const minPrice = Math.min(...priceValues).toFixed(2);
  const maxPrice = Math.max(...priceValues).toFixed(2);
  
  res.json({
    card,
    prices,
    stats: {
      average: avgPrice,
      min: minPrice,
      max: maxPrice,
      count: prices.length
    }
  });
});

// POST save price to database
app.post('/api/price', (req, res) => {
  const { cardId, price, source } = req.body;
  
  try {
    db.prepare('INSERT INTO prices (cardId, price, source, date) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
      .run(cardId, price, source || 'eBay');
    
    res.json({ success: true, message: 'Price saved' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET price history for a card
app.get('/api/price-history/:cardId', (req, res) => {
  const prices = db.prepare(`
    SELECT price, source, date FROM prices 
    WHERE cardId = ? 
    ORDER BY date DESC
  `).all(req.params.cardId);
  
  res.json(prices);
});

// GET all saved prices
app.get('/api/saved-prices', (req, res) => {
  const prices = db.prepare(`
    SELECT c.id, c.number, c.name, c.rarity, p.price, p.source, p.date
    FROM prices p
    JOIN cards c ON p.cardId = c.id
    ORDER BY c.number, p.date DESC
  `).all();
  
  res.json(prices);
});

// Health check
app.get('/', (req, res) => {
  const cardCount = db.prepare('SELECT COUNT(*) as count FROM cards').get();
  const priceCount = db.prepare('SELECT COUNT(*) as count FROM prices').get();
  res.json({ 
    status: 'Avatar Price Scraper is running!',
    cards: cardCount.count,
    prices: priceCount.count
  });
});

const PORT = process.env.PORT || 3000;

// Load CSV and start server
loadCSV();

app.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`);
  console.log(`✓ Visit http://localhost:${PORT} for status`);
});

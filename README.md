# Avatar Quick Strike TCG Price Scraper

eBay price scraper for Avatar Quick Strike TCG cards with live pricing and history tracking.

## Features

- 📊 **248+ Avatar TCG Cards** - Auto-loaded from GitHub CSV
- 🔍 **Live eBay Scraping** - Real sold listing prices
- 💾 **Price History** - Track prices over time
- 📈 **Statistics** - Average, min, max prices
- 🎨 **Beautiful UI** - Integrated into your one-page app

## Local Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Locally
```bash
npm start
```

Server runs on `http://localhost:3000`

### 3. Test API
```
http://localhost:3000 → Status page
http://localhost:3000/api/cards → All cards
http://localhost:3000/api/prices/1 → Prices for card #1
```

## Deploy to Render

### 1. Push to GitHub
```bash
git add .
git commit -m "Add Avatar TCG price scraper"
git push origin main
```

### 2. Deploy on Render
1. Go to https://render.com
2. Sign in with GitHub
3. Click "New +" → "Web Service"
4. Select `avatar-price-scraper` repo
5. Configure:
   - **Name**: `avatar-price-scraper`
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
6. Click "Create Web Service"
7. Wait 2-3 minutes for deployment
8. Copy the URL (e.g., `https://avatar-price-scraper.onrender.com`)

### 3. Update Frontend
In your HTML, change:
```javascript
const API_URL = 'https://avatar-price-scraper.onrender.com/api';
```

## API Endpoints

### GET /api/cards
Get all Avatar TCG cards
```
Response: [{id, number, name, type, rarity, set_name, imageLink}, ...]
```

### GET /api/prices/:cardId
Get live eBay prices for a card
```
Response: {card, prices, stats: {average, min, max, count}}
```

### POST /api/price
Save a price to database
```
Body: {cardId, price, source}
```

### GET /api/saved-prices
Get all saved prices
```
Response: [{id, number, name, rarity, price, source, date}, ...]
```

## Database

Uses SQLite with two tables:
- **cards** - All 248+ Avatar TCG cards from GitHub CSV
- **prices** - Saved price entries with timestamps

## Notes

- **Free Render Tier**: Server spins down after 15 min of inactivity
  - First request takes 10-30 sec to wake up
  - Perfect for your low-volume use case
- **Auto-Deploy**: Push to GitHub → auto-deploys on Render
- **Card Updates**: CSV is fetched from GitHub on server startup

## Files

- `server.js` - Backend API & web scraper
- `package.json` - Dependencies
- `.gitignore` - Ignore node_modules & database

## Troubleshooting

**"Cards not loading"**
- Check Render logs for CSV fetch errors
- Database file may need to be deleted

**"eBay scraping fails"**
- eBay sometimes blocks scrapers
- Try different card names
- Wait a few minutes before retrying

**"Prices showing as $0"**
- eBay page format may have changed
- Check console errors in browser
- File an issue with card name

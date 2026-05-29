const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const EXCLUDE_DOMAINS = ['sentry.io','wixpress.com','squarespace.com','shopify.com','example.com','domain.com','email.com','yoursite.com','yourdomain.com'];

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.json({ status: 'ok', service: 'LaunchX Email Scraper' }));

// ── SEARCH GOOGLE MAPS ──
app.post('/search-maps', async (req, res) => {
  const { trade, city, count = 10 } = req.body;
  if (!trade || !city) return res.status(400).json({ error: 'trade and city required' });
  if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'GOOGLE_API_KEY not set' });

  try {
    const query = `${trade} in ${city}`;
    // Step 1: Text search to get place IDs
    const searchRes = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: { query, key: GOOGLE_API_KEY, type: 'establishment' }
    });

    const places = searchRes.data.results.slice(0, count);
    const businesses = [];

    for (const place of places) {
      // Step 2: Get place details (website, phone)
      try {
        const detailRes = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
          params: { place_id: place.place_id, fields: 'name,formatted_phone_number,website,formatted_address', key: GOOGLE_API_KEY }
        });
        const d = detailRes.data.result;
        businesses.push({
          biz: d.name || place.name,
          phone: d.formatted_phone_number || '',
          website: d.website || '',
          address: d.formatted_address || '',
          city,
          trade
        });
      } catch {
        businesses.push({ biz: place.name, phone: '', website: '', address: '', city, trade });
      }
    }

    res.json({ businesses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SCRAPE EMAIL FROM WEBSITE ──
app.post('/scrape-email', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const emails = await scrapeEmailsFromSite(url);
    res.json({ emails, url });
  } catch (err) {
    res.json({ emails: [], url, error: err.message });
  }
});

// ── BATCH SCRAPE ──
app.post('/scrape-batch', async (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: 'urls array required' });

  const results = [];
  for (const url of urls.slice(0, 20)) { // cap at 20
    try {
      const emails = await scrapeEmailsFromSite(url);
      results.push({ url, emails });
    } catch (err) {
      results.push({ url, emails: [], error: err.message });
    }
  }
  res.json({ results });
});

// ── HELPER: scrape emails from a site ──
async function scrapeEmailsFromSite(url) {
  const pages = [url, url.replace(/\/$/, '') + '/contact', url.replace(/\/$/, '') + '/about'];
  const found = new Set();

  for (const page of pages) {
    try {
      const response = await axios.get(page, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EmailFinder/1.0)' },
        maxRedirects: 3
      });
      const html = response.data;
      const $ = cheerio.load(html);

      // Remove scripts/styles to avoid garbage
      $('script, style').remove();
      const text = $.text() + ' ' + html;

      const matches = text.match(EMAIL_REGEX) || [];
      matches.forEach(e => {
        const domain = e.split('@')[1]?.toLowerCase();
        if (domain && !EXCLUDE_DOMAINS.some(ex => domain.includes(ex)) && !e.includes('..')) {
          found.add(e.toLowerCase());
        }
      });

      if (found.size > 0) break; // stop once we find emails
    } catch { /* try next page */ }
  }

  return [...found].slice(0, 3); // return top 3
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Email scraper running on port ${PORT}`));

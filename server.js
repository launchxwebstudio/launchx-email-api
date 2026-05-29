const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // add this in Render environment variables

// Strict regex — requires a real TLD, rejects image extensions and paths
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|svg|ico|bmp|tiff?|avif|mp4|mp3|css|js|woff2?|eot|ttf)$/i;
const EXCLUDE_DOMAINS = [
  'sentry.io','wixpress.com','squarespace.com','shopify.com',
  'example.com','domain.com','email.com','yoursite.com','yourdomain.com',
  'cloudinary.com','amazonaws.com','cloudfront.net','imgix.net'
];

function isValidEmail(str) {
  if (!str) return false;
  const parts = str.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || /[\s\/\\]/.test(local)) return false;
  if (!domain.includes('.') || /[\/\\]/.test(domain)) return false;
  if (IMAGE_EXTENSIONS.test(domain)) return false; // catches flags@2x.webp etc.
  const excluded = EXCLUDE_DOMAINS.some(ex => domain.toLowerCase().includes(ex));
  if (excluded) return false;
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(str);
}

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.json({ status: 'ok', service: 'LaunchX Email Scraper' }));

// ── ANTHROPIC PROXY ──
// Forwards requests to the Anthropic API, attaching your secret key server-side.
// The frontend never sees ANTHROPIC_API_KEY.
app.post('/anthropic-proxy', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Render environment variables' });
  }
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      req.body,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05'
        },
        timeout: 60000 // 60s — AI calls can take a moment
      }
    );
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data || { error: err.message };
    res.status(status).json(message);
  }
});

// ── SEARCH GOOGLE MAPS ──
app.post('/search-maps', async (req, res) => {
  const { trade, city, count = 10 } = req.body;
  if (!trade || !city) return res.status(400).json({ error: 'trade and city required' });
  if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'GOOGLE_API_KEY not set' });

  try {
    const query = `${trade} in ${city}`;
    const searchRes = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: { query, key: GOOGLE_API_KEY, type: 'establishment' }
    });

    const places = searchRes.data.results.slice(0, count);
    const businesses = [];

    for (const place of places) {
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
          city, trade
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
  for (const url of urls.slice(0, 20)) {
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
  const base = url.replace(/\/$/, '');
  const pages = [base, base + '/contact', base + '/about'];
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
      $('script, style').remove();
      const text = $.text() + ' ' + html;

      const matches = text.match(EMAIL_REGEX) || [];
      matches.forEach(e => {
        if (isValidEmail(e)) found.add(e.toLowerCase());
      });

      if (found.size > 0) break;
    } catch { /* try next page */ }
  }

  return [...found].slice(0, 3);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Email scraper running on port ${PORT}`));

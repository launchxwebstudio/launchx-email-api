const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|svg|ico|bmp|tiff?|avif|mp4|mp3|css|js|woff2?|eot|ttf)$/i;
const EXCLUDE_DOMAINS = [
  'sentry.io','wixpress.com','squarespace.com','shopify.com',
  'example.com','domain.com','email.com','yoursite.com','yourdomain.com',
  'cloudinary.com','amazonaws.com','cloudfront.net','imgix.net',
  'googleusercontent.com','googleapis.com','gstatic.com'
];

function isValidEmail(str) {
  if (!str || typeof str !== 'string') return false;
  str = str.trim();
  const parts = str.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || /[\s\/\\]/.test(local)) return false;
  if (!domain.includes('.') || /[\/\\]/.test(domain)) return false;
  if (IMAGE_EXTENSIONS.test(domain)) return false;
  if (EXCLUDE_DOMAINS.some(ex => domain.toLowerCase().includes(ex))) return false;
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(str);
}

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.json({ status: 'ok', service: 'LaunchX Email Scraper' }));

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
          params: {
            place_id: place.place_id,
            fields: 'name,formatted_phone_number,website,formatted_address',
            key: GOOGLE_API_KEY
          }
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
  // Check homepage + common contact pages
  const pages = [
    base,
    base + '/contact',
    base + '/contact-us',
    base + '/about',
    base + '/about-us'
  ];
  const found = new Set();

  for (const page of pages) {
    try {
      const response = await axios.get(page, {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        maxRedirects: 3
      });
      const html = response.data;
      const $ = cheerio.load(html);

      // Remove noise
      $('script, style, noscript, img, svg').remove();

      // Check visible text first
      const text = $.text();
      const rawHtml = html;

      // Also decode mailto: links which often have obfuscated emails
      $('a[href^="mailto:"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const email = href.replace('mailto:', '').split('?')[0].trim();
        if (isValidEmail(email)) found.add(email.toLowerCase());
      });

      // Match emails in text and raw HTML
      const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
      const textMatches = (text + ' ' + rawHtml).match(EMAIL_REGEX) || [];
      textMatches.forEach(e => {
        if (isValidEmail(e)) found.add(e.toLowerCase());
      });

      if (found.size > 0) break; // stop as soon as we find valid emails
    } catch { /* try next page */ }
  }

  return [...found].slice(0, 3);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Email scraper running on port ${PORT}`));

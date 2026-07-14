const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/*
  Live news setup
  ----------------
  1) First tries GNews if you have an API key.
  2) If GNews fails because of quota / wrong key / network / API issue,
     it automatically falls back to Google News RSS.
  3) Result: your globe should still show live news instead of "fetch failed".

  Safer option:
  - Create a .env later and keep keys outside code.
  - For now, this also works without any key because RSS fallback is enabled.
*/
const GNEWS_API_KEY = process.env.GNEWS_API_KEY || "4034aa889b6c84c246e90e2469f0dad";

const CATEGORY_QUERY = {
  all: "",
  business: "business economy markets",
  technology: "technology AI startups software",
  sports: "sports",
  health: "health medicine",
  politics: "politics government election",
  entertainment: "entertainment movies music celebrities"
};

function cleanText(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function getTag(item, tag) {
  const match = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return cleanText(match ? match[1] : "");
}

function extractSourceFromTitle(title = "") {
  // Google News titles often look like: "Headline - Publisher"
  const parts = title.split(" - ");
  return parts.length > 1 ? parts[parts.length - 1].trim() : "Google News";
}

function buildSearchQuery(country, category) {
  const cat = CATEGORY_QUERY[category] || CATEGORY_QUERY.all;
  return [country, cat, "news"].filter(Boolean).join(" ").trim();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 GlobeNews/1.0",
        ...(options.headers || {})
      }
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromGNews(country, category) {
  if (!GNEWS_API_KEY || GNEWS_API_KEY.length < 20) {
    throw new Error("GNews API key missing");
  }

  const q = buildSearchQuery(country, category);
  const url =
    "https://gnews.io/api/v4/search?" +
    `q=${encodeURIComponent(q)}` +
    "&lang=en" +
    "&max=10" +
    `&apikey=${encodeURIComponent(GNEWS_API_KEY)}`;

  const response = await fetchWithTimeout(url);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const msg = data?.errors?.[0] || data?.message || `GNews HTTP ${response.status}`;
    throw new Error(msg);
  }

  if (!Array.isArray(data.articles)) {
    throw new Error("GNews returned no articles array");
  }

  return {
    source: "gnews",
    totalArticles: data.totalArticles || data.articles.length,
    articles: data.articles.map(article => ({
      title: article.title || "Untitled",
      description: article.description || article.content || "Open the article to read more.",
      url: article.url || "#",
      image: article.image || "",
      publishedAt: article.publishedAt || new Date().toISOString(),
      source: {
        name: article.source?.name || "GNews"
      }
    }))
  };
}

async function fetchFromGoogleNewsRSS(country, category) {
  const q = buildSearchQuery(country, category);
  const rssUrl =
    "https://news.google.com/rss/search?" +
    `q=${encodeURIComponent(q)}` +
    "&hl=en-IN&gl=IN&ceid=IN:en";

  const response = await fetchWithTimeout(rssUrl, {
    headers: {
      Accept: "application/rss+xml,text/xml,*/*"
    }
  });

  if (!response.ok) {
    throw new Error(`Google News RSS HTTP ${response.status}`);
  }

  const xml = await response.text();
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

  const articles = items.slice(0, 10).map(item => {
    const title = getTag(item, "title");
    const link = getTag(item, "link");
    const pubDate = getTag(item, "pubDate");
    const description = getTag(item, "description");
    const sourceMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    const sourceName = cleanText(sourceMatch ? sourceMatch[1] : extractSourceFromTitle(title));

    return {
      title: title || "Untitled",
      description: description || "Open the article to read more.",
      url: link || "#",
      image: "",
      publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      source: {
        name: sourceName || "Google News"
      }
    };
  });

  return {
    source: "google-news-rss",
    totalArticles: articles.length,
    articles
  };
}

app.get("/api/news", async (req, res) => {
  const country = String(req.query.country || "India").trim();
  const category = String(req.query.category || "all").trim() || "all";

  try {
    let data;
    let fallbackReason = "";

    try {
      data = await fetchFromGNews(country, category);
    } catch (gnewsError) {
      fallbackReason = gnewsError.message;
      console.warn("GNews failed, using RSS fallback:", fallbackReason);
      data = await fetchFromGoogleNewsRSS(country, category);
    }

    res.json({
      ok: true,
      country,
      category,
      provider: data.source,
      fallbackReason,
      totalArticles: data.totalArticles,
      articles: data.articles
    });
  } catch (error) {
    console.error("All news providers failed:", error);

    res.status(500).json({
      ok: false,
      error: "All news providers failed",
      message: error.message,
      articles: []
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// War / conflict — curated active-conflict list (always returns data)
app.get("/api/conflict", (req, res) => {
  res.json({ conflicts: [
    { name: "Russia–Ukraine war", region: "Eastern Europe", intensity: 95 },
    { name: "Israel–Gaza / Hamas", region: "Middle East", intensity: 90 },
    { name: "Sudan civil war (RSF vs SAF)", region: "Africa", intensity: 88 },
    { name: "Myanmar civil war", region: "SE Asia", intensity: 80 },
    { name: "Sahel insurgency (Mali/Niger/Burkina)", region: "Africa", intensity: 78 },
    { name: "DR Congo (M23, east)", region: "Africa", intensity: 76 },
    { name: "Israel–Hezbollah (Lebanon)", region: "Middle East", intensity: 72 },
    { name: "Somalia (al-Shabaab)", region: "Africa", intensity: 70 },
    { name: "Yemen civil war", region: "Middle East", intensity: 68 },
    { name: "Syria conflict", region: "Middle East", intensity: 60 },
    { name: "Ethiopia (Amhara unrest)", region: "Africa", intensity: 58 },
    { name: "Haiti gang crisis", region: "Caribbean", intensity: 55 }
  ]});
});

// Climate anomalies / active natural events (NASA EONET)
app.get("/api/climate", async (req, res) => {
  try {
    const r = await fetchWithTimeout("https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=120", {}, 12000);
    res.json(await r.json());
  } catch (e) { res.json({ events: [] }); }
});

// Live prices: gold, silver, BTC, ETH (no API key)
app.get("/api/prices", async (req, res) => {
  try {
    const [gold, silver, crypto] = await Promise.all([
      fetchWithTimeout("https://api.gold-api.com/price/XAU", {}, 8000).then(r => r.json()).catch(() => null),
      fetchWithTimeout("https://api.gold-api.com/price/XAG", {}, 8000).then(r => r.json()).catch(() => null),
      fetchWithTimeout("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true", {}, 8000).then(r => r.json()).catch(() => ({}))
    ]);
    res.json({
      gold: gold && gold.price ? gold.price : null,
      silver: silver && silver.price ? silver.price : null,
      btc: crypto.bitcoin ? { price: crypto.bitcoin.usd, chg: crypto.bitcoin.usd_24h_change } : null,
      eth: crypto.ethereum ? { price: crypto.ethereum.usd, chg: crypto.ethereum.usd_24h_change } : null
    });
  } catch (e) { res.json({}); }
});

// Live oil benchmark prices: Brent, WTI, Natural Gas (Yahoo Finance, no key)
app.get("/api/oil", async (req, res) => {
  async function yf(sym) {
    try {
      const r = await fetchWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`, {}, 8000);
      const d = await r.json();
      const m = d.chart.result[0].meta;
      const price = m.regularMarketPrice, prev = m.chartPreviousClose || m.previousClose;
      return { price, chg: prev ? ((price - prev) / prev) * 100 : null };
    } catch (e) { return null; }
  }
  const [brent, wti, gas] = await Promise.all([yf("BZ=F"), yf("CL=F"), yf("NG=F")]);
  res.json({ brent, wti, gas });
});

// Live aircraft positions (OpenSky Network, no key)
app.get("/api/flights", async (req, res) => {
  try {
    const r = await fetchWithTimeout("https://opensky-network.org/api/states/all", {}, 12000);
    const d = await r.json();
    let s = (d.states || []).filter(a => a[5] != null && a[6] != null && !a[8]).map(a => ({
      lon: a[5], lat: a[6], vel: a[9] || 0, trk: a[10] || 0
    }));
    const CAP = 2500;
    if (s.length > CAP) { const step = s.length / CAP, out = []; for (let i = 0; i < s.length; i += step) out.push(s[Math.floor(i)]); s = out; }
    res.json({ flights: s });
  } catch (e) { res.json({ flights: [] }); }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`GlobeNews running on http://localhost:${PORT}`);
  console.log("Live news endpoint: http://localhost:" + PORT + "/api/news?country=India");
});
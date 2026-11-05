const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const express = require("express");

// Scrapes an HTML page URL to automatically locate embedded .m3u8 links
async function extractM3u8FromPage(pageUrl) {
    try {
        const response = await fetch(pageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': pageUrl
            }
        });
        const html = await response.text();

        // Match standard m3u8 playlist URLs in scripts or attributes
        const m3u8Match = html.match(/(https?:[^\s"'<>]+?\.m3u8[^\s"'<>]*)/i);
        if (m3u8Match && m3u8Match[0]) {
            return m3u8Match[0];
        }
    } catch (err) {
        console.error(`Failed to extract m3u8 from ${pageUrl}:`, err.message);
    }
    return null;
}

const API_BASE = "https://api.ppv.st/api";
const TIMEZONE = process.env.TZ_DISPLAY || "Australia/Sydney";
const CACHE_MS = 60 * 1000;

// Official PPV domains. The first is the main link, the rest are listed as mirrors.
// Override in Render with PPV_SITES=ppv.st,ppv.tj,...
const PPV_SITES = (process.env.PPV_SITES ||
  "ppv.st,ppv.tj,ppvs.pk,ppv.rw,ppv.ms,ppv.bi,ppv.ug")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------- custom HLS feeds ----------
// ENABLE_HLS_PROXY=true wraps custom feeds & extracted streams in the Cloudflare Worker relay.
// HLS_RELAY_URL overrides the relay endpoint.
const ENABLE_HLS_PROXY = String(process.env.ENABLE_HLS_PROXY || "false").toLowerCase() === "true";
const HLS_RELAY_URL = (process.env.HLS_RELAY_URL ||
  "https://stremio-hls-relay.stremio-hls-relay-worker.workers.dev/stream").replace(/\/+$/, "");

function isValidHlsUrl(raw) {
  try {
    const u = new URL(raw);
    return (u.protocol === "https:" || u.protocol === "http:") && /\.m3u8$/i.test(u.pathname);
  } catch {
    return false;
  }
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function loadHlsFeeds() {
  if (!process.env.HLS_FEEDS) return [];
  let parsed;
  try {
    parsed = JSON.parse(process.env.HLS_FEEDS);
  } catch (err) {
    console.error("HLS_FEEDS is not valid JSON:", err.message);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set();
  const feeds = [];
  for (const f of parsed) {
    if (!f || !isValidHlsUrl(f.url)) {
      console.warn("Skipping HLS feed with invalid .m3u8 url:", f && f.url);
      continue;
    }
    const id = slug(f.id || f.name || feeds.length);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    feeds.push({
      id,
      name: f.name || id,
      url: f.url,
      poster: f.poster,
      category: f.category || "Custom HLS"
    });
  }
  return feeds;
}

const HLS_FEEDS = loadHlsFeeds();

// Wraps a .m3u8 feed in a Stremio stream object. With the proxy on, the relayed
// stream comes first and the direct URL follows as a fallback; with it off, only
// the direct URL is returned. Returns [] for anything that isn't a valid .m3u8 URL.
function buildHlsStreamObject(hlsUrl, label = "HLS") {
  if (!isValidHlsUrl(hlsUrl)) return [];
  const direct = {
    name: "HLS Stream",
    title: ENABLE_HLS_PROXY ? `${label} • Direct (fallback)` : `${label} • Direct`,
    url: hlsUrl,
    behaviorHints: { notWebReady: true }
  };
  if (!ENABLE_HLS_PROXY) return [direct];
  return [
    {
      name: "HLS Stream",
      title: `${label} • Native Relay`,
      url: `${HLS_RELAY_URL}?url=${encodeURIComponent(hlsUrl)}`,
      behaviorHints: { notWebReady: true }
    },
    direct
  ];
}

// Shown in Stremio's genre dropdown on the Discover page.
const CATEGORIES = [
  "American Football",
  "Australian Football",
  "Basketball",
  "Cricket",
  "Football",
  "Golf",
  "Ice Hockey",
  "Rugby",
  "Wrestling",
  "24/7 Streams"
];

const manifest = {
  id: "org.ppvst.sports",
  version: "1.1.1",
  name: "PPV Sports Live",
  description: "Live sports streams and scheduled events provided by PPV.ST",
  resources: ["catalog", "meta", "stream"],
  types: ["tv"],
  idPrefixes: HLS_FEEDS.length ? ["ppv_", "hls_"] : ["ppv_"],
  catalogs: [
    ...(HLS_FEEDS.length
      ? [{ type: "tv", id: "hls_custom", name: "Custom HLS" }]
      : []),
    {
      type: "tv",
      id: "ppv_live",
      name: "PPV Live Now"
    },
    {
      type: "tv",
      id: "ppv_sports",
      name: "PPV Sports",
      extra: [
        { name: "genre", options: CATEGORIES, isRequired: false },
        { name: "search", isRequired: false }
      ]
    }
  ]
};

const builder = new addonBuilder(manifest);

// ---------- data ----------

let cache = { at: 0, events: [] };

function toMs(t) {
  if (!t) return 0;
  return t < 1e12 ? t * 1000 : t;
}

async function fetchEvents() {
  if (Date.now() - cache.at < CACHE_MS && cache.events.length) return cache.events;
  try {
    const res = await fetch(`${API_BASE}/streams`, { timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.success && Array.isArray(data.streams)) {
      const events = [];
      for (const cat of data.streams) {
        if (!Array.isArray(cat.streams)) continue;
        for (const item of cat.streams) {
          events.push({
            ...item,
            category: cat.category,
            startMs: toMs(item.starts_at),
            endMs: toMs(item.ends_at),
            alwaysLive: Boolean(item.always_live || cat.always_live)
          });
        }
      }
      cache = { at: Date.now(), events };
    }
  } catch (err) {
    console.error("Error fetching streams:", err.message);
  }
  return cache.events;
}

function isLive(ev, now = Date.now()) {
  if (ev.alwaysLive) return true;
  return ev.startMs && ev.startMs <= now && (!ev.endMs || ev.endMs > now);
}

function hasEnded(ev, now = Date.now()) {
  return !ev.alwaysLive && ev.endMs && ev.endMs < now;
}

function formatStart(ms) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: TIMEZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(ms));
}

function timeLabel(ev) {
  if (ev.alwaysLive) return "24/7";
  if (isLive(ev)) return "LIVE NOW";
  if (ev.startMs) return formatStart(ev.startMs);
  return "";
}

// Live events first, then upcoming by start time, 24/7 channels last.
function sortEvents(a, b) {
  const rank = (e) => (e.alwaysLive ? 2 : isLive(e) ? 0 : 1);
  const r = rank(a) - rank(b);
  if (r !== 0) return r;
  return (a.startMs || 0) - (b.startMs || 0);
}

function toMeta(ev) {
  const live = isLive(ev) && !ev.alwaysLive;
  const when = timeLabel(ev);
  return {
    id: `ppv_${ev.id}`,
    type: "tv",
    name: live ? `🔴 ${ev.name}` : ev.name || "Live Match",
    poster: ev.poster || undefined,
    posterShape: "landscape",
    background: ev.poster || undefined,
    genres: [ev.category],
    releaseInfo: when,
    description: [
      when && `${when}`,
      ev.category,
      ev.tag && `Broadcaster: ${ev.tag}`
    ]
      .filter(Boolean)
      .join(" • ")
  };
}

function hlsFeedToMeta(feed) {
  return {
    id: `hls_${feed.id}`,
    type: "tv",
    name: feed.name,
    poster: feed.poster || undefined,
    posterShape: "landscape",
    background: feed.poster || undefined,
    genres: [feed.category],
    description: feed.category
  };
}

function findHlsFeed(id) {
  return HLS_FEEDS.find((f) => `hls_${f.id}` === id) || null;
}

// ---------- handlers ----------

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "tv") return { metas: [] };

  if (id === "hls_custom") {
    return { metas: HLS_FEEDS.map(hlsFeedToMeta), cacheMaxAge: 300 };
  }

  const now = Date.now();
  let events = (await fetchEvents()).filter((e) => !hasEnded(e, now));

  if (id === "ppv_live") {
    events = events.filter((e) => isLive(e, now) && !e.alwaysLive);
  } else if (id === "ppv_sports") {
    if (extra && extra.genre) {
      events = events.filter((e) => e.category === extra.genre);
    }
    if (extra && extra.search) {
      const q = extra.search.toLowerCase();
      events = events.filter((e) =>
        [e.name, e.category, e.tag, e.source_tag]
          .filter(Boolean)
          .some((s) => s.toLowerCase().includes(q))
      );
    }
  } else {
    return { metas: [] };
  }

  events.sort(sortEvents);
  return { metas: events.map(toMeta), cacheMaxAge: 60 };
});

async function findEvent(id) {
  const streamId = parseInt(id.replace("ppv_", ""), 10);
  const events = await fetchEvents();
  return events.find((e) => e.id === streamId) || null;
}
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const express = require("express");

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
  idPrefixes: ["ppv_"],
  catalogs: [
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

// ---------- handlers ----------

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "tv") return { metas: [] };

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

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "tv" || !id.startsWith("ppv_")) return { meta: null };
  const ev = await findEvent(id);
  if (!ev) return { meta: null };
  return { meta: toMeta(ev), cacheMaxAge: 60 };
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "tv" || !id.startsWith("ppv_")) return { streams: [] };
  const ev = await findEvent(id);
  if (!ev || !ev.uri_name) return { streams: [] };

  const label = ev.source_tag || ev.tag || ev.name;
  return {
    streams: PPV_SITES.map((site, i) => ({
      name: i === 0 ? "PPV" : "PPV Mirror",
      title: `${site} • ${label}`,
      externalUrl: `https://${site}/live/${ev.uri_name}`
    }))
  };
});

// ---------- server ----------

const app = express();
const addonInterface = builder.getInterface();

app.set("trust proxy", true);

app.get("/", (req, res) => {
  const host = req.get("host");
  const manifestUrl = `${req.protocol}://${host}/manifest.json`;
  const installUrl = `stremio://${host}/manifest.json`;
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${manifest.name}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0f0d1a;color:#eee;font-family:system-ui,sans-serif;padding:16px;box-sizing:border-box}
  .card{max-width:440px;width:100%;background:#1b1830;border-radius:14px;padding:28px;text-align:center}
  h1{margin:0 0 8px;font-size:24px}
  p{color:#aaa;line-height:1.5}
  a.btn{display:inline-block;margin:16px 0;padding:14px 28px;border-radius:10px;
        background:#7b5bf5;color:#fff;text-decoration:none;font-weight:600}
  code{display:block;word-break:break-all;background:#0f0d1a;padding:10px;border-radius:8px;
       font-size:13px;user-select:all}
</style></head><body><div class="card">
  <h1>${manifest.name}</h1>
  <p>${manifest.description}</p>
  <a class="btn" href="${installUrl}">Install in Stremio</a>
  <p>Or paste this into Stremio's add-on search bar<br>(use this on Firestick / TV):</p>
  <code>${manifestUrl}</code>
</div></body></html>`);
});

app.use(getRouter(addonInterface));

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`Add-on running on port ${PORT}`);
});

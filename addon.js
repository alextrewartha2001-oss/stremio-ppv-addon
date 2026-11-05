const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const express = require("express");

const API_BASE = "https://api.ppv.st/api";

const manifest = {
  id: "org.ppvst.sports",
  version: "1.0.0",
  name: "PPV Sports Live",
  description: "Live sports streams and scheduled events provided by PPV.ST",
  resources: ["catalog", "meta", "stream"],
  types: ["tv"],
  catalogs: [
    {
      type: "tv",
      id: "ppv_sports",
      name: "PPV Sports"
    }
  ]
};

const builder = new addonBuilder(manifest);

async function fetchStreams() {
  try {
    const res = await fetch(`${API_BASE}/streams`);
    const data = await res.json();
    if (data && data.success && Array.isArray(data.streams)) {
      return data.streams;
    }
  } catch (err) {
    console.error("Error fetching streams:", err);
  }
  return [];
}

builder.defineCatalogHandler(async ({ type, id }) => {
  if (type !== "tv" || id !== "ppv_sports") return { metas: [] };

  const categories = await fetchStreams();
  const metas = [];

  for (const cat of categories) {
    if (Array.isArray(cat.streams)) {
      for (const item of cat.streams) {
        metas.push({
          id: `ppv_${item.id}`,
          type: "tv",
          name: item.name || "Live Match",
          poster: item.poster || "",
          description: `Category: ${cat.category} | Broadcaster: ${item.tag || "N/A"}`
        });
      }
    }
  }

  return { metas };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "tv" || !id.startsWith("ppv_")) return { meta: null };

  const streamId = parseInt(id.replace("ppv_", ""), 10);
  const categories = await fetchStreams();

  let foundItem = null;
  let foundCategory = "";

  for (const cat of categories) {
    if (Array.isArray(cat.streams)) {
      const match = cat.streams.find((s) => s.id === streamId);
      if (match) {
        foundItem = match;
        foundCategory = cat.category;
        break;
      }
    }
  }

  if (!foundItem) return { meta: null };

  return {
    meta: {
      id: id,
      type: "tv",
      name: foundItem.name,
      poster: foundItem.poster,
      description: `Category: ${foundCategory}\nSource: ${foundItem.tag || "Live Broadcast"}\nURI: ${foundItem.uri_name}`
    }
  };
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "tv" || !id.startsWith("ppv_")) return { streams: [] };

  const streamId = parseInt(id.replace("ppv_", ""), 10);
  const categories = await fetchStreams();

  let foundItem = null;
  for (const cat of categories) {
    if (Array.isArray(cat.streams)) {
      const match = cat.streams.find((s) => s.id === streamId);
      if (match) {
        foundItem = match;
        break;
      }
    }
  }

  if (!foundItem) return { streams: [] };

  const results = [];

  if (foundItem.iframe) {
    const match = foundItem.iframe.match(/src=["']([^"']+)["']/i);
    if (match && match[1]) {
      results.push({
        title: `Watch Embed (${foundItem.tag || "Live"})`,
        externalUrl: match[1]
      });
    }
  }

  if (foundItem.uri_name) {
    results.push({
      title: `Watch on Web (${foundItem.name})`,
      externalUrl: `https://ppv.land/watch/${foundItem.uri_name}`
    });
  }

  return { streams: results };
});

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
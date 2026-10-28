#!/usr/bin/env node
/**
 * Minimalist (beminimalist.co) product pipeline  -  Node.js version
 * ================================================================
 *
 * STEP 1  clean  : minimilast.json -> master-minimilast.json
 *                  - keeps every product field as-is
 *                  - `images` becomes a plain array of image URL strings
 *                  - adds `url` + `product_urls` (baseURL/products/<handle>?variant=<id>)
 *
 * STEP 2  scrape : opens every product URL, reads the page source and saves
 *                  subtitle / quote / highlights / toggle-tab sections under `details`.
 *                  Resumable: products already scraped are skipped.
 *
 * Setup (Node 18+):
 *   npm init -y && npm install cheerio
 *
 * Usage:
 *   node minimalist_pipeline.js clean  minimilast.json
 *   node minimalist_pipeline.js scrape
 *   node minimalist_pipeline.js all    minimilast.json
 *   node minimalist_pipeline.js scrape --force
 *   node minimalist_pipeline.js scrape --handle salicylic-lha-2-cleanser
 *   node minimalist_pipeline.js scrape --out my-output.json
 *
 * Files:  minimilast.json -> (clean) -> master-minimilast.json -> (scrape) -> master-minimilast2.json
 */
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const BASE_URL = "https://beminimalist.co";
const DEFAULT_MASTER = "master-minimilast.json";   // clean file (step 1 output, never modified by scrape)
const DEFAULT_OUT = "master-minimilast2.json";      // scraped file (step 2 output)
const DELAY_MS = 1500; // be polite to the server
const TIMEOUT_MS = 30000;
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "en-IN,en;q=0.9",
};

// ---------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const cleanText = (s) => (s || "").replace(/[ \t\r\f\v\u00a0]+/g, " ").trim();

function saveJson(data, p) {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, p); // atomic: never leaves a half-written master
}

function productUrl(product, variantId) {
  const id = variantId ?? product.variants[0].id;
  return `${BASE_URL}/products/${product.handle}?variant=${id}`;
}

// ---------------------------------------------------------------- STEP 1
function stepClean(srcPath, outPath = DEFAULT_MASTER) {
  const raw = loadJson(srcPath);
  const products = Array.isArray(raw) ? raw : raw.products;

  for (const p of products) {
    // [ {id, src, width...}, ... ]  ->  [ "https://...jpg", ... ]
    p.images = (p.images || [])
      .map((img) => (typeof img === "string" ? img : img && img.src))
      .filter(Boolean);
    p.product_urls = (p.variants || []).map((v) => productUrl(p, v.id));
    p.url = p.product_urls[0] || null;
  }

  saveJson({ products }, outPath);
  console.log(`[clean] ${products.length} products -> ${outPath}`);
  return products;
}

// ---------------------------------------------------------------- STEP 2
/** Text of an element as clean lines (<br>, <p>, <li>, <div> -> line breaks). */
function linesOf($, el) {
  const clone = $("<div></div>").html($(el).html() || "");
  clone.find("br").replaceWith("\n");
  clone.find("p,li,div,ul,ol,h1,h2,h3,h4,h5,h6,tr").each((_, n) => {
    $(n).append("\n");
  });
  return clone
    .text()
    .split("\n")
    .map(cleanText)
    .filter(Boolean);
}

function parseToggleContent($, content) {
  const html = ($(content).html() || "").trim();

  const bullets = $(content)
    .find("li")
    .map((_, li) => cleanText($(li).text()))
    .get()
    .filter(Boolean);

  // <strong>Skin type:</strong> Oily/Combination  ->  { "Skin type": "Oily/Combination" }
  const fields = {};
  $(content)
    .find("strong")
    .each((_, strong) => {
      const label = cleanText($(strong).text()).replace(/:\s*$/, "").trim();
      if (!label) return;
      let value = "";
      let node = strong.nextSibling;
      while (node) {
        if (node.type === "tag" && (node.name === "strong" || node.name === "br")) break;
        value += node.type === "text" ? node.data : $(node).text();
        node = node.nextSibling;
      }
      value = cleanText(value);
      if (value) fields[label] = value;
    });

  const lines = linesOf($, content);
  return { text: lines.join("\n"), lines, bullets, fields, html };
}

function parseProductPage(htmlText) {
  const $ = cheerio.load(htmlText);
  const details = {};

  // title
  const h1 = $("h1").first();
  if (h1.length) details.page_title = cleanText(h1.text());

  // subtitle block(s): short tagline + description + quote
  const subtitles = $(".product__subtitle")
    .map((_, el) => linesOf($, el).join("\n"))
    .get()
    .filter(Boolean);
  if (subtitles.length) details.subtitle = subtitles;

  const quote = $(".product__subtitle em").first();
  if (quote.length) details.customer_quote = cleanText(quote.text());

  // highlight pills: Fragrance Free, Non-comedogenic, pH ...
  const scope = $(".product-icons-list").length ? $(".product-icons-list") : $.root();
  const pills = [];
  scope.find(".pill__label").each((_, el) => {
    const t = cleanText($(el).text());
    if (t && !pills.includes(t)) pills.push(t);
  });
  if (pills.length) details.highlights = pills;

  // rating - only if present in the raw source (JSON-LD)
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const ld = JSON.parse($(el).contents().text() || "");
      for (const item of Array.isArray(ld) ? ld : [ld]) {
        const agg = item && item.aggregateRating;
        if (agg) {
          details.rating = {
            value: agg.ratingValue,
            count: agg.reviewCount || agg.ratingCount,
          };
        }
      }
    } catch (_) {}
  });

  // toggle tabs: What Makes It Potent? / Ideal For / How to Use / Consumer Studies
  const sections = {};
  $("toggle-tab").each((_, tab) => {
    const titleEl = $(tab).find(".toggle__title").first();
    const contentEl = $(tab).find(".toggle__content").first();
    if (!titleEl.length || !contentEl.length) return;
    const title = cleanText(titleEl.text());
    let key = title;
    let n = 2;
    while (key in sections) key = `${title} (${n++})`;
    sections[key] = parseToggleContent($, contentEl[0]);
  });
  if (Object.keys(sections).length) details.sections = sections;

  return details;
}

async function fetchHtml(url, retries = 3) {
  let last;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return await res.text();
      last = `HTTP ${res.status}`;
      if (res.status === 403 || res.status === 404) break;
    } catch (e) {
      last = e.message;
    }
    await sleep(2000 * attempt);
  }
  throw new Error(`${url} -> ${last}`);
}

async function stepScrape(masterPath = DEFAULT_MASTER, outPath = DEFAULT_OUT, { force = false, handle = null } = {}) {
  // Always start from the clean master; carry over anything already scraped in the output file.
  const products = loadJson(masterPath).products;
  if (fs.existsSync(outPath)) {
    const prior = new Map(loadJson(outPath).products.map((x) => [x.id, x]));
    for (const p of products) {
      const old = prior.get(p.id);
      if (old && old.details) p.details = old.details;
    }
  }
  let done = 0, failed = 0, skipped = 0;

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    if (handle && p.handle !== handle) continue;
    if (p.details && p.details.sections && !force) {
      skipped++;
      continue;
    }

    const url = p.url || productUrl(p);
    console.log(`[${i + 1}/${products.length}] ${p.handle}`);
    try {
      const html = await fetchHtml(url);
      const details = parseProductPage(html);
      details.source_url = url;
      p.details = details;
      delete p.details_error;
      const names = Object.keys(details.sections || {});
      console.log(`    ok - ${names.length} sections: ${JSON.stringify(names)}`);
      if (!names.length) console.log("    WARNING: no toggle-tab sections found on this page");
      done++;
    } catch (e) {
      console.log(`    FAILED: ${e.message}`);
      p.details_error = e.message;
      failed++;
    }

    saveJson({ products }, outPath); // save after every product (resumable)
    await sleep(DELAY_MS);
  }
  saveJson({ products }, outPath);
  console.log(`[scrape] done=${done} skipped=${skipped} failed=${failed} -> ${outPath}`);
}

// ---------------------------------------------------------------- CLI
async function main() {
  const args = process.argv.slice(2);
  const step = args[0];
  const flags = { force: args.includes("--force") };
  const hi = args.indexOf("--handle");
  flags.handle = hi >= 0 ? args[hi + 1] : null;
  const mi = args.indexOf("--master");
  const master = mi >= 0 ? args[mi + 1] : DEFAULT_MASTER;
  const oi = args.indexOf("--out");
  const out = oi >= 0 ? args[oi + 1] : DEFAULT_OUT;
  const positional = args.slice(1).filter((a, i, arr) => !a.startsWith("--") && !["--handle", "--master", "--out"].includes(arr[i - 1]));
  const source = positional[0] || "minimilast.json";

  if (!["clean", "scrape", "all"].includes(step)) {
    console.log("Usage: node minimalist_pipeline.js <clean|scrape|all> [minimilast.json] [--force] [--handle <handle>] [--master <file>] [--out <file>]");
    process.exit(1);
  }
  if (step === "clean" || step === "all") stepClean(source, master);
  if (step === "scrape" || step === "all") await stepScrape(master, out, flags);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { stepClean, stepScrape, parseProductPage, productUrl };
#!/usr/bin/env node
/**
 * productsWithIngredients3.json  ->  productsWithIngredients3-clean.json
 *
 * For every product, keeps ONLY the imageUrls that start with
 *     https://images-static.nykaa.com/media/catalog/product
 * and removes all the other image URLs (logos, banners, review photos, icons ...).
 * Every other field (url, name, price, description, ingredients, howToUse, ...)
 * is copied exactly as it is. The original file is never modified.
 *
 * No npm packages needed (Node 18+).
 *
 * Usage:
 *   node nykaa-filter-images.js
 *   node nykaa-filter-images.js --in productsWithIngredients3.json --out productsWithIngredients3-clean.json
 *
 * Optional extras (OFF by default - without them the output is exactly "prefix filter only"):
 *   --dedupe         also drop duplicates of the same picture (same image in a different size/query)
 *   --same-product   also drop catalog images that belong to OTHER products (carousel/"similar products")
 */
const fs = require("fs");

const PREFIX = "https://images-static.nykaa.com/media/catalog/product";

// ------------------------------------------------------------------ cli
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(name);

const IN_FILE = arg("--in", "productsWithIngredients3.json");
const OUT_FILE = arg("--out", "productsWithIngredients3-clean.json");
const DEDUPE = flag("--dedupe");
const SAME_PRODUCT = flag("--same-product");

// ------------------------------------------------------------------ helpers
/** "…/product/tr:h-800,w-800,cm-pad_resize/1/e/1e72cd5NYKAC00002827_1.jpg?tr=w-344" -> "/1/e/1e72cd5NYKAC00002827_1.jpg" */
function baseImagePath(url) {
  return url
    .slice(PREFIX.length)
    .split("?")[0]
    .replace(/^\/tr:[^/]*/, ""); // drop the "tr:h-800,w-800,cm-pad_resize" resize segment
}

/** "/1/e/1e72cd5NYKAC00002827_3.jpg" -> "1e72cd5NYKAC00002827" (the product's own image id) */
function productKey(url) {
  const m = baseImagePath(url).match(/([^/]+?)_[a-z]?\d+\.\w+$/i);
  return m ? m[1] : null;
}

function filterImages(urls) {
  let out = urls.filter((u) => typeof u === "string" && u.startsWith(PREFIX));

  if (SAME_PRODUCT && out.length) {
    const key = productKey(out[0]); // the first catalog image is the product's main image
    if (key) out = out.filter((u) => productKey(u) === key);
  }

  if (DEDUPE) {
    const seen = new Set();
    out = out.filter((u) => {
      const k = baseImagePath(u);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return out;
}

// ------------------------------------------------------------------ main
function main() {
  const raw = JSON.parse(fs.readFileSync(IN_FILE, "utf8"));
  const isArray = Array.isArray(raw);
  const products = isArray ? raw : raw.products;
  if (!Array.isArray(products)) throw new Error("Expected a JSON array of products (or { products: [...] }).");

  let before = 0, after = 0, empty = [], noField = 0;

  for (const p of products) {
    if (!Array.isArray(p.imageUrls)) {
      noField++;
      continue;
    }
    before += p.imageUrls.length;
    p.imageUrls = filterImages(p.imageUrls); // same key, same position in the object
    after += p.imageUrls.length;
    if (!p.imageUrls.length) empty.push(p.name || p.url || "(unnamed)");
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(raw, null, 2), "utf8");

  console.log(`[images] ${products.length} products`);
  console.log(`         imageUrls: ${before} -> ${after}  (removed ${before - after})`);
  console.log(`         saved -> ${OUT_FILE}`);
  if (noField) console.log(`\n${noField} product(s) have no imageUrls array (left unchanged).`);
  if (empty.length) {
    console.log(`\n${empty.length} product(s) have NO catalog image left:`);
    empty.slice(0, 20).forEach((n) => console.log("  - " + n));
    if (empty.length > 20) console.log(`  ... and ${empty.length - 20} more`);
  }
}

main();
#!/usr/bin/env node
/**
 * productsWithIngredients3.json (Nykaa)  ->  nykaa-shopify-import.csv
 *
 * Builds Shopify's full product import template (61 columns, same header/order as
 * product_template.csv) from Nykaa records shaped like:
 *   { url, name, price, imageUrls[], description, ingredients, howToUse }
 *
 * ROW LAYOUT PER PRODUCT (one variant: Title / Default Title)
 *   row 1        : product fields + the variant + image #1
 *   rows 2..N    : one row per extra image (handle + image URL + position + alt)
 *   "URL handle" is repeated on EVERY row - that is how Shopify groups the rows.
 *
 * Images: only URLs starting with https://images-static.nykaa.com/media/catalog/product
 * are used (logos, banners, review photos ... are dropped), then duplicates of the same
 * picture and pictures of OTHER products (similar-product carousel) are removed.
 *
 * No npm packages needed (Node 18+).
 *
 * Usage:
 *   node nykaa-to-shopify-csv.js
 *   node nykaa-to-shopify-csv.js --in productsWithIngredients3.json --out nykaa-shopify-import.csv
 *   node nykaa-to-shopify-csv.js --vendor "Nykaa"
 *   node nykaa-to-shopify-csv.js --inventory 100
 *   node nykaa-to-shopify-csv.js --no-dedupe --no-same-product    # prefix filter only
 */
const fs = require("fs");

// ------------------------------------------------------------------ config (edit here)
const HEADERS = [
  "Title", "URL handle", "Description", "Vendor", "Product category", "Type", "Tags",
  "Published on online store", "Status", "SKU", "Variant Barcodes",
  "Option1 name", "Option1 value", "Option1 Linked To",
  "Option2 name", "Option2 value", "Option2 Linked To",
  "Option3 name", "Option3 value", "Option3 Linked To",
  "Price", "Compare-at price", "Cost per item", "Charge tax", "Tax code",
  "Unit price total measure", "Unit price total measure unit",
  "Unit price base measure", "Unit price base measure unit",
  "Inventory tracker", "Inventory quantity", "Continue selling when out of stock",
  "Weight value (grams)", "Weight unit for display", "Requires shipping", "Fulfillment service",
  "Product image URL", "Image position", "Image alt text", "Variant image URL",
  "Gift card", "SEO title", "SEO description",
  "Color (product.metafields.shopify.color-pattern)",
  "Google Shopping / Google product category", "Google Shopping / Gender",
  "Google Shopping / Age group", "Google Shopping / Manufacturer part number (MPN)",
  "Google Shopping / Ad group name", "Google Shopping / Ads labels",
  "Google Shopping / Condition", "Google Shopping / Custom product",
  "Google Shopping / Custom label 0", "Google Shopping / Custom label 1",
  "Google Shopping / Custom label 2", "Google Shopping / Custom label 3",
  "Google Shopping / Custom label 4",
  "Packed product length", "Packed product width", "Packed product height",
  "Packed product dimension unit",
];

const IMAGE_PREFIX = "https://images-static.nykaa.com/media/catalog/product";

const DEFAULT_VENDOR = "Skincare"; // Nykaa data has no brand field; your store uses Vendor as category
const CATEGORY_SKIN = "Health & Beauty > Personal Care > Cosmetics > Skin Care";
const CATEGORY_HAIR = "Health & Beauty > Personal Care > Hair Care";

// Product "Type" guessed from the product name (first match wins). Add your own rules here.
const TYPE_RULES = [
  [/eye\s*cream/i, "Eye Cream"],
  [/face\s*wash|cleanser|cleansing/i, "Face Wash"],
  [/serum/i, "Face Serum"],
  [/sunscreen|spf/i, "Sunscreen"],
  [/toner|face\s*mist/i, "Toner"],
  [/moisturi[sz]er|face\s*cream|gel\s*cream|lotion/i, "Moisturizer"],
  [/mask/i, "Face Mask"],
  [/lip\s*balm/i, "Lip Balm"],
  [/shampoo/i, "Shampoo"],
  [/conditioner/i, "Conditioner"],
  [/hair\s*oil/i, "Hair Oil"],
];

const USE_NYKAA_SKU_ID = true; // fill SKU from the skuId in the Nykaa URL (falls back to productId)
const CHARGE_TAX = true; // no tax info in the Nykaa data
const FULFILLMENT_SERVICE = "manual";
const CONTINUE_SELLING = "DENY";

// ------------------------------------------------------------------ cli
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(name);
const IN_FILE = arg("--in", "productsWithIngredients3.json");
const OUT_FILE = arg("--out", "nykaa-shopify-import.csv");
const VENDOR = arg("--vendor", DEFAULT_VENDOR);
const INVENTORY = arg("--inventory", null); // null = inventory not tracked
const DEDUPE = !flag("--no-dedupe");
const SAME_PRODUCT = !flag("--no-same-product");

// ------------------------------------------------------------------ helpers
const esc = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const bool = (b) => (b ? "TRUE" : "FALSE");

function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return (at > 0 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, "") + "…";
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/%/g, " percent ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

/** "181" / "₹1,299" / "Rs. 1299.00" -> "181" / "1299" / "1299" ; "" if not a number */
function parsePrice(v) {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? String(n) : "";
}

function nykaaIds(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/p\/(\d+)/);
    return {
      productId: u.searchParams.get("productId") || (m && m[1]) || "",
      skuId: u.searchParams.get("skuId") || "",
    };
  } catch (_) {
    return { productId: "", skuId: "" };
  }
}

/** Plain text -> <p> paragraphs; text that already contains HTML tags is kept as it is. */
function toHtml(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  if (/<[a-z][\s\S]*>/i.test(t)) return t;
  return t
    .split(/\r?\n+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => `<p>${escHtml(x)}</p>`)
    .join("\n");
}

function buildDescription(p) {
  const parts = [];
  const d = toHtml(p.description);
  const ing = toHtml(p.ingredients);
  const how = toHtml(p.howToUse);
  if (d) parts.push(d);
  if (ing) parts.push(`<h3>Ingredients</h3>\n${ing}`);
  if (how) parts.push(`<h3>How to Use</h3>\n${how}`);
  return parts.join("\n");
}

function plainText(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

// ---- images
const baseImagePath = (url) =>
  url.slice(IMAGE_PREFIX.length).split("?")[0].replace(/^\/tr:[^/]*/, ""); // drop "tr:h-800,..." + query
const productKey = (url) => {
  const m = baseImagePath(url).match(/([^/]+?)_[a-z]?\d+\.\w+$/i);
  return m ? m[1] : null;
};

function pickImages(urls, stats) {
  const all = Array.isArray(urls) ? urls.filter((u) => typeof u === "string") : [];
  let out = all.filter((u) => u.startsWith(IMAGE_PREFIX));
  stats.prefix += all.length - out.length;

  if (SAME_PRODUCT && out.length) {
    const key = productKey(out[0]); // first catalog image = the product's main image
    if (key) {
      const n = out.length;
      out = out.filter((u) => productKey(u) === key);
      stats.other += n - out.length;
    }
  }
  if (DEDUPE) {
    const seen = new Set();
    const n = out.length;
    out = out.filter((u) => {
      const k = baseImagePath(u);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    stats.dupes += n - out.length;
  }
  return out;
}

// ------------------------------------------------------------------ build
function buildRows(products) {
  const rows = [];
  const warnings = [];
  const handles = new Set();
  const seenProduct = new Set();
  const seenSku = new Set();
  const stats = { prefix: 0, other: 0, dupes: 0 };
  let skipped = 0;

  for (const p of products) {
    const title = String(p.name || "").trim();
    if (!title) {
      warnings.push(`record without a name (${p.url || "no url"}) - skipped`);
      skipped++;
      continue;
    }
    const { productId, skuId } = nykaaIds(p.url);

    // same Nykaa product scraped twice -> keep the first
    const pKey = productId || p.url || title;
    if (seenProduct.has(pKey)) {
      warnings.push(`duplicate product "${title}" (productId ${productId || "?"}) - skipped`);
      skipped++;
      continue;
    }
    seenProduct.add(pKey);

    // unique URL handle
    let handle = slugify(title) || `product-${productId}`;
    if (handles.has(handle)) handle = productId ? `${handle}-${productId}` : `${handle}-2`;
    handles.add(handle);

    const price = parsePrice(p.price);
    if (!price) warnings.push(`${handle}: no valid price ("${p.price}")`);

    const images = pickImages(p.imageUrls, stats);
    if (!images.length) warnings.push(`${handle}: no catalog image`);

    const type = (TYPE_RULES.find(([re]) => re.test(title)) || [null, ""])[1];
    const isHair = /hair|shampoo|conditioner/i.test(`${title} ${type}`);

    let sku = "";
    if (USE_NYKAA_SKU_ID) {
      sku = skuId || productId;
      if (sku && seenSku.has(sku)) warnings.push(`duplicate SKU ${sku} (${handle})`);
      if (sku) seenSku.add(sku);
    }

    const description = buildDescription(p);
    if (!description) warnings.push(`${handle}: description, ingredients and howToUse are all empty`);
    const seoDesc = truncate(plainText(toHtml(p.description)), 320);

    // row 1: product + variant + image #1
    rows.push({
      Title: title,
      "URL handle": handle,
      Description: description,
      Vendor: VENDOR,
      "Product category": isHair ? CATEGORY_HAIR : CATEGORY_SKIN,
      Type: type,
      Tags: "",
      "Published on online store": "TRUE",
      Status: "Active",
      SKU: sku,
      "Option1 name": "Title",
      "Option1 value": "Default Title",
      Price: price,
      "Charge tax": bool(CHARGE_TAX),
      "Inventory tracker": INVENTORY !== null ? "shopify" : "",
      "Inventory quantity": INVENTORY !== null ? INVENTORY : "",
      "Continue selling when out of stock": CONTINUE_SELLING,
      "Requires shipping": "TRUE",
      "Fulfillment service": FULFILLMENT_SERVICE,
      "Product image URL": images[0] || "",
      "Image position": images[0] ? "1" : "",
      "Image alt text": images[0] ? title : "",
      "Gift card": "FALSE",
      "SEO title": truncate(title, 70),
      "SEO description": seoDesc,
    });

    // extra images
    images.slice(1).forEach((src, i) =>
      rows.push({
        "URL handle": handle,
        "Product image URL": src,
        "Image position": String(i + 2),
        "Image alt text": title,
      })
    );
  }
  return { rows, warnings, stats, skipped };
}

function main() {
  const raw = JSON.parse(fs.readFileSync(IN_FILE, "utf8"));
  const products = Array.isArray(raw) ? raw : raw.products;
  if (!Array.isArray(products)) throw new Error("Expected a JSON array of products (or { products: [...] }).");

  const { rows, warnings, stats, skipped } = buildRows(products);

  const lines = [HEADERS.map(esc).join(",")];
  for (const r of rows) lines.push(HEADERS.map((h) => esc(r[h])).join(","));
  fs.writeFileSync(OUT_FILE, lines.join("\r\n") + "\r\n", "utf8");

  console.log(`[csv] ${products.length - skipped} products (${skipped} skipped) -> ${rows.length} rows -> ${OUT_FILE}`);
  console.log(
    `      images removed: ${stats.prefix} not catalog, ${stats.other} other products' pictures, ${stats.dupes} duplicates`
  );
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    warnings.slice(0, 40).forEach((w) => console.log("  - " + w));
    if (warnings.length > 40) console.log(`  ... and ${warnings.length - 40} more`);
  }
}

if (require.main === module) main();
module.exports = { buildRows };
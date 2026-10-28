#!/usr/bin/env node
/**
 * pilgrim.json  ->  pilgrim-shopify-template-import.csv
 *
 * Converts a raw Shopify products.json export (Pilgrim) into Shopify's full
 * product import template (61 columns, same header/order as product_template.csv).
 *
 * ROW LAYOUT PER PRODUCT
 *   row 1            : product fields + variant #1 + image #1
 *   rows 2..V        : one row per extra variant  (handle + variant fields only)
 *   rows V+1 ..      : one row per extra image    (handle + image URL + position + alt)
 *   "URL handle" is repeated on EVERY row - that is how Shopify groups the rows.
 *
 * Standalone: needs only Node 18+ and `npm install cheerio`.
 *
 * Usage:
 *   node pilgrim-to-shopify-csv.js
 *   node pilgrim-to-shopify-csv.js --in pilgrim.json --out pilgrim-shopify-template-import.csv
 *   node pilgrim-to-shopify-csv.js --vendor "Pilgrim"     # force one Vendor for every product
 *   node pilgrim-to-shopify-csv.js --inventory 100        # track inventory with this quantity
 */
const fs = require("fs");
const cheerio = require("cheerio");

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

// Shopify "Product category" by the product's vendor (Pilgrim uses Skincare / Haircare / Makeup ...).
// Unlisted vendors get an empty category. If Shopify rejects a path on a test import, fix it here.
const CATEGORY_BY_VENDOR = {
  skincare: "Health & Beauty > Personal Care > Cosmetics > Skin Care",
  haircare: "Health & Beauty > Personal Care > Hair Care",
  makeup: "Health & Beauty > Personal Care > Cosmetics > Makeup",
};

const FULFILLMENT_SERVICE = "manual";
const CONTINUE_SELLING = "DENY"; // DENY = stop selling at 0 stock, CONTINUE = keep selling

// Pilgrim's tags include internal/promo ones (e.g. "25-off-10June", "buy3at999", "pritish").
// Tags matching any pattern below are dropped. Empty list = keep every tag as-is.
const DROP_TAG_PATTERNS = [
  // /off/i, /^buy\d/i, /^mktp-/i, /^SM-\d+/i, /bucket/i, /^top[ _-]?20/i, /^pritish$/i, /^Primary - /i,
];

const KEEP_SPLIT_COMMENT = true; // keep the "<!-- split -->" marker some themes use in body_html
const ALT_FALLBACK_TO_TITLE = true; // images without alt text get the product title

// ------------------------------------------------------------------ cli
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const IN_FILE = arg("--in", "pilgrim.json");
const OUT_FILE = arg("--out", "pilgrim-shopify-template-import.csv");
const VENDOR_OVERRIDE = arg("--vendor", null);
const INVENTORY = arg("--inventory", null); // null = inventory not tracked

// ------------------------------------------------------------------ helpers
const esc = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const fmtPrice = (v) => (v === null || v === undefined || v === "" ? "" : String(parseFloat(v)));
const bool = (b) => (b ? "TRUE" : "FALSE");

function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return (at > 0 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, "") + "…";
}

/** Clean body_html: drop spreadsheet/data-* attributes, unwrap spans, normalise spaces. */
function cleanHtml(html) {
  const $ = cheerio.load(`<div id="root">${html || ""}</div>`, null, false);
  $("*").each((_, el) => {
    for (const a of Object.keys(el.attribs || {})) {
      if (a === "class" || a === "style" || a.startsWith("data-")) $(el).removeAttr(a);
    }
  });
  $("span").each((_, el) => {
    $(el).replaceWith($(el).contents());
  });
  let out = $("#root").html() || "";
  if (!KEEP_SPLIT_COMMENT) out = out.replace(/<!--\s*split\s*-->/gi, "");
  return out.replace(/\u00a0|&nbsp;/g, " ").replace(/<br\s*\/?>\s*(<br\s*\/?>)+/g, "<br>").trim();
}

/** First real descriptive paragraph (skips short lines such as "Suitable For: All Skin Types"). */
function seoDescription(html) {
  const $ = cheerio.load(`<div id="root">${(html || "").split(/<!--\s*split\s*-->/i)[0]}</div>`, null, false);
  let found = "";
  $("#root p").each((_, p) => {
    const t = $(p).text().replace(/\s+/g, " ").trim();
    if (!found && t.length >= 60) found = t;
  });
  return truncate(found, 320);
}

const imgSrc = (i) => (typeof i === "string" ? i : i && i.src);

function categoryFor(p) {
  return CATEGORY_BY_VENDOR[(p.vendor || "").toLowerCase()] || "";
}

// ------------------------------------------------------------------ build
function buildRows(products) {
  const rows = [];
  const warnings = [];
  const seenSku = new Map();
  const seenHandle = new Set();
  const unmappedVendors = new Set();

  for (const p of products) {
    const variants = [...(p.variants || [])].sort((a, b) => (a.position || 0) - (b.position || 0));
    const imageObjs = [...(p.images || [])]
      .map((i) => (typeof i === "string" ? { src: i } : i))
      .filter((i) => i && i.src)
      .sort((a, b) => (a.position || 0) - (b.position || 0));
    const images = imageObjs.map((i) => i.src);
    const options = p.options || [];

    if (!variants.length) {
      warnings.push(`${p.handle}: no variants - skipped`);
      continue;
    }
    if (seenHandle.has(p.handle)) warnings.push(`duplicate handle ${p.handle}`);
    seenHandle.add(p.handle);
    if (options.length > 3) warnings.push(`${p.handle}: ${options.length} options, Shopify allows 3 - extra ignored`);
    if (!images.length) warnings.push(`${p.handle}: no images`);

    const category = categoryFor(p);
    if (!category) unmappedVendors.add(p.vendor || "(none)");

    // alt text: image's own alt, else the alt of a variant's featured image with the same URL, else title
    const altBySrc = new Map();
    for (const i of imageObjs) if (i.alt) altBySrc.set(i.src, i.alt);
    for (const v of variants) {
      const f = v.featured_image;
      if (f && f.src && f.alt && !altBySrc.has(f.src)) altBySrc.set(f.src, f.alt);
    }
    const altFor = (src) => altBySrc.get(src) || (ALT_FALLBACK_TO_TITLE ? p.title : "");

    const tags = (p.tags || [])
      .filter((t) => !DROP_TAG_PATTERNS.some((re) => re.test(t)))
      .join(", ");

    const variantFields = (v) => {
      const price = parseFloat(v.price);
      const cmp = parseFloat(v.compare_at_price);
      const vi = v.featured_image && v.featured_image.src;
      if (vi && !images.includes(vi)) warnings.push(`${p.handle}: variant image for "${v.title}" is not among the product images`);
      if (v.sku) {
        if (seenSku.has(v.sku)) warnings.push(`duplicate SKU ${v.sku} (${p.handle} & ${seenSku.get(v.sku)})`);
        seenSku.set(v.sku, p.handle);
      }
      return {
        SKU: v.sku || "",
        "Variant Barcodes": v.barcode || "",
        "Option1 value": v.option1 || "Default Title",
        "Option2 value": v.option2 || "",
        "Option3 value": v.option3 || "",
        Price: fmtPrice(v.price),
        "Compare-at price": cmp > price ? fmtPrice(v.compare_at_price) : "",
        "Charge tax": bool(v.taxable),
        "Inventory tracker": INVENTORY !== null ? "shopify" : "",
        "Inventory quantity": INVENTORY !== null ? INVENTORY : "",
        "Continue selling when out of stock": CONTINUE_SELLING,
        "Weight value (grams)": v.grams ? String(v.grams) : "",
        "Weight unit for display": v.grams ? "g" : "",
        "Requires shipping": bool(v.requires_shipping),
        "Fulfillment service": FULFILLMENT_SERVICE,
        "Variant image URL": vi || "",
      };
    };

    // row 1: product-level fields + first variant + first image
    rows.push({
      Title: p.title,
      "URL handle": p.handle,
      Description: cleanHtml(p.body_html),
      Vendor: VENDOR_OVERRIDE || p.vendor || "",
      "Product category": category,
      Type: p.product_type || "",
      Tags: tags,
      "Published on online store": bool(!!p.published_at),
      Status: "Active",
      "Option1 name": (options[0] && options[0].name) || "Title",
      "Option2 name": (options[1] && options[1].name) || "",
      "Option3 name": (options[2] && options[2].name) || "",
      ...variantFields(variants[0]),
      "Product image URL": images[0] || "",
      "Image position": images[0] ? "1" : "",
      "Image alt text": images[0] ? altFor(images[0]) : "",
      "Gift card": "FALSE",
      "SEO title": truncate(p.title, 70),
      "SEO description": seoDescription(p.body_html),
    });

    // extra variants
    for (const v of variants.slice(1)) rows.push({ "URL handle": p.handle, ...variantFields(v) });

    // extra images
    images.slice(1).forEach((src, i) =>
      rows.push({
        "URL handle": p.handle,
        "Product image URL": src,
        "Image position": String(i + 2),
        "Image alt text": altFor(src),
      })
    );
  }
  if (unmappedVendors.size) {
    warnings.push(`no Product category mapping for vendor(s): ${[...unmappedVendors].join(", ")} (column left empty)`);
  }
  return { rows, warnings };
}

function main() {
  const raw = JSON.parse(fs.readFileSync(IN_FILE, "utf8"));
  const products = Array.isArray(raw) ? raw : raw.products;
  const { rows, warnings } = buildRows(products);

  const lines = [HEADERS.map(esc).join(",")];
  for (const r of rows) lines.push(HEADERS.map((h) => esc(r[h])).join(","));
  fs.writeFileSync(OUT_FILE, lines.join("\r\n") + "\r\n", "utf8");

  console.log(`[csv] ${products.length} products -> ${rows.length} rows -> ${OUT_FILE}`);
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    warnings.forEach((w) => console.log("  - " + w));
  }
}

if (require.main === module) main();
module.exports = { buildRows };
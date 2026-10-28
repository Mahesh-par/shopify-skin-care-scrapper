#!/usr/bin/env node
/**
 * master-minimilast2.json  ->  minimalist-shopify-import.csv
 *
 * Follows Shopify's full product template (product_template.csv, 61 columns).
 *
 * ROW LAYOUT PER PRODUCT
 *   row 1            : product fields + variant #1 + image #1
 *   rows 2..V        : one row per extra variant  (handle + variant fields only)
 *   rows V+1 ..      : one row per extra image    (handle + image URL + position + alt)
 *   "URL handle" is repeated on EVERY row - that is how Shopify groups the rows.
 *
 * Usage:
 *   node minimalist-to-csv.js
 *   node minimalist-to-csv.js --in master-minimilast2.json --out minimalist-shopify-import.csv
 *   node minimalist-to-csv.js --inventory 100     # track inventory with this quantity (default: not tracked)
 *   node minimalist-to-csv.js --vendor "Minimalist"
 */
const fs = require("fs");
const cheerio = require("cheerio");

// ------------------------------------------------------------------ config (edit here)
const HEADERS = [
  "Title",
  "URL handle",
  "Description",
  "Vendor",
  "Product category",
  "Type",
  "Tags",
  "Published on online store",
  "Status",
  "SKU",
  "Variant Barcodes",
  "Option1 name",
  "Option1 value",
  "Option1 Linked To",
  "Option2 name",
  "Option2 value",
  "Option2 Linked To",
  "Option3 name",
  "Option3 value",
  "Option3 Linked To",
  "Price",
  "Compare-at price",
  "Cost per item",
  "Charge tax",
  "Tax code",
  "Unit price total measure",
  "Unit price total measure unit",
  "Unit price base measure",
  "Unit price base measure unit",
  "Inventory tracker",
  "Inventory quantity",
  "Continue selling when out of stock",
  "Weight value (grams)",
  "Weight unit for display",
  "Requires shipping",
  "Fulfillment service",
  "Product image URL",
  "Image position",
  "Image alt text",
  "Variant image URL",
  "Gift card",
  "SEO title",
  "SEO description",
  "Color (product.metafields.shopify.color-pattern)",
  "Google Shopping / Google product category",
  "Google Shopping / Gender",
  "Google Shopping / Age group",
  "Google Shopping / Manufacturer part number (MPN)",
  "Google Shopping / Ad group name",
  "Google Shopping / Ads labels",
  "Google Shopping / Condition",
  "Google Shopping / Custom product",
  "Google Shopping / Custom label 0",
  "Google Shopping / Custom label 1",
  "Google Shopping / Custom label 2",
  "Google Shopping / Custom label 3",
  "Google Shopping / Custom label 4",
  "Packed product length",
  "Packed product width",
  "Packed product height",
  "Packed product dimension unit",
];

// Shopify "Product category" (taxonomy path). Set to "" to leave the column empty.
// If Shopify rejects it on a test import, change it to the exact path from your Shopify admin.
const PRODUCT_CATEGORY =
  "Health & Beauty > Personal Care > Cosmetics > Skin Care";

const FULFILLMENT_SERVICE = "manual";
const CONTINUE_SELLING = "DENY"; // DENY = stop selling at 0 stock, CONTINUE = keep selling
const SKIP_TAG_PREFIXES = ["score:"]; // internal ranking tags, not useful in the store
const IMAGE_ALT_FROM_TITLE = true; // use the product title as image alt text

// Description: which scraped sections to include. null = all of them.
const INCLUDE_SECTIONS = null; // e.g. ["What Makes It Potent?", "How to Use"]
const SKIP_SECTIONS = []; // e.g. ["Is the product pregnancy safe?"]

// ------------------------------------------------------------------ cli
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const IN_FILE = arg("--in", "master-minimilast2.json");
const OUT_FILE = arg("--out", "minimalist-shopify-import2.csv");
const VENDOR_OVERRIDE = arg("--vendor", null);
const INVENTORY = arg("--inventory", null); // null = inventory not tracked

// ------------------------------------------------------------------ helpers
const esc = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const escHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Cloudflare hides emails as data-cfemail="hex"; the first byte is the XOR key. */
function decodeCfEmail(hex) {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2)
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

/** Strip classes/styles, decode hidden emails, normalise spaces. Returns clean HTML. */
function cleanHtml(html) {
  const $ = cheerio.load(`<div id="root">${html || ""}</div>`, null, false);
  $("[data-cfemail]").each((_, el) => {
    $(el).replaceWith(decodeCfEmail($(el).attr("data-cfemail")));
  });
  $("*").each((_, el) => {
    for (const a of Object.keys(el.attribs || {})) {
      if (a === "class" || a === "style" || a.startsWith("data-"))
        $(el).removeAttr(a);
    }
  });
  $("span").each((_, el) => {
    $(el).replaceWith($(el).contents());
  });
  return $("#root")
    .html()
    .replace(/\u00a0|&nbsp;/g, " ")
    .replace(/<br\s*\/?>\s*(<br\s*\/?>)+/g, "<br>")
    .trim();
}

function buildDescription(p) {
  const d = p.details;
  if (!d || !d.sections) return cleanHtml(p.body_html); // not scraped -> Shopify's own body_html

  const parts = [];
  const subs = (d.subtitle || []).filter((s) => s !== d.customer_quote); // skip the review quote
  if (subs.length > 1)
    parts.push(`<p><strong>${escHtml(subs[0])}</strong></p>`);
  for (const s of subs.length > 1 ? subs.slice(1) : subs)
    parts.push(`<p>${escHtml(s)}</p>`);

  if (d.highlights && d.highlights.length) {
    parts.push(
      `<ul>${d.highlights.map((h) => `<li>${escHtml(h)}</li>`).join("")}</ul>`,
    );
  }
  for (const [title, sec] of Object.entries(d.sections)) {
    if (INCLUDE_SECTIONS && !INCLUDE_SECTIONS.includes(title)) continue;
    if (SKIP_SECTIONS.includes(title)) continue;
    parts.push(`<h3>${escHtml(title)}</h3>${cleanHtml(sec.html)}`);
  }
  return parts.join("\n");
}

/** "284.00" -> "284", "284.50" -> "284.5" */
const fmtPrice = (v) =>
  v === null || v === undefined || v === "" ? "" : String(parseFloat(v));
const bool = (b) => (b ? "TRUE" : "FALSE");

function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return (
    cut
      .slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : cut.length)
      .replace(/[,;:\s]+$/, "") + "…"
  );
}

function seoDescription(p) {
  const d = p.details;
  const subs =
    d && d.subtitle ? d.subtitle.filter((s) => s !== d.customer_quote) : [];
  const text = (subs.length > 1 ? subs[1] : subs[0]) || "";
  return truncate(text.replace(/\s+/g, " ").trim(), 320);
}

// ------------------------------------------------------------------ build
function buildRows(products) {
  const rows = [];
  const warnings = [];
  const seenSku = new Map();
  const seenHandle = new Set();

  for (const p of products) {
    const variants = p.variants || [];
    const images = p.images || [];
    const optName = (p.options && p.options[0] && p.options[0].name) || "Title";

    if (!variants.length) {
      warnings.push(`${p.handle}: no variants - skipped`);
      continue;
    }
    if (seenHandle.has(p.handle)) warnings.push(`duplicate handle ${p.handle}`);
    seenHandle.add(p.handle);
    if (p.options && p.options.length > 1)
      warnings.push(
        `${p.handle}: has ${p.options.length} options, only Option1 is filled`,
      );
    if (!images.length) warnings.push(`${p.handle}: no images`);
    if (p.details_error)
      warnings.push(
        `${p.handle}: scrape failed (${p.details_error}) - description uses body_html`,
      );
    else if (!p.details)
      warnings.push(
        `${p.handle}: not scraped yet - description uses body_html`,
      );

    const alt = IMAGE_ALT_FROM_TITLE ? p.title : "";
    const tags = (p.tags || [])
      .filter((t) => !SKIP_TAG_PREFIXES.some((x) => t.startsWith(x)))
      .join(", ");

    const variantFields = (v) => {
      const price = parseFloat(v.price);
      const cmp = parseFloat(v.compare_at_price);
      const vi = v.featured_image && v.featured_image.src;
      if (vi && !images.includes(vi))
        warnings.push(
          `${p.handle}: variant image for ${v.title} is not in the product's images`,
        );
      if (v.sku) {
        if (seenSku.has(v.sku))
          warnings.push(
            `duplicate SKU ${v.sku} (${p.handle} & ${seenSku.get(v.sku)})`,
          );
        seenSku.set(v.sku, p.handle);
      }
      return {
        SKU: v.sku || "",
        "Option1 value": v.option1 || "Default Title",
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
      Description: buildDescription(p),
      Vendor: VENDOR_OVERRIDE || p.vendor || "",
      "Product category": PRODUCT_CATEGORY,
      Type: p.product_type || "",
      Tags: tags,
      "Published on online store": bool(!!p.published_at),
      Status: "Active",
      "Option1 name": optName,
      ...variantFields(variants[0]),
      "Product image URL": images[0] || "",
      "Image position": images[0] ? "1" : "",
      "Image alt text": images[0] ? alt : "",
      "Gift card": "FALSE",
      "SEO title": truncate(p.title, 70),
      "SEO description": seoDescription(p),
    });

    // extra variants
    for (const v of variants.slice(1))
      rows.push({ "URL handle": p.handle, ...variantFields(v) });

    // extra images
    images.slice(1).forEach((img, i) =>
      rows.push({
        "URL handle": p.handle,
        "Product image URL": img,
        "Image position": String(i + 2),
        "Image alt text": alt,
      }),
    );
  }
  return { rows, warnings };
}

function main() {
  const products = JSON.parse(fs.readFileSync(IN_FILE, "utf8")).products;
  const { rows, warnings } = buildRows(products);

  const lines = [HEADERS.map(esc).join(",")];
  for (const r of rows) lines.push(HEADERS.map((h) => esc(r[h])).join(","));
  fs.writeFileSync(OUT_FILE, lines.join("\r\n") + "\r\n", "utf8");

  const unscraped = warnings.filter((w) =>
    /not scraped|scrape failed/.test(w),
  ).length;
  console.log(
    `[csv] ${products.length} products -> ${rows.length} rows -> ${OUT_FILE}`,
  );
  const other = warnings.filter((w) => !/not scraped|scrape failed/.test(w));
  if (unscraped)
    console.log(
      `\n${unscraped} product(s) not scraped yet (their description uses the short body_html).`,
    );
  if (other.length) {
    console.log(`\n${other.length} warning(s):`);
    other.forEach((w) => console.log("  - " + w));
  }
}

if (require.main === module) main();
module.exports = { buildRows, buildDescription, decodeCfEmail };

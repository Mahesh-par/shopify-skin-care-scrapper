const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const START_URL =
  'https://www.nykaa.com/brands/nykaa-skin/c/74554?transaction_id=d92acd2707f62bc4e476aca06d667647';
const PAGE_COUNT = 6;
const OUTPUT_FILE = path.join(process.cwd(), 'productsWithIngredients3.json');
const NAVIGATION_ATTEMPTS = 4;

async function gotoWithRetry(page, url) {
  for (let attempt = 1; attempt <= NAVIGATION_ATTEMPTS; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return;
    } catch (error) {
      if (attempt === NAVIGATION_ATTEMPTS) throw error;

      const delay = 2000 * (2 ** (attempt - 1));
      console.warn(
        `Navigation failed (attempt ${attempt}/${NAVIGATION_ATTEMPTS}): ${error.message}`,
      );
      await page.waitForTimeout(delay);
    }
  }
}

function listingUrl(pageNumber) {
  const url = new URL(START_URL);

  if (pageNumber > 1) {
    url.searchParams.set('page_no', String(pageNumber));
    url.searchParams.set('sort', 'popularity');
  }

  return url.toString();
}

async function collectProductUrls(page, pageNumber) {
  const url = listingUrl(pageNumber);
  console.log(`Reading listing page ${pageNumber}: ${url}`);
  await gotoWithRetry(page, url);
  await page.waitForTimeout(2000);

  for (let step = 0; step < 5; step += 1) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(300);
  }

  return page.evaluate(() => {
    const listing = document.querySelector('#product-list-wrap, #product-listing');
    const anchors = listing
      ? listing.querySelectorAll('a[href*="/p/"]')
      : document.querySelectorAll('a[href*="/p/"]');

    return [...new Set(
      [...anchors]
        .map((anchor) => anchor.href)
        .filter((href) => /\/p\/\d+/.test(new URL(href).pathname)),
    )];
  });
}

async function scrapeDescriptionTabs(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(700);

  const sectionHeading = page
    .locator('h2')
    .filter({ hasText: /^Product Description$/i })
    .first();
  if (await sectionHeading.count()) {
    await sectionHeading.scrollIntoViewIfNeeded();
  }

  const readTab = async (label) => {
    const heading = page
      .locator('h3')
      .filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })
      .first();

    if (!(await heading.count())) return '';

    await heading.scrollIntoViewIfNeeded();
    const tabBar = heading.locator('xpath=..');
    const panel = tabBar.locator('xpath=following-sibling::*[1]');
    await heading.click();
    await page.waitForTimeout(400);

    if (label === 'Description') {
      const readMore = panel
        .locator('button, [role="button"], span')
        .filter({ hasText: /^Read More$/i })
        .first();

      if (await readMore.count()) {
        await readMore.click();
        await page.waitForTimeout(300);
      }
    }

    return (await panel.innerText()).trim();
  };

  return {
    description: await readTab('Description'),
    ingredients: await readTab('Ingredients'),
    howToUse: await readTab('How To Use'),
  };
}

async function scrapeProduct(page, url) {
  await gotoWithRetry(page, url);
  await page.waitForTimeout(1000);

  const productDetails = await scrapeDescriptionTabs(page);
  for (const [field, value] of Object.entries(productDetails)) {
    if (!value) console.warn(`${field} tab was empty or missing: ${url}`);
  }

  return page.evaluate(() => {
    const parseJsonLd = () => {
      for (const script of document.querySelectorAll(
        'script[type="application/ld+json"]',
      )) {
        try {
          const parsed = JSON.parse(script.textContent);
          const entries = Array.isArray(parsed) ? parsed : [parsed];
          const product = entries
            .flatMap((entry) => entry['@graph'] || [entry])
            .find((entry) => {
              const type = entry['@type'];
              return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
            });

          if (product) return product;
        } catch (error) {
          console.warn('Could not parse a product JSON-LD block:', error.message);
        }
      }

      return null;
    };

    const jsonLdProduct = parseJsonLd();
    const textOf = (element) => element?.textContent?.trim().replace(/\s+/g, ' ') || '';
    const title =
      jsonLdProduct?.name ||
      textOf(document.querySelector('h1')) ||
      document.title;

    const offer = Array.isArray(jsonLdProduct?.offers)
      ? jsonLdProduct.offers[0]
      : jsonLdProduct?.offers;
    const priceMeta =
      document.querySelector('meta[property="product:price:amount"]')?.content ||
      document.querySelector('meta[itemprop="price"]')?.content ||
      document.querySelector('[itemprop="price"]')?.getAttribute('content');
    const price = offer?.price || offer?.lowPrice || priceMeta || null;

    const imageUrls = new Set();
    const jsonLdImages = jsonLdProduct?.image;
    for (const image of Array.isArray(jsonLdImages) ? jsonLdImages : [jsonLdImages]) {
      if (typeof image === 'string') imageUrls.add(image);
      else if (image?.url) imageUrls.add(image.url);
    }

    for (const image of document.querySelectorAll('img')) {
      const candidates = [
        image.currentSrc,
        image.src,
        image.getAttribute('data-src'),
        image.getAttribute('data-original'),
        image.getAttribute('data-zoom-image'),
      ];

      for (const candidate of candidates) {
        if (!candidate || candidate.startsWith('data:')) continue;
        if (image.naturalWidth >= 150 || /nykaa|product/i.test(candidate)) {
          imageUrls.add(new URL(candidate, location.href).href);
        }
      }

      const srcset = image.getAttribute('srcset');
      if (srcset && image.naturalWidth >= 150) {
        for (const entry of srcset.split(',')) {
          const candidate = entry.trim().split(/\s+/)[0];
          if (candidate) imageUrls.add(new URL(candidate, location.href).href);
        }
      }
    }

    return {
      name: title,
      price: price === null ? null : String(price),
      imageUrls: [...imageUrls],
    };
  }).then((product) => ({ ...product, ...productDetails }));
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-http2'],
  });

  try {
    const page = await browser.newPage();
    const productUrls = new Set();

    for (let pageNumber = 1; pageNumber <= PAGE_COUNT; pageNumber += 1) {
      const urls = await collectProductUrls(page, pageNumber);
      console.log(`Found ${urls.length} product links on page ${pageNumber}`);
      urls.forEach((url) => productUrls.add(url));
    }

    console.log(`Scraping details for ${productUrls.size} unique products...`);
    const products = [];
    const failures = [];

    for (const url of productUrls) {
      try {
        const product = await scrapeProduct(page, url);
        products.push({ url, ...product });
        console.log(`Scraped: ${product.name || url}`);
      } catch (error) {
        failures.push({ url, error: error.message });
        console.error(`Failed to scrape ${url}: ${error.message}`);
      }
    }

    await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(products, null, 2)}\n`);
    console.log(`Saved ${products.length} products to ${OUTPUT_FILE}`);

    if (failures.length > 0) {
      console.error(`${failures.length} product page(s) failed; see the log above.`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('Scraper failed:', error);
  process.exitCode = 1;
});

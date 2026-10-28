const fs = require('node:fs/promises');
const path = require('node:path');

const INPUT_FILE = path.join(process.cwd(), 'pilgrim.json');
const OUTPUT_FILE = path.join(process.cwd(), 'pilgrim-shopify-import.csv');
const COLUMNS = [
  'Title',
  'Description',
  'Product image URL',
  'Price',
  'SKU',
  'Option1 name',
  'Option1 value',
  'Inventory quantity',
  'Vendor',
];

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

async function main() {
  const input = JSON.parse(await fs.readFile(INPUT_FILE, 'utf8'));
  if (!Array.isArray(input.products)) {
    throw new Error('Expected pilgrim.json to contain a products array.');
  }

  const rows = [];
  for (const product of input.products) {
    const images = Array.isArray(product.images)
      ? product.images
        .map((image) => (typeof image === 'string' ? image : image?.src))
        .filter(Boolean)
      : [];
    const variants = Array.isArray(product.variants) && product.variants.length > 0
      ? product.variants
      : [null];
    const option1Name = product.options?.find((option) => option.position === 1)?.name || '';

    variants.forEach((variant, index) => {
      rows.push([
        index === 0 ? product.title : '',
        index === 0 ? product.body_html : '',
        index === 0 ? (images[0] || '') : '',
        variant?.price ?? '',
        variant?.sku ?? '',
        option1Name,
        variant?.option1 ?? '',
        '',
        index === 0 ? product.vendor : '',
      ]);
    });

    for (const imageUrl of images.slice(1)) {
      rows.push(['', '', imageUrl, '', '', '', '', '', '']);
    }
  }
  const csv = [
    COLUMNS.map(csvCell).join(','),
    ...rows.map((row) => row.map(csvCell).join(',')),
  ].join('\r\n');

  await fs.writeFile(OUTPUT_FILE, `\uFEFF${csv}\r\n`, 'utf8');
  console.log(`Saved ${rows.length} Shopify import rows to ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error('Pilgrim CSV export failed:', error);
  process.exitCode = 1;
});

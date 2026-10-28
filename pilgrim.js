const fs = require('node:fs/promises');
const path = require('node:path');

const BASE_URL = 'https://discoverpilgrim.com';
const INPUT_FILE = path.join(process.cwd(), 'pilgrim.json');
const OUTPUT_FILE = path.join(process.cwd(), 'pilgrim.csv');
const MAX_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 5000;
const REQUEST_DELAY_MS = 1500;
const CSV_HEADER = 'handle,status,response_json,error';

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function csvRow(handle, status, responseJson, error) {
  return [
    csvCell(handle),
    status,
    csvCell(responseJson),
    csvCell(error),
  ].join(',');
}

function readHandleAndStatus(row) {
  const match = row.match(/^"((?:[^"]|"")*)",([^,]*)/);
  if (!match) return null;

  return {
    handle: match[1].replace(/""/g, '"'),
    status: match[2],
  };
}

function retryDelay(response, attempt) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const retryAt = Date.parse(retryAfter);
    if (!Number.isNaN(retryAt)) return Math.max(0, retryAt - Date.now());
  }

  return INITIAL_RETRY_DELAY_MS * (2 ** (attempt - 1));
}

async function saveCsv(rows) {
  const contents = `${CSV_HEADER}\r\n${[...rows.values()].join('\r\n')}\r\n`;
  const temporaryFile = `${OUTPUT_FILE}.tmp`;
  await fs.writeFile(temporaryFile, contents, 'utf8');
  await fs.rename(temporaryFile, OUTPUT_FILE);
}

async function main() {
  const input = JSON.parse(await fs.readFile(INPUT_FILE, 'utf8'));
  if (!Array.isArray(input.products)) {
    throw new Error('Expected pilgrim.json to contain a products array.');
  }

  const handles = [...new Set(
    input.products.map((product) => product.handle).filter(Boolean),
  )];
  if (handles.length === 0) {
    throw new Error('No product handles found in pilgrim.json.');
  }

  const rows = new Map();
  try {
    const existingCsv = await fs.readFile(OUTPUT_FILE, 'utf8');
    const existingLines = existingCsv.split(/\r?\n/);
    for (const line of existingLines.slice(1)) {
      const parsed = readHandleAndStatus(line);
      if (parsed?.handle) rows.set(parsed.handle, line);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  for (let index = 0; index < handles.length; index += 1) {
    const handle = handles[index];
    const savedRow = rows.get(handle);
    const savedStatus = savedRow && readHandleAndStatus(savedRow)?.status;

    if (savedStatus && Number(savedStatus) >= 200 && Number(savedStatus) < 300) {
      console.log(`Already saved ${index + 1}/${handles.length}: ${handle}`);
      continue;
    }

    const url = `${BASE_URL}/products/${encodeURIComponent(handle)}.json`;
    let resultRow;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(30000),
        });
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) {
          resultRow = csvRow(handle, '', '', error.message);
          console.error(`Request failed for ${handle}: ${error.message}`);
          break;
        }

        const delay = INITIAL_RETRY_DELAY_MS * (2 ** (attempt - 1));
        console.warn(
          `Request error for ${handle}; retrying in ${Math.ceil(delay / 1000)}s ` +
          `(attempt ${attempt + 1}/${MAX_ATTEMPTS}).`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      const body = await response.text();

      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          const delay = retryDelay(response, attempt);
          console.warn(
            `HTTP ${response.status} for ${handle}; retrying in ` +
            `${Math.ceil(delay / 1000)}s (attempt ${attempt + 1}/${MAX_ATTEMPTS}).`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      if (!response.ok) {
        resultRow = csvRow(
          handle,
          response.status,
          body,
          `HTTP ${response.status} ${response.statusText}`,
        );
        console.error(`Request failed for ${handle}: HTTP ${response.status}`);
        break;
      }

      try {
        const productJson = JSON.parse(body);
        resultRow = csvRow(handle, response.status, JSON.stringify(productJson), '');
        console.log(`Fetched ${index + 1}/${handles.length}: ${handle}`);
      } catch (error) {
        resultRow = csvRow(handle, response.status, body, `Invalid JSON: ${error.message}`);
        console.error(`Invalid JSON for ${handle}: ${error.message}`);
      }
      break;
    }

    if (resultRow) {
      rows.set(handle, resultRow);
      await saveCsv(rows);
      console.log(`Updated ${OUTPUT_FILE} with ${handle}`);
    }

    if (index < handles.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
    }
  }

  console.log(`Finished. CSV contains ${rows.size} saved product rows.`);
}

main().catch((error) => {
  console.error('Pilgrim scraper failed:', error);
  process.exitCode = 1;
});

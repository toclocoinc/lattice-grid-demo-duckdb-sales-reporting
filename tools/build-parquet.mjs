/**
 * Build data/sales.parquet from the Contoso Data Generator V2 ready-to-use data.
 *
 * Developer tool: the published page never runs it. Run it to refresh the
 * data, then upload data/sales.parquet to
 * https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-sales-reporting/
 *
 *   node tools/build-parquet.mjs            # download, extract, write
 *   node tools/build-parquet.mjs --keep     # keep the extracted tables in .cache/
 *
 * What it does:
 *
 *   1. Downloads parquet-10m.7z (about 680 MB) from the SQLBI release into
 *      .cache/, unless it is already there.
 *   2. Extracts it with `7z`, `7zz` or `bsdtar` (any of them) into .cache/.
 *   3. Joins the order lines to the product and store tables and writes ONE
 *      Parquet file: zstd, row groups of 100,000 rows, sorted by order date.
 *
 * The sort and the row-group size are the point. DuckDB-Wasm reads the file
 * over HTTP in byte ranges and can skip a row group only when its min/max
 * statistics rule it out; sorted by date, "2025" is a tenth of the file.
 *
 * Nothing is invented. Every column is copied from a source table or computed
 * by the arithmetic written out in SQL below. Amounts are in US dollars, as
 * the source carries them (its ExchangeRate column converts to the order's
 * local currency and is not applied here).
 */

import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.cache');
const extracted = join(cache, 'contoso-10m');
const archive = join(cache, 'parquet-10m.7z');
const outFile = join(root, 'data', 'sales.parquet');
const SOURCE = 'https://github.com/sql-bi/Contoso-Data-Generator-V2-Data/releases/download/ready-to-use-data/parquet-10m.7z';
const keep = process.argv.includes('--keep');

const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

async function download() {
  if (await exists(archive)) { console.log(`Using cached ${archive}`); return; }
  console.log(`Downloading ${SOURCE}`);
  await mkdir(cache, { recursive: true });
  const response = await fetch(SOURCE, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  console.log(`  ${mb((await stat(archive)).size)}`);
}

function extract() {
  const tools = [['7zz', ['x', '-y']], ['7z', ['x', '-y']], ['bsdtar', ['-xf']]];
  for (const [command, flags] of tools) {
    const probe = spawnSync(command, ['--help'], { stdio: 'ignore' });
    if (probe.error) continue;
    console.log(`Extracting with ${command}`);
    const args = command === 'bsdtar'
      ? [...flags, archive, '-C', extracted]
      : [...flags, `-o${extracted}`, archive];
    const run = spawnSync(command, args, { stdio: 'inherit' });
    if (run.status !== 0) throw new Error(`${command} failed`);
    return;
  }
  throw new Error('Needs 7z, 7zz or bsdtar on the PATH to open the .7z archive.');
}

/*
 * One row per order line. Dimension attributes are folded in so the page reads
 * a single file:
 *   revenue = quantity * net price (after the line discount), USD
 *   cost    = quantity * unit cost, USD
 *   orders  = 1 on an order's first line, else 0, so SUM(orders) counts orders
 * `line_id` is a unique key for the line (an order has at most 20).
 * `period` is the calendar month, `week` the Monday that starts the week.
 */
const sql = (dir) => `
COPY (
  SELECT
    CAST(s.OrderDate AS DATE)                                  AS order_date,
    s.OrderKey                                                 AS order_key,
    s.OrderKey * 20 + s.LineNumber                             AS line_id,
    CAST(s.LineNumber AS UTINYINT)                             AS line_no,
    CAST(CASE WHEN s.LineNumber = 0 THEN 1 ELSE 0 END AS UTINYINT) AS orders,
    CAST(year(s.OrderDate) AS SMALLINT)                        AS year,
    strftime(s.OrderDate, '%Y-%m')                             AS period,
    strftime(date_trunc('week', s.OrderDate), '%Y-%m-%d')      AS week,
    st.CountryName                                             AS country,
    st.State || ' · ' || CAST(s.StoreKey AS VARCHAR)           AS store,
    p.CategoryName                                             AS category,
    p.SubCategoryName                                          AS subcategory,
    p.Brand                                                    AS brand,
    p.ProductName                                              AS product,
    CAST(s.Quantity AS UTINYINT)                               AS quantity,
    CAST(round(s.Quantity * s.NetPrice * 100) AS INTEGER)      AS revenue_cents,
    CAST(round(s.Quantity * s.UnitCost * 100) AS INTEGER)      AS cost_cents
  FROM read_parquet('${dir}/sales.parquet') s
  JOIN read_parquet('${dir}/product.parquet') p USING (ProductKey)
  JOIN read_parquet('${dir}/store.parquet') st USING (StoreKey)
  ORDER BY s.OrderDate, s.OrderKey, s.LineNumber
) TO '${outFile}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000, PARQUET_VERSION V2)`;

await download();
if (!(await exists(join(extracted, 'sales.parquet')))) {
  await mkdir(extracted, { recursive: true });
  extract();
}

await mkdir(join(root, 'data'), { recursive: true });
await rm(outFile, { force: true });
const connection = await (await DuckDBInstance.create(':memory:')).connect();
await connection.run(`SET preserve_insertion_order = true`);
console.log('Writing data/sales.parquet (sorted by order date; this takes a few minutes)...');
await connection.run(sql(extracted));

const one = async (query) => (await connection.runAndReadAll(query)).getRowObjectsJson()[0];
const counts = await one(`SELECT count(*) AS lines, sum(orders) AS orders, min(order_date)::VARCHAR AS first, max(order_date)::VARCHAR AS last FROM read_parquet('${outFile}')`);
const groups = await one(`SELECT count(DISTINCT row_group_id) AS row_groups FROM parquet_metadata('${outFile}')`);
const size = (await stat(outFile)).size;
const facts = { ...counts, ...groups, bytes: size, size: mb(size), source: SOURCE };
console.log(JSON.stringify(facts, null, 2));
await writeFile(join(root, '.cache', 'facts.json'), JSON.stringify(facts, null, 2));
if (!keep) await rm(extracted, { recursive: true, force: true });

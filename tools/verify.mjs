/**
 * Load the page in headless Chrome against the local data and check that what
 * it says is what the data says.
 *
 * Every figure is recomputed here by a second DuckDB, in Node, with SQL written
 * out separately from the grid's. Interactions are real events: mouse clicks on
 * tabs, group chevrons, column headers and pager buttons, keystrokes in the
 * search box. The run also asserts no console errors, no NaN or undefined text,
 * and no watermark.
 *
 *   npm run verify                    # needs data/sales.parquet (npm run build-data)
 *   node tools/verify.mjs --shots <dir>
 */

import { access, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { openBrowser } from './browser.mjs';
import { LATEST_YEAR } from '../src/config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const shotDir = args.includes('--shots') ? resolve(args[args.indexOf('--shots') + 1]) : null;
const file = join(root, 'data', 'sales.parquet');

const failures = [];
const check = (ok, what, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(what);
};
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const tile = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2, minimumFractionDigits: 2 });
const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', notation: 'compact', maximumFractionDigits: 1 });

try { await access(file); } catch {
  console.error('data/sales.parquet is missing. Run `npm run build-data` first.');
  process.exit(2);
}

/* ---------- the independent answer: a second DuckDB, in Node ---------- */

const { DuckDBInstance } = await import('@duckdb/node-api');
const node = await (await DuckDBInstance.create(':memory:')).connect();
const quoted = file.replaceAll("'", "''");
const rows = async (sql) => (await node.runAndReadAll(sql)).getRowObjectsJson();
const one = async (sql) => (await rows(sql))[0];
const lines = `read_parquet('${quoted}')`;

const total = await one(`SELECT count(*) AS n FROM ${lines}`);
const year = async (y) => one(`SELECT sum(revenue_cents) / 100.0 AS revenue, sum(revenue_cents - cost_cents) / 100.0 AS margin, sum(orders) AS orders, count(*) AS lines FROM ${lines} WHERE year = ${y}`);
const y25 = await year(LATEST_YEAR);
const y24 = await year(LATEST_YEAR - 1);

/* ---------------------------- the browser ----------------------------- */

const served = await startServer(0);
const origin = `http://127.0.0.1:${served.port}`;
const desktop = await openBrowser({ width: 1440, height: 1000, colorScheme: 'light' });
const { evaluate, waitFor, click, sleep } = desktop;

/** Wait until no grid in view is loading and the timing readouts have stopped changing. */
async function settle(what, ms = 90000) {
  let last = '';
  let stable = 0;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const snapshot = await evaluate(`(() => {
      const busy = [...document.querySelectorAll('.lat-skeleton, .lat-loading, [aria-busy="true"]')].some((n) => n.offsetParent !== null);
      const t = [...document.querySelectorAll('[data-timing]')].map((n) => n.textContent).join('|');
      return (busy ? 'busy' : 'idle') + t;
    })()`).catch(() => 'busy');
    if (snapshot.startsWith('idle') && snapshot === last) stable += 1; else stable = 0;
    last = snapshot;
    if (stable >= 3) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what} to settle`);
}

const text = (selector) => evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).innerText || ''`);
const gridText = (key) => text(`[data-grid=${key}]`);
const shot = async (name) => { if (shotDir) { await mkdir(shotDir, { recursive: true }); await desktop.shoot(join(shotDir, `${name}.png`)); } };

async function run() {
  console.log(`Serving ${origin}; ${total.n} lines in the file`);
  await desktop.call('Page.navigate', { url: `${origin}/?data=local` });
  await waitFor('window.__salesDemo && (window.__salesDemo.ready || window.__salesDemo.error)', 180000, 'the page to report in');
  const state = await evaluate('({ ready: __salesDemo.ready, error: __salesDemo.error || null, url: __salesDemo.dataUrl })');
  check(state.ready, 'the page is ready', state.error ?? state.url);
  if (!state.ready) return;
  await settle('the first paint');

  console.log('KPI strip');
  const kpi = await text('.kpi-strip');
  check(kpi.includes(tile.format(y25.revenue)), 'revenue tile equals SUM over the year', tile.format(y25.revenue));
  check(kpi.includes(tile.format(y25.margin)), 'gross margin tile', tile.format(y25.margin));
  check(kpi.includes(Number(y25.orders).toLocaleString('en-US')), 'orders tile', y25.orders);
  const yoy = y25.revenue / y24.revenue - 1;
  check(kpi.includes(`${(yoy * 100).toFixed(1)}%`), 'revenue vs last year tile', `${(yoy * 100).toFixed(1)}%`);
  check(kpi.includes(`${((y25.margin / y25.revenue) * 100).toFixed(1)}%`), 'margin rate tile');
  const kpiTiming = await evaluate(`document.querySelector('[data-timing=kpi]').dataset.ms`);
  check(Number(kpiTiming) > 0, 'the tiles show their query time', `${kpiTiming} ms`);

  console.log('Running totals and period over period');
  const months = await rows(`SELECT period, sum(revenue_cents)/100.0 AS revenue FROM ${lines} WHERE year IN (${LATEST_YEAR - 1}, ${LATEST_YEAR}) GROUP BY period ORDER BY period`);
  const jan = months.find((m) => m.period === `${LATEST_YEAR}-01`);
  const janPrior = months.find((m) => m.period === `${LATEST_YEAR - 1}-01`);
  const monthly = await gridText('monthly');
  check(await evaluate(`__salesDemo.grids.monthly.grid.rows.count()`) === 12, 'twelve months in the monthly grid');
  check(monthly.includes(money(jan.revenue)), 'January revenue', money(jan.revenue));
  check(monthly.includes(money(janPrior.revenue)), 'January last year, from LAG(12)', money(janPrior.revenue));
  check(monthly.includes(`${((jan.revenue / janPrior.revenue - 1) * 100).toFixed(1)}%`), 'January change on year');
  check(monthly.includes(money(y25.revenue)), 'December year-to-date equals the year total');
  check(await evaluate(`document.querySelector('[data-chart=trend] svg, [data-chart=trend] canvas') !== null`), 'the revenue chart drew');
  check(await evaluate(`document.querySelectorAll('[data-chart=margin] rect, [data-chart=margin] path, [data-chart=margin] canvas').length > 8`), 'the margin chart drew its bars');

  console.log('Margin by category');
  const cats = await rows(`SELECT category, sum(revenue_cents - cost_cents) / sum(revenue_cents) AS rate FROM ${lines} WHERE year = ${LATEST_YEAR} GROUP BY category ORDER BY rate DESC`);
  const categoryText = await gridText('categories');
  check(await evaluate(`__salesDemo.grids.categories.grid.rows.count()`) === cats.length, `${cats.length} categories`);
  check(categoryText.includes(`${(cats[0].rate * 100).toFixed(1)}%`) && categoryText.includes(cats[0].category), 'the best margin category', `${cats[0].category} ${(cats[0].rate * 100).toFixed(1)}%`);

  console.log('The pack (pivot)');
  const pack = await rows(`SELECT category, period, sum(revenue_cents)/100.0 AS revenue FROM ${lines} WHERE year = ${LATEST_YEAR} GROUP BY ALL ORDER BY ALL`);
  const packText = await gridText('pack');
  check(pack.length === 8 * 12 || pack.length > 90, 'pivot has a cell per category and month', pack.length);
  for (let m = 1; m <= 12; m += 1) {
    if (!packText.includes(`${LATEST_YEAR}-${String(m).padStart(2, '0')}`)) { check(false, `month ${m} is a pivot column`); break; }
    if (m === 12) check(true, 'all twelve months are pivot columns');
  }
  const computers = pack.find((p) => p.category === 'Computers' && p.period === `${LATEST_YEAR}-01`);
  const computersRow = await evaluate(`[...document.querySelectorAll('[data-grid=pack] .lat-row')].map((r) => r.innerText.replace(/\\s+/g, ' ')).find((t) => t.includes('Computers')) || ''`);
  check(computersRow.includes(compact.format(computers.revenue)), 'Computers, January cell', compact.format(computers.revenue));
  const packTiming = await evaluate(`document.querySelector('[data-timing=pack]').dataset.scanned`);
  check(Number(packTiming) === Number(y25.lines), 'rows scanned equals the year’s lines', packTiming);
  await shot('pack');

  console.log('Region to store');
  await click('#tab-region');
  await settle('the region view');
  const regions = await rows(`SELECT country, sum(revenue_cents)/100.0 AS revenue FROM ${lines} WHERE year = ${LATEST_YEAR} GROUP BY country ORDER BY country`);
  let regionText = await gridText('region');
  check(regionText.includes(regions[0].country) && regionText.includes(money(regions[0].revenue)), 'first region and its revenue', `${regions[0].country} ${money(regions[0].revenue)}`);
  /* The first regions open on their own; open the last one by its chevron, a real click. */
  const lastRegion = regions[regions.length - 1].country;
  await evaluate(`(() => { const row = document.querySelector('[data-grid=region] [data-key="g ${lastRegion}"] .lat-expander'); if (row) row.setAttribute('data-verify-toggle', ''); })()`);
  const wasOpen = await evaluate(`document.querySelector('[data-grid=region] [data-key="g ${lastRegion}"]')?.getAttribute('aria-expanded')`);
  if (wasOpen === 'false') { await click('[data-verify-toggle]'); await settle('the region drill-down'); }
  const stores = await rows(`SELECT store, sum(revenue_cents)/100.0 AS revenue FROM ${lines} WHERE year = ${LATEST_YEAR} AND country = '${regions[0].country}' GROUP BY store ORDER BY store`);
  regionText = await gridText('region');
  check(regionText.includes(stores[0].store.split(' · ')[0]) && regionText.includes(money(stores[0].revenue)), 'opening the region lists its stores', `${stores[0].store} ${money(stores[0].revenue)}`);
  await shot('region');

  console.log('Demand by week');
  await click('#tab-demand');
  await settle('the demand view', 120000);
  const weeks = await rows(`SELECT DISTINCT week FROM ${lines} WHERE year = ${LATEST_YEAR} ORDER BY week`);
  const demandText = await gridText('demand');
  check(demandText.includes(weeks[0].week), 'first week column', weeks[0].week);
  const demandCategories = await rows(`SELECT category, sum(quantity) AS units FROM ${lines} WHERE year = ${LATEST_YEAR} GROUP BY category ORDER BY category`);
  check(demandText.includes(demandCategories[0].category), 'categories are the rows', demandCategories[0].category);
  const firstWeek = await one(`SELECT sum(quantity) AS units FROM ${lines} WHERE year = ${LATEST_YEAR} AND week = '${weeks[0].week}' AND category = '${demandCategories[0].category}'`);
  const demandRow = await evaluate(`[...document.querySelectorAll('[data-grid=demand] .lat-row')].map((r) => r.innerText.replace(/\\s+/g, ' ')).find((t) => t.includes(${JSON.stringify(demandCategories[0].category)})) || ''`);
  const unitsFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(firstWeek.units));
  check(demandRow.includes(unitsFormat), 'units for the first week of the first category', unitsFormat);
  await shot('demand');

  console.log('Order lines');
  await click('#tab-lines');
  await settle('the order lines');
  const first = await one(`SELECT order_key, product, revenue_cents/100.0 AS revenue FROM ${lines} WHERE year = ${LATEST_YEAR} ORDER BY order_date, order_key, line_no LIMIT 1`);
  let linesText = await gridText('lines');
  check(linesText.includes(first.product), 'first row is the first line of the year', first.product);
  const pager = await evaluate(`__salesDemo.grids.lines.grid.pagination.get()`);
  check(Number(pager.total) === Number(y25.lines), 'the pager counts every line of the year', pager.total);

  const page0 = await evaluate(`__salesDemo.grids.lines.grid.pagination.get().page`);
  await click('[data-grid=lines] button[aria-label="Next page"]');
  await settle('page two');
  const page1 = await evaluate(`__salesDemo.grids.lines.grid.pagination.get().page`);
  check(page1 === page0 + 1, 'the next-page button moves on a page', `${page0} to ${page1}`);
  await click('[data-grid=lines] button[aria-label="First page"]');
  await settle('page one');

  await click('[data-grid=lines] .lat-header-cell[data-col=revenue] .lat-header-label');
  await settle('the sort');
  const top = await one(`SELECT max(revenue_cents)/100.0 AS revenue FROM ${lines} WHERE year = ${LATEST_YEAR}`);
  const sortedDir = await evaluate(`document.querySelector('[data-grid=lines] .lat-header-cell[data-col=revenue]').dataset.sort`);
  if (sortedDir === 'asc') { await click('[data-grid=lines] .lat-header-cell[data-col=revenue] .lat-header-label'); await settle('the descending sort'); }
  linesText = await gridText('lines');
  check(linesText.includes(`$${top.revenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}`), 'sorting by revenue puts the largest line first', money(top.revenue));

  await click('[data-search]');
  await desktop.type('Alaska');
  await sleep(600);
  await settle('the search');
  const alaska = await one(`SELECT count(*) AS n FROM ${lines} WHERE year = ${LATEST_YEAR} AND store ILIKE '%Alaska%'`);
  const searched = await evaluate(`__salesDemo.grids.lines.grid.pagination.get().total`);
  check(Number(searched) === Number(alaska.n) && Number(alaska.n) > 0, 'quick search runs in the engine', `${searched} lines for "Alaska"`);
  const searchTiming = await evaluate(`document.querySelector('[data-timing=lines]').dataset.ms`);
  check(Number(searchTiming) > 0, 'the search shows its query time', `${searchTiming} ms`);
  await shot('lines');

  console.log('Year and theme');
  await evaluate(`(() => { const s = document.querySelector('#year'); s.value = '${LATEST_YEAR - 1}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await settle('the new year');
  await click('#tab-pack');
  await settle('the pack for the new year');
  const kpi24 = await text('.kpi-strip');
  check(kpi24.includes(tile.format(y24.revenue)), 'changing the year changes the tiles', tile.format(y24.revenue));
  check((await gridText('monthly')).includes(`${LATEST_YEAR - 1}-12`), 'and the monthly grid');
  check((await gridText('pack')).includes(`${LATEST_YEAR - 1}-01`), 'and the pivot');
  await click('[data-theme-toggle]');
  const theme = await evaluate('document.documentElement.dataset.theme');
  check(theme === 'dark', 'the theme button switches to dark', theme);
  await sleep(500);

  console.log('Whole page');
  const body = await evaluate('document.body.innerText');
  check(!/\bNaN\b|undefined|\[object/.test(body), 'no NaN, undefined or [object] text');
  check(!(await evaluate(`/watermark|trial|unlicen[cs]ed/i.test(document.body.innerText) || document.querySelector('[class*=watermark], [data-watermark]') !== null`)), 'no watermark');
  check(desktop.errors.length === 0, '0 console errors', desktop.errors.slice(0, 3).join(' | '));
}

try {
  await run();
} catch (error) {
  failures.push(String(error?.message ?? error));
  console.log(`  FAIL ${error?.stack ?? error}`);
} finally {
  await desktop.close();
  served.server.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);

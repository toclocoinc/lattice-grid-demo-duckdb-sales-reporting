/**
 * What the data is, and how each view reads it.
 *
 * One Parquet file, one row per order line, built by tools/build-parquet.mjs
 * from the Contoso Data Generator V2 10M-orders set. Amounts are held in whole
 * cents so that the file is small; `SALES` turns them into dollars, and adds
 * the margin, in the FROM clause DuckDB runs. Nothing is computed in the page.
 */

import { dataUrl } from './config.js';

/** Years the pack can be opened on. 2016 starts in May, so it has no full year before it. */
export const YEARS = [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017];

const escape = (text) => text.replaceAll("'", "''");

/** The order lines of the given years, with dollars and margin. Only columns a query names are read. */
export function salesFrom(fromYear, toYear = fromYear) {
  const file = escape(dataUrl());
  return `(SELECT *, revenue_cents / 100.0 AS revenue, cost_cents / 100.0 AS cost, `
    + `(revenue_cents - cost_cents) / 100.0 AS margin `
    + `FROM read_parquet('${file}') WHERE year BETWEEN ${Number(fromYear)} AND ${Number(toYear)})`;
}

/**
 * The monthly series with its running total and period-over-period figures,
 * all window functions in DuckDB. It reads the year before as well, so January
 * has a prior month and every month has a same-month-last-year to compare to.
 */
export function monthlyFrom(year) {
  return `(SELECT * FROM (
    SELECT period, year, revenue, margin, orders,
      sum(revenue) OVER (PARTITION BY year ORDER BY period) AS running_revenue,
      revenue - lag(revenue) OVER (ORDER BY period) AS change_on_month,
      lag(revenue, 12) OVER (ORDER BY period) AS revenue_last_year,
      revenue / nullif(lag(revenue, 12) OVER (ORDER BY period), 0) - 1 AS change_on_year
    FROM (
      SELECT period, year, sum(revenue) AS revenue, sum(margin) AS margin, sum(orders) AS orders
      FROM ${salesFrom(year - 1, year)} GROUP BY period, year
    )
  ) WHERE year = ${Number(year)})`;
}

/** One row per store (and per product and week), so a drill-down ends on a store rather than on order lines. */
export function storesFrom(year) {
  return `(SELECT country, store, sum(revenue) AS revenue, sum(margin) AS margin, sum(orders) AS orders, sum(quantity) AS quantity `
    + `FROM ${salesFrom(year)} GROUP BY country, store)`;
}

export function demandFrom(year) {
  return `(SELECT category, product, week, sum(quantity) AS quantity FROM ${salesFrom(year)} GROUP BY category, product, week)`;
}

/** Revenue and margin by category, for the margin chart. */
export function categoryFrom(year) {
  return `(SELECT category, sum(revenue) AS revenue, sum(margin) AS margin, sum(margin) / sum(revenue) AS margin_rate `
    + `FROM ${salesFrom(year)} GROUP BY category)`;
}

const dollars = { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', decimals: 0 };
const dollarsShort = { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', notation: 'compact', maxDecimals: 1 };
const whole = { decimals: 0 };
const percent = { style: 'percent', decimals: 1 };

/** The pack: revenue by category across the months, totalled both ways. */
export const PACK_COLUMNS = [
  { field: 'category', title: 'Category', group: { enabled: true, index: 0 }, allowGroup: true, layout: { width: 270 } },
  { field: 'period', title: 'Month', pivot: { enabled: true, index: 0 }, allowPivot: true },
  { field: 'revenue', title: 'Revenue', type: 'number', total: 'sum', format: dollarsShort, layout: { width: 96 } },
];

/** Running totals and period-over-period. */
export const MONTHLY_COLUMNS = [
  { field: 'period', title: 'Month', layout: { width: 110, pin: 'start' } },
  { field: 'revenue', title: 'Revenue', type: 'number', format: dollars, layout: { width: 130 } },
  { field: 'running_revenue', title: 'Year to date', type: 'number', format: dollars, layout: { width: 140 } },
  { field: 'change_on_month', title: 'Change on month', type: 'number', format: { ...dollars, signDisplay: 'exceptZero' }, layout: { width: 150 } },
  { field: 'revenue_last_year', title: 'Same month last year', type: 'number', format: dollars, layout: { width: 170 } },
  { field: 'change_on_year', title: 'Change on year', type: 'number', format: { ...percent, signDisplay: 'exceptZero' }, layout: { width: 140 } },
  { field: 'margin', title: 'Margin', type: 'number', format: dollars, layout: { width: 130 } },
  { field: 'orders', title: 'Orders', type: 'number', format: whole, layout: { width: 100 } },
];

/** Region to store. */
export const REGION_COLUMNS = [
  { field: 'country', title: 'Region', group: { enabled: true, index: 0 }, allowGroup: true, layout: { width: 220 } },
  { field: 'store', title: 'Store', layout: { width: 260 } },
  { field: 'revenue', title: 'Revenue', type: 'number', total: 'sum', format: dollars, layout: { width: 150 } },
  { field: 'margin', title: 'Margin', type: 'number', total: 'sum', format: dollars, layout: { width: 150 } },
  { field: 'orders', title: 'Orders', type: 'number', total: 'sum', format: whole, layout: { width: 110 } },
  { field: 'quantity', title: 'Units', type: 'number', total: 'sum', format: whole, layout: { width: 110 } },
];

/** Units by product by week. */
export const DEMAND_COLUMNS = [
  { field: 'category', title: 'Category', group: { enabled: true, index: 0 }, allowGroup: true, layout: { width: 220 } },
  { field: 'product', title: 'Product', layout: { width: 320 } },
  { field: 'week', title: 'Week of', pivot: { enabled: true, index: 0 }, allowPivot: true },
  { field: 'quantity', title: 'Units', type: 'number', total: 'sum', format: { ...whole, notation: 'compact', maxDecimals: 1 }, layout: { width: 104 } },
];

/** The order lines themselves: filter, sort, quick search and paging, all in the engine. */
export const LINE_COLUMNS = [
  { field: 'order_date', title: 'Date', type: 'date', filter: { type: 'date' }, layout: { width: 120, pin: 'start' } },
  { field: 'order_key', title: 'Order', type: 'number', format: { useGrouping: false, decimals: 0 }, filter: { type: 'number' }, layout: { width: 110 } },
  { field: 'country', title: 'Region', filter: { type: 'set' }, layout: { width: 150 } },
  { field: 'store', title: 'Store', filter: { type: 'text' }, layout: { width: 230 } },
  { field: 'category', title: 'Category', filter: { type: 'set' }, layout: { width: 200 } },
  { field: 'product', title: 'Product', filter: { type: 'text' }, layout: { width: 320 } },
  { field: 'quantity', title: 'Units', type: 'number', format: whole, filter: { type: 'number' }, layout: { width: 90 } },
  { field: 'revenue', title: 'Revenue', type: 'number', format: { ...dollars, decimals: 2 }, filter: { type: 'number' }, layout: { width: 130 } },
  { field: 'margin', title: 'Margin', type: 'number', format: { ...dollars, decimals: 2 }, filter: { type: 'number' }, layout: { width: 130 } },
];
export const LINE_FIELDS = ['line_id', 'order_date', 'order_key', 'country', 'store', 'category', 'product', 'quantity', 'revenue', 'margin'];

export const fmt = {
  int: (n) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US')),
  dollars: (n) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })),
  percent: (n, digits = 1) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${(Number(n) * 100).toFixed(digits)}%`),
  ms: (n) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`),
};

/**
 * Roughly how many bytes of the file a year's opening views will fetch: the
 * compressed size of the columns they name, in the row groups whose `year`
 * statistics reach the year or the one before. Taken from the footer, which
 * the engine has already read. The loading line uses it for its progress bar.
 */
export function readBytesSql(year) {
  const file = escape(dataUrl());
  return `SELECT sum(total_compressed_size) AS bytes FROM parquet_metadata('${file}')
    WHERE path_in_schema IN ('year', 'period', 'revenue_cents', 'cost_cents', 'orders', 'category')
      AND row_group_id IN (
        SELECT row_group_id FROM parquet_metadata('${file}')
        WHERE path_in_schema = 'year' AND CAST(stats_max AS INTEGER) >= ${Number(year) - 1} AND CAST(stats_min AS INTEGER) <= ${Number(year)})`;
}

# Data

`data/sales.parquet` is not committed (it is about 216 MB). Build it with
`npm run build-data` (Node 22; needs `7z`, `7zz` or `bsdtar` to open the archive)
and upload it, with the two summary tables below, to
`https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-sales-reporting/v2/`,
the one base in `src/config.js` (the table names sit beside `sales.parquet` there). For development, `npm start`
and open `/?data=local` to read the local copy.

## Source, licence, attribution

**Contoso Data Generator V2**, ready-to-use data, the 10M-orders Parquet set
(`parquet-10m.7z`): <https://github.com/sql-bi/Contoso-Data-Generator-V2-Data/releases/tag/ready-to-use-data>.
Published by SQLBI under the MIT licence. Credit: SQLBI.

The build joins the source's `sales`, `product` and `store` tables into one
file. Amounts are US dollars as the source carries them (its `ExchangeRate` is
not applied). The source's `currencyexchange`, `customer` and `date` tables
are not read: the calendar columns are derived from the order date and the
page does not use customers.

## Measured (SELECT count(*), file sizes)

| | |
|---|---|
| Order lines (`SELECT count(*)`) | 23,719,935 |
| Orders (`SELECT sum(orders)`) | 9,887,613 |
| Order dates | 2016-05-18 to 2025-12-31 |
| Row groups | 237 (100,000 rows each, sorted by order date) |
| `sales.parquet` | 226,720,473 bytes (216.2 MB), zstd |
| Source archive `parquet-10m.7z` | 679,235,825 bytes |

## Summary tables

Written by the same build, from `sales.parquet`, next to it: zstd, sorted, Parquet
v2, no Bloom filters. The opening views read only these; `sales.parquet` is read
for the Order lines tab. Each is a plain sum of the order lines, so any total over
them equals the total over the lines (`npm run verify` checks it against the full file).

| File | Grain | Columns | Rows | Size |
|---|---|---|---|---|
| `sales_monthly.parquet` | month x category x region x store | `year`, `period`, `category`, `country`, `store`, `lines`, `orders`, `quantity`, `revenue_cents`, `cost_cents` | 54,296 | 692,309 bytes (676 KB), row groups of 5,000 |
| `sales_weekly.parquet` | week x category x product | `year`, `week`, `category`, `product`, `quantity` | 1,221,238 | 2,087,245 bytes (2.0 MB), row groups of 50,000 |

A year of the monthly table is about 126 KB of the columns the opening view reads;
a year of the weekly table (the demand tab) is one or two row groups.

## Columns

`order_date`, `order_key`, `line_id` (unique key), `line_no`, `orders` (1 on an
order's first line), `year`, `period` (YYYY-MM), `week` (the Monday that starts
the week), `country`, `store`, `category`, `subcategory`, `brand`, `product`,
`quantity`, `revenue_cents` (quantity x net price), `cost_cents` (quantity x unit cost).

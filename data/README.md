# Data

`data/sales.parquet` is not committed (it is about 216 MB). Build it with
`npm run build-data` (Node 22; needs `7z`, `7zz` or `bsdtar` to open the archive)
and upload it to `https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-sales-reporting/sales.parquet`,
which is the one constant in `src/config.js`. For development, `npm start`
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

## Columns

`order_date`, `order_key`, `line_id` (unique key), `line_no`, `orders` (1 on an
order's first line), `year`, `period` (YYYY-MM), `week` (the Monday that starts
the week), `country`, `store`, `category`, `subcategory`, `brand`, `product`,
`quantity`, `revenue_cents` (quantity x net price), `cost_cents` (quantity x unit cost).

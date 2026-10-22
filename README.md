# The monthly pack, live — Lattice Grid over DuckDB-Wasm

Financial and operational reporting over 23.7 million Contoso order lines
(9.9 million orders, 2016–2025), read in the browser from one Parquet file.

- KPI strip: revenue, gross margin, margin rate, orders, revenue against last year.
- Running totals and period over period: window functions (`SUM() OVER`, `LAG`) in the query behind a grid; a chart bound to that grid.
- Margin by category: a grid and a chart bound to it.
- Tabs: the pack (category x month pivot with totals), region to store drill-down, units by product by week (a demand pivot), and the order lines with search, filter, sort and paging.

Every filter, sort, group, pivot, quick search and page is SQL run by DuckDB-Wasm
through the grid's `duckdbAdapter` and pushdown source; the page shows each
view's statement count, time and rows scanned.

## Loading

The first visit has slow steps (the query engine, about 34 MB of WebAssembly and a fifth of that on the wire; starting it; reading the year's columns from the Parquet file), so the page says what it is doing instead of showing blank space. Same pattern as the SaaS demo (`src/loading.js`, `src/duckdb.js`):

- A status line in `index.html`, so it is on screen from first paint: a spinner, one plain-English sentence and a progress bar wherever the size is known. "Downloading the query engine (about 34 MB, first visit only): n of m MB", "Starting the engine", "Reading the Parquet footer", then "Reading the 2025 order lines (n of m MB)".
- Real byte counts, no second download: the engine reports its own download, and the Parquet reads are counted by wrapping the worker. The expected total comes from `parquet_metadata()` (the columns and row groups the opening views touch).
- Every panel (tiles, charts, grids) is covered by a loading state until its grid holds real rows, and again when the year changes or a tab is opened for the first time.

```
npm install
npm run build-data      # downloads the public source and writes data/sales.parquet
npm start               # then open http://localhost:<port>/?data=local
npm run verify          # headless Chrome against the local data
```

Data, licence and attribution: [data/README.md](data/README.md). Code: MIT.

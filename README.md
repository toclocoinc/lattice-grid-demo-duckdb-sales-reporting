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

```
npm install
npm run build-data      # downloads the public source and writes data/sales.parquet
npm start               # then open http://localhost:<port>/?data=local
npm run verify          # headless Chrome against the local data
```

Data, licence and attribution: [data/README.md](data/README.md). Code: MIT.

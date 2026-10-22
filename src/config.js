/**
 * Where the data lives. The one place the Parquet file is named.
 *
 * By default the page reads the file from the data host, which answers HTTP
 * range requests (GitHub Pages cannot, so the file is not published with the
 * page). `?data=local` reads `data/sales.parquet` from the same server instead,
 * for development with `npm start`; `?data=<url>` points at any other copy.
 */
export const DATA_URL = 'https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-sales-reporting/v2/sales.parquet';
export const LOCAL_DATA = './data/sales.parquet';

/** The Parquet file this page load reads, as an absolute URL (DuckDB resolves it in a worker). */
export function dataUrl(search = location.search) {
  const wanted = new URLSearchParams(search).get('data');
  if (wanted === 'local') return new URL(LOCAL_DATA, location.href).href;
  if (wanted && /^https?:\/\//.test(wanted)) return wanted;
  return DATA_URL;
}

/** The last full year in the file; the pack opens on it, compared with the year before. */
export const LATEST_YEAR = 2025;

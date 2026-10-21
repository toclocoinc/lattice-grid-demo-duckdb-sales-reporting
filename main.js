/**
 * The entry point.
 *
 * Starts DuckDB, hands the connection to the page, and gets out of the way.
 * Nothing is awaited at the top level: a module with a pending top-level await
 * leaves the document in its loading state, which blocks a headless browser's
 * evaluations. `start()` is called and the module finishes.
 */

import * as LG from './node_modules/@toclocoinc/lattice-grid/lattice-grid.esm.min.js';
import { createChart } from './node_modules/@toclocoinc/lattice-grid/modules/charts.esm.min.js';
import { createKPI } from './node_modules/@toclocoinc/lattice-grid/modules/kpi.esm.min.js';
import { DEMO_LICENCE } from './src/licence.js';
import { startDuckDB, readOne } from './src/duckdb.js';
import { dataUrl } from './src/config.js';
import { buildPage } from './src/page.js';

/* Applied before anything is drawn: a grid keeps whatever licence was in force when it was built. */
LG.setLicence(DEMO_LICENCE);

const root = document.querySelector('#app');

function showMessage(title, message, hint) {
  root.textContent = '';
  const panel = document.createElement('div');
  panel.className = 'loading';
  const heading = document.createElement('h1');
  heading.textContent = title;
  const line = document.createElement('p');
  line.className = 'loading-message';
  line.textContent = message;
  panel.append(heading, line);
  if (hint) {
    const note = document.createElement('p');
    note.className = 'loading-message';
    note.textContent = hint;
    panel.append(note);
  }
  root.append(panel);
  return (next) => { line.textContent = next; };
}

async function start() {
  const started = performance.now();
  const update = showMessage('The monthly pack, live', 'Starting DuckDB in your browser...');
  try {
    const { connection, version, close } = await startDuckDB(update);
    update('Reading the Parquet footer...');
    /* An unfiltered count is answered from the file's metadata: no row data is read. */
    const counted = await readOne(connection, `SELECT count(*) AS n FROM read_parquet('${dataUrl().replaceAll("'", "''")}')`);
    const totalLines = Number(counted?.n ?? 0);

    const page = buildPage({ root, LG, createChart, createKPI, connection, totalLines });
    window.addEventListener('pagehide', () => { page.destroy(); close(); }, { once: true });
    window.__salesDemo = page;
    await page.start();

    /* Ready means the page is true, not that something appeared: the tiles are filled and the first grid has rows. */
    const deadline = Date.now() + 120000;
    const settled = () => page.kpiValues?.revenue != null
      && page.grids.monthly?.grid.rows.count() > 0
      && page.grids.categories?.grid.rows.count() > 0
      && page.grids.pack?.grid.rows.count() > 0;
    while (Date.now() < deadline && !settled()) await new Promise((r) => setTimeout(r, 150));

    page.ready = true;
    page.bootMs = Math.round(performance.now() - started);
    page.duckdbVersion = version;
    page.dataUrl = dataUrl();
    console.log('[sales demo] ready', { ms: page.bootMs, lines: totalLines, duckdb: version });
  } catch (error) {
    window.__salesDemo = { ready: false, error: String(error?.message ?? error) };
    showMessage(
      'The pack could not be loaded',
      String(error?.message ?? error),
      'This page runs DuckDB compiled to WebAssembly and reads a Parquet file with HTTP range requests. '
      + 'It needs a browser with WebAssembly and a host that answers 206 Partial Content.',
    );
    console.error('[sales demo]', error);
  }
}

start();
